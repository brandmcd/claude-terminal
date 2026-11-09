import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmailGate } from "../codex-email-gate";

const adapter = join(import.meta.dir, "../codex-email-hook.py");
const shared = "/home/ctuser/.claude/hooks/email-gate.py";
const mail = { tool_name: "mcp__gmail__send_gmail_message", tool_input: { to: "test@example.invalid", subject: "Approval test", body: "Never delivered", user_google_email: "sender@example.invalid" } };
async function fixture(run: (home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "email-gate-test-"));
  mkdirSync(join(home, ".claude/hooks"), { recursive: true });
  copyFileSync(shared, join(home, ".claude/hooks/email-gate.py"));
  try { await run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
async function hook(home: string, event: unknown, socket = "") {
  const child = Bun.spawn(["python3", adapter], { env: { ...process.env, HOME: home, CT_EMAIL_GATE_SOCKET: socket }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(event)); child.stdin.end();
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return output.trim() ? JSON.parse(output).hookSpecificOutput : null;
}
test("ordinary tools and mail reads pass without a prompt", () => fixture(async home => {
  expect(await hook(home, { tool_name: "Bash", tool_input: { command: "pwd" } })).toBeNull();
  expect(await hook(home, { tool_name: "mcp__gmail__read_message", tool_input: {} })).toBeNull();
}));
test("MCP sends, forwards, replies, shell sends, and executed scripts block without a bridge", () => fixture(async home => {
  for (const tool of ["send_gmail_message", "send_gmail_draft", "forward_email", "reply_email"]) {
    expect((await hook(home, { ...mail, tool_name: `mcp__gmail__${tool}` })).permissionDecision).toBe("deny");
  }
  const script = join(home, "send.py"); writeFileSync(script, "import smtplib\n");
  for (const command of ["sendmail test@example.invalid", `python3 ${script}`]) {
    expect((await hook(home, { tool_name: "Bash", tool_input: { command } })).permissionDecision).toBe("deny");
  }
}));
test("approval waits for the chat and includes all send fields", () => fixture(async home => {
  let release!: (approved: boolean) => void;
  let seen!: (reason: string) => void;
  const asked = new Promise<string>(r => seen = r);
  const gate = await createEmailGate(reason => { seen(reason); return new Promise(r => release = r); });
  try {
    let finished = false;
    const result = hook(home, mail, gate.socket).then(r => { finished = true; return r; });
    const reason = await asked;
    expect(reason).toContain(mail.tool_input.body);
    expect(reason).toContain(mail.tool_input.user_google_email);
    expect(finished).toBe(false);
    release(true);
    expect((await result).permissionDecision).toBe("allow");
  } finally { gate.close(); }
}));
test("cancel and bridge failure deny", () => fixture(async home => {
  for (const approve of [async () => false, async () => { throw new Error("unavailable"); }]) {
    const gate = await createEmailGate(approve);
    try { expect((await hook(home, mail, gate.socket)).permissionDecision).toBe("deny"); }
    finally { gate.close(); }
  }
  expect((await hook(home, mail, join(home, "missing.sock"))).permissionDecision).toBe("deny");
}));
test("existing compose approvals allow the exact send once; changed and expired drafts deny", () => fixture(async home => {
  const approvals = join(home, ".local/state/email-approvals"); mkdirSync(approvals, { recursive: true });
  const approval = { to: mail.tool_input.to, cc: "", bcc: "", subject: mail.tool_input.subject, body: mail.tool_input.body, from: mail.tool_input.user_google_email, attachments: "", expires: Date.now() + 60_000 };
  const path = join(approvals, "test.json"); writeFileSync(path, JSON.stringify(approval));
  expect((await hook(home, { ...mail, tool_input: { ...mail.tool_input, body: "Changed" } })).permissionDecision).toBe("deny");
  expect((await hook(home, mail)).permissionDecision).toBe("allow");
  expect((await hook(home, mail)).permissionDecision).toBe("deny");
  writeFileSync(path, JSON.stringify({ ...approval, expires: Date.now() - 1 }));
  expect((await hook(home, mail)).permissionDecision).toBe("deny");
}));
test("missing shared detector explicitly denies instead of failing open", () => fixture(async home => {
  rmSync(join(home, ".claude/hooks/email-gate.py"));
  expect((await hook(home, mail)).permissionDecision).toBe("deny");
}));


test("chat approval cards expire and interruption clears pending approvals", async () => {
  const { CodexConversation } = await import("../codex-runner");
  const home = mkdtempSync(join(tmpdir(), "email-chat-test-"));
  const previous = process.env.CODEX_APP_STATE_DIR;
  process.env.CODEX_APP_STATE_DIR = home;
  const conversation = new CodexConversation(`codex-${crypto.randomUUID()}`, { cwd: home } as any);
  try {
    const timed = (conversation as any).ask("Test approval", [{ label: "Send email" }, { label: "Cancel" }], false, 10);
    expect(await timed).toBe("Cancelled");
    expect(conversation.listPendingAsks()).toHaveLength(0);
    const interrupted = (conversation as any).ask("Test approval", [], false, 300_000);
    await conversation.interrupt();
    expect(await interrupted).toBe("Cancelled");
    expect(conversation.listPendingAsks()).toHaveLength(0);
  } finally {
    conversation.close();
    if (previous === undefined) delete process.env.CODEX_APP_STATE_DIR; else process.env.CODEX_APP_STATE_DIR = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
