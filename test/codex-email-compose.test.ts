import { test, expect } from "bun:test";
import { CodexConversation } from "../codex-runner";
import { listTools } from "../shared-tools";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("compose tool is available and card preserves draft, edits and cancellation", async () => {
  expect(listTools().some(t => t.name === "email_compose")).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "compose-test-"));
  const prior = process.env.CODEX_APP_STATE_DIR;
  process.env.CODEX_APP_STATE_DIR = dir;
  const conv = new CodexConversation(`codex-${crypto.randomUUID()}`, { cwd: dir } as any);
  (conv as any).phase = "working";
  (conv as any).mcpOverride = { google_personal: { args: ["workspace-mcp"], env: { USER_GOOGLE_EMAIL: "sender@example.invalid" } } };
  try {
    const cancelled = conv.composeEmail({ to: "self@example.invalid", subject: "hi", body: "hi" });
    await Bun.sleep(1);
    const card = conv.listPendingAsks()[0];
    expect(card.email?.to).toBe("self@example.invalid");
    expect(card.email?.body).toBe("hi");
    expect(card.email?.fromOptions).toEqual(["sender@example.invalid"]);
    conv.answerAsk(card.askId, JSON.stringify({ action: "cancel" }));
    expect(await cancelled).toContain("cancelled");
    const revised = conv.composeEmail({ to: "self@example.invalid", subject: "hi", body: "hi" });
    await Bun.sleep(1);
    conv.answerAsk(conv.listPendingAsks()[0].askId, "change subject");
    expect(await revised).toContain("asked for changes: change subject");
    expect(conv.listPendingAsks()).toHaveLength(0);
  } finally {
    conv.close();
    if (prior === undefined) delete process.env.CODEX_APP_STATE_DIR; else process.env.CODEX_APP_STATE_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
