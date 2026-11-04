import { join } from "node:path";
import type { ConvOpts } from "./app-runner";

export function sharedMcpConfig(opts: ConvOpts, id: string, provider: string, model?: string): Record<string, any> {
  if (!opts.sharedTools) return {};
  return { "shared-work": { type: "stdio", command: process.execPath, args: [join(import.meta.dir, "shared-tools.ts")], env: {
    CT_APP_URL: opts.sharedTools.url, CT_OWNER: opts.sharedTools.owner, CT_VAULT_DIR: opts.sharedTools.vault,
    CT_AGENT_PROVIDER: provider, CT_AGENT_MODEL: model || provider, CT_PARENT_SESSION: id,
    CT_AGENT_DEPTH: String(opts.agentDepth || 0),
  } } };
}

export function sharedInstructions(provider: string, model?: string): string {
  return [
    `You are ${provider}, using model ${model || "selected by the user"}, in the owner's shared chat application.`,
    "Use shared-work agent_models to find available model IDs and map names such as Sol or Opus before delegation. Use shared-work agent_spawn when asked to delegate to a model from either provider. Select the exact model requested. Read its result with agent_status and report failures. Give each child a distinct task and avoid simultaneous edits to the same files.",
    "When the user explicitly asks for a phone call, use /usr/local/bin/claude-call and respect the existing quiet hours.",
    "The shared Obsidian vault is ~/vault. Read its AGENTS.md and _System/AI Rules.md before editing notes. Preserve all existing human and other-agent writing. Use shared-work vault_read followed by vault_append for additions or new notes. Supply the returned hash so a concurrent change is detected. On a conflict, reread and reconcile your addition; never overwrite the other writer's work.",
    "The shared tool records provider, model, session and content hashes outside the vault. Keep the vault's existing ai: none/assisted/generated metadata. Do not invent model tags or rewrite provenance on existing passages.",
    "For explicitly requested replacement of existing note text, acquire an isolated Git worktree and preserve the shared working tree's uncommitted changes. Do not reset, stash, rebase, commit or push someone else's pending changes.",
  ].join("\n");
}

export const richChatInstructions = [
  "You are replying in a rich chat interface. Use Markdown for prose, code fences for code, and Markdown images for plots and screenshots.",
  "Files under the working directory or the owner's home are served by the app. Link local file paths for downloads and images; do not upload files just to display them.",
  "HTML, SVG and React code fences can render as interactive artifacts. Match the user's requested output format.",
].join("\n");
