import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegationIndex } from "../delegated";
import { saveLaunchContext, deleteLaunchContext } from "../provider-handoff";
import { appRoutes, type AppCtx } from "../app-server";

test("temporary parent aliases survive restarts and descendants stay inside their root", () => {
  const rows = [
    { id: "parent", launchAlias: "new-parent" },
    { id: "child", parentSession: "new-parent", launchAlias: "new-child" },
    { id: "grandchild", parentSession: "new-child" },
    { id: "other", parentSession: "unrelated" },
  ];
  const index = delegationIndex(rows, () => undefined);
  expect(index.descendants("parent").map(r => r.id)).toEqual(["child", "grandchild"]);
  expect(index.descendants("new-parent").map(r => r.id)).toEqual(["child", "grandchild"]);
  expect(index.children.has("parent")).toBe(false);
  expect(delegationIndex([{ id: "child", parentSession: "temporary" }], id => id === "temporary" ? "parent" : undefined).descendants("parent")).toHaveLength(1);
});
const root = mkdtempSync(join(tmpdir(), "delegation-test-"));
const project = join(root, "projects", "fixture"); mkdirSync(project, { recursive: true });
const parent = crypto.randomUUID(), child = crypto.randomUUID(), other = crypto.randomUUID();
const ctx = { allowed: () => true, cors: () => ({}), publicDir: root, dataDir: join(root, "projects"), claudeDir: root, mcpFile: join(root, "mcp.json"), historyHide: [], hideProjectDirs: [], defaultCwd: root, downloadRoots: [root], models: [], moreModels: [], guest: true, favoritesFile: join(root, "favs.json"), titlesFile: join(root, "titles.json"), autoTitlesFile: join(root, "auto.json"), readsFile: join(root, "reads.json") } as AppCtx;
for (const id of [parent, child, other]) writeFileSync(join(project, id + ".jsonl"), JSON.stringify({ type: "user", uuid: crypto.randomUUID(), cwd: root, timestamp: new Date().toISOString(), message: { role: "user", content: "Blind CFB " + id } }) + "\n");
saveLaunchContext(child, { cwd: root, model: "opus", parentSession: parent, agentDepth: 1 });
writeFileSync(ctx.favoritesFile, JSON.stringify([child]));
afterAll(() => { deleteLaunchContext(child); rmSync(root, { recursive: true, force: true }); });
async function call(path: string) { return (await appRoutes(new Request("http://local" + path), path.split("?")[0], ctx))!; }
test("child chats are absent from history, favorites and search, but readable within the parent", async () => {
  const list = await (await call("/app/api/conversations")).json();
  expect(list.conversations.map((r: any) => r.sessionId).sort()).toEqual([parent, other].sort());
  expect(list.favorites).toEqual([]);
  expect(list.delegatedIds).toContain(child);
  const search = await (await call("/app/api/search?q=" + child)).json();
  expect(search.results).toEqual([]);
  const spawned = await (await call("/app/api/spawned?id=" + parent)).json();
  expect(spawned.items.map((r: any) => r.key)).toContain("delegated:" + child);
  const transcript = await (await call(`/app/api/spawned/transcript?id=${parent}&key=delegated:${child}`)).json();
  expect(transcript.events.some((e: any) => e.t === "user" && e.text.includes(child))).toBe(true);
  expect((await call(`/app/api/spawned/transcript?id=${other}&key=delegated:${child}`)).status).toBe(404);
  expect((await call("/app/api/conversation/" + child)).status).toBe(200);
});
test("Codex parents and children use the same contained transcript viewer", async () => {
  const previous = process.env.CODEX_APP_STATE_DIR;
  const dir = join(root, "codex"); mkdirSync(dir);
  process.env.CODEX_APP_STATE_DIR = dir;
  const p = "codex-" + crypto.randomUUID(), c = "codex-" + crypto.randomUUID();
  try {
    for (const id of [p, c]) {
      writeFileSync(join(dir, id + ".json"), JSON.stringify({ id, first: "CFB ranking", title: "CFB ranking", cwd: root, ...(id === c ? { parentSession: p, agentDepth: 1 } : {}) }));
      writeFileSync(join(dir, id + ".jsonl"), JSON.stringify({ t: "text", text: "Ranking result" }) + "\n");
    }
    const ownerCtx = { ...ctx, guest: false };
    const list = await (await appRoutes(new Request(`http://local/app/api/spawned?id=${p}`), "/app/api/spawned", ownerCtx))!.json();
    expect(list.items.map((r: any) => r.key)).toEqual(["delegated:" + c]);
    const transcript = await (await appRoutes(new Request(`http://local/app/api/spawned/transcript?id=${p}&key=delegated:${c}`), "/app/api/spawned/transcript", ownerCtx))!.json();
    expect(transcript.events).toContainEqual({ t: "text", text: "Ranking result" });
  } finally {
    if (previous === undefined) delete process.env.CODEX_APP_STATE_DIR;
    else process.env.CODEX_APP_STATE_DIR = previous;
  }
});
