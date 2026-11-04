import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CodexClient, type RpcMessage } from "./codex-client.ts";
import { sharedMcpConfig, sharedInstructions, richChatInstructions } from "./shared-mcp.ts";
import type { AppEvent, AppModel, ConvOpts, LiveStatus, PendingAsk, Phase, SessionSettings, TurnUsage } from "./app-runner.ts";

type Event = AppEvent & { _seq?: number };
type Metadata = { id: string; threadId?: string; cwd: string; model?: string; title: string; first: string; createdAt: number; updatedAt: number; settings: SessionSettings; mode?: "plan" | "default"; sharedTools?: ConvOpts["sharedTools"]; agentDepth?: number; parentSession?: string; handoffContext?: string };
type Sub = (event: AppEvent) => void;
const ID = /^codex-[a-f0-9-]{36}$/i;
const stateDir = () => process.env.CODEX_APP_STATE_DIR || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "ct-app");
function pathFor(id: string, ext = "json"): string { if (!ID.test(id)) throw new Error("Invalid Codex conversation ID"); return join(stateDir(), `${id}.${ext}`); }
function loadMeta(idOrPath: string): Metadata | null {
  try { const id = basename(idOrPath).replace(/\.(jsonl|json)$/, ""); return JSON.parse(readFileSync(pathFor(id), "utf8")); } catch { return null; }
}
function saveMeta(meta: Metadata) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const path = pathFor(meta.id); const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 }); renameSync(tmp, path);
}
function readEvents(id: string): Event[] {
  try { return readFileSync(pathFor(id, "jsonl"), "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; }
}
export function isCodexModel(model?: string | null): boolean { return !!model && /^(codex:|gpt-|codex-)/i.test(model); }
export function codexModelId(model: string): string { return model.replace(/^codex:/i, ""); }
let catalog: (AppModel & { provider: "codex" })[] = [];
let catalogAt = 0;
let catalogFailureAt = 0;
let catalogPending: Promise<typeof catalog> | undefined;
let discovery: CodexClient | undefined;
function discoveryClient() { return discovery ||= new CodexClient(); }
export async function getCodexModels(): Promise<(AppModel & { provider: "codex" })[]> {
  if (catalogFailureAt && Date.now() - catalogFailureAt < 60_000) return catalog;
  if (catalogAt && Date.now() - catalogAt < 300_000) return catalog;
  if (catalogPending) return catalogPending;
  catalogPending = (async () => {
    const models: typeof catalog = []; let cursor: string | undefined;
    do {
      const page = await discoveryClient().request("model/list", { cursor, limit: 100 });
      for (const model of page.data || []) {
        if (model.hidden) continue;
        const efforts = (model.supportedReasoningEfforts || []).map((option: any) => option.reasoningEffort);
        models.push({ id: model.model || model.id, label: model.displayName || model.model, description: model.description, resolvedModel: model.model, provider: "codex", supportsEffort: efforts.length > 0, supportedEffortLevels: efforts });
      }
      cursor = page.nextCursor || undefined;
    } while (cursor);
    catalog = models; catalogAt = Date.now(); catalogFailureAt = 0; return catalog;
  })().catch(() => { catalogFailureAt = Date.now(); return catalog; }).finally(() => { catalogPending = undefined; });
  return catalogPending;
}

type UsageWindow = { utilization: number; resetsAt: string | null };
export type CodexUsage = { available: boolean; authenticated?: boolean; fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; windows?: { label: string; utilization: number; resetsAt: string | null; windowDurationMins: number | null }[]; fetchedAt: number; error?: string; accountUsage?: any; subscription?: string | null };
let usage: CodexUsage | null = null;
let usagePending: Promise<void> | undefined;
export function getCodexUsage(): CodexUsage | null {
  if ((!usage || Date.now() - usage.fetchedAt > 60_000) && !usagePending) {
    usagePending = refreshCodexUsage().finally(() => { usagePending = undefined; });
  }
  return usage;
}
export async function getCodexUsageReady(): Promise<CodexUsage | null> {
  const cached = getCodexUsage();
  if (cached) return cached;
  await usagePending;
  return usage;
}
export async function refreshCodexUsage(): Promise<void> {
  const client = discoveryClient();
  const [limits, account, tokens] = await Promise.allSettled([
    client.request("account/rateLimits/read"), client.request("account/read", { refreshToken: false }), client.request("account/usage/read"),
  ]);
  const snapshot = limits.status === "fulfilled" ? limits.value : null;
  const window = (w: any): UsageWindow | null => w ? { utilization: w.usedPercent, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null } : null;
  const windows = Object.entries(snapshot?.rateLimitsByLimitId || { codex: snapshot?.rateLimits }).flatMap(([id, raw]) => {
    const bucket = raw as any;
    return [bucket?.primary, bucket?.secondary].filter(Boolean).map(w => ({ label: `${bucket.limitName || id} (${w.windowDurationMins === 300 ? "5 hours" : w.windowDurationMins === 10080 ? "7 days" : `${w.windowDurationMins ?? "unknown"} minutes`})`, ...window(w)!, windowDurationMins: w.windowDurationMins }));
  });
  usage = { available: !!snapshot, authenticated: account.status === "fulfilled" ? !!account.value.account : undefined,
    fiveHour: window([snapshot?.rateLimits?.primary, snapshot?.rateLimits?.secondary].find(w => w?.windowDurationMins === 300)), sevenDay: window([snapshot?.rateLimits?.primary, snapshot?.rateLimits?.secondary].find(w => w?.windowDurationMins === 10080)),
    subscription: snapshot?.rateLimits?.planType || null, windows,
    fetchedAt: Date.now(), ...(tokens.status === "fulfilled" ? { accountUsage: tokens.value } : {}),
    ...(limits.status === "rejected" ? { error: limits.reason.message } : {}),
  };
}

// MCP endpoints come from the same persisted Connections map used by Claude chats.
export function codexMcpConfig(stored: Record<string, any>): Record<string, any> {
  const servers: Record<string, any> = {};
  for (const [name, server] of Object.entries(stored)) {
    if (server.type === "sse") throw new Error(`Codex does not support legacy SSE MCP server "${name}". Use its streamable HTTP endpoint.`);
    if (server.type === "http") servers[name] = { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) };
    else if (!server.type || server.type === "stdio") servers[name] = { command: server.command, args: server.args || [], ...(server.env ? { env: server.env } : {}) };
    else throw new Error(`Codex does not support MCP transport "${server.type}"`);
  }
  return servers;
}

const conversations = new Map<string, CodexConversation>();
export class CodexConversation {
  readonly id: string;
  readonly epoch = randomUUID();
  readonly cwd: string;
  model?: string;
  settings: SessionSettings = {};
  phase: Phase = "idle";
  lastActivity = Date.now();
  lastUsage?: TurnUsage;
  private meta: Metadata;
  private client?: CodexClient;
  private booting?: Promise<void>;
  private closed = false;
  private phaseSince = Date.now();
  private busyStart = 0;
  private log: Event[] = [];
  private sequence = 0;
  private runStart = 0;
  private turnId?: string;
  private turnStarted = 0;
  private turnDone?: () => void;
  private queue = Promise.resolve();
  private streamed = new Set<string>();
  private asks = new Map<string, { meta: PendingAsk; resolve: (answer: string) => void }>();
  private subs = new Map<Sub, { evict?: (why?: string) => void; key?: string }>();
  private hooks = new Set<Sub>();
  private tokenUsage?: any;
  private tokenBaseline?: any;
  private mcpOverride?: Record<string, any>;
  private restarting = false;
  private runtimeModel?: string;
  private interruptGeneration = 0;
  private tools = new Set<string>();
  constructor(id: string, private opts: ConvOpts) {
    this.id = id;
    this.meta = loadMeta(id) || { id, cwd: opts.cwd, model: opts.model ? codexModelId(opts.model) : undefined, title: "", first: "", createdAt: Date.now(), updatedAt: Date.now(), settings: {} };
    this.cwd = this.meta.cwd;
    this.model = opts.model ? codexModelId(opts.model) : this.meta.model;
    this.settings = { ...this.meta.settings, ...opts.settings };
    this.opts = { ...opts, sharedTools: this.meta.sharedTools || opts.sharedTools, agentDepth: this.meta.agentDepth ?? opts.agentDepth, parentSession: this.meta.parentSession || opts.parentSession, handoffContext: this.meta.handoffContext || opts.handoffContext };
    this.meta.sharedTools = this.opts.sharedTools; this.meta.agentDepth = this.opts.agentDepth; this.meta.parentSession = this.opts.parentSession; this.meta.handoffContext = this.opts.handoffContext;
    this.checkSettings(this.settings);
    saveMeta(this.meta);
  }
  get busy() { return this.phase !== "idle"; }
  get isClosed() { return this.closed; }
  get seq() { return this.sequence - 1; }
  get activitySeq() { return this.sequence; }
  hasSubscribers() { return this.subs.size > 0; }
  busySince() { return this.busy ? this.busyStart : 0; }
  statusInfo(): LiveStatus { return { busy: this.busy, waiting: this.asks.size > 0, ...(this.busy ? { since: this.busyStart } : {}) }; }
  statusEvent(): AppEvent { return { t: "status", phase: this.phase, since: this.phaseSince }; }
  setPhase(phase: Phase) {
    if (this.phase === phase) return;
    const wasBusy = this.busy; this.phase = phase; this.phaseSince = Date.now();
    if (!wasBusy && this.busy) this.busyStart = this.phaseSince;
    this.emit(this.statusEvent());
    if (wasBusy !== this.busy) this.emit({ t: "busy", busy: this.busy, ...(this.busy ? { since: this.busyStart } : {}) });
  }
  private emit(event: AppEvent) {
    const e = { ...event, _seq: this.sequence++ }; this.lastActivity = Date.now();
    this.log.push(e);
    if (this.log.length > 5000) { this.log.shift(); this.runStart = Math.max(0, this.runStart - 1); }
    appendFileSync(pathFor(this.id, "jsonl"), JSON.stringify(e) + "\n", { mode: 0o600 });
    for (const fn of [...this.subs.keys(), ...this.hooks]) { try { fn(e); } catch {} }
  }
  // `key` names the client socket; a reconnect with the same key replaces its own stale subscriber
  // instead of pushing out another tab's live one (same rule as Conversation.addSub in app-runner.ts).
  private addSub(fn: Sub, evict?: (why?: string) => void, key?: string) {
    if (key) for (const [f, meta] of this.subs) { if (meta.key !== key) continue; this.subs.delete(f); try { meta.evict?.("replaced"); } catch {} }
    this.subs.set(fn, { evict, key });
    if (this.subs.size > 12) { const [oldest, meta] = this.subs.entries().next().value!; this.subs.delete(oldest); meta.evict?.(); }
  }
  // Claude chats stamp the user's device timezone on each turn; Codex turns carry no such stamp.
  setClientTz(_tz: unknown) {}
  subscribe(fn: Sub, fromNow = false, evict?: (why?: string) => void, key?: string) {
    this.addSub(fn, evict, key); if (!fromNow) for (const e of this.log.slice(this.runStart)) fn(e);
    return () => { this.subs.delete(fn); };
  }
  subscribeSince(fn: Sub, seq: number, evict?: (why?: string) => void, key?: string) {
    this.addSub(fn, evict, key); for (const e of this.log) if ((e._seq ?? -1) > seq) fn(e);
    return () => { this.subs.delete(fn); };
  }
  onEvent(fn: Sub) { this.hooks.add(fn); return () => { this.hooks.delete(fn); }; }
  listPendingAsks(): PendingAsk[] { return [...this.asks.values()].map(a => a.meta); }
  answerAsk(askId: string, answer: string) {
    const ask = this.asks.get(askId); if (!ask) return false;
    this.asks.delete(askId); this.emit({ t: "ask_done", askId, answer }); ask.resolve(answer); return true;
  }
  private ask(question: string, options: PendingAsk["options"], allowText = true): Promise<string> {
    const askId = randomUUID(); const meta = { askId, question, options, allowText };
    return new Promise(resolve => { this.asks.set(askId, { meta, resolve }); this.emit({ t: "ask", ...meta });
      if (!this.hasSubscribers()) this.opts.notifier?.({ sessionId: this.id, question, allowText });
    });
  }
  private checkSettings(patch: SessionSettings) {
    if (patch.advisorModel) throw new Error("Codex does not support advisorModel");
    if (patch.alwaysThinkingEnabled != null) throw new Error("Use Codex reasoning effort to control thinking");
  }
  async setSettings(patch: SessionSettings) {
    this.checkSettings(patch);
    if (patch.effortLevel) {
      const models = await getCodexModels(); const model = models.find(m => m.id === this.model);
      if (model && !model.supportedEffortLevels?.includes(patch.effortLevel)) throw new Error(`Model ${this.model} does not support ${patch.effortLevel} reasoning effort`);
    }
    this.settings = { ...this.settings, ...patch }; this.persist(); this.emit({ t: "settings", settings: this.settings });
  }
  async setModel(model: string) {
    if (!isCodexModel(model)) throw new Error("Switch providers by starting a new conversation");
    model = codexModelId(model);
    const models = await getCodexModels(); if (!models.some(m => m.id === model)) throw new Error(`Codex model unavailable: ${model}`);
    this.model = model; this.persist(); this.emit({ t: "model", model });
  }
  private persist() {
    this.meta.model = this.model; this.meta.settings = this.settings; this.meta.updatedAt = Date.now(); saveMeta(this.meta);
  }
  private async boot() {
    if (this.booting) return this.booting;
    if (this.client) return;
    this.booting = (async () => {
      let stored = this.mcpOverride || {};
      if (!this.mcpOverride && this.opts.mcpFile && existsSync(this.opts.mcpFile)) stored = JSON.parse(readFileSync(this.opts.mcpFile, "utf8"));
      const config = { mcp_servers: codexMcpConfig({ ...stored, ...sharedMcpConfig(this.opts, this.id, "codex", this.model) }) };
      const developerInstructions = [richChatInstructions, this.opts.sharedTools ? sharedInstructions("codex", this.model) : "", this.opts.handoffContext || ""].filter(Boolean).join("\n\n");
      const client = new CodexClient(this.cwd);
      client.onNotification((method, params) => this.notification(method, params));
      client.onRequest = message => this.serverRequest(message);
      client.onExit = error => {
        if (this.restarting || this.closed) return;
        this.client = undefined; this.emit({ t: "error", message: error.message }); this.finish();
        for (const id of this.asks.keys()) this.answerAsk(id, "Cancelled");
      };
      this.client = client;
      try {
        const result = await client.request(this.meta.threadId ? "thread/resume" : "thread/start", {
          ...(this.meta.threadId ? { threadId: this.meta.threadId, excludeTurns: true } : {}),
          cwd: this.cwd, model: this.model, developerInstructions, approvalPolicy: "never", sandbox: "danger-full-access", config,
        });
        this.meta.threadId = result.thread.id; this.model ||= result.model || result.thread.model; this.runtimeModel = this.model;
        this.persist(); this.emit({ t: "init", sessionId: this.id, cwd: this.cwd, model: this.model || "" });
        this.emit({ t: "settings", settings: this.settings });
      } catch (error) { this.client = undefined; client.close(); throw error; }
    })().finally(() => { this.booting = undefined; });
    return this.booting;
  }
  async run(text?: string, cid?: string): Promise<void> { if (text !== undefined) return this.enqueue(text, cid); await this.boot(); }
  send(text: string, cid?: string) { if (this.closed) throw new Error("Codex conversation is closed"); void this.enqueue(text, cid); }
  private enqueue(text: string, cid?: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex conversation is closed"));
    const generation = this.interruptGeneration;
    this.runStart = this.log.length;
    this.emit({ t: "user", text, ...(cid ? { cid } : {}) });
    if (!this.meta.first) { this.meta.first = text; this.meta.title = text.replace(/\s+/g, " ").slice(0, 80); this.persist(); }
    this.setPhase("starting");
    const next = this.queue.then(async () => {
      if (this.closed) return;
      try {
        if (this.client && this.runtimeModel !== this.model) { this.client.close(); this.client = undefined; }
        await this.boot();
        if (this.closed || generation !== this.interruptGeneration) { this.finish(); return; }
        const mode = /^\/(plan|default)\b\s*/.exec(text);
        if (mode) { this.meta.mode = mode[1] as "plan" | "default"; text = text.slice(mode[0].length) || (this.meta.mode === "plan" ? "Create a plan for the current task." : "Continue with the current task."); this.persist(); }
        this.turnStarted = Date.now(); this.tokenBaseline = this.tokenUsage?.total; this.lastUsage = undefined; this.streamed.clear(); this.tools.clear();
        const finished = new Promise<void>(resolve => { this.turnDone = resolve; });
        this.setPhase("waiting");
        const effort = this.settings.effortLevel || null;
        const result = await this.client!.request("turn/start", {
          threadId: this.meta.threadId, input: [{ type: "text", text, text_elements: [] }],
          model: this.model, effort, serviceTier: this.settings.fastMode ? "priority" : "default",
          ...(this.meta.mode ? { collaborationMode: { mode: this.meta.mode, settings: { model: this.model, reasoning_effort: effort, developer_instructions: null } } } : {}),
        });
        if (this.turnDone) { this.turnId = result.turn.id; if (generation !== this.interruptGeneration) await this.interrupt(); }
        await finished;
      } catch (error: any) { this.emit({ t: "error", message: error.message || String(error) }); this.finish(); }
    });
    this.queue = next.catch(() => {}); return next;
  }
  private finish() {
    this.turnId = undefined; this.setPhase("idle"); this.persist(); const done = this.turnDone; this.turnDone = undefined; done?.();
  }
  async interrupt() {
    this.interruptGeneration++;
    if (this.client && this.meta.threadId && this.turnId) await this.client.request("turn/interrupt", { threadId: this.meta.threadId, turnId: this.turnId });
  }
  close() {
    if (this.closed) return;
    this.closed = true; for (const id of this.asks.keys()) this.answerAsk(id, "Cancelled");
    this.client?.close(); this.client = undefined; this.finish(); this.emit({ t: "closed" });
    conversations.delete(this.id);
  }
  async contextUsage(): Promise<any | null> {
    if (!this.tokenUsage) return null;
    const used = this.tokenUsage.last?.inputTokens || 0, max = this.tokenUsage.modelContextWindow || 0;
    return { total_tokens: used, raw_max_tokens: max, percentage: max ? 100 * used / max : null, categories: [] };
  }
  compact() {
    if (this.busy) throw new Error("Wait for the Codex turn to finish before compacting");
    void this.boot().then(() => this.client!.request("thread/compact/start", { threadId: this.meta.threadId })).catch(error => this.emit({ t: "error", message: error.message }));
  }
  async mcpStatus(): Promise<any[]> {
    await this.boot(); const result = await this.client!.request("mcpServerStatus/list", { threadId: this.meta.threadId, limit: 100 });
    return (result.data || []).map((server: any) => ({ name: server.name, status: ({ connected: "connected", authenticationRequired: "needs-auth", starting: "pending", notStarted: "pending", disabled: "disabled" } as any)[server.runtimeStatus] || "failed", ...(server.toolsError ? { error: server.toolsError } : {}) }));
  }
  async applyMcpServers(stored: Record<string, any>) {
    codexMcpConfig(stored); if (this.busy) throw new Error("Wait for the Codex turn to finish before changing MCP servers");
    this.mcpOverride = stored; this.restarting = true; this.client?.close(); this.client = undefined;
    try { await this.boot(); return { added: Object.keys(stored), removed: [], errors: [] }; } finally { this.restarting = false; }
  }
  async reconnectMcp(_name: string) { if (this.busy) throw new Error("Wait for the Codex turn to finish before reconnecting MCP"); await this.applyMcpServers(this.mcpOverride || (this.opts.mcpFile ? JSON.parse(readFileSync(this.opts.mcpFile, "utf8")) : {})); }
  async reloadSkills() { await this.boot(); return this.client!.request("skills/list", { cwds: [this.cwd], forceReload: true }); }
  async bootForRewind() { throw new Error("Codex edit-and-rerun is not supported; fork this conversation instead"); }
  async editTurn(_fork: string | null, _rewind: string | null, _text: string): Promise<any> { throw new Error("Codex edit-and-rerun is not supported; fork this conversation instead"); }
  private notification(method: string, p: any) {
    if (!p || p.threadId !== this.meta.threadId) return;
    if (method === "turn/started") { this.turnId = p.turn.id; this.setPhase("waiting"); }
    else if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
      this.streamed.add(p.itemId); this.setPhase("writing"); this.emit({ t: "text_delta", text: p.delta, bid: p.itemId });
    } else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      this.streamed.add(p.itemId); this.setPhase("thinking"); this.emit({ t: "thinking_delta", text: p.delta, bid: p.itemId });
    } else if (method === "item/started" || method === "item/completed") {
      this.item(p.item, method === "item/completed");
    } else if (method === "thread/tokenUsage/updated") {
      this.tokenUsage = p.tokenUsage;
      if (!this.tokenBaseline && this.turnDone && p.tokenUsage.total && p.tokenUsage.last) this.tokenBaseline = Object.fromEntries(Object.entries(p.tokenUsage.total).map(([key, value]) => [key, Math.max(0, Number(value) - (p.tokenUsage.last[key] || 0))]));
      this.emit({ t: "context", used: p.tokenUsage.last?.inputTokens || 0, max: p.tokenUsage.modelContextWindow || undefined });
    } else if (method === "thread/compacted") {
      this.emit({ t: "compacting", active: false }); this.emit({ t: "compact", trigger: "manual" }); this.setPhase("idle");
    } else if (method === "turn/completed") {
      const total = this.tokenUsage?.total;
      const u = total ? Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Math.max(0, Number(value) - (this.tokenBaseline?.[key] || 0))])) as any : this.tokenUsage?.last;
      if (u) this.lastUsage = { input: Math.max(0, u.inputTokens - (u.cachedInputTokens || 0)), output: u.outputTokens || 0, thinking: u.reasoningOutputTokens || 0, cacheRead: u.cachedInputTokens || 0, cacheCreate: u.cacheWriteInputTokens || 0, context: this.tokenUsage?.last?.inputTokens || 0, total: u.totalTokens || 0, costUsd: 0, durationMs: Date.now() - this.turnStarted };
      if (p.turn.error) this.emit({ t: "error", message: p.turn.error.message || "Codex turn failed" });
      this.emit({ t: "result", subtype: p.turn.status === "completed" ? "success" : p.turn.status, sessionId: this.id, costUsd: 0, ...(this.lastUsage ? { usage: this.lastUsage } : {}) });
      this.finish();
    } else if (method === "error") {
      this.emit({ t: "error", message: p.error?.message || p.message || "Codex error" });
      if (!p.willRetry) this.finish(); else this.setPhase("retrying");
    } else if (method === "thread/name/updated") {
      this.meta.title = p.threadName || p.name || this.meta.title; this.persist(); this.emit({ t: "title", title: this.meta.title });
    } else if (method === "model/rerouted") {
      this.model = p.toModel || this.model; this.persist(); if (this.model) this.emit({ t: "model", model: this.model });
    } else if (method === "item/mcpToolCall/progress") this.emit({ t: "notice", kind: "info", text: p.message || "MCP tool is running" });
  }
  private item(item: any, done: boolean) {
    if (!item) return;
    const id = item.id;
    if (["agentMessage", "plan", "reasoning"].includes(item.type)) {
      if (!done) return;
      if (!this.streamed.has(id)) {
        if (item.type === "reasoning") { const text = (item.summary?.length ? item.summary : item.content || []).join("\n"); if (text) this.emit({ t: "thinking", text, bid: id }); }
        else if (item.text) this.emit({ t: "text", text: item.text, bid: id });
      }
      this.emit({ t: "block_end", bid: id }); return;
    }
    if (item.type === "contextCompaction") {
      this.emit({ t: "compacting", active: !done }); this.setPhase(done ? "waiting" : "compacting");
      if (done) this.emit({ t: "compact", trigger: "auto" }); return;
    }
    let name: string, input: any, content: any;
    if (item.type === "commandExecution") { name = "Bash"; input = { command: item.command, cwd: item.cwd }; content = item.aggregatedOutput || `(exit ${item.exitCode ?? "unknown"})`; }
    else if (item.type === "fileChange") { name = "Edit"; input = { changes: item.changes }; content = item.changes; }
    else if (item.type === "mcpToolCall") { name = `mcp__${item.server}__${item.tool}`; input = item.arguments; content = item.error || item.result; }
    else if (item.type === "dynamicToolCall") { name = item.tool; input = item.arguments; content = item.contentItems; }
    else if (item.type === "webSearch") { name = "WebSearch"; input = { query: item.query, action: item.action }; content = item.action || item.query; }
    else if (item.type === "collabAgentToolCall") { name = item.tool; input = { prompt: item.prompt, agents: item.receiverThreadIds }; content = item.agentsStates; }
    else return;
    if (!this.tools.has(id)) { this.tools.add(id); this.emit({ t: "tool_start", id, name }); this.emit({ t: "tool_use", id, name, input }); }
    this.setPhase("tool");
    if (done) { this.emit({ t: "tool_result", id, content, isError: item.status === "failed" || !!item.error || (item.exitCode != null && item.exitCode !== 0) }); this.setPhase("waiting"); }
  }
  private async serverRequest(message: RpcMessage): Promise<any> {
    const p = message.params || {};
    if (p.threadId && p.threadId !== this.meta.threadId) throw new Error("Codex request belongs to an unknown thread");
    if (message.method === "item/tool/requestUserInput") {
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of p.questions || []) {
        if (q.isSecret) throw new Error("Secret answers are not supported in this chat");
        const answer = await this.ask(q.question, q.options || [], q.isOther || !q.options?.length);
        answers[q.id] = { answers: [answer] };
      }
      return { answers };
    }
    if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
      const answer = await this.ask(p.reason || p.command || "Allow Codex to apply this change?", [{ label: "Allow" }, { label: "Deny" }], false);
      return { decision: answer === "Allow" ? "accept" : "decline" };
    }
    if (message.method === "item/permissions/requestApproval") {
      const answer = await this.ask(p.reason || "Allow the requested Codex permissions?", [{ label: "Allow" }, { label: "Deny" }], false);
      return { permissions: answer === "Allow" ? p.permissions : {}, scope: "turn" };
    }
    if (message.method === "mcpServer/elicitation/request") {
      if (p.mode === "url") {
        const answer = await this.ask(`${p.message}\n${p.url}`, [{ label: "Completed" }, { label: "Cancel" }], false);
        return { action: answer === "Completed" ? "accept" : "cancel", content: null, _meta: null };
      }
      if (p.mode === "form" || p.mode === "openai/form" || p.mode === "openaiForm") {
        const content: Record<string, any> = {};
        for (const [key, schema] of Object.entries(p.requestedSchema?.properties || {}) as [string, any][]) {
          const answer = await this.ask(schema.description || schema.title || key, (schema.enum || []).map((v: any) => ({ label: String(v) })), true);
          content[key] = schema.type === "boolean" ? answer.toLowerCase() === "true" : ["integer", "number"].includes(schema.type) ? Number(answer) : answer;
        }
        return { action: "accept", content, _meta: null };
      }
      throw new Error(`Unsupported MCP elicitation mode: ${p.mode}`);
    }
    if (message.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
    if (message.method === "item/tool/call") return { success: false, contentItems: [{ type: "inputText", text: `Unsupported dynamic tool: ${p.tool}` }] };
    throw new Error(`Unsupported Codex request: ${message.method}`);
  }
}

