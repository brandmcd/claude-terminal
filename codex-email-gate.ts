import { createServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A separate private socket per conversation routes approval to the correct chat.
// No email is sent here: the hook waits for this decision before releasing its tool.
export async function createEmailGate(approve: (reason: string) => Promise<boolean>) {
  const dir = mkdtempSync(join(tmpdir(), "ct-email-"));
  chmodSync(dir, 0o700);
  const socket = join(dir, "gate.sock");
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "POST" || req.url !== "/approve") { res.writeHead(404).end('{}'); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) { res.writeHead(413).end('{}'); return; }
        chunks.push(Buffer.from(chunk));
      }
      const { reason } = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof reason !== "string" || !reason.trim()) { res.writeHead(400).end('{}'); return; }
      const approved = await approve(reason);
      res.end(JSON.stringify({ approved: approved === true }));
    } catch { res.writeHead(503).end('{"approved":false}'); }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    chmodSync(socket, 0o600);
  } catch (error) { server.close(); rmSync(dir, { recursive: true, force: true }); throw error; }
  server.unref();
  return { socket, close() { server.close(); server.closeAllConnections(); rmSync(dir, { recursive: true, force: true }); } };
}
