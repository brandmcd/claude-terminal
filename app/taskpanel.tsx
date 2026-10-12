// taskpanel.tsx — the editable task list docked on the right of the desktop chat window.
//
// It shows the agent's current TodoWrite list (latestTodos in todos.tsx) and lets you edit it while
// the agent runs: tick or untick a task, reword it, remove it, add one. Edits stay a local draft
// until you press Send, which posts the revised list as a chat message. A message sent mid-turn is
// folded into the running turn (see the "result" case in app-runner.ts), so the agent sees it
// without stopping. The draft is kept until the agent writes a new list, so the panel does not snap
// back to the old one in between.
//
// Drafts live in memory per conversation and are lost on reload. Styles are injected from here,
// like todos.tsx, and reuse the styles.css variables.
import React, { useEffect, useRef, useState } from "react";
import { latestTodos, type Todo } from "./todos";

// #region draft model + message builder (pure, so they can be checked without a DOM)
// A draft row remembers which row of the agent's list it started as (`from`), so the change summary
// can say "reworded" or "marked done" instead of "removed one, added another".
export interface DraftTodo extends Todo { from?: number }

export function sameTodos(a: readonly Todo[], b: readonly Todo[]): boolean {
  return a.length === b.length && a.every((t, i) => t.content === b[i].content && t.status === b[i].status);
}

const box = (s: Todo["status"]) => (s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]");

// One line per change against the list the edits started from.
export function diffTodos(base: readonly Todo[], next: readonly DraftTodo[]): string[] {
  const out: string[] = [];
  const kept = new Set<number>();
  for (const t of next) {
    if (t.from === undefined || !base[t.from]) { out.push(`added: ${t.content}`); continue; }
    kept.add(t.from);
    const was = base[t.from];
    if (was.content !== t.content) out.push(`reworded: "${was.content}" -> "${t.content}"`);
    if (was.status !== t.status) {
      out.push(t.status === "completed" ? `marked done: ${t.content}` : was.status === "completed" ? `reopened: ${t.content}` : `set ${t.status.replace("_", " ")}: ${t.content}`);
    }
  }
  base.forEach((t, i) => { if (!kept.has(i)) out.push(`removed: ${t.content}`); });
  const order = next.filter((t) => t.from !== undefined).map((t) => t.from!);
  if (order.some((f, i) => i > 0 && f < order[i - 1])) out.push("reordered the list");
  return out;
}

export function buildTaskMessage(base: readonly Todo[], next: readonly DraftTodo[]): string {
  const list = next.length ? next.map((t) => `- ${box(t.status)} ${t.content}`).join("\n") : "(empty: drop the current list)";
  const changes = diffTodos(base, next);
  return [
    "I edited your task list in the side panel. Call TodoWrite with this list ([x] done, [~] in progress, [ ] pending), then carry on with the work it describes.",
    "",
    list,
    ...(changes.length ? ["", "Changes:", ...changes.map((c) => "- " + c)] : []),
  ].join("\n");
}
// #endregion

// #region collapsed state (persisted per device)
const COLLAPSED_LS = "ct-taskpanel-collapsed";
const loadCollapsed = () => { try { return localStorage.getItem(COLLAPSED_LS) === "1"; } catch { return false; } };
// #endregion

interface Draft { base: Todo[]; todos: DraftTodo[]; sent?: boolean }

export interface TaskPanelProps {
  items: { kind: string; name?: string; input?: unknown }[];
  convId: string | null;
  onSend: (text: string) => Promise<unknown>;
  // An unanswered ask_user card parks the turn inside the tool call, and a plain send waits behind
  // it until the turn ends, so Send is held until the question is answered.
  askOpen?: boolean;
}

