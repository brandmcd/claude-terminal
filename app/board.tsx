// board.tsx: the team to-do board (FTC accounts, config appBoard). A list the whole team shares:
// anyone can add, edit, claim, finish or delete a task, and the team's Claude chats change the same
// list through the `team-todo` command (board.ts). The desktop shows it as the "Team To-Do" window,
// opened on every load; on a phone it is a strip under the top bar that opens a full-screen sheet.
//
// One PIN login is shared by the whole team, so the server cannot tell people apart. Each browser
// asks for a first name once and keeps it in localStorage; that name is what claims and edits carry.
// Styles are injected from here (like todos.tsx) with a "tb-" prefix and reuse the styles.css
// variables, so the board follows the retro, dark and light themes.
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";

// #region store: one poller shared by every component that shows the board
export type BoardItem = {
  id: string; text: string; note?: string; owner?: string; done: boolean; urgent?: boolean; due?: string;
  by: string; at: number; updated: number; updatedBy: string;
};
type Board = { items: BoardItem[]; rev: number };

const NAME_KEY = "ct-board-name";
const SEEN_KEY = "ct-board-seen";
let board: Board | null = null;
let error = "";
const subs = new Set<() => void>();
const emit = () => { snap = { board, error }; subs.forEach((f) => f()); };
let snap = { board, error };
let timer: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  try {
    const r = await fetch("/app/api/board", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    board = await r.json(); error = "";
  } catch (e: any) { error = "Could not load the board: " + (e?.message || e); }
  emit();
}

function subscribe(f: () => void) {
  subs.add(f);
  if (!timer) {
    void refresh();
    // Every 5 s while the tab is visible, so a teammate's change or Claude's shows up quickly.
    timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    document.addEventListener("visibilitychange", onVis);
  }
  return () => {
    subs.delete(f);
    if (!subs.size && timer) { clearInterval(timer); timer = null; document.removeEventListener("visibilitychange", onVis); }
  };
}
const onVis = () => { if (!document.hidden) void refresh(); };

export function useBoard() {
  return useSyncExternalStore(subscribe, () => snap);
}

export function myName(): string { try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; } }

async function send(op: Record<string, unknown>): Promise<string> {
  try {
    const r = await fetch("/app/api/board", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...op, who: myName() }),
    });
    const j = await r.json();
    if (!r.ok) return j.error || `HTTP ${r.status}`;
    board = j; error = ""; emit();
    return "";
  } catch (e: any) { return String(e?.message || e); }
}

// Counts for badges: open tasks, open tasks nobody has claimed, and tasks someone else changed since
// this browser last looked at the board.
export function boardCounts(b: Board | null) {
  const items = b?.items || [];
  const open = items.filter((i) => !i.done);
  let seen = 0; try { seen = +(localStorage.getItem(SEEN_KEY) || 0); } catch { /* */ }
  const me = myName().toLowerCase();
  return {
    open: open.length,
    unclaimed: open.filter((i) => !i.owner).length,
    urgent: open.filter((i) => i.urgent).length,
    fresh: items.filter((i) => i.updated > seen && i.updatedBy.toLowerCase() !== me).length,
  };
}
// #endregion

// #region helpers
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function dueLabel(due: string): { text: string; cls: string } {
  const days = Math.round((new Date(due + "T00:00").getTime() - new Date(today() + "T00:00").getTime()) / 86_400_000);
  if (days < 0) return { text: `${-days}d overdue`, cls: "tb-due-late" };
  if (days === 0) return { text: "due today", cls: "tb-due-soon" };
  if (days === 1) return { text: "due tomorrow", cls: "tb-due-soon" };
  const d = new Date(due + "T00:00");
  return { text: "due " + d.toLocaleDateString(undefined, { weekday: days < 7 ? "short" : undefined, month: "short", day: "numeric" }), cls: "" };
}
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const order = (a: BoardItem, b: BoardItem) =>
  (+!!b.urgent - +!!a.urgent) || (a.due || "9999").localeCompare(b.due || "9999") || a.at - b.at;
// #endregion

