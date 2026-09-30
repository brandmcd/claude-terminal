// External-peer collector: pull usage from OTHER claude-terminal instances and store
// it locally so it can be shown on this instance's board. A peer is a friend who runs
// their own copy of this app and exposes GET /usage/export (see server.ts), gated by a
// shared token. We fetch that snapshot and REPLACE the peer's rows in the external_*
// tables, so values are absolute (never double-counted) and a peer that goes offline
// just keeps its last snapshot until it comes back.
//
// Peers are deliberately kept OUT of the money split (server.ts flags them `external`
// and gives them no share_usd). This module only ingests; it never touches the local
// collector's offset/delta bookkeeping.
//
// Configured via config.json -> externalPeers: [{ name, url, token }]. No-ops when the
// list is absent or empty, so a vanilla install is unaffected.
import { openDb } from "./db.ts";

type Peer = { name?: string; url?: string; token?: string; tokenFile?: string };

// A peer's shared token may be given inline as `token`, or out of line as `tokenFile`
// pointing at a file that holds it. deploy/config.json.proposed is tracked in a public
// repo, so an inline token in the config gets committed; tokenFile keeps the secret in
// /etc where it belongs and leaves the tracked file safe to push.
async function peerToken(p: Peer): Promise<string> {
  if (p.token) return p.token;
  if (!p.tokenFile) return "";
  try {
    return (await Bun.file(p.tokenFile).text()).trim();
  } catch (e) {
    console.error(`external peer ${p.name || p.url}: cannot read tokenFile ${p.tokenFile}:`, e);
    return "";
  }
}

export async function sampleExternalPeers(configPath: string): Promise<void> {
  const cfg = JSON.parse(await Bun.file(configPath).text());
  const peers: Peer[] = Array.isArray(cfg.externalPeers) ? cfg.externalPeers : [];
  if (!peers.length) return;

  const db = openDb(cfg.db); // writable handle; also ensures the external_* tables exist
  const delCum = db.prepare("DELETE FROM external_cum WHERE peer = ?");
  const delHours = db.prepare("DELETE FROM external_hourly WHERE peer = ?");
  const delMeta = db.prepare("DELETE FROM external_meta WHERE peer = ?");
  const delModels = db.prepare("DELETE FROM external_model_usage WHERE peer = ?");
  const insModels = db.prepare("INSERT OR REPLACE INTO external_model_usage (peer, user, mk, model, output) VALUES (?, ?, ?, ?, ?)");
  const insCum = db.prepare(
    `INSERT INTO external_cum (peer, user, name, input, output, cache_creation, cache_read, total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insHours = db.prepare(
    `INSERT OR REPLACE INTO external_hourly
       (peer, user, hour_utc, total, output, input, cache_creation, cache_read)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insMeta = db.prepare(
    `INSERT INTO external_meta (peer, user, sessions, models, last_activity, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  // A token count past 2^53 cannot be real; a peer's corrupt row once sent 9.96e22 output
  // tokens for a single hour, which SQLite stored as REAL and the boards printed as-is.
  const num = (v: any) => {
    if (typeof v !== "number" || !isFinite(v)) return 0;
    const n = Math.trunc(v);
    if (Number.isSafeInteger(n)) return Math.max(0, n);
    console.error(`external peer: dropping implausible token count ${v}`);
    return 0;
  };

  // Output and input per hour are capped too. One stream writes roughly 100 tokens/s, about
  // 360k an hour, and this box's busiest hour so far wrote 1.1M output. 50M allows for ~140
  // parallel streams. The laptop once reported 6.02e9 output for 2026-09-23T18, which fits
  // under 2^53 and so passed num(). Cache reads legitimately reach hundreds of millions an
  // hour, so they stay uncapped. Totals are rebuilt from the kept parts.
  const HOURLY_TOKEN_CAP = 50_000_000;
  const hourPart = (v: any, what: string, hour: string) => {
    const n = num(v);
    if (n <= HOURLY_TOKEN_CAP) return n;
    console.error(`external peer: dropping implausible ${what} ${n} for hour ${hour}`);
    return 0;
  };

  for (const p of peers) {
    if (!p?.url) continue;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      const token = await peerToken(p);
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(p.url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        console.error(`external peer ${p.name || p.url}: HTTP ${res.status}`);
        continue;
      }
      const data: any = await res.json();
      const peerName = p.name || data?.peer;
      if (!peerName) { console.error(`external peer ${p.url}: no name`); continue; }
      const exportUsers: any[] = Array.isArray(data?.users) ? data.users : [];
      const fetchedAt = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");

      const tx = db.transaction(() => {
        delCum.run(peerName);
        delHours.run(peerName);
        delMeta.run(peerName);
        delModels.run(peerName);
        for (const u of exportUsers) {
          const user = String(u?.user || "").trim();
          if (!user) continue;
          const c = u.cumulative || {};
          insCum.run(
            peerName, user, String(u.name || user),
            num(c.input), num(c.output), num(c.cache_creation), num(c.cache_read), num(c.total),
          );
          const m = u.meta || {};
          const models = typeof m.models === "string" ? m.models : JSON.stringify(m.models || []);
          insMeta.run(peerName, user, num(m.sessions), models, m.last_activity || null, fetchedAt);
          for (const h of Array.isArray(u.hourly) ? u.hourly : []) {
            if (!h?.hour_utc) continue;
            // a peer on the older export shape sends no parts; num() makes those 0,
            // which keeps the row loadable rather than dropping the hour entirely
            const hour = String(h.hour_utc);
            const output = hourPart(h.output, "output", hour), input = hourPart(h.input, "input", hour);
            const cc = num(h.cache_creation), cr = num(h.cache_read);
            // an older peer sends only total, so fall back to it when there are no parts
            const total = output + input + cc + cr || num(h.total);
            insHours.run(peerName, user, hour, total, output, input, cc, cr);
          }
          // Per-model output, when the peer's export carries it (older peers omit it -> raw fallback).
          for (const mm of Array.isArray(u.models) ? u.models : []) {
            if (!mm?.mk || !mm?.model) continue;
            insModels.run(peerName, user, String(mm.mk), String(mm.model), num(mm.output));
          }
          // Per-model output, when the peer's export carries it (older peers omit it -> raw fallback).
          for (const mm of Array.isArray(u.models) ? u.models : []) {
            if (!mm?.mk || !mm?.model) continue;
            insModels.run(peerName, user, String(mm.mk), String(mm.model), num(mm.output));
          }
        }
      });
      tx();
      console.log(`external peer ${peerName}: ${exportUsers.length} user(s) synced`);
    } catch (e) {
      console.error(`external peer ${p.name || p.url} sample failed:`, e);
    }
  }

  db.close();
}
