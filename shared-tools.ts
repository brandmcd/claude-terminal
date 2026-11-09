// Shared MCP tools for delegated sessions and append-only vault contributions.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

type Args = Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
class ToolError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
const object = (properties: Args, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string", minLength: 1 };
const TOOLS: Tool[] = [
  { name: "email_compose", description: "Show an editable email compose card with Send and Cancel. Use before sending any email. Leave signatures out of body; the card adds the selected account signature. Returns exact approved send fields or cancellation/revision instructions. Never sends by itself.", inputSchema: object({ question: string, from: string, to: string, cc: {type:"string"}, bcc: {type:"string"}, subject: {type:"string"}, body: {type:"string"}, attachments: {type:"array",items:string} }, ["to", "subject", "body"]) },
  { name: "agent_models", description: "List available Claude and Codex model IDs, labels and providers. Use this before delegation to map user names such as Sol or Opus to an available model ID.", inputSchema: object({}, []) },
  { name: "agent_spawn", description: "Start a scoped child chat on an explicit Claude or Codex model. Poll agent_status for its result. Delegation is limited to three levels. The child must use the shared vault tools for vault writes.", inputSchema: object({ model: string, prompt: string, cwd: string }, ["model", "prompt"]) },
  { name: "agent_status", description: "Read a child chat's latest assistant response, busy state, unanswered questions, and recent tool states.", inputSchema: object({ id: string }, ["id"]) },
  { name: "agent_interrupt", description: "Interrupt a child chat's current turn.", inputSchema: object({ id: string }, ["id"]) },
  { name: "vault_read", description: "Read a Markdown note relative to the configured vault and obtain its SHA-256. An absent note returns exists:false and sha256:\"\". Read the vault's AGENTS.md and schema before contributing.", inputSchema: object({ path: string }, ["path"]) },
  { name: "vault_append", description: "Append text to a Markdown note only if expectedHash matches vault_read. Use an empty expectedHash to create an absent note. New notes require caller-supplied valid frontmatter; ai:generated is inserted if absent. Existing ai:none becomes assisted. Existing prose is preserved. No callouts or other properties are added. The tool records authorship outside the vault.", inputSchema: object({ path: string, text: string, expectedHash: { type: "string" } }, ["path", "text", "expectedHash"]) },
];
export const listTools = () => TOOLS;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function required(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new ToolError("invalid_arguments", `${key} must be a nonempty string`);
  return value;
}
function sessionId(args: Args): string {
  const id = required(args, "id");
  if (!/^[\w-]{1,200}$/.test(id)) throw new ToolError("invalid_arguments", "Invalid chat ID");
  return id;
}
function depth(): number {
  const value = Number(process.env.CT_AGENT_DEPTH || "0");
  if (!Number.isInteger(value) || value < 0 || value > 3) throw new ToolError("configuration", "CT_AGENT_DEPTH must be an integer between 0 and 3");
  return value;
}
async function appRequest(path: string, body?: Args, timeoutMs = 30_000): Promise<any> {
  const url = new URL(process.env.CT_APP_URL || "http://127.0.0.1:3001");
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new ToolError("configuration", "CT_APP_URL must be a loopback HTTP URL without credentials");
  }
  const owner = process.env.CT_OWNER;
  if (!owner) throw new ToolError("configuration", "CT_OWNER is required for agent tools");
  const response = await fetch(new URL(path, url), {
    method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: { "remote-user": owner, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error || data?.ok === false) throw new ToolError("agent_request", data?.error || `Chat request failed (HTTP ${response.status})`);
  if (!data) throw new ToolError("agent_request", "Chat server returned an empty response");
  return data;
}
export async function agentModels() {
  const data = await appRequest("/app/api/models");
  const models = [...(data.models || []), ...(data.moreModels || [])];
  return { models: models.map((model: any) => ({ id: model.id, label: model.label, provider: model.provider || "claude" })) };
}
export async function agentSpawn(args: Args) {
  const model = required(args, "model"), prompt = required(args, "prompt"), currentDepth = depth();
  if (currentDepth >= 3) throw new ToolError("depth_limit", "Child chats cannot delegate beyond three levels");
  if (model === "default") throw new ToolError("invalid_arguments", "Choose an explicit Claude or Codex model");
  const cwd = args.cwd === undefined ? undefined : required(args, "cwd");
  const scope = "You are a delegated agent. Complete only the task above and preserve other agents' work. Report what you changed and verified. Use the shared vault_read and vault_append tools for every vault contribution. Do not modify vault files through a shell, editor, or another tool. A hash conflict requires reading the note again before deciding what to append. Follow the vault's AGENTS.md and metadata schema. Delegate further only when the assigned task requires it, within the configured depth limit.";
  const result = await appRequest("/app/api/start", { text: `${prompt}\n\n<shared-agent-scope>\n${scope}\n</shared-agent-scope>`, model, ...(cwd ? { cwd } : {}), parentSession: process.env.CT_PARENT_SESSION || undefined, agentDepth: currentDepth + 1 });
  if (!result.id) throw new ToolError("agent_request", "Chat server returned no child chat ID");
  return { id: result.id, model, depth: currentDepth + 1 };
}
export async function agentStatus(args: Args) {
  const id = sessionId(args), data = await appRequest(`/app/api/conversation/${encodeURIComponent(id)}`);
  const events = Array.isArray(data.events) ? data.events : [];
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].t === "user") { start = i + 1; break; }
  const blocks: { bid?: string; text: string }[] = [];
  for (const event of events.slice(start)) {
    if (event.t !== "text" && event.t !== "text_delta") continue;
    const block = event.bid ? blocks.find(b => b.bid === event.bid) : event.t === "text_delta" ? blocks.at(-1) : undefined;
    if (block) block.text += event.text || "";
    else blocks.push({ bid: event.bid, text: event.text || "" });
  }
  const errors = events.filter((e: any) => e.t === "error").slice(-10).map((e: any) => e.message);
  const tools = events.filter((e: any) => e.t === "tool_use").slice(-20).map((e: any) => {
    const result = events.findLast((r: any) => r.t === "tool_result" && r.id === e.id);
    return { id: e.id, name: e.name, state: !result ? "running" : result.isError ? "error" : "done" };
  });
  const pendingAsks = Array.isArray(data.pendingAsks) ? data.pendingAsks : events.filter((e: any) => e.t === "ask" && !events.some((r: any) => r.t === "ask_done" && r.askId === e.askId));
  const text = blocks.map(b => b.text).join("\n\n");
  return { id: data.sessionId || id, model: data.model, busy: !!data.busy, finalText: text.slice(-60_000), truncated: text.length > 60_000, pendingAsks, errors, tools };
}
export async function agentInterrupt(args: Args) {
  const id = sessionId(args);
  await appRequest("/app/api/interrupt", { id });
  return { id, interrupted: true };
}