// #region the board body
export function TeamBoard() {
  injectCss();
  const { board: b, error: loadErr } = useBoard();
  const [name, setName] = useState(myName);
  const [nameDraft, setNameDraft] = useState("");
  const [askName, setAskName] = useState(false);
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [due, setDue] = useState("");
  const [tab, setTab] = useState<"open" | "mine" | "done">("open");
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  // Rows someone else changed since the last visit stay marked for this whole visit.
  const [seenAt] = useState(() => { try { return +(localStorage.getItem(SEEN_KEY) || 0); } catch { return 0; } });
  // Marked only while the board is on screen: the desktop keeps a minimized or closed window mounted.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mark = () => {
      const el = rootRef.current;
      if (!el || document.hidden || !(el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null)) return;
      try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* */ }
    };
    mark();
    const t = setInterval(mark, 10_000);
    return () => clearInterval(t);
  }, []);

  const needName = !name;
  const run = async (op: Record<string, unknown>) => {
    if (needName) { setAskName(true); return false; }
    const e = await send(op);
    setErr(e);
    return !e;
  };
  const saveName = () => {
    const n = nameDraft.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!n) return;
    try { localStorage.setItem(NAME_KEY, n); } catch { /* */ }
    setName(n); setAskName(false); setNameDraft("");
  };
  const add = async () => {
    if (!text.trim()) return;
    if (await run({ op: "add", text, urgent, due: due || undefined })) { setText(""); setUrgent(false); setDue(""); }
  };

  const items = b?.items || [];
  const me = name.toLowerCase();
  const open = items.filter((i) => !i.done).sort(order);
  const mine = open.filter((i) => i.owner && i.owner.toLowerCase() === me);
  const done = items.filter((i) => i.done).sort((x, y) => y.updated - x.updated);
  const grabs = open.filter((i) => !i.owner);
  const claimed = open.filter((i) => i.owner);

  const row = (i: BoardItem) => (
    <BoardRow key={i.id} item={i} me={me} fresh={i.updated > seenAt && i.updatedBy.toLowerCase() !== me}
      editing={editing === i.id} onEdit={(on) => setEditing(on ? i.id : null)} run={run} />
  );

  return (
    <div className="tb-root" ref={rootRef}>
      <div className="tb-head">
        <div className="tb-title">Team To-Do</div>
        <div className="tb-who">
          {name && !askName ? <>You are <b>{name}</b> <button type="button" className="tb-link" onClick={() => { setNameDraft(name); setAskName(true); }}>change</button></> : null}
        </div>
      </div>

      {(needName || askName) && (
        <form className="tb-name" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
          <span>{needName ? "Type your first name so teammates can see who claimed what:" : "Your name:"}</span>
          <input autoFocus value={nameDraft} maxLength={40} placeholder="First name" onChange={(e) => setNameDraft(e.target.value)} />
          <button type="submit" className="tb-btn tb-primary" disabled={!nameDraft.trim()}>Save</button>
          {!needName && <button type="button" className="tb-btn" onClick={() => setAskName(false)}>Cancel</button>}
        </form>
      )}

      <form className="tb-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input className="tb-add-text" value={text} maxLength={300} placeholder="Add a task for the team…" onChange={(e) => setText(e.target.value)} />
        <div className="tb-add-opts">
          <label className={"tb-chip" + (urgent ? " tb-chip-on" : "")} title="Mark urgent">
            <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> Urgent
          </label>
          <input type="date" className="tb-date" value={due} onChange={(e) => setDue(e.target.value)} title="Due date (optional)" />
          <button type="submit" className="tb-btn tb-primary" disabled={!text.trim()}>Add</button>
        </div>
      </form>

      {(err || loadErr) && <div className="tb-err">{err || loadErr}</div>}

      <div className="tb-tabs">
        <button type="button" className={tab === "open" ? "tb-tab-on" : ""} onClick={() => setTab("open")}>Open ({open.length})</button>
        <button type="button" className={tab === "mine" ? "tb-tab-on" : ""} onClick={() => setTab("mine")}>Mine ({mine.length})</button>
        <button type="button" className={tab === "done" ? "tb-tab-on" : ""} onClick={() => setTab("done")}>Done ({done.length})</button>
      </div>

      <div className="tb-list">
        {!b && !loadErr && <div className="tb-empty">Loading…</div>}
        {b && tab === "open" && (open.length === 0
          ? <div className="tb-empty">Nothing open. Add a task above, or ask Claude to add some.</div>
          : <>
              {grabs.length > 0 && <div className="tb-group">Up for grabs ({grabs.length})</div>}
              {grabs.map(row)}
              {claimed.length > 0 && <div className="tb-group">Claimed ({claimed.length})</div>}
              {claimed.map(row)}
            </>)}
        {b && tab === "mine" && (mine.length === 0
          ? <div className="tb-empty">{name ? "You have not claimed anything. Pick a task under Open and press Claim." : "Set your name first."}</div>
          : mine.map(row))}
        {b && tab === "done" && (done.length === 0
          ? <div className="tb-empty">No finished tasks yet.</div>
          : <>
              {done.map(row)}
              <button type="button" className="tb-btn tb-clear" onClick={() => { if (window.confirm(`Remove all ${done.length} finished tasks from the board?`)) void run({ op: "clearDone" }); }}>Clear finished</button>
            </>)}
      </div>
    </div>
  );
}

