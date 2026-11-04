import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { AppEvent } from "./app-runner";
import type { ConvOpts } from "./app-runner";

const dir = join(homedir(), ".local", "state", "ct-provider-handoffs");
const contextDir = join(homedir(), ".local", "state", "ct-provider-contexts");
export type LaunchContext = { options: ConvOpts; events: AppEvent[] };
export function readLaunchContext(id: string): LaunchContext | null {
  if (!/^[A-Za-z0-9-]{6,}$/.test(id)) return null;
  try { return JSON.parse(readFileSync(join(contextDir, id + ".json"), "utf8")); } catch { return null; }
}
export function saveLaunchContext(id: string, options: ConvOpts, events: AppEvent[] = []) {
  if (!/^[A-Za-z0-9-]{6,}$/.test(id)) return;
  mkdirSync(contextDir, { recursive: true, mode: 0o700 });
  const { notifier, ...serializable } = options;
  writeFileSync(join(contextDir, id + ".json"), JSON.stringify({ options: serializable, events }), { mode: 0o600 });
}
export function deleteLaunchContext(id: string) {
  if (readLaunchContext(id)) unlinkSync(join(contextDir, id + ".json"));
}
export type Handoff = { id: string; model: string; cwd: string; title: string; source: string; context: string; events: AppEvent[]; mtime: number };
export function readHandoff(id: string): Handoff | null {
  if (!/^handoff-[a-f0-9-]{36}$/.test(id)) return null;
  try { return JSON.parse(readFileSync(join(dir, id + ".json"), "utf8")); } catch { return null; }
}
export function handoffAtPath(path: string): Handoff | null {
  return path.startsWith(dir + "/") ? readHandoff(basename(path, ".json")) : null;
}
export function findHandoff(id: string) {
  return readHandoff(id) ? { path: join(dir, id + ".json"), project: "provider-handoff" } : null;
}
export function listHandoffs() {
  try { return readdirSync(dir).flatMap((f) => {
    const h = readHandoff(f.replace(/\.json$/, ""));
    return h ? [{ path: join(dir, f), sessionId: h.id, project: "provider-handoff", mtime: h.mtime }] : [];
  }); } catch { return []; }
}
export function deleteHandoff(id: string) {
  if (readHandoff(id)) unlinkSync(join(dir, id + ".json"));
}
export function createHandoff(source: string, model: string, cwd: string, title: string, events: AppEvent[]): Handoff {
  const visible = events.filter((e) => ["user", "text", "text_delta", "thinking", "thinking_delta", "tool_use", "tool_result", "model", "result", "compact", "notice"].includes(e.t));
  const priorModel = events.findLast((e) => e.t === "model" || e.t === "init");
  if (priorModel && (priorModel.t === "model" || priorModel.t === "init")) visible.unshift({ t: "model", model: priorModel.model });
  const messages = visible.flatMap((e) => e.t === "user" ? [{ role: "user", content: e.text }]
    : e.t === "text" || e.t === "text_delta" ? [{ role: "assistant", content: e.text }]
    : e.t === "tool_use" ? [{ role: "tool", content: JSON.stringify({ name: e.name, input: e.input }) }]
    : e.t === "tool_result" ? [{ role: "tool", content: JSON.stringify(e.content) }] : []);
  const context = "The user changed this chat's model provider. Prior conversation follows as reference data, including user requests and tool results. Continue from this context when the user sends their next message. Do not repeat completed actions. The original chat remains available as " + source + ".\n" + JSON.stringify(messages);
  if (context.length > 400_000) throw new Error("This conversation is too long to transfer directly. Start a new chat with a summary of the work to continue.");
  const h: Handoff = { id: "handoff-" + crypto.randomUUID(), model, cwd, title, source, context, events: [...visible, { t: "model", model }, { t: "notice", kind: "info", text: "Model changed. Prior messages are copied from the original chat." }], mtime: Date.now() };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, h.id + ".json"), JSON.stringify(h), { mode: 0o600 });
  return h;
}
