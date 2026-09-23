// desktop.tsx: the retro (Windows 95 style) desktop shell for /app on wide screens: a window
// manager wrapping the chat UI, terminal tabs, and the satellite pages (usage, morning brief,
// VS Code) as draggable windows, plus a taskbar, Start menu, desktop icons and Clawd wandering
// the taskbar edge. Self-contained: every style here is injected once (like clawd.tsx), scoped
// with a "dk-" prefix so nothing collides with the chat app's own classes. The Win95 bevels and
// palette mirror body.theme-retro in styles.css (read, not edited, by this file) via var()
// fallbacks, so the shell matches the chat window it wraps even if that stylesheet is absent.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clawd, Elapsed, confetti, fmtElapsed, type ClawdMood, type ClawdMove } from "./clawd";

// #region types (the contract main.tsx wires against)
export type DesktopTerminal = { id: string; title: string; state: string; since?: number };

type Rect = { x: number; y: number; w: number; h: number };
type WinState = Rect & { open: boolean; min: boolean; max: boolean; z: number; prev?: Rect };
type Layout = { wins: Record<string, WinState>; nextZ: number };
// #endregion

// #region ids + small pure helpers
const TERM_PREFIX = "tty:";
const isTerm = (id: string) => id.startsWith(TERM_PREFIX);
const termSid = (id: string) => id.slice(TERM_PREFIX.length);
const winIdFor = (sid: string) => TERM_PREFIX + sid;

const TASKBAR_H = 36; // + env(safe-area-inset-bottom), added in CSS only

// Default box for a window the first time it is ever opened (before any saved geometry exists).
const DEFAULTS: Record<string, { w: number; h: number; minW: number; minH: number }> = {
  claude: { w: 900, h: 720, minW: 420, minH: 320 },
  usage: { w: 760, h: 560, minW: 340, minH: 260 },
  brief: { w: 760, h: 560, minW: 340, minH: 260 },
  code: { w: 900, h: 640, minW: 420, minH: 300 },
  clawd: { w: 300, h: 260, minW: 240, minH: 220 },
  recycle: { w: 260, h: 150, minW: 220, minH: 130 },
  term: { w: 640, h: 420, minW: 320, minH: 200 },
};
const sizeFor = (id: string) => DEFAULTS[isTerm(id) ? "term" : id] ?? DEFAULTS.term;

function clampRect(r: Rect, minW: number, minH: number, vw: number, vh: number): Rect {
  const deskH = Math.max(minH, vh - TASKBAR_H);
  const w = Math.min(Math.max(r.w, minW), vw);
  const h = Math.min(Math.max(r.h, minH), deskH);
  const x = Math.min(Math.max(r.x, 0), Math.max(0, vw - w));
  const y = Math.min(Math.max(r.y, 0), Math.max(0, deskH - h));
  return { x, y, w, h };
}

const LS_KEY = "ct-desk-layout";
function defaultLayout(vw: number, vh: number): Layout {
  const d = DEFAULTS.claude;
  // x starts clear of the desktop-icon column (icons sit at 6..82px) so a first-run user can still
  // see and use them; the window is still "on the left" and near-full-height per spec.
  const rect = clampRect({ x: 92, y: 14, w: Math.round(vw * 0.62), h: vh - TASKBAR_H - 28 }, d.minW, d.minH, vw, vh);
  return { wins: { claude: { ...rect, open: true, min: false, max: false, z: 1 } }, nextZ: 1 };
}
function loadLayout(vw: number, vh: number): Layout {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Layout>;
      if (p && typeof p === "object" && p.wins && typeof p.wins === "object") {
        const wins: Record<string, WinState> = {};
        for (const [id, w] of Object.entries(p.wins)) {
          if (!w || typeof w !== "object") continue;
          const d = sizeFor(id);
          const max = !!w.max;
          // A maximized window refits to the current viewport rather than clamping its saved (old
          // viewport's) size, so it is still actually maximized after a resize between sessions.
          const rect = max
            ? { x: 0, y: 0, w: vw, h: vh - TASKBAR_H }
            : clampRect({ x: +w.x || 0, y: +w.y || 0, w: +w.w || d.w, h: +w.h || d.h }, d.minW, d.minH, vw, vh);
          const prev = w.prev && typeof w.prev === "object"
            ? clampRect({ x: +w.prev.x || 0, y: +w.prev.y || 0, w: +w.prev.w || d.w, h: +w.prev.h || d.h }, d.minW, d.minH, vw, vh)
            : undefined;
          wins[id] = { ...rect, open: !!w.open, min: !!w.min, max, z: +w.z || 0, prev };
        }
        // Renumber z to small consecutive integers so it cannot grow without bound across sessions
        // (it is persisted and bumped on every focus change).
        const ids = Object.keys(wins).sort((a, b) => wins[a].z - wins[b].z);
        ids.forEach((id, i) => { wins[id].z = i + 1; });
        if (wins.claude) return { wins, nextZ: ids.length };
      }
    }
  } catch { /* corrupt or unavailable storage: fall back to defaults */ }
  return defaultLayout(vw, vh);
}
function saveLayout(l: Layout) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(l)); } catch { /* private mode / quota: skip persistence */ }
}
// #endregion