function BoardRow({ item: i, me, fresh, editing, onEdit, run }: {
  item: BoardItem; me: string; fresh: boolean; editing: boolean;
  onEdit: (on: boolean) => void; run: (op: Record<string, unknown>) => Promise<boolean>;
}) {
  const [t, setT] = useState(i.text);
  const [n, setN] = useState(i.note || "");
  const [d, setD] = useState(i.due || "");
  useEffect(() => { if (editing) { setT(i.text); setN(i.note || ""); setD(i.due || ""); } }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const isMine = !!i.owner && i.owner.toLowerCase() === me;
  const dl = i.due && !i.done ? dueLabel(i.due) : null;
  const save = async () => { if (await run({ op: "edit", id: i.id, text: t, note: n, due: d })) onEdit(false); };

  return (
    <div className={"tb-row" + (i.done ? " tb-row-done" : "") + (i.urgent && !i.done ? " tb-row-urgent" : "") + (fresh ? " tb-row-fresh" : "")}>
      <input type="checkbox" className="tb-check" checked={i.done} title={i.done ? "Mark not done" : "Mark done"}
        onChange={(e) => void run({ op: "done", id: i.id, done: e.target.checked })} />
      <div className="tb-main">
        {editing ? (
          <form className="tb-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <input autoFocus value={t} maxLength={300} onChange={(e) => setT(e.target.value)} />
            <textarea value={n} rows={2} placeholder="Notes (optional)" onChange={(e) => setN(e.target.value)} />
            <div className="tb-edit-foot">
              <input type="date" className="tb-date" value={d} onChange={(e) => setD(e.target.value)} />
              <button type="submit" className="tb-btn tb-primary">Save</button>
              <button type="button" className="tb-btn" onClick={() => onEdit(false)}>Cancel</button>
              <button type="button" className="tb-btn tb-danger" onClick={() => { if (window.confirm(`Delete "${i.text}"?`)) void run({ op: "delete", id: i.id }); }}>Delete</button>
            </div>
          </form>
        ) : (
          <>
            <div className="tb-text" onDoubleClick={() => onEdit(true)}>
              {fresh && <span className="tb-new">NEW</span>}
              {i.urgent && !i.done && <span className="tb-urgent">URGENT</span>}
              {i.text}
            </div>
            {i.note && <div className="tb-note">{i.note}</div>}
            <div className="tb-meta">
              {dl && <span className={"tb-due " + dl.cls}>{dl.text}</span>}
              <span>added by {i.by} {ago(i.at)}</span>
              {i.updatedBy !== i.by || i.updated - i.at > 1000 ? <span>· changed by {i.updatedBy} {ago(i.updated)}</span> : null}
            </div>
          </>
        )}
      </div>
      {!editing && (
        <div className="tb-side">
          {i.done ? (i.owner ? <span className="tb-owner">{i.owner}</span> : null)
            : i.owner ? <>
                <span className={"tb-owner" + (isMine ? " tb-owner-me" : "")} title={`Claimed by ${i.owner}`}>{i.owner}</span>
                <button type="button" className="tb-btn tb-small" onClick={() => void run({ op: "claim", id: i.id, owner: isMine ? "" : undefined })}
                  title={isMine ? "Give this task back" : `Take this over from ${i.owner}`}>{isMine ? "Release" : "Take over"}</button>
              </>
            : <button type="button" className="tb-btn tb-primary tb-small" onClick={() => void run({ op: "claim", id: i.id })}>Claim</button>}
          <button type="button" className="tb-btn tb-small" onClick={() => onEdit(true)} title="Edit, add notes, or delete">Edit</button>
          {!i.done && <button type="button" className={"tb-btn tb-small" + (i.urgent ? " tb-chip-on" : "")} title={i.urgent ? "Not urgent" : "Mark urgent"}
            onClick={() => void run({ op: "edit", id: i.id, urgent: !i.urgent })}>!</button>}
        </div>
      )}
    </div>
  );
}
// #endregion

// #region phone strip: a bar under the top bar that opens the board as a full-screen sheet
export function BoardStrip() {
  injectCss();
  const { board: b } = useBoard();
  const [open, setOpen] = useState(false);
  const c = boardCounts(b);
  // Open the sheet once per day on first load, so the list is seen before the chat.
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current || !b) return;
    shown.current = true;
    try { if (localStorage.getItem("ct-board-autoshow") !== today() && c.open) { localStorage.setItem("ct-board-autoshow", today()); setOpen(true); } } catch { /* */ }
  }, [b]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <button type="button" className={"tb-strip" + (c.fresh ? " tb-strip-fresh" : "")} onClick={() => setOpen(true)}>
        <span className="tb-strip-title">📋 Team To-Do</span>
        <span className="tb-strip-counts">
          {c.urgent > 0 && <span className="tb-pill tb-pill-red">{c.urgent} urgent</span>}
          <span className="tb-pill">{c.open} open</span>
          {c.unclaimed > 0 && <span className="tb-pill tb-pill-warn">{c.unclaimed} unclaimed</span>}
          {c.fresh > 0 && <span className="tb-pill tb-pill-new">{c.fresh} new</span>}
        </span>
      </button>
      {open && (
        <div className="tb-sheet">
          <div className="tb-sheet-bar">
            <button type="button" className="tb-btn" onClick={() => setOpen(false)}>Back to chat</button>
          </div>
          <TeamBoard />
        </div>
      )}
    </>
  );
}
// #endregion