export function TaskPanel({ items, convId, onSend, askOpen }: TaskPanelProps): React.JSX.Element {
  injectCss();
  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);
  useEffect(() => { try { localStorage.setItem(COLLAPSED_LS, collapsed ? "1" : "0"); } catch { /* */ } }, [collapsed]);
  const drafts = useRef(new Map<string, Draft>());
  const [, bump] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [adding, setAdding] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => { setEditing(null); setAdding(""); }, [convId]);

  const key = convId ?? "__new__";
  const agent = latestTodos(items) ?? [];
  let draft = drafts.current.get(key);
  // A sent draft is done once the agent writes a list other than the one the edits started from.
  if (draft?.sent && !sameTodos(agent, draft.base)) { drafts.current.delete(key); draft = undefined; }
  const shown: DraftTodo[] = draft ? draft.todos : agent.map((t, i) => ({ ...t, from: i }));
  const dirty = !!draft && !draft.sent && (!sameTodos(draft.todos, draft.base) || draft.todos.some((t, i) => t.from !== i));
  const stale = !!draft && !draft.sent && !sameTodos(agent, draft.base);

  const update = (fn: (todos: DraftTodo[]) => DraftTodo[]) => {
    const cur = drafts.current.get(key);
    const base = cur && !cur.sent ? cur.base : agent;
    const start = cur && !cur.sent ? cur.todos : agent.map((t, i) => ({ ...t, from: i }));
    drafts.current.set(key, { base, todos: fn(start) });
    bump((n) => n + 1);
  };
  const discard = () => { drafts.current.delete(key); setEditing(null); bump((n) => n + 1); };
  const cycle = (i: number) => update((ts) => ts.map((t, k) => (k === i ? { ...t, status: t.status === "completed" ? "pending" : "completed" } : t)));
  const remove = (i: number) => update((ts) => ts.filter((_, k) => k !== i));
  const move = (i: number, d: number) => update((ts) => {
    const j = i + d; if (j < 0 || j >= ts.length) return ts;
    const out = ts.slice(); [out[i], out[j]] = [out[j], out[i]]; return out;
  });
  const commitEdit = () => {
    if (editing === null) return;
    const i = editing, text = editText.trim();
    setEditing(null);
    if (!text) remove(i);
    else if (text !== shown[i]?.content) update((ts) => ts.map((t, k) => (k === i ? { ...t, content: text, activeForm: undefined } : t)));
  };
  const add = () => {
    const text = adding.trim(); if (!text) return;
    update((ts) => [...ts, { content: text, status: "pending" }]);
    setAdding("");
  };
  const send = async () => {
    const d = drafts.current.get(key); if (!d || sending) return;
    setSending(true);
    try {
      await onSend(buildTaskMessage(d.base, d.todos));
      if (convId) d.sent = true; else drafts.current.delete(key); // a new chat gets its real id on send
    } finally { setSending(false); bump((n) => n + 1); }
  };

  const done = shown.filter((t) => t.status === "completed").length;
  const active = agent.find((t) => t.status === "in_progress");

  if (collapsed) {
    return (
      <aside className="tp-panel tp-collapsed" aria-label="Tasks">
        <button type="button" className="tp-strip" onClick={() => setCollapsed(false)} title="Show tasks" aria-expanded={false}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span className="tp-strip-label">Tasks{shown.length ? ` ${done}/${shown.length}` : ""}</span>
          {dirty && <span className="tp-dot" title="Unsent edits" />}
        </button>
      </aside>
    );
  }

  return (
    <aside className="tp-panel" aria-label="Tasks">
      <div className="tp-head">
        <span className="tp-title">Tasks</span>
        {shown.length > 0 && <span className="tp-progress">{done}/{shown.length}</span>}
        <button type="button" className="tp-icon" onClick={() => setCollapsed(true)} title="Hide tasks" aria-label="Hide tasks" aria-expanded={true}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      {active && !dirty && <div className="tp-sub">{active.activeForm || active.content}</div>}
      <div className="tp-well">
      {shown.length > 0 ? <ul className="tp-list">
        {shown.map((t, i) => (
          <li key={i} className={"tp-item tp-" + t.status}>
            <button type="button" className="tp-check" onClick={() => cycle(i)} title={t.status === "completed" ? "Mark not done" : "Mark done"} aria-label={t.status === "completed" ? "Mark not done" : "Mark done"}>
              {t.status === "completed" ? "✓" : t.status === "in_progress" ? <span className="tp-run" /> : ""}
            </button>
            {editing === i ? (
              <input className="tp-edit" autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} onBlur={commitEdit}
                onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); else if (e.key === "Escape") setEditing(null); }} />
            ) : (
              <span className="tp-text" onClick={() => { setEditing(i); setEditText(t.content); }} title="Click to edit">
                {t.status === "in_progress" && t.activeForm && !draft ? t.activeForm : t.content}
              </span>
            )}
            <span className="tp-row-btns">
              <button type="button" className="tp-icon" onClick={() => move(i, -1)} disabled={i === 0} title="Move up" aria-label="Move up">↑</button>
              <button type="button" className="tp-icon" onClick={() => move(i, 1)} disabled={i === shown.length - 1} title="Move down" aria-label="Move down">↓</button>
              <button type="button" className="tp-icon" onClick={() => remove(i)} title="Remove" aria-label="Remove">×</button>
            </span>
          </li>
        ))}
      </ul> : (
        <div className="tp-empty">
          <div className="tp-empty-title">No tasks yet</div>
          <div>The agent lists its steps here on longer jobs. You can add your own below.</div>
        </div>
      )}
      </div>
      <input className="tp-add" placeholder="Add a task…" value={adding} onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
      {stale && <div className="tp-note">The agent changed its list after you started editing. Sending replaces its list with yours.</div>}
      {draft?.sent && <div className="tp-note">Sent. Waiting for the agent to update its list.</div>}
      {dirty && (
        <div className="tp-foot">
          <button type="button" className="tp-send" onClick={send} disabled={sending || askOpen} title={askOpen ? "Answer the open question first" : "Send the edited list to the agent"}>
            {sending ? "Sending…" : "Send to agent"}
          </button>
          <button type="button" className="tp-discard" onClick={discard}>Discard</button>
        </div>
      )}
    </aside>
  );
}