// #region styles: one <style> tag, injected once, "dk-" prefixed
const CSS = `
.dk-desktop{position:fixed;inset:0;overflow:hidden;background:#008080;font-family:var(--font,Tahoma,"MS Sans Serif",Verdana,"Segoe UI",sans-serif);font-size:13px;color:#000;-webkit-user-select:none;user-select:none;}
.dk-desktop *{box-sizing:border-box;}
.dk-desktop.dk-interacting iframe{pointer-events:none;}
.dk-raised{box-shadow:var(--win-raised,inset -1px -1px 0 #0a0a0a,inset 1px 1px 0 #fff,inset -2px -2px 0 #808080,inset 2px 2px 0 #dfdfdf);}
.dk-sunken{box-shadow:var(--win-sunken,inset -1px -1px 0 #fff,inset 1px 1px 0 #0a0a0a,inset -2px -2px 0 #dfdfdf,inset 2px 2px 0 #808080);}

/* ---------- desktop icons ---------- */
.dk-icons{position:absolute;left:6px;top:6px;display:flex;flex-direction:column;gap:2px;}
.dk-icon{width:76px;background:transparent;border:1px dotted transparent;padding:5px 2px;display:flex;flex-direction:column;align-items:center;gap:4px;color:#fff;font-size:11.5px;line-height:1.25;text-shadow:1px 1px 0 #004040,-1px -1px 0 #004040,1px -1px 0 #004040,-1px 1px 0 #004040;}
.dk-icon-sel{background:rgba(0,0,128,.55);border-color:#fff;text-shadow:none;}
.dk-icon-glyph{width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-size:20px;line-height:0;}
.dk-icon-label{text-align:center;word-break:break-word;}

/* ---------- window frame ---------- */
.dk-win{position:absolute;background:#c0c0c0;display:flex;flex-direction:column;min-width:0;min-height:0;}
.dk-win.dk-hidden{display:none;}
.dk-titlebar{flex:0 0 auto;height:20px;display:flex;align-items:center;gap:4px;padding:0 3px;background:linear-gradient(90deg,#000080,#1084d0);touch-action:none;}
.dk-titlebar.dk-inactive{background:linear-gradient(90deg,#808080,#b5b5b5);}
.dk-tb-icon{flex:0 0 auto;width:15px;height:15px;display:flex;align-items:center;justify-content:center;font-size:12px;line-height:0;cursor:default;}
.dk-tb-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;font-weight:700;font-size:12px;cursor:default;}
.dk-titlebar.dk-inactive .dk-tb-text{color:#dcdcdc;}
.dk-tb-btns{flex:0 0 auto;display:flex;gap:2px;}
.dk-tbtn{width:16px;height:14px;padding:0;line-height:1;font-size:10px;font-weight:700;background:#c0c0c0;box-shadow:var(--win-raised,inset -1px -1px 0 #0a0a0a,inset 1px 1px 0 #fff,inset -2px -2px 0 #808080,inset 2px 2px 0 #dfdfdf);display:flex;align-items:center;justify-content:center;color:#000;}
.dk-tbtn:active{box-shadow:var(--win-sunken,inset -1px -1px 0 #fff,inset 1px 1px 0 #0a0a0a,inset -2px -2px 0 #dfdfdf,inset 2px 2px 0 #808080);}
.dk-body{flex:1;min-height:0;position:relative;overflow:hidden;background:#fff;}
.dk-body-visible{overflow:visible;}
.dk-body iframe{display:block;width:100%;height:100%;border:0;}
.dk-body-pad{padding:14px;font-size:12.5px;line-height:1.5;}
.dk-rs{position:absolute;}
.dk-rs-e{right:-2px;top:0;bottom:12px;width:5px;cursor:ew-resize;}
.dk-rs-s{left:0;right:12px;bottom:-2px;height:5px;cursor:ns-resize;}
.dk-rs-se{right:-1px;bottom:-1px;width:12px;height:12px;cursor:nwse-resize;background:repeating-linear-gradient(135deg,#808080 0 1px,transparent 1px 3px);}

/* ---------- Clawd.exe + Recycle bin bodies ---------- */
.dk-clawdexe{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:12px;}
.dk-clawdexe-btns{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;}
.dk-btn{padding:5px 12px;background:#c0c0c0;box-shadow:var(--win-raised,inset -1px -1px 0 #0a0a0a,inset 1px 1px 0 #fff,inset -2px -2px 0 #808080,inset 2px 2px 0 #dfdfdf);font-size:12px;color:#000;}
.dk-btn:active{box-shadow:var(--win-sunken,inset -1px -1px 0 #fff,inset 1px 1px 0 #0a0a0a,inset -2px -2px 0 #dfdfdf,inset 2px 2px 0 #808080);}
.dk-recycle{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#000;font-size:12.5px;}

/* ---------- taskbar ---------- */
.dk-taskbar{position:absolute;left:0;right:0;bottom:0;height:calc(${TASKBAR_H}px + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom);background:#c0c0c0;box-shadow:inset 0 1px 0 #fff;display:flex;align-items:center;gap:6px;padding-left:4px;padding-right:4px;z-index:5000;}
.dk-start{flex:0 0 auto;display:flex;align-items:center;gap:5px;height:26px;padding:0 8px;font-weight:700;font-size:12.5px;background:#c0c0c0;box-shadow:var(--win-raised,inset -1px -1px 0 #0a0a0a,inset 1px 1px 0 #fff,inset -2px -2px 0 #808080,inset 2px 2px 0 #dfdfdf);color:#000;}
.dk-start.dk-pressed,.dk-start:active{box-shadow:var(--win-sunken,inset -1px -1px 0 #fff,inset 1px 1px 0 #0a0a0a,inset -2px -2px 0 #dfdfdf,inset 2px 2px 0 #808080);}
.dk-tasklist{flex:1;min-width:0;display:flex;gap:3px;overflow-x:auto;height:26px;align-items:center;}
.dk-taskbtn{flex:0 1 160px;min-width:80px;max-width:160px;height:24px;display:flex;align-items:center;gap:5px;padding:0 6px;font-size:12px;background:#c0c0c0;box-shadow:var(--win-raised,inset -1px -1px 0 #0a0a0a,inset 1px 1px 0 #fff,inset -2px -2px 0 #808080,inset 2px 2px 0 #dfdfdf);color:#000;overflow:hidden;}
.dk-taskbtn.dk-focused{box-shadow:var(--win-sunken,inset -1px -1px 0 #fff,inset 1px 1px 0 #0a0a0a,inset -2px -2px 0 #dfdfdf,inset 2px 2px 0 #808080);}
.dk-taskbtn-ic{flex:0 0 auto;font-size:12px;line-height:0;display:flex;}
.dk-taskbtn-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}
.dk-taskbtn-mini{flex:0 0 auto;transform:scale(.6);transform-origin:right center;pointer-events:none;}
.dk-taskbtn-elapsed{flex:0 0 auto;font-size:10.5px;font-variant-numeric:tabular-nums;}
.dk-tray{flex:0 0 auto;display:flex;align-items:center;gap:6px;height:26px;}
.dk-well{height:22px;display:flex;align-items:center;gap:5px;padding:0 7px;font-size:11.5px;background:#c0c0c0;box-shadow:var(--win-sunken,inset -1px -1px 0 #fff,inset 1px 1px 0 #0a0a0a,inset -2px -2px 0 #dfdfdf,inset 2px 2px 0 #808080);color:#000;white-space:nowrap;}
.dk-well.dk-well-btn{cursor:pointer;}
.dk-clock{font-variant-numeric:tabular-nums;}
.dk-busy-pop{position:absolute;right:4px;bottom:${TASKBAR_H + 6}px;min-width:180px;background:#c0c0c0;box-shadow:var(--win-raised,inset -1px -1px 0 #0a0a0a,inset 1px 1px 0 #fff,inset -2px -2px 0 #808080,inset 2px 2px 0 #dfdfdf);padding:4px;z-index:6000;}
.dk-busy-row{width:100%;display:flex;justify-content:space-between;gap:10px;padding:4px 6px;font-size:12px;color:#000;}
.dk-busy-row:hover{background:#000080;color:#fff;}

/* ---------- context menus (window menu, start menu, taskbar right-click) ---------- */
.dk-menu{position:absolute;background:#c0c0c0;box-shadow:var(--win-raised,inset -1px -1px 0 #0a0a0a,inset 1px 1px 0 #fff,inset -2px -2px 0 #808080,inset 2px 2px 0 #dfdfdf);padding:2px;min-width:150px;z-index:9000;}
.dk-menu.dk-menu-embed{position:static;box-shadow:none;padding:0;min-width:0;}
.dk-mi{width:100%;display:flex;align-items:center;gap:8px;padding:5px 10px;font-size:12.5px;text-align:left;color:#000;position:relative;}
.dk-mi:hover,.dk-mi.dk-mi-open{background:#000080;color:#fff;}
.dk-mi-ic{flex:0 0 16px;display:flex;justify-content:center;font-size:13px;line-height:0;}
.dk-mi-arrow{margin-left:auto;font-size:10px;}
.dk-sep{height:1px;margin:3px 2px;box-shadow:var(--win-sunken,inset -1px -1px 0 #fff,inset 1px 1px 0 #0a0a0a,inset -2px -2px 0 #dfdfdf,inset 2px 2px 0 #808080);}
.dk-submenu{position:absolute;top:-2px;left:100%;}

/* ---------- start menu ---------- */
.dk-startmenu{position:absolute;left:2px;bottom:calc(${TASKBAR_H}px + env(safe-area-inset-bottom) + 3px);width:240px;display:flex;background:#c0c0c0;box-shadow:var(--win-raised,inset -1px -1px 0 #0a0a0a,inset 1px 1px 0 #fff,inset -2px -2px 0 #808080,inset 2px 2px 0 #dfdfdf);z-index:9000;}
.dk-startmenu-banner{flex:0 0 26px;background:linear-gradient(180deg,#000080,#1084d0);display:flex;align-items:flex-end;justify-content:center;padding-bottom:10px;}
.dk-startmenu-banner span{writing-mode:vertical-rl;transform:rotate(180deg);color:#fff;font-weight:700;font-size:15px;letter-spacing:.03em;}
.dk-startmenu-items{flex:1;padding:2px;min-width:0;}

/* ---------- pet ---------- */
.dk-pet{position:absolute;left:24px;bottom:calc(${TASKBAR_H}px + env(safe-area-inset-bottom));z-index:4000;line-height:0;}
.dk-pet-flip{display:inline-block;}
.dk-pet-bubble{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:4px;background:#ffffe1;box-shadow:var(--win-raised,inset -1px -1px 0 #0a0a0a,inset 1px 1px 0 #fff,inset -2px -2px 0 #808080,inset 2px 2px 0 #dfdfdf);padding:4px 8px;font-size:11.5px;white-space:nowrap;color:#000;}

/* ---------- shut down screen ---------- */
.dk-shutdown{position:fixed;inset:0;background:#ff8c00;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;z-index:20000;cursor:pointer;text-align:center;font-size:15px;}

/* ---------- focus outlines: dotted, Win95-style ---------- */
.dk-desktop button:focus-visible,.dk-desktop [tabindex]:focus-visible{outline:1px dotted #000;outline-offset:-3px;}

@media (max-width:1099px){.dk-taskbtn{flex-basis:120px;}}
`;
let injected = false;
function injectCss() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.id = "desktop-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
// #endregion