export function getOrCreateCodex(key: string | null, opts: ConvOpts): CodexConversation {
  if (key && getCodex(key)) return getCodex(key)!;
  const id = key && ID.test(key) ? key : `codex-${randomUUID()}`;
  const conversation = new CodexConversation(id, opts); conversations.set(id, conversation); return conversation;
}
export function getCodex(id: string): CodexConversation | undefined { const c = conversations.get(id); return c && !c.isClosed ? c : undefined; }
export function codexLiveStatuses(): Record<string, LiveStatus> { return Object.fromEntries([...conversations].filter(([, c]) => !c.isClosed).map(([id, c]) => [id, c.statusInfo()])); }
export function codexLiveActivity(): { id: string; busy: boolean; waiting: boolean; activitySeq: number }[] { return [...conversations].filter(([, c]) => !c.isClosed).map(([id, c]) => ({ id, ...c.statusInfo(), activitySeq: c.activitySeq })); }
export function listCodexConversations(): { sessionId: string; path: string; project: string; mtime: number }[] {
  try { return readdirSync(stateDir()).filter(name => ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json")).flatMap(name => {
    const id = name.slice(0, -5), meta = loadMeta(id); if (!meta?.first) return [];
    return [{ sessionId: id, path: pathFor(id, "jsonl"), project: "codex", mtime: meta.updatedAt || statSync(pathFor(id)).mtimeMs }];
  }).sort((a, b) => b.mtime - a.mtime); } catch { return []; }
}
export function isCodexTranscriptPath(path: string): boolean { return /^codex-[a-f0-9-]{36}\.jsonl$/i.test(basename(path)); }
export function findCodexTranscript(id: string): { path: string; project: string } | null { return loadMeta(id) ? { path: pathFor(id, "jsonl"), project: "codex" } : null; }
export function codexMeta(idOrPath: string) { const meta = loadMeta(idOrPath); return meta ? { title: meta.title, cwd: meta.cwd, first: meta.first, model: meta.model, settings: meta.settings } : { title: "", cwd: "", first: "" }; }
export async function replayCodexTranscript(idOrPath: string): Promise<AppEvent[]> {
  const id = basename(idOrPath).replace(/\.(jsonl|json)$/, "");
  const events: AppEvent[] = [];
  const blocks = new Map<string, { t: "text" | "thinking"; text: string; bid?: string }>();
  for (const original of readEvents(id)) {
    if (["status", "busy", "closed", "ask", "ask_done", "settings"].includes(original.t)) continue;
    const { _seq, ...event } = original;
    if (event.t === "init") { events.push({ t: "model", model: event.model }); continue; }
    if (event.t === "text_delta" || event.t === "thinking_delta") {
      const kind = event.t === "text_delta" ? "text" : "thinking";
      const key = `${kind}:${event.bid || "default"}`;
      const existing = blocks.get(key);
      if (existing) existing.text += event.text;
      else { const block = { t: kind, text: event.text, ...(event.bid ? { bid: event.bid } : {}) }; blocks.set(key, block); events.push(block); }
    } else {
      // Completed aggregate blocks replace their streamed copy when both were recorded.
      if ((event.t === "text" || event.t === "thinking") && event.bid) {
        const existing = blocks.get(`${event.t}:${event.bid}`);
        if (existing) { existing.text = event.text; continue; }
      }
      events.push(event as AppEvent);
    }
  }
  return events;
}
export function deleteCodexConversation(id: string) {
  getCodex(id)?.close(); conversations.delete(id); rmSync(pathFor(id), { force: true }); rmSync(pathFor(id, "jsonl"), { force: true });
}
export async function forkCodexConversation(id: string): Promise<{ id: string }> {
  const meta = loadMeta(id); if (!meta?.threadId) throw new Error("Codex conversation has no persisted thread");
  const client = new CodexClient(meta.cwd);
  try {
    const result = await client.request("thread/fork", { threadId: meta.threadId, cwd: meta.cwd, model: meta.model });
    const forkId = `codex-${randomUUID()}`;
    saveMeta({ ...meta, id: forkId, threadId: result.thread.id, createdAt: Date.now(), updatedAt: Date.now() });
    const events = readEvents(id); if (events.length) writeFileSync(pathFor(forkId, "jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    return { id: forkId };
  } finally { client.close(); }
}