// #region injected styles
let cssDone = false;
function injectCss() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const css = `
  .tp-panel{flex:0 0 280px;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--line);background:var(--bg-2);font-family:var(--font);color:var(--text);overflow:hidden}
  .tp-panel.tp-collapsed{flex:0 0 30px}
  .tp-strip{flex:1;display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px 0;background:transparent;border:0;cursor:pointer;color:var(--text-2);font-family:inherit}
  .tp-strip:hover{background:var(--bg-3)}
  .tp-strip-label{writing-mode:vertical-rl;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
  .tp-dot{width:7px;height:7px;border-radius:50%;background:var(--warning,#F59E0B)}
  .tp-head{display:flex;align-items:center;gap:8px;padding:10px 10px 8px 14px;border-bottom:1px solid var(--line-2)}
  .tp-title{font-size:13px;font-weight:600}
  .tp-head .tp-icon{margin-left:auto}
  .tp-progress{flex:1;font-size:12px;font-weight:600;color:var(--text-3);font-variant-numeric:tabular-nums}
  .tp-sub{padding:6px 14px;font-size:12px;color:var(--text-3);border-bottom:1px solid var(--line-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tp-well{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column}
  .tp-list{list-style:none;margin:0;padding:6px}
  .tp-item{display:flex;align-items:flex-start;gap:8px;padding:5px 6px;border-radius:6px;font-size:13px;line-height:1.45;color:var(--text-2)}
  .tp-item:hover{background:var(--bg-3)}
  .tp-check{flex:0 0 auto;width:16px;height:16px;margin-top:2px;padding:0;display:grid;place-items:center;border:1.5px solid var(--line);border-radius:4px;background:var(--bg);color:var(--success,#10B981);font-size:11px;font-weight:700;line-height:1;cursor:pointer}
  .tp-completed .tp-check{border-color:var(--success,#10B981)}
  .tp-in_progress .tp-check{border-color:var(--warning,#F59E0B)}
  .tp-run{width:6px;height:6px;border-radius:50%;background:var(--warning,#F59E0B)}
  .tp-text{flex:1;min-width:0;word-break:break-word;cursor:text}
  .tp-in_progress .tp-text{color:var(--text);font-weight:500}
  .tp-completed .tp-text{text-decoration:line-through;color:var(--text-3)}
  .tp-edit{flex:1;min-width:0;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 4px}
  .tp-row-btns{flex:0 0 auto;display:flex;visibility:hidden}
  .tp-item:hover .tp-row-btns,.tp-item:focus-within .tp-row-btns{visibility:visible}
  .tp-icon{flex:0 0 auto;width:20px;height:20px;padding:0;display:grid;place-items:center;background:transparent;border:0;border-radius:4px;color:var(--text-3);cursor:pointer;font-size:13px}
  .tp-icon:hover:not(:disabled){background:var(--bg-3);color:var(--text)}
  .tp-icon:disabled{opacity:.3;cursor:default}
  .tp-empty{margin:auto;padding:16px 20px;max-width:220px;text-align:center;font-size:12px;line-height:1.5;color:var(--text-3)}
  .tp-empty-title{font-size:13px;font-weight:600;color:var(--text-2);margin-bottom:4px}
  .tp-add{margin:4px 10px 8px;font:inherit;font-size:13px;color:var(--text);background:var(--bg);border:1px dashed var(--line);border-radius:6px;padding:5px 8px}
  .tp-note{margin:0 10px 8px;font-size:12px;line-height:1.45;color:var(--text-3)}
  .tp-foot{display:flex;gap:8px;padding:8px 10px;border-top:1px solid var(--line-2)}
  .tp-send,.tp-discard{font:inherit;font-size:12.5px;font-weight:600;padding:5px 10px;border-radius:6px;cursor:pointer}
  .tp-send{flex:1;background:var(--accent,#D97757);color:#fff;border:1px solid transparent}
  .tp-send:disabled{opacity:.5;cursor:default}
  .tp-discard{background:transparent;color:var(--text-2);border:1px solid var(--line)}
  /* Retro (the only theme the desktop renders): silver chrome, the list on a white sunken well like
     the sidebar's conversation list, square raised buttons, Win95 checkboxes. */
  body.theme-retro .tp-panel{background:var(--bg);border-left:0;box-shadow:inset 1px 0 0 #fff,inset 2px 0 0 #dfdfdf}
  body.theme-retro .tp-strip:hover{background:var(--bg)}
  body.theme-retro .tp-strip:active{box-shadow:var(--win-sunken)}
  body.theme-retro .tp-strip,body.theme-retro .tp-title,body.theme-retro .tp-progress{color:#000}
  body.theme-retro .tp-dot{border-radius:0;background:#000080}
  body.theme-retro .tp-head{border-bottom:0;padding:8px 8px 6px 12px}
  body.theme-retro .tp-sub{border-bottom:0;padding:0 12px 6px;color:#000}
  body.theme-retro .tp-well{background:#fff;box-shadow:var(--win-sunken);margin:0 8px 8px}
  body.theme-retro .tp-list{padding:4px}
  body.theme-retro .tp-item{border-radius:0;color:#000;padding:3px 4px}
  body.theme-retro .tp-item:hover{background:transparent}
  body.theme-retro .tp-item:focus-within{background:#000080}
  body.theme-retro .tp-item:focus-within .tp-text,body.theme-retro .tp-item:focus-within .tp-icon{color:#fff}
  body.theme-retro .tp-text{color:#000}
  body.theme-retro .tp-completed .tp-text{color:#404040}
  body.theme-retro .tp-check,body.theme-retro .tp-completed .tp-check,body.theme-retro .tp-in_progress .tp-check{width:13px;height:13px;border:0;border-radius:0;background:#fff;box-shadow:var(--win-sunken);color:#000;font-size:10px}
  body.theme-retro .tp-run{border-radius:0;background:#000;width:5px;height:5px}
  body.theme-retro .tp-edit,body.theme-retro .tp-add{border:0;border-radius:0;background:#fff;box-shadow:var(--win-sunken);color:#000}
  body.theme-retro .tp-add{margin:0 8px 8px;padding:4px 6px}
  body.theme-retro .tp-edit{padding:1px 3px}
  body.theme-retro .tp-icon{border-radius:0;color:#000;width:18px;height:18px}
  body.theme-retro .tp-icon:hover:not(:disabled){background:var(--bg);box-shadow:var(--win-raised);color:#000}
  body.theme-retro .tp-icon:active:not(:disabled){box-shadow:var(--win-sunken)}
  body.theme-retro .tp-note{color:#000;margin:0 8px 8px;padding:0}
  body.theme-retro .tp-empty{color:#404040}
  body.theme-retro .tp-empty-title{color:#000}
  body.theme-retro .tp-foot{border-top:0;padding:0 8px 8px}
  body.theme-retro .tp-send,body.theme-retro .tp-discard{border:0;border-radius:0;background:var(--bg);color:#000;box-shadow:var(--win-raised);font-weight:400;padding:4px 10px}
  body.theme-retro .tp-send{outline:1px solid #000}
  body.theme-retro .tp-send:active:not(:disabled),body.theme-retro .tp-discard:active{box-shadow:var(--win-sunken)}
  body.theme-retro .tp-send:disabled{color:#808080;opacity:1;text-shadow:1px 1px 0 #fff}
  `;
  const el = document.createElement("style");
  el.id = "taskpanel-css";
  el.textContent = css;
  document.head.appendChild(el);
}
// #endregion
