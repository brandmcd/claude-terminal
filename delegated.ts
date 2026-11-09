import { listLaunchContexts } from "./provider-handoff";
import { listCodexDelegations } from "./codex-runner";
import { get } from "./app-runner";

export type Delegation = { id: string; parentSession?: string; agentDepth?: number; model?: string; launchAlias?: string };

// Resolve the temporary IDs used by MCP servers before Claude emits its session UUID.
// Saved aliases keep the relationship intact after a process restart.
export function delegationIndex(rows?: Delegation[], liveId = (id: string) => get(id)?.id) {
  rows ??= [
    ...listLaunchContexts().map(({ id, context }) => ({ id, ...context.options })),
    ...listCodexDelegations(),
  ];
  const aliases = new Map(rows.filter(r => r.launchAlias).map(r => [r.launchAlias!, r.id]));
  const canonical = (id: string) => liveId(id) || aliases.get(id) || id;
  const children = new Map<string, Delegation>();
  for (const row of rows) {
    if (row.parentSession || (row.agentDepth ?? 0) > 0)
      children.set(row.id, { ...row, parentSession: row.parentSession ? canonical(row.parentSession) : undefined });
  }
  return {
    children,
    descendants(parent: string) {
      const seen = new Set([canonical(parent)]);
      const result: Delegation[] = [];
      for (let changed = true; changed;) {
        changed = false;
        for (const row of children.values()) {
          if (!seen.has(row.id) && row.parentSession && seen.has(row.parentSession)) {
            seen.add(row.id); result.push(row); changed = true;
          }
        }
      }
      return result;
    },
  };
}
