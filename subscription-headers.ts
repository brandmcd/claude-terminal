// Subscription rate-limit windows, read straight off the API's response headers.
//
// WHY THIS EXISTS. app-runner's getSubscriptionUsage() asks the SDK control query for
// `rate_limits`, and on this box that comes back `rate_limits_available: false` — the control
// query is opened purely to call the usage API and never sends a turn, so it never receives a
// response whose headers carry the numbers. The windows are real and they are not hard to get:
// EVERY API response carries them.
//
//   anthropic-ratelimit-unified-5h-utilization: 0.16      <- percent of the 5h session window used
//   anthropic-ratelimit-unified-5h-reset:       1788326400 <- unix seconds
//   anthropic-ratelimit-unified-7d-utilization: 0.02      <- the weekly window
//   anthropic-ratelimit-unified-7d-reset:       1788462000
//
// So this samples them with the cheapest request that exists: max_tokens 1 on Haiku, which the
// server answers (and charges) as roughly a dozen tokens. That is ~16k tokens a day at the 60s
// collector cadence, against a box that moves billions — but it is not nothing, so the result is
// cached and the sampler is only ever called by the collector, never per page view.
//
// The credential is the same subscription OAuth token the terminal and the sidecar already run on
// (`sk-ant-oat01-…` from `claude setup-token`), read from the environment. OAuth tokens go on
// `Authorization: Bearer` with the oauth beta header — NOT `x-api-key`, which rejects them.
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const PROBE_MODEL = "claude-haiku-4-5";
const TTL_MS = 60_000;

export interface LimitWindow {
  utilization: number | null; // 0-100
  resets_at: string | null; // ISO 8601
}
export interface Limits {
  available: boolean;
  subscription: string | null;
  five_hour: LimitWindow | null;
  seven_day: LimitWindow | null;
  overage_status: string | null;
  fetched_at: number;
}

let cache: Limits | null = null;
let inflight: Promise<Limits | null> | null = null;

// Header utilization is a fraction (0.16 = 16%); the rest of the stack speaks percent.
function pct(raw: string | null): number | null {
  if (raw == null) return null;
  const v = Number(raw);
  if (!isFinite(v)) return null;
  return Math.max(0, Math.min(100, v <= 1 ? v * 100 : v));
}

function iso(raw: string | null): string | null {
  if (!raw) return null;
  const v = Number(raw);
  if (!isFinite(v) || v <= 0) return null;
  return new Date(v * 1000).toISOString().replace(/\.\d+Z$/, "+00:00");
}

async function probe(): Promise<Limits | null> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
      signal: AbortSignal.timeout(15_000),
    });
    // A 429 still carries the headers, and is exactly when they matter most — so read them on any
    // response that isn't an auth/shape failure. Only give up when the headers are absent.
    const h = res.headers;
    const five = h.get("anthropic-ratelimit-unified-5h-utilization");
    const seven = h.get("anthropic-ratelimit-unified-7d-utilization");
    if (five == null && seven == null) {
      if (!res.ok) console.error(`subscription headers: HTTP ${res.status}, no unified headers`);
      return { available: false, subscription: null, five_hour: null, seven_day: null, overage_status: null, fetched_at: Date.now() };
    }
    return {
      available: true,
      // There is no plan-name header — `unified-status` is "allowed"/"rejected", not "max"/"pro" —
      // so leave the subscription-type column null rather than filling it with a status word.
      subscription: null,
      five_hour: { utilization: pct(five), resets_at: iso(h.get("anthropic-ratelimit-unified-5h-reset")) },
      seven_day: { utilization: pct(seven), resets_at: iso(h.get("anthropic-ratelimit-unified-7d-reset")) },
      overage_status: h.get("anthropic-ratelimit-unified-overage-status"),
      fetched_at: Date.now(),
    };
  } catch (e) {
    console.error("subscription headers: probe failed:", e);
    return null;
  }
}

// Cached, single-flight. Returns null only when there is no usable reading at all.
export async function getLimitsFromHeaders(): Promise<Limits | null> {
  if (cache && Date.now() - cache.fetched_at < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = probe()
    .then((r) => {
      if (r) cache = r;
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
