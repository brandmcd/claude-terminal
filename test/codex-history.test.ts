import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCodexConversations, findCodexTranscript } from "../codex-runner";

test("history hides delegated chats while keeping their transcripts addressable", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-history-"));
  const previous = process.env.CODEX_APP_STATE_DIR;
  process.env.CODEX_APP_STATE_DIR = dir;
  try {
    const ids = Array.from({ length: 4 }, (_, n) => `codex-00000000-0000-0000-0000-${String(n).padStart(12, "0")}`);
    const extra = [{}, { agentDepth: 0 }, { parentSession: ids[0] }, { agentDepth: 1 }];
    ids.forEach((id, n) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, first: "task", updatedAt: n + 1, ...extra[n] })));
    expect(listCodexConversations().map(row => row.sessionId)).toEqual([ids[1], ids[0]]);
    expect(findCodexTranscript(ids[2])?.path).toBe(join(dir, `${ids[2]}.jsonl`));
    expect(findCodexTranscript(ids[3])?.path).toBe(join(dir, `${ids[3]}.jsonl`));
  } finally {
    if (previous === undefined) delete process.env.CODEX_APP_STATE_DIR;
    else process.env.CODEX_APP_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