type NotePath = { root: string; file: string; parent: string; relative: string };
function inside(root: string, path: string) { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
async function notePath(path: string): Promise<NotePath> {
  const root = await realpath(process.env.CT_VAULT_DIR || join(homedir(), "vault"));
  if (path.includes("\0") || path.split(/[\\/]/).includes("..") || !path.endsWith(".md")) throw new ToolError("invalid_path", "Use a .md path inside the vault without '..' components");
  const target = resolve(root, path);
  if (!inside(root, target)) throw new ToolError("invalid_path", "The note must be inside the vault");
  const parent = await realpath(dirname(target));
  if (!inside(root, parent)) throw new ToolError("invalid_path", "The note's parent resolves outside the vault");
  const file = join(parent, basename(target));
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ToolError("invalid_path", "The note must be a regular file, not a symlink");
    if (!inside(root, await realpath(file))) throw new ToolError("invalid_path", "The note resolves outside the vault");
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  return { root, file, parent, relative: relative(root, file) };
}
async function readNote(file: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw new ToolError("invalid_path", "The note must be a regular file");
    return await handle.readFile();
  } catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
  finally { await handle?.close(); }
}
export async function vaultRead(args: Args) {
  const path = await notePath(required(args, "path")), data = await readNote(path.file);
  return { path: path.relative, exists: data !== null, content: data?.toString("utf8") || "", sha256: data === null ? "" : sha256(data) };
}
function provenance(text: string, isNew: boolean): string {
  const front = text.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m);
  if (!front || front.index !== 0) {
    if (isNew) throw new ToolError("frontmatter", "New notes require caller-supplied frontmatter consistent with the vault schema");
    if (/^\uFEFF?---(?:\r?\n|$)/.test(text)) throw new ToolError("frontmatter", "The note's frontmatter is not closed");
    return `---\nai: assisted\n---\n\n${text}`;
  }
  const fields = [...front[2].matchAll(/^ai[ \t]*:[ \t]*(?:(['"])(none|assisted|generated)\1|(none|assisted|generated))([ \t]*(?:#[^\r\n]*)?)(\r?)$/gm)];
  const aiLines = [...front[2].matchAll(/^ai[ \t]*:/gm)];
  if (aiLines.length !== fields.length || fields.length > 1) throw new ToolError("frontmatter", "The note must have one valid ai value: none, assisted, or generated");
  const newline = front[1].endsWith("\r\n") ? "\r\n" : "\n";
  let metadata = front[2];
  if (!fields.length) metadata += `${metadata && !metadata.endsWith("\n") ? newline : ""}ai: ${isNew ? "generated" : "assisted"}${newline}`;
  else {
    const value = fields[0][2] || fields[0][3];
    if (isNew && value !== "generated") throw new ToolError("frontmatter", "A new note must use ai: generated");
    if (!isNew && value === "none") metadata = metadata.slice(0, fields[0].index) + fields[0][0].replace(/\bnone\b/, "assisted") + metadata.slice(fields[0].index! + fields[0][0].length);
  }
  return front[1] + metadata + front[3] + text.slice(front[0].length);
}
export async function vaultAppend(args: Args) {
  const path = await notePath(required(args, "path")), text = required(args, "text");
  if (typeof args.expectedHash !== "string" || (args.expectedHash && !/^[a-f\d]{64}$/i.test(args.expectedHash))) throw new ToolError("invalid_arguments", "expectedHash must be a SHA-256 or an empty string for an absent note");
  const state = join(homedir(), ".local", "state"), locks = join(state, "ct-vault-locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const lockPath = join(locks, `${sha256(path.file)}.lock`);
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error: any) { if (error.code === "EEXIST") throw new ToolError("locked", "Another writer holds this note's lock. Read again after it finishes. A stale lock requires manual inspection."); throw error; }
  const temp = join(path.parent, `.${basename(path.file)}.${randomUUID()}.tmp`);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, session: process.env.CT_PARENT_SESSION || null, time: new Date().toISOString() }));
    const checked = await notePath(path.file);
    if (checked.file !== path.file) throw new ToolError("invalid_path", "The note path changed while acquiring its lock");
    const before = await readNote(path.file), beforeHash = before === null ? "" : sha256(before);
    if (beforeHash !== args.expectedHash.toLowerCase()) return { ok: false, conflict: true, path: path.relative, sha256: beforeHash, error: "The note changed since it was read. Read it again before appending." };
    const original = before?.toString("utf8") || "";
    if (before && !Buffer.from(original, "utf8").equals(before)) throw new ToolError("encoding", "The note must be valid UTF-8");
    const updated = before === null ? provenance(text, true) : provenance(original, false) + (original.endsWith("\n") || !original ? "" : "\n") + text + (text.endsWith("\n") ? "" : "\n");
    const afterHash = sha256(updated), priorStat = before === null ? null : await lstat(path.file);
    const output = await open(temp, "wx", priorStat ? priorStat.mode & 0o777 : 0o600);
    try { await output.writeFile(updated); await output.sync(); } finally { await output.close(); }
    // The audit's prepared record retains attribution even if committing the note or its final record fails.
    const audit = await open(join(state, "ct-vault-authorship.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      await audit.chmod(0o600);
      const record = { id: randomUUID(), provider: process.env.CT_AGENT_PROVIDER || "unknown", model: process.env.CT_AGENT_MODEL || "unknown", session: process.env.CT_PARENT_SESSION || null, path: path.relative, beforeSha256: beforeHash, afterSha256: afterHash, time: new Date().toISOString() };
      await audit.writeFile(JSON.stringify({ ...record, phase: "prepared" }) + "\n"); await audit.sync();
      // Check the source again immediately before the atomic rename, including external-editor changes.
      const latest = await readNote(path.file);
      if ((latest === null ? "" : sha256(latest)) !== beforeHash) return { ok: false, conflict: true, path: path.relative, sha256: latest === null ? "" : sha256(latest), error: "The note changed during the append. Read it again." };
      const finalPath = await notePath(path.file);
      if (finalPath.file !== path.file) throw new ToolError("invalid_path", "The note's parent changed during the append");
      await rename(temp, path.file);
      await audit.writeFile(JSON.stringify({ ...record, phase: "committed", time: new Date().toISOString() }) + "\n"); await audit.sync();
    } finally { await audit.close(); }
    return { ok: true, path: path.relative, created: before === null, sha256: afterHash };
  } finally {
    await unlink(temp).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

export async function callTool(name: string, args: Args = {}) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new ToolError("unknown_tool", `Unknown tool: ${name}`);
  const properties = (tool.inputSchema.properties || {}) as Args;
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !(key in properties))) throw new ToolError("invalid_arguments", "Unexpected tool arguments");
  switch (name) {
    case "email_compose": {
      const id = process.env.CT_PARENT_SESSION;
      if (!id) throw new ToolError("configuration", "Conversation ID required");
      return appRequest("/app/api/email-compose", { ...args, id }, 960_000);
    }
    case "agent_models": return agentModels();
    case "agent_spawn": return agentSpawn(args);
    case "agent_status": return agentStatus(args);
    case "agent_interrupt": return agentInterrupt(args);
    case "vault_read": return vaultRead(args);
    case "vault_append": return vaultAppend(args);
  }
}
export async function handleRpc(message: any): Promise<any | null> {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request" } };
  if (message.id === undefined) return null;
  const result = (value: unknown) => ({ jsonrpc: "2.0", id: message.id, result: value });
  switch (message.method) {
    case "initialize": return result({ protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ct-shared-tools", version: "1.0.0" } });
    case "ping": return result({});
    case "tools/list": return result({ tools: TOOLS });
    case "tools/call": {
      try { const value = await callTool(message.params?.name, message.params?.arguments || {}); return result({ content: [{ type: "text", text: JSON.stringify(value) }], ...(value && "ok" in value && value.ok === false ? { isError: true } : {}) }); }
      catch (error: any) { return result({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: error.message || String(error), code: error.code || "tool_error" }) }] }); }
    }
    default: return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
}
export function startServer() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", async line => {
    let message;
    try { message = JSON.parse(line); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); return; }
    const response = await handleRpc(message);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}
if (import.meta.main) startServer();
