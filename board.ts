// board.ts: the team to-do board for FTC accounts. One JSON file per Unix user, read and written
// by the sidecar's /app/api/board routes (app-server.ts) and by the `team-todo` command that the
// team's Claude chats run. Both writers take the same mkdir lock and write through a temp file plus
// rename, so a student clicking in the page and Claude running the command cannot lose each other's
// change. Every change is one small operation on one item, never a whole-list replace.
//
// Run directly it is the CLI: `bun board.ts list`, `bun board.ts add "text"`, and so on
// (/usr/local/bin/team-todo wraps it).
import { homedir } from "os";
import { join, dirname } from "path";
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "fs";

export type BoardItem = {
  id: string;
  text: string;
  note?: string;
  owner?: string; // who claimed it; empty means up for grabs
  done: boolean;
  urgent?: boolean;
  due?: string; // YYYY-MM-DD
  by: string; // who added it
  at: number;
  updated: number;
  updatedBy: string;
};
export type Board = { items: BoardItem[]; rev: number };

export const BOARD_FILE = process.env.TEAM_TODO_FILE || join(homedir(), ".local", "state", "team-todo.json");
const LOCK = BOARD_FILE + ".lock";

export function readBoard(file = BOARD_FILE): Board {
  try {
    const b = JSON.parse(readFileSync(file, "utf8"));
    if (b && Array.isArray(b.items)) return { items: b.items, rev: +b.rev || 0 };
  } catch { /* missing or unreadable: start empty */ }
  return { items: [], rev: 0 };
}

function lock(): void {
  mkdirSync(dirname(BOARD_FILE), { recursive: true });
  const until = Date.now() + 5000;
  for (;;) {
    try { mkdirSync(LOCK); return; } catch { /* held */ }
    // A lock older than 10 s belongs to a writer that died mid-change.
    try { if (Date.now() - statSync(LOCK).mtimeMs > 10_000) { rmdirSync(LOCK); continue; } } catch { continue; }
    if (Date.now() > until) throw new Error("board is busy, try again");
    Bun.sleepSync(25);
  }
}

export type Op =
  | { op: "add"; text: string; note?: string; urgent?: boolean; due?: string; owner?: string }
  | { op: "edit"; id: string; text?: string; note?: string; urgent?: boolean; due?: string }
  | { op: "claim"; id: string; owner?: string } // owner defaults to the actor; "" releases it
  | { op: "done"; id: string; done: boolean }
  | { op: "delete"; id: string }
  | { op: "clearDone" };

const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanNote = (s: unknown) => String(s ?? "").trim().slice(0, 2000);
const cleanDue = (s: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? "")) ? String(s) : "");

// Find an item by full id or by a unique id prefix (the CLI prints 4-character ids).
export function findItem(b: Board, id: string): BoardItem | undefined {
  const exact = b.items.find((i) => i.id === id);
  if (exact) return exact;
  const hits = b.items.filter((i) => i.id.startsWith(id));
  return id && hits.length === 1 ? hits[0] : undefined;
}

