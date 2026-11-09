import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexTitleStream } from "../codex-title";
import { CodexConversation, codexMeta, replayCodexTranscript } from "../codex-runner";

test("title tags stay hidden at every possible stream boundary", () => {
  const reply = "<title>Robot Intake Design</title>\nHere is the design.";
  for (let split = 0; split <= reply.length; split++) {
    const titles: string[] = [];
    const stream = new CodexTitleStream(title => titles.push(title));
    const visible = stream.push(reply.slice(0, split)) + stream.push(reply.slice(split)) + stream.finish();
    expect(visible.trim()).toBe("Here is the design.");
    expect(titles).toEqual(["Robot Intake Design"]);
  }
});

test("ordinary replies and incomplete tags are preserved", () => {
  for (const reply of ["Hello", "<title", "<title>" + "x".repeat(300), "<div>Example</div>"]) {
    const stream = new CodexTitleStream(() => { throw new Error("unexpected title"); });
    expect(stream.push(reply) + stream.finish()).toBe(reply);
  }
});

test("image-only chat requests, persists, and replays a descriptive title", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-title-"));
  const previous = process.env.CODEX_APP_STATE_DIR;
  process.env.CODEX_APP_STATE_DIR = dir;
  try {
    const id = "codex-11111111-1111-1111-1111-111111111111";
    const conv = new CodexConversation(id, { cwd: dir } as any);
    const internal = conv as any;
    internal.meta.threadId = "fixture";
    internal.boot = async () => {};
    const inputs: string[] = [];
    internal.client = { close() {}, async request(method: string, args: any) {
      expect(method).toBe("turn/start");
      inputs.push(args.input[0].text);
      const bid = `message-${inputs.length}`;
      const notify = (method: string, extra: any) => internal.notification(method, { threadId: "fixture", ...extra });
      if (inputs.length === 1) {
        // Models may inspect an image before producing their first text.
        notify("item/completed", { item: { id: "view", type: "imageView", path: "/tmp/photo.jpg" } });
        for (const delta of ["<tit", "le>Robot Intake Design</title>", "\nHere is what I see."])
          notify("item/agentMessage/delta", { itemId: bid, delta });
        notify("item/completed", { item: { id: bid, type: "agentMessage", text: "<title>Robot Intake Design</title>\nHere is what I see." } });
        notify("thread/name/updated", { threadName: "Attached files" });
      } else {
        // Non-streamed responses also hide a repeated title without renaming.
        notify("item/completed", { item: { id: bid, type: "agentMessage", text: "<title>Another title</title>\nNext answer." } });
      }
      notify("turn/completed", { turn: { id: "turn", status: "completed" } });
      return { turn: { id: "turn" } };
    } };
    const prompt = "Attached files:\n/tmp/IMG_1234.jpg";
    await conv.run(prompt);
    await conv.run("continue");
    expect(inputs[0]).toContain("<title-request>");
    expect(inputs[1]).toBe("continue");
    expect(codexMeta(id).title).toBe("Robot Intake Design");
    expect(JSON.parse(readFileSync(join(dir, id + ".json"), "utf8")).generatedTitle).toBe(true);
    const events = await replayCodexTranscript(id);
    expect(events.filter(e => e.t === "title").map((e: any) => e.title)).toEqual(["Robot Intake Design"]);
    const visible = events.filter(e => e.t === "text" || e.t === "text_delta").map((e: any) => e.text).join("");
    expect(visible).toContain("Here is what I see.");
    expect(visible).toContain("Next answer.");
    expect(visible).not.toContain("<title>");
    expect(events.find(e => e.t === "user")).toMatchObject({ text: prompt });
    conv.close();
  } finally {
    if (previous === undefined) delete process.env.CODEX_APP_STATE_DIR;
    else process.env.CODEX_APP_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