// #region sessions: poll GET /_ct/sessions every 3s, optimistic create/close
function useSessions(): {
  sessions: DesktopTerminal[];
  loaded: boolean;
  createSession: () => Promise<string>;
  closeSession: (id: string) => void;
  ensureKnown: (id: string) => void;
} {
  const [sessions, setSessions] = useState<DesktopTerminal[]>([]);
  // False until the first poll actually lands. The reconcile effect that drops terminal windows
  // for sessions gone from the list must wait for this, or it deletes every saved terminal window
  // on load (sessions starts empty, so an empty first render would otherwise read as "all closed").
  const [loaded, setLoaded] = useState(false);
  const optimistic = useRef<Map<string, DesktopTerminal>>(new Map());

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/_ct/sessions", { credentials: "same-origin" });
      if (!r.ok) return;
      const list = (await r.json()) as DesktopTerminal[];
      if (!Array.isArray(list)) return;
      for (const s of list) optimistic.current.delete(s.id);
      setSessions([...list, ...optimistic.current.values()]);
      setLoaded(true);
    } catch { /* offline / sidecar restarting: keep the last known list */ }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [poll]);

  const createSession = useCallback(async (): Promise<string> => {
    const r = await fetch("/_ct/sessions/new", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}",
    });
    const { id } = (await r.json()) as { id: string };
    const entry: DesktopTerminal = { id, title: "Terminal", state: "seen" };
    optimistic.current.set(id, entry);
    setSessions((s) => (s.some((x) => x.id === id) ? s : [...s, entry]));
    return id;
  }, []);

  const closeSession = useCallback((id: string) => {
    optimistic.current.delete(id);
    setSessions((s) => s.filter((x) => x.id !== id));
    fetch("/_ct/sessions/close", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
    }).catch(() => {});
  }, []);

  // Used to open a terminal window immediately when the poll has not returned that id yet.
  const ensureKnown = useCallback((id: string) => {
    setSessions((s) => {
      if (s.some((x) => x.id === id)) return s;
      const entry: DesktopTerminal = { id, title: "Terminal", state: "seen" };
      optimistic.current.set(id, entry);
      return [...s, entry];
    });
  }, []);

  return { sessions, loaded, createSession, closeSession, ensureKnown };
}
// #endregion

