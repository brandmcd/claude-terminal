// app-mcp-signin.ts
// Paste-back sign-in for stdio MCP servers that run a localhost OAuth listener (workspace-mcp, the
// Google servers). Kept beside app-mcp.ts so app-server.ts gains only route hooks.
//
// The flow mirrors what worked by hand: start a helper copy of the server from its stored config,
// call its start_google_auth tool to get the Google URL, and keep the helper alive because the
// callback listener lives inside that same process. The browser cannot load the
// localhost:<port>/oauth2callback?... address it lands on, so the user pastes it back and the
// sidecar requests it on 127.0.0.1. The helper writes the new credentials file and is killed; a
// reconnect then makes the chat's own server process read that file.

import type { StoredMcpServer } from "./app-mcp";

type Helper = { proc: ReturnType<typeof Bun.spawn>; port: number; timer: ReturnType<typeof setTimeout> };
const helpers = new Map<string, Helper>();
const HELPER_TTL_MS = 10 * 60 * 1000;

// The localhost port the server's OAuth redirect points at, or null if it has no paste-back flow.
export function signInPort(cfg: StoredMcpServer | undefined): number | null {
  if (!cfg || (cfg.type && cfg.type !== "stdio")) return null;
  const uri = (cfg as any).env?.GOOGLE_OAUTH_REDIRECT_URI;
  if (typeof uri !== "string") return null;
  try {
    const u = new URL(uri);
    if (!/^(localhost|127\.0\.0\.1)$/.test(u.hostname) || !u.port) return null;
    return Number(u.port);
  } catch { return null; }
}

function stopHelper(name: string) {
  const h = helpers.get(name);
  if (!h) return;
  clearTimeout(h.timer);
  try { h.proc.kill(); } catch {}
  helpers.delete(name);
}

// Minimal JSON-RPC over the helper's stdio: write one line, read lines until the matching id.
async function rpc(proc: Helper["proc"], reader: ReadableStreamDefaultReader<Uint8Array>, buf: { s: string }, id: number, method: string, params: unknown, ms: number): Promise<any> {
  const stdin = proc.stdin as any;
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  stdin.flush?.();
  const dec = new TextDecoder();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    let nl;
    while ((nl = buf.s.indexOf("\n")) >= 0) {
      const line = buf.s.slice(0, nl); buf.s = buf.s.slice(nl + 1);
      try { const m = JSON.parse(line); if (m.id === id) return m; } catch {}
    }
    const r = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
    if (!r || r.done) break;
    buf.s += dec.decode(r.value, { stream: true });
  }
  throw new Error(method + " timed out");
}

// Start a sign-in: returns the Google URL to open. Replaces any earlier helper for this server.
export async function startSignIn(name: string, cfg: StoredMcpServer | undefined): Promise<{ url: string; port: number }> {
  const port = signInPort(cfg);
  if (!cfg || port === null) throw new Error(`"${name}" has no sign-in flow (no localhost GOOGLE_OAUTH_REDIRECT_URI)`);
  stopHelper(name);
  const c = cfg as Extract<StoredMcpServer, { command: string }>;
  const proc = Bun.spawn([c.command, ...(c.args || [])], {
    env: { ...process.env, ...(c.env || {}) },
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  helpers.set(name, { proc, port, timer: setTimeout(() => stopHelper(name), HELPER_TTL_MS) });
  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const buf = { s: "" };
    await rpc(proc, reader, buf, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ct-signin", version: "1" } }, 90000);
    (proc.stdin as any).write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const email = c.env?.USER_GOOGLE_EMAIL;
    const res = await rpc(proc, reader, buf, 2, "tools/call", { name: "start_google_auth", arguments: { service_name: "Gmail", ...(email ? { user_google_email: email } : {}) } }, 30000);
    const text = (res.result?.content || []).map((x: any) => x?.text || "").join("\n") || JSON.stringify(res.error || res);
    const url = text.match(/https:\/\/accounts\.google\.com\/[^\s)"'*]+/)?.[0];
    if (!url) throw new Error("the server did not return a sign-in URL: " + text.slice(0, 200));
    reader.releaseLock();
    return { url, port };
  } catch (e) {
    stopHelper(name);
    throw e;
  }
}

// Finish a sign-in from the pasted localhost callback address. The address carries the one-time
// auth code, so it is never logged or echoed back.
export async function finishSignIn(name: string, pasted: string): Promise<void> {
  const h = helpers.get(name);
  if (!h) throw new Error("no sign-in is waiting for this server (it expires after 10 minutes); press Fix again");
  let u: URL;
  try { u = new URL(pasted.trim()); } catch { throw new Error("that is not a URL; paste the whole address from the browser bar"); }
  if (!/^(localhost|127\.0\.0\.1)$/.test(u.hostname) || Number(u.port) !== h.port || u.pathname !== "/oauth2callback")
    throw new Error(`expected an address starting http://localhost:${h.port}/oauth2callback`);
  if (u.searchParams.get("error")) throw new Error("Google returned an error: " + u.searchParams.get("error"));
  if (!u.searchParams.get("code")) throw new Error("the address has no code= part; copy it again after signing in");
  let r: Response;
  try { r = await fetch(`http://127.0.0.1:${h.port}/oauth2callback${u.search}`); }
  catch { stopHelper(name); throw new Error("the sign-in listener is gone; press Fix again"); }
  const body = await r.text().catch(() => "");
  stopHelper(name);
  if (!r.ok) {
    const why = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error("sign-in failed: " + (why || "HTTP " + r.status));
  }
}