// #region styles
let cssDone = false;
function injectCss() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const s = document.createElement("style");
  s.textContent = `
.tb-root{container-type:inline-size;height:100%;display:flex;flex-direction:column;background:var(--panel,#fff);color:var(--text,#000);font-size:13.5px;min-height:0;}
.tb-head{display:flex;align-items:baseline;gap:10px;padding:10px 12px 6px;background:var(--accent,#d97757);color:#fff;}
.tb-title{font-weight:800;font-size:17px;letter-spacing:.02em;}
.tb-who{margin-left:auto;font-size:12.5px;}
.tb-who .tb-link{color:#fff;}
.tb-link{background:none;border:0;padding:0;text-decoration:underline;cursor:pointer;color:inherit;font:inherit;}
.tb-name{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px;background:#fff6c2;color:#000;border-bottom:1px solid var(--line,#ccc);}
.tb-name input{flex:1 1 120px;min-width:0;}
.tb-add{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid var(--line,#ccc);}
.tb-add-text{flex:1 1 220px;min-width:0;}
.tb-add-opts{display:flex;gap:6px;align-items:center;}
.tb-root input:not([type=checkbox]),.tb-root textarea{font:inherit;font-size:14px;padding:5px 7px;border:1px solid var(--line,#999);border-radius:4px;background:var(--bg,#fff);color:var(--text,#000);}
.tb-btn{font:inherit;font-size:12.5px;padding:4px 10px;border:1px solid var(--line,#999);border-radius:4px;background:var(--bg-2,#eee);color:var(--text,#000);cursor:pointer;white-space:nowrap;}
.tb-btn:disabled{opacity:.5;cursor:default;}
.tb-primary{background:var(--accent,#d97757);border-color:var(--accent,#d97757);color:#fff;font-weight:600;}
.tb-danger{color:var(--danger,#c00);margin-left:auto;}
.tb-small{padding:2px 8px;font-size:12px;}
.tb-chip{display:inline-flex;align-items:center;gap:4px;font-size:12.5px;padding:3px 8px;border:1px solid var(--line,#999);border-radius:4px;cursor:pointer;}
.tb-chip input{margin:0;}
.tb-chip-on{background:var(--danger,#c00)!important;border-color:var(--danger,#c00)!important;color:#fff!important;}
.tb-err{padding:6px 12px;color:#fff;background:var(--danger,#c00);font-size:12.5px;}
.tb-tabs{display:flex;gap:2px;padding:6px 12px 0;border-bottom:1px solid var(--line,#ccc);}
.tb-tabs button{font:inherit;font-size:12.5px;padding:5px 12px;border:1px solid var(--line,#ccc);border-bottom:0;border-radius:5px 5px 0 0;background:var(--bg-2,#eee);color:var(--text-2,#333);cursor:pointer;}
.tb-tabs .tb-tab-on{background:var(--panel,#fff);color:var(--text,#000);font-weight:700;position:relative;top:1px;}
.tb-list{flex:1;overflow:auto;padding:4px 8px 12px;min-height:0;}
.tb-group{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3,#666);padding:10px 4px 4px;}
.tb-empty{padding:24px 8px;text-align:center;color:var(--text-3,#666);}
.tb-row{display:flex;gap:8px;align-items:flex-start;padding:8px 6px;border-bottom:1px solid var(--line-2,#e5e5e5);border-left:4px solid transparent;}
.tb-row-urgent{border-left-color:var(--danger,#c00);background:color-mix(in srgb,var(--danger,#c00) 8%,transparent);}
.tb-row-fresh{background:color-mix(in srgb,#ffd400 22%,transparent);}
.tb-row-done .tb-text{text-decoration:line-through;color:var(--text-3,#777);}
.tb-check{width:18px;height:18px;margin-top:1px;flex:0 0 auto;cursor:pointer;accent-color:var(--success,#10b981);}
.tb-main{flex:1;min-width:0;}
.tb-text{font-size:14px;line-height:1.35;word-wrap:break-word;}
.tb-note{font-size:12.5px;color:var(--text-2,#444);white-space:pre-wrap;margin-top:2px;}
.tb-meta{font-size:11.5px;color:var(--text-3,#777);margin-top:3px;display:flex;flex-wrap:wrap;gap:6px;}
.tb-due{font-weight:600;color:var(--text-2,#444);}
.tb-due-soon{color:var(--warning,#b45309);}
.tb-due-late{color:var(--danger,#c00);}
.tb-urgent,.tb-new{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.05em;padding:1px 5px;border-radius:3px;margin-right:6px;vertical-align:1px;}
.tb-urgent{background:var(--danger,#c00);color:#fff;}
.tb-new{background:#ffd400;color:#000;}
.tb-side{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:4px;max-width:46%;}
.tb-owner{font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--bg-3,#ddd);color:var(--text,#000);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.tb-owner-me{background:var(--success,#10b981);color:#fff;}
.tb-edit{display:flex;flex-direction:column;gap:5px;}
.tb-edit-foot{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.tb-clear{margin:12px auto 0;display:block;}
@container (max-width:520px){.tb-row{flex-wrap:wrap;}.tb-main{flex:1 1 calc(100% - 44px);}.tb-side{max-width:none;width:100%;justify-content:flex-start;padding-left:26px;}}
.tb-strip{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:0;border-bottom:1px solid var(--line,#ccc);background:color-mix(in srgb,var(--accent,#d97757) 16%,var(--panel,#fff));color:var(--text,#000);font:inherit;cursor:pointer;text-align:left;}
.tb-strip-fresh{animation:tb-pulse 1.6s ease-in-out 4;}
@keyframes tb-pulse{50%{background:color-mix(in srgb,#ffd400 45%,var(--panel,#fff));}}
.tb-strip-title{font-weight:800;font-size:14px;white-space:nowrap;}
.tb-strip-counts{display:flex;flex-wrap:wrap;gap:4px;margin-left:auto;justify-content:flex-end;}
.tb-pill{font-size:11.5px;font-weight:700;padding:2px 7px;border-radius:999px;background:var(--bg-3,#ddd);color:var(--text,#000);white-space:nowrap;}
.tb-pill-red{background:var(--danger,#c00);color:#fff;}
.tb-pill-warn{background:var(--warning,#f59e0b);color:#000;}
.tb-pill-new{background:#ffd400;color:#000;}
.tb-sheet{position:fixed;inset:0;z-index:5000;display:flex;flex-direction:column;background:var(--panel,#fff);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);}
.tb-sheet-bar{padding:6px 10px;border-bottom:1px solid var(--line,#ccc);}
.tb-sheet .tb-root{flex:1;}
.tb-sheet input:not([type=checkbox]),.tb-sheet textarea{font-size:16px!important;}
`;
  document.head.appendChild(s);
}
// #endregion