// #region small presentational pieces
function TinyClawd({ mood }: { mood: ClawdMood }) {
  return <Clawd size={0.7} mood={mood} className="dk-taskbtn-mini" title="" />;
}

// The busy/waiting indicator a taskbar button (or the tray) shows next to its label.
function BusyBadge({ state, since }: { state: string; since?: number | null }) {
  if (state === "thinking") return <><TinyClawd mood="walk" /><Elapsed since={since} className="dk-taskbtn-elapsed" /></>;
  if (state === "waiting") return <TinyClawd mood="needs" />;
  return null;
}

function DesktopIcon({ icon, label, onOpen }: { icon: React.ReactNode; label: string; onOpen: () => void }) {
  const [sel, setSel] = useState(false);
  const touch = useRef(false);
  return (
    <button
      type="button"
      className={"dk-icon" + (sel ? " dk-icon-sel" : "")}
      onPointerDown={(e) => { touch.current = e.pointerType === "touch"; setSel(true); }}
      onClick={() => { if (touch.current) onOpen(); }}
      onDoubleClick={onOpen}
      onBlur={() => setSel(false)}
    >
      <span className="dk-icon-glyph" aria-hidden>{icon}</span>
      <span className="dk-icon-label">{label}</span>
    </button>
  );
}

// A generic Win95 popup menu: a list of rows, some of which open a submenu. Closes on outside
// click or Escape (wired by the caller via `onClose`).
type MenuItem = { label: string; icon?: React.ReactNode; onClick?: () => void; sub?: MenuItem[]; disabled?: boolean };
function Menu({ items, style, embedded, onClose }: { items: MenuItem[]; style?: React.CSSProperties; embedded?: boolean; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <div className={"dk-menu" + (embedded ? " dk-menu-embed" : "")} style={style} onPointerDown={(e) => e.stopPropagation()}>
      {items.map((it, i) => (
        <div key={i} style={{ position: "relative" }}>
          <button
            type="button"
            className={"dk-mi" + (openSub === i ? " dk-mi-open" : "")}
            disabled={it.disabled}
            onClick={() => { if (it.sub) { setOpenSub(openSub === i ? null : i); return; } it.onClick?.(); onClose(); }}
            onMouseEnter={() => setOpenSub(it.sub ? i : null)}
          >
            <span className="dk-mi-ic">{it.icon}</span>
            <span>{it.label}</span>
            {it.sub && <span className="dk-mi-arrow">▸</span>}
          </button>
          {it.sub && openSub === i && (
            <div className="dk-submenu">
              <Menu items={it.sub} onClose={onClose} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
// #endregion

// #region the pet: a Clawd walking the taskbar edge
function Pet({ mood, danceKey }: { mood: ClawdMood; danceKey: number }) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const flipRef = useRef<HTMLDivElement | null>(null);
  const posRef = useRef(24);
  const dirRef = useRef<1 | -1>(1);
  const dancingRef = useRef(false); // pauses the walk loop; Clawd overlays its own dance visuals via danceKey
  const [bubble, setBubble] = useState<string | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moodRef = useRef(mood);
  moodRef.current = mood;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const SPEED = 30; // px/s at full walk
    const W = 22 * 2.4;
    const step = (t: number) => {
      raf = requestAnimationFrame(step);
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      if (document.hidden || dancingRef.current || moodRef.current === "sleep") return;
      const max = Math.max(0, window.innerWidth - W - 4);
      const rate = moodRef.current === "walk" ? 1 : 0.35;
      let x = posRef.current + SPEED * rate * dt * dirRef.current;
      let flipped = dirRef.current === -1;
      if (x <= 0) { x = 0; dirRef.current = 1; flipped = false; }
      else if (x >= max) { x = max; dirRef.current = -1; flipped = true; }
      posRef.current = x;
      if (outerRef.current) outerRef.current.style.left = x + "px";
      if (flipRef.current) flipRef.current.style.transform = flipped ? "scaleX(-1)" : "scaleX(1)";
    };
    raf = requestAnimationFrame(step);
    const onVis = () => { last = performance.now(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  const skipFirst = useRef(true);
  useEffect(() => {
    if (skipFirst.current) { skipFirst.current = false; return; }
    dancingRef.current = true;
    const t = setTimeout(() => { dancingRef.current = false; }, 2400);
    return () => clearTimeout(t);
  }, [danceKey]);

  const LINES = ["shipping it", "tests pass!", "one more tool call", "reading 40 files…", "need anything?"];
  const onTap = useCallback(() => {
    setBubble(LINES[Math.floor(Math.random() * LINES.length)]);
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    bubbleTimer.current = setTimeout(() => setBubble(null), 2200);
  }, []);
  useEffect(() => () => { if (bubbleTimer.current) clearTimeout(bubbleTimer.current); }, []);

  return (
    <div ref={outerRef} className="dk-pet" onPointerDownCapture={onTap}>
      {bubble && <div className="dk-pet-bubble">{bubble}</div>}
      <div ref={flipRef} className="dk-pet-flip">
        <Clawd size={2.4} mood={mood} danceKey={danceKey} move="d-hop" />
      </div>
    </div>
  );
}
// #endregion

// A self-contained Clawd.exe body: Hop / Wiggle / Shuffle / Spin / Party make the (large) Clawd
// dance. A fixed move per button avoids the shared round-robin so each button does what it says.
function ClawdExeBody() {
  const [danceKey, setDanceKey] = useState(0);
  const [move, setMove] = useState<ClawdMove>("d-hop");
  const go = (m: ClawdMove) => { setMove(m); setDanceKey((k) => k + 1); };
  return (
    <div className="dk-clawdexe">
      <Clawd size={7} mood="idle" danceKey={danceKey} move={move} />
      <div className="dk-clawdexe-btns">
        <button type="button" className="dk-btn" onClick={() => go("d-hop")}>Hop</button>
        <button type="button" className="dk-btn" onClick={() => go("d-wiggle")}>Wiggle</button>
        <button type="button" className="dk-btn" onClick={() => go("d-shuffle")}>Shuffle</button>
        <button type="button" className="dk-btn" onClick={() => go("d-spin")}>Spin</button>
        <button type="button" className="dk-btn" onClick={() => go("d-party")}>Party</button>
      </div>
    </div>
  );
}

// #region window frame
function WinFrame({
  id, icon, title, rect, z, min, max, focused, closable, resizable = true,
  bodyClassName, frameRef, onFocus, onClose, onMinimize, onMaxToggle, onMenu, onBeginMove, onBeginResize, children,
}: {
  id: string; icon: React.ReactNode; title: string; rect: Rect; z: number; min: boolean; max: boolean; focused: boolean;
  closable: boolean; resizable?: boolean; bodyClassName?: string;
  frameRef: (el: HTMLDivElement | null) => void;
  onFocus: () => void; onClose: () => void; onMinimize: () => void; onMaxToggle: () => void;
  onMenu: (e: React.MouseEvent) => void;
  onBeginMove: (e: React.PointerEvent) => void; onBeginResize: (e: React.PointerEvent, edge: "e" | "s" | "se") => void;
  children: React.ReactNode;
}) {
  const guardedMove = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".dk-tbtn, .dk-tb-icon")) return;
    onBeginMove(e);
  };
  const guardedDouble = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".dk-tbtn, .dk-tb-icon")) return;
    onMaxToggle();
  };
  return (
    <div
      ref={frameRef}
      className={"dk-win dk-raised" + (min ? " dk-hidden" : "")}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: z }}
      onPointerDown={onFocus}
      data-win={id}
    >
      <div
        className={"dk-titlebar" + (focused ? "" : " dk-inactive")}
        onPointerDown={guardedMove}
        onDoubleClick={guardedDouble}
        onContextMenu={(e) => { e.preventDefault(); onMenu(e); }}
      >
        <button type="button" className="dk-tb-icon" onClick={onMenu} title="System menu">{icon}</button>
        <span className="dk-tb-text">{title}</span>
        <span className="dk-tb-btns">
          <button type="button" className="dk-tbtn" title="Minimize" onClick={onMinimize}>_</button>
          <button type="button" className="dk-tbtn" title={max ? "Restore" : "Maximize"} onClick={onMaxToggle}>{max ? "❐" : "□"}</button>
          {closable && <button type="button" className="dk-tbtn" title="Close" onClick={onClose}>×</button>}
        </span>
      </div>
      <div className={"dk-body" + (bodyClassName ? " " + bodyClassName : "")}>{children}</div>
      {resizable && !max && (
        <>
          <div className="dk-rs dk-rs-e" onPointerDown={(e) => onBeginResize(e, "e")} />
          <div className="dk-rs dk-rs-s" onPointerDown={(e) => onBeginResize(e, "s")} />
          <div className="dk-rs dk-rs-se" onPointerDown={(e) => onBeginResize(e, "se")} />
        </>
      )}
    </div>
  );
}
// #endregion

