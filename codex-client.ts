import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RpcMessage = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
type Listener = (method: string, params: any) => void;

export function codexExecutable(): string {
  const userBinary = join(homedir(), ".local", "bin", "codex");
  return process.env.CODEX_BIN || (existsSync(userBinary) ? userBinary : existsSync("/usr/lib/chatgpt/resources/codex") ? "/usr/lib/chatgpt/resources/codex" : "codex");
}

// App-server uses one JSON object per line. Authentication remains owned by the CLI.
export class CodexClient {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<Listener>();
  private ready?: Promise<void>;
  onRequest?: (message: RpcMessage) => Promise<any>;
  onExit?: (error: Error) => void;
  constructor(private cwd?: string, private extraArgs: string[] = []) {}

  onNotification(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.initialize();
    return this.ready;
  }
  private async initialize() {
    const child = this.process = spawn(codexExecutable(), ["app-server", "--listen", "stdio://", ...this.extraArgs], {
      cwd: this.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    // Consume stderr without forwarding configuration or authentication material into app logs.
    child.stderr.resume();
    let ended = false;
    const end = (error: Error) => {
      if (ended) return; ended = true;
      this.process = undefined; this.ready = undefined;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear(); this.onExit?.(error);
    };
    child.on("error", (error) => end(error));
    child.on("exit", (code, signal) => end(new Error(`Codex app-server exited (${signal || code})`)));
    child.stdin.on("error", (error) => end(error));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        if (message.id !== undefined) {
          void Promise.resolve().then(() => {
            if (!this.onRequest) throw new Error(`Unsupported Codex request: ${message.method}`);
            return this.onRequest(message);
          }).then(result => this.write({ id: message.id, result }), error => this.write({ id: message.id, error: { code: -32601, message: error.message } }));
        } else for (const fn of this.listeners) { try { fn(message.method, message.params); } catch {} }
        return;
      }
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
    await this.requestRaw("initialize", { clientInfo: { name: "claude_terminal", title: "Claude Terminal", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.write({ method: "initialized", params: {} });
  }
  private write(message: RpcMessage) {
    if (!this.process || this.process.stdin.destroyed) return;
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  private requestRaw(method: string, params: any = {}, timeoutMs = 30_000): Promise<any> {
    if (!this.process) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  async request(method: string, params: any = {}, timeoutMs?: number): Promise<any> {
    await this.start(); return this.requestRaw(method, params, timeoutMs);
  }
  close() {
    const child = this.process;
    if (!child) return;
    this.onExit = undefined;
    child.stdin.end(); child.kill("SIGTERM");
  }
}