// Apply one operation as `actor` and return the new board. Throws with a readable message.
export function applyOp(op: Op, actor: string): { board: Board; item?: BoardItem } {
  const who = clean(actor, 40) || "someone";
  lock();
  try {
    const b = readBoard();
    const now = Date.now();
    let item: BoardItem | undefined;
    if (op.op === "add") {
      const text = clean(op.text, 300);
      if (!text) throw new Error("text is empty");
      if (b.items.length >= 500) throw new Error("board is full (500 items); clear finished ones");
      let id = "";
      do id = Math.random().toString(36).slice(2, 8); while (b.items.some((i) => i.id.startsWith(id.slice(0, 4))));
      item = { id, text, done: false, by: who, at: now, updated: now, updatedBy: who };
      if (op.note) item.note = cleanNote(op.note);
      if (op.urgent) item.urgent = true;
      if (cleanDue(op.due)) item.due = cleanDue(op.due);
      if (op.owner) item.owner = clean(op.owner, 40);
      b.items.push(item);
    } else if (op.op === "clearDone") {
      b.items = b.items.filter((i) => !i.done);
    } else {
      item = findItem(b, op.id);
      if (!item) throw new Error(`no item ${op.id}`);
      if (op.op === "delete") b.items = b.items.filter((i) => i !== item);
      else {
        if (op.op === "edit") {
          if (op.text !== undefined) { const t = clean(op.text, 300); if (!t) throw new Error("text is empty"); item.text = t; }
          if (op.note !== undefined) { const n = cleanNote(op.note); if (n) item.note = n; else delete item.note; }
          if (op.urgent !== undefined) { if (op.urgent) item.urgent = true; else delete item.urgent; }
          if (op.due !== undefined) { const d = cleanDue(op.due); if (d) item.due = d; else delete item.due; }
        } else if (op.op === "claim") {
          const o = op.owner === undefined ? who : clean(op.owner, 40);
          if (o) item.owner = o; else delete item.owner;
        } else if (op.op === "done") item.done = !!op.done;
        item.updated = now; item.updatedBy = who;
      }
    }
    b.rev += 1;
    const tmp = `${BOARD_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(b, null, 1));
    renameSync(tmp, BOARD_FILE);
    return { board: b, item };
  } finally {
    try { rmdirSync(LOCK); } catch { /* */ }
  }
}

// #region CLI
const HELP = `team-todo: the team's shared to-do board (the "Team To-Do" window in the app).

  team-todo list [--all]               open items (--all includes finished ones)
  team-todo add "text" [--urgent] [--due YYYY-MM-DD] [--note "..."] [--for NAME]
  team-todo edit ID [--text "..."] [--note "..."] [--due YYYY-MM-DD|none] [--urgent|--not-urgent]
  team-todo claim ID [NAME]            NAME defaults to "Claude"
  team-todo release ID                 un-claim
  team-todo done ID | reopen ID
  team-todo delete ID
  team-todo clear-done                 remove every finished item

IDs are the 4-character codes that list prints. Changes show in the app within a few seconds.`;

function fmt(i: BoardItem): string {
  const bits = [i.done ? "[x]" : "[ ]", i.id.slice(0, 4), i.urgent ? "URGENT" : "", i.text];
  const tail = [i.owner ? `claimed by ${i.owner}` : "unclaimed", i.due ? `due ${i.due}` : "", `added by ${i.by}`].filter(Boolean).join(", ");
  return bits.filter(Boolean).join(" ") + `  (${tail})` + (i.note ? `\n      note: ${i.note.replace(/\n/g, "\n      ")}` : "");
}

function cli(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (["all", "urgent", "not-urgent"].includes(name)) flags[name] = true;
      else flags[name] = rest[++k] ?? "";
    } else pos.push(a);
  }
  const actor = "Claude";
  const s = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
  const show = (r: { item?: BoardItem }) => { if (r.item) console.log(fmt(r.item)); };
  switch (cmd) {
    case "list": case "ls": case undefined: {
      const items = readBoard().items.filter((i) => flags.all || !i.done);
      items.sort((a, b) => (+!!b.urgent - +!!a.urgent) || (a.due || "9").localeCompare(b.due || "9") || a.at - b.at);
      console.log(items.length ? items.map(fmt).join("\n") : "(board is empty)");
      return 0;
    }
    case "add":
      show(applyOp({ op: "add", text: pos.join(" "), note: s(flags.note), urgent: !!flags.urgent, due: s(flags.due), owner: s(flags.for) }, actor));
      return 0;
    case "edit": {
      const due = s(flags.due);
      show(applyOp({ op: "edit", id: pos[0] || "", text: s(flags.text), note: s(flags.note), due: due === "none" ? "" : due,
        urgent: flags.urgent ? true : flags["not-urgent"] ? false : undefined }, actor));
      return 0;
    }
    case "claim": show(applyOp({ op: "claim", id: pos[0] || "", owner: pos.slice(1).join(" ") || actor }, actor)); return 0;
    case "release": case "unclaim": show(applyOp({ op: "claim", id: pos[0] || "", owner: "" }, actor)); return 0;
    case "done": show(applyOp({ op: "done", id: pos[0] || "", done: true }, actor)); return 0;
    case "reopen": case "undone": show(applyOp({ op: "done", id: pos[0] || "", done: false }, actor)); return 0;
    case "delete": case "rm": applyOp({ op: "delete", id: pos[0] || "" }, actor); console.log("deleted"); return 0;
    case "clear-done": applyOp({ op: "clearDone" }, actor); console.log("cleared finished items"); return 0;
    case "help": case "-h": case "--help": console.log(HELP); return 0;
    default: console.error(`unknown command: ${cmd}\n\n${HELP}`); return 2;
  }
}

if (import.meta.main) {
  try { process.exit(cli(process.argv.slice(2))); } catch (e: any) { console.error(`team-todo: ${e?.message || e}`); process.exit(1); }
}
// #endregion