// #region Desktop
export function Desktop(props: {
  chat: React.ReactNode;
  chatTitle: string;
  chatBusySince: number | null;
  chatWaiting: boolean;
  otherBusy: { id: string; title: string; since?: number }[];
  modelLabel: string;
  onModelClick: () => void;
  onOpenChat: (id: string) => void;
  finishedKey: number;
  openTerminalId?: string | null;
  onTheme: (t: "retro" | "dark" | "light") => void;
}): JSX.Element {
  injectCss();

  // ---- layout state (geometry, open/min/max, z-order) ----
  const [layout, setLayout] = useState<Layout>(() =>
    typeof window === "undefined" ? defaultLayout(1440, 900) : loadLayout(window.innerWidth, window.innerHeight));
  const [order, setOrder] = useState<string[]>(() => Object.keys(layout.wins));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const persist = useCallback((l: Layout) => { saveLayout(l); }, []);

  const patchWin = useCallback((id: string, patch: Partial<WinState>, persistNow = true) => {
    setLayout((l) => {
      const cur = l.wins[id];
      if (!cur) return l;
      const next = { ...l, wins: { ...l.wins, [id]: { ...cur, ...patch } } };
      if (persistNow) persist(next);
      return next;
    });
  }, [persist]);

  const focus = useCallback((id: string) => {
    setLayout((l) => {
      const cur = l.wins[id];
      if (!cur || !cur.open || cur.z === l.nextZ) return l;
      const z = l.nextZ + 1;
      const next = { wins: { ...l.wins, [id]: { ...cur, z } }, nextZ: z };
      persist(next);
      return next;
    });
  }, [persist]);

  // Create the window entry if this is the first time id has ever been opened (cascading its
  // default position so repeated new windows don't stack exactly on top of each other), then open
  // and focus it, all in one state update, so there is no gap where it exists but isn't shown.
  const openWinSafe = useCallback((id: string) => {
    setLayout((l) => {
      const cascade = Object.keys(l.wins).length;
      const vw = window.innerWidth, vh = window.innerHeight;
      const cur = l.wins[id];
      const d = sizeFor(id);
      const base = cur ?? clampRect({ x: 120 + (cascade % 6) * 26, y: 70 + (cascade % 6) * 24, w: d.w, h: d.h }, d.minW, d.minH, vw, vh);
      const z = l.nextZ + 1;
      const next = { wins: { ...l.wins, [id]: { ...base, open: true, min: false, max: cur?.max ?? false, z } }, nextZ: z };
      persist(next);
      return next;
    });
    setOrder((o) => (o.includes(id) ? o : [...o, id]));
  }, [persist]);

  const closeWin = useCallback((id: string) => { patchWin(id, { open: false, min: false }); }, [patchWin]);
  const minimizeWin = useCallback((id: string) => { patchWin(id, { min: true }); }, [patchWin]);
  const restoreWin = useCallback((id: string) => { focus(id); patchWin(id, { min: false }, false); }, [focus, patchWin]);
  const maxToggle = useCallback((id: string) => {
    setLayout((l) => {
      const cur = l.wins[id];
      if (!cur) return l;
      const vw = window.innerWidth, vh = window.innerHeight;
      const z = l.nextZ + 1;
      let w: WinState;
      if (cur.max) w = { ...cur, ...(cur.prev ?? cur), max: false, z };
      else w = { ...cur, x: 0, y: 0, w: vw, h: vh - TASKBAR_H, max: true, prev: { x: cur.x, y: cur.y, w: cur.w, h: cur.h }, z };
      const next = { wins: { ...l.wins, [id]: w }, nextZ: z };
      persist(next);
      return next;
    });
  }, [persist]);

  // click-anywhere-to-focus (toggle behavior lives in the taskbar handler)
  const onTaskbarClick = useCallback((id: string) => {
    const w = layoutRef.current.wins[id];
    if (!w || !w.open) { openWinSafe(id); return; }
    const topId = Object.entries(layoutRef.current.wins).filter(([, v]) => v.open && !v.min).sort((a, b) => b[1].z - a[1].z)[0]?.[0];
    if (w.min) restoreWin(id);
    else if (topId === id) minimizeWin(id);
    else focus(id);
  }, [openWinSafe, restoreWin, minimizeWin, focus]);

  // ---- drag / resize (direct DOM writes while dragging, committed to state on pointerup) ----
  const frameRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({});
  const [interacting, setInteracting] = useState(false);
  const dragRef = useRef<{ id: string; kind: "move" | "resize"; edge?: "e" | "s" | "se"; startX: number; startY: number; start: Rect; live: Rect } | null>(null);

  const applyLive = (id: string, r: Rect) => {
    const el = frameRefs.current[id];
    if (el) { el.style.left = r.x + "px"; el.style.top = r.y + "px"; el.style.width = r.w + "px"; el.style.height = r.h + "px"; }
  };

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    const vw = window.innerWidth, vh = window.innerHeight;
    const size = sizeFor(d.id);
    let r: Rect;
    if (d.kind === "move") {
      r = clampRect({ x: d.start.x + dx, y: d.start.y + dy, w: d.start.w, h: d.start.h }, size.minW, size.minH, vw, vh);
    } else {
      let w = d.start.w, h = d.start.h;
      if (d.edge === "e" || d.edge === "se") w = Math.max(size.minW, Math.min(vw - d.start.x, d.start.w + dx));
      if (d.edge === "s" || d.edge === "se") h = Math.max(size.minH, Math.min(vh - TASKBAR_H - d.start.y, d.start.h + dy));
      r = { x: d.start.x, y: d.start.y, w, h };
    }
    d.live = r;
    applyLive(d.id, r);
  }, []);

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setInteracting(false);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (!d) return;
    patchWin(d.id, { x: d.live.x, y: d.live.y, w: d.live.w, h: d.live.h });
  }, [onPointerMove, patchWin]);

  const beginMove = useCallback((id: string, e: React.PointerEvent) => {
    const w = layoutRef.current.wins[id];
    if (!w || w.max) { focus(id); return; }
    focus(id);
    dragRef.current = { id, kind: "move", startX: e.clientX, startY: e.clientY, start: { x: w.x, y: w.y, w: w.w, h: w.h }, live: { x: w.x, y: w.y, w: w.w, h: w.h } };
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* synthetic events in tests: no active pointer to capture */ }
    setInteracting(true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }, [focus, onPointerMove, onPointerUp]);

  const beginResize = useCallback((id: string, edge: "e" | "s" | "se", e: React.PointerEvent) => {
    const w = layoutRef.current.wins[id];
    if (!w) return;
    e.stopPropagation();
    focus(id);
    dragRef.current = { id, kind: "resize", edge, startX: e.clientX, startY: e.clientY, start: { x: w.x, y: w.y, w: w.w, h: w.h }, live: { x: w.x, y: w.y, w: w.w, h: w.h } };
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* synthetic events in tests */ }
    setInteracting(true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }, [focus, onPointerMove, onPointerUp]);

  // Reclamp every window into the viewport when it changes (rotation, browser resize).
  useEffect(() => {
    const onResize = () => {
      setLayout((l) => {
        const vw = window.innerWidth, vh = window.innerHeight;
        const wins: Record<string, WinState> = {};
        for (const [id, w] of Object.entries(l.wins)) {
          const size = sizeFor(id);
          if (w.max) wins[id] = { ...w, x: 0, y: 0, w: vw, h: vh - TASKBAR_H };
          else wins[id] = { ...w, ...clampRect(w, size.minW, size.minH, vw, vh) };
        }
        const next = { ...l, wins };
        persist(next);
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [persist]);

  // A click landing inside an iframe never bubbles to the host document, so title-bar/body
  // pointerdown handlers miss it. Catch that case via the window blur it causes instead.
  useEffect(() => {
    const onBlur = () => {
      setTimeout(() => {
        const ae = document.activeElement;
        for (const [id, el] of Object.entries(iframeRefs.current)) {
          if (el && ae === el) { focus(id); break; }
        }
      }, 0);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [focus]);

  // ---- sessions (terminal tabs) ----
  const { sessions, loaded: sessionsLoaded, createSession, closeSession, ensureKnown } = useSessions();

  const newTerminal = useCallback(async () => {
    const id = await createSession();
    openWinSafe(winIdFor(id));
  }, [createSession, openWinSafe]);

  const openTerminal = useCallback((sid: string) => {
    ensureKnown(sid);
    openWinSafe(winIdFor(sid));
  }, [ensureKnown, openWinSafe]);

  const endSession = useCallback((sid: string) => {
    if (!window.confirm("End this terminal session?")) return;
    closeSession(sid);
    setOrder((o) => o.filter((id) => id !== winIdFor(sid)));
    setLayout((l) => {
      if (!l.wins[winIdFor(sid)]) return l;
      const wins = { ...l.wins };
      delete wins[winIdFor(sid)];
      const next = { ...l, wins };
      persist(next);
      return next;
    });
  }, [closeSession, persist]);

  // Drop windows for terminals the poll no longer reports (closed elsewhere: tmux exited, etc).
  // Gated on the first poll landing: sessions starts empty, and reconciling against that would
  // read as "every saved terminal window closed" and wipe them all before the real list arrives.
  const sessionIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  useEffect(() => {
    if (!sessionsLoaded) return;
    setOrder((o) => {
      const next = o.filter((id) => !isTerm(id) || sessionIds.has(termSid(id)));
      return next.length === o.length ? o : next;
    });
    setLayout((l) => {
      let changed = false;
      const wins = { ...l.wins };
      for (const id of Object.keys(wins)) {
        if (isTerm(id) && !sessionIds.has(termSid(id))) { delete wins[id]; changed = true; }
      }
      if (!changed) return l;
      const next = { ...l, wins };
      persist(next);
      return next;
    });
  }, [sessionIds, sessionsLoaded, persist]);

  // Open (or optimistically create) the requested terminal window once, on mount.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (openedInitial.current || !props.openTerminalId) return;
    openedInitial.current = true;
    openTerminal(props.openTerminalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- keyboard: Escape closes menus, Ctrl+Alt+T opens a terminal ----
  const [startOpen, setStartOpen] = useState(false);
  const [shutdown, setShutdown] = useState(false);
  const [winMenu, setWinMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [taskMenu, setTaskMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [busyPop, setBusyPop] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setStartOpen(false); setWinMenu(null); setTaskMenu(null); setBusyPop(false); }
      else if (e.ctrlKey && e.altKey && (e.key === "t" || e.key === "T")) { e.preventDefault(); void newTerminal(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newTerminal]);

  // ---- pet mood: needs (someone waiting) beats walk (someone busy) beats idle/sleep ----
  const anyBusy = props.chatBusySince != null || props.otherBusy.length > 0 || sessions.some((s) => s.state === "thinking");
  const anyWaiting = props.chatWaiting || sessions.some((s) => s.state === "waiting");
  const idleSinceRef = useRef<number | null>(Date.now());
  if (anyBusy || anyWaiting) idleSinceRef.current = null;
  else if (idleSinceRef.current === null) idleSinceRef.current = Date.now();
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNowTick(Date.now()), 15000); return () => clearInterval(t); }, []);
  const sleepy = idleSinceRef.current != null && nowTick - idleSinceRef.current > 10 * 60_000;
  const petMood: ClawdMood = anyWaiting ? "needs" : anyBusy ? "walk" : sleepy ? "sleep" : "idle";

  // Confetti for a chat turn that ran long, tracked separately from the pet's own dance (whose
  // fixed "d-hop" move never fires confetti on its own; see Pet).
  const lastBusySince = useRef<number | null>(null);
  if (props.chatBusySince != null) lastBusySince.current = props.chatBusySince;
  const skipFirstFinish = useRef(true);
  useEffect(() => {
    if (skipFirstFinish.current) { skipFirstFinish.current = false; return; }
    const started = lastBusySince.current;
    if (started && Date.now() - started > 60_000) confetti();
  }, [props.finishedKey]);

  // ---- the clock ----
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(t); }, []);
  const clockLabel = useMemo(() => {
    let h = clock.getHours();
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${String(clock.getMinutes()).padStart(2, "0")} ${ap}`;
  }, [clock]);

  // ---- derived: which window is topmost/focused ----
  const focusedId = useMemo(() => {
    let best: string | null = null, bestZ = -1;
    for (const [id, w] of Object.entries(layout.wins)) if (w.open && !w.min && w.z > bestZ) { best = id; bestZ = w.z; }
    return best;
  }, [layout]);

  // ---- window titles + icons ----
  const winTitle = (id: string): string => {
    if (id === "claude") return props.chatTitle || "Claude";
    if (id === "usage") return "Usage";
    if (id === "brief") return "Morning brief";
    if (id === "code") return "VS Code";
    if (id === "clawd") return "Clawd.exe";
    if (id === "recycle") return "Recycle Bin";
    if (isTerm(id)) return sessions.find((s) => s.id === termSid(id))?.title || "Terminal";
    return id;
  };
  const winIcon = (id: string): React.ReactNode => {
    if (id === "claude") return "💬";
    if (id === "usage") return "📊";
    if (id === "brief") return "📰";
    if (id === "code") return "</>";
    if (id === "clawd") return <Clawd size={0.55} mood="idle" title="" />;
    if (id === "recycle") return "🗑️";
    if (isTerm(id)) return "⌨";
    return "🪟";
  };

  const openWindowMenuItems = (id: string): MenuItem[] => {
    const w = layout.wins[id];
    const items: MenuItem[] = [
      { label: "Minimize", onClick: () => minimizeWin(id) },
      { label: w?.max ? "Restore" : "Maximize", onClick: () => maxToggle(id) },
    ];
    if (isTerm(id)) items.push({ label: "End session", onClick: () => endSession(termSid(id)) });
    else if (id !== "claude") items.push({ label: "Close", onClick: () => closeWin(id) });
    return items;
  };

  // ---- render one window body by id ----
  const windowBody = (id: string): React.ReactNode => {
    if (id === "claude") return props.chat;
    if (id === "usage") return <iframe ref={(el) => { iframeRefs.current[id] = el; }} src="/usage/" title="Usage" />;
    if (id === "brief") return <iframe ref={(el) => { iframeRefs.current[id] = el; }} src="/brief/" title="Morning brief" />;
    if (id === "code") return <iframe ref={(el) => { iframeRefs.current[id] = el; }} src="/code/" title="VS Code" />;
    if (id === "clawd") return <ClawdExeBody />;
    if (id === "recycle") return <div className="dk-recycle"><span style={{ fontSize: 28 }}>🗑️</span><span>The Recycle Bin is empty.</span></div>;
    if (isTerm(id)) {
      const sid = termSid(id);
      return (
        <iframe
          ref={(el) => { iframeRefs.current[id] = el; }}
          src={`/tty/?arg=${encodeURIComponent(sid)}&embed=1`}
          title={winTitle(id)}
          allow="clipboard-read; clipboard-write; microphone"
        />
      );
    }
    return null;
  };

  const renderWindow = (id: string) => {
    const w = layout.wins[id];
    if (!w) return null;
    const closable = id === "claude" ? false : true;
    return (
      <WinFrame
        key={id}
        id={id}
        icon={winIcon(id)}
        title={winTitle(id)}
        rect={{ x: w.x, y: w.y, w: w.w, h: w.h }}
        z={w.z}
        min={w.min}
        max={w.max}
        focused={focusedId === id}
        closable={closable}
        bodyClassName={id === "claude" ? "dk-body-visible" : undefined}
        frameRef={(el) => { frameRefs.current[id] = el; }}
        onFocus={() => focus(id)}
        onClose={() => closeWin(id)}
        onMinimize={() => minimizeWin(id)}
        onMaxToggle={() => maxToggle(id)}
        onMenu={(e) => { e.stopPropagation(); focus(id); setWinMenu({ id, x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY }); }}
        onBeginMove={(e) => beginMove(id, e)}
        onBeginResize={(e, edge) => beginResize(id, edge, e)}
      >
        {windowBody(id)}
      </WinFrame>
    );
  };

  // ---- taskbar buttons: every id with open:true (minimized or not) ----
  const openIds = order.filter((id) => layout.wins[id]?.open);

  const startMenuItems: MenuItem[] = [
    { label: "Claude", icon: "💬", onClick: () => onTaskbarClick("claude") },
    { label: "New terminal", icon: "⌨", onClick: () => void newTerminal() },
    {
      label: "Terminals", icon: "🖥️",
      sub: sessions.length === 0
        ? [{ label: "(none running)", disabled: true }]
        : sessions.map((s) => ({
            label: `${s.title || "Terminal"} \u00b7 ${s.state}${s.state === "thinking" && s.since ? " " + fmtElapsed(Date.now() - s.since) : ""}`,
            onClick: () => openTerminal(s.id),
          })),
    },
    { label: "Usage", icon: "📊", onClick: () => openWinSafe("usage") },
    { label: "Morning brief", icon: "📰", onClick: () => openWinSafe("brief") },
    { label: "VS Code", icon: "</>", onClick: () => openWinSafe("code") },
    { label: "Clawd.exe", icon: <Clawd size={0.8} title="" />, onClick: () => openWinSafe("clawd") },
    {
      label: "Theme", icon: "🎨",
      sub: [
        { label: "Retro", onClick: () => props.onTheme("retro") },
        { label: "Dark", onClick: () => props.onTheme("dark") },
        { label: "Light", onClick: () => props.onTheme("light") },
      ],
    },
    { label: "Shut down…", icon: "💤", onClick: () => setShutdown(true) },
  ];

  const openClaudeThenModelClick = () => { restoreWin("claude"); props.onModelClick(); };

  return (
    <div className={"dk-desktop" + (interacting ? " dk-interacting" : "")} onPointerDown={() => { setStartOpen(false); setWinMenu(null); setTaskMenu(null); setBusyPop(false); }}>
      <div className="dk-icons">
        <DesktopIcon icon="💬" label="Claude" onOpen={() => onTaskbarClick("claude")} />
        <DesktopIcon icon="⌨" label="Terminal" onOpen={() => void newTerminal()} />
        <DesktopIcon icon="📊" label="Usage" onOpen={() => openWinSafe("usage")} />
        <DesktopIcon icon="📰" label="Morning brief" onOpen={() => openWinSafe("brief")} />
        <DesktopIcon icon="</>" label="VS Code" onOpen={() => openWinSafe("code")} />
        <DesktopIcon icon={<Clawd size={1.4} title="" />} label="Clawd.exe" onOpen={() => openWinSafe("clawd")} />
        <DesktopIcon icon="🗑️" label="Recycle Bin" onOpen={() => openWinSafe("recycle")} />
      </div>

      {order.map((id) => renderWindow(id))}

      <Pet mood={petMood} danceKey={props.finishedKey} />

      {winMenu && (
        <Menu items={openWindowMenuItems(winMenu.id)} style={{ left: winMenu.x, top: winMenu.y }} onClose={() => setWinMenu(null)} />
      )}
      {taskMenu && (
        <Menu items={openWindowMenuItems(taskMenu.id)} style={{ left: taskMenu.x, top: taskMenu.y }} onClose={() => setTaskMenu(null)} />
      )}

      {startOpen && (
        <div className="dk-startmenu" onPointerDown={(e) => e.stopPropagation()}>
          <div className="dk-startmenu-banner"><span>Claude</span></div>
          <div className="dk-startmenu-items">
            <Menu embedded items={startMenuItems} onClose={() => setStartOpen(false)} />
          </div>
        </div>
      )}

      {shutdown && (
        <div className="dk-shutdown" onClick={() => setShutdown(false)}>
          <Clawd size={4} mood="sleep" title="" />
          <div>It's now safe to turn off your computer.</div>
        </div>
      )}

      <div className="dk-taskbar" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className={"dk-start" + (startOpen ? " dk-pressed" : "")} onClick={() => setStartOpen((s) => !s)}>
          <Clawd size={0.6} mood="idle" title="" /> Start
        </button>
        <div className="dk-tasklist">
          {openIds.map((id) => (
            <button
              key={id}
              type="button"
              className={"dk-taskbtn" + (focusedId === id && !layout.wins[id]?.min ? " dk-focused" : "")}
              onClick={() => onTaskbarClick(id)}
              onContextMenu={(e) => { e.preventDefault(); setTaskMenu({ id, x: e.clientX, y: e.clientY }); }}
              title={winTitle(id)}
            >
              <span className="dk-taskbtn-ic">{winIcon(id)}</span>
              <span className="dk-taskbtn-label">{winTitle(id)}</span>
              {id === "claude"
                ? (props.chatBusySince != null ? <><TinyClawd mood="walk" /><Elapsed since={props.chatBusySince} className="dk-taskbtn-elapsed" /></> : props.chatWaiting ? <TinyClawd mood="needs" /> : null)
                : isTerm(id) ? <BusyBadge state={sessions.find((s) => s.id === termSid(id))?.state || "seen"} since={sessions.find((s) => s.id === termSid(id))?.since} /> : null}
            </button>
          ))}
        </div>
        <div className="dk-tray">
          <button type="button" className="dk-well dk-well-btn" onClick={openClaudeThenModelClick}>{props.modelLabel}</button>
          {props.otherBusy.length > 0 && (
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className="dk-well dk-well-btn"
                onClick={() => setBusyPop((b) => !b)}
                title={props.otherBusy.map((b) => b.title + (b.since ? " (" + fmtElapsed(Date.now() - b.since) + ")" : "")).join("\n")}
              >
                {props.otherBusy.length} running
              </button>
              {busyPop && (
                <div className="dk-busy-pop" onPointerDown={(e) => e.stopPropagation()}>
                  {props.otherBusy.map((b) => (
                    <button key={b.id} type="button" className="dk-busy-row" onClick={() => { props.onOpenChat(b.id); setBusyPop(false); }}>
                      <span>{b.title}</span>
                      <Elapsed since={b.since ?? null} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="dk-well dk-clock">{clockLabel}</div>
        </div>
      </div>
    </div>
  );
}
// #endregion
