// Clawd, the Claude Code mascot, drawn on a 22x15 pixel grid, plus the elapsed-time label that
// shows how long a task has been running. Both are shared by the chat view and the desktop shell.
// Styles are injected once from here so neither caller has to touch styles.css.
import React, { useEffect, useRef, useState } from "react";

export type ClawdMood = "idle" | "walk" | "needs" | "sleep";
const MOVES = ["d-hop", "d-wiggle", "d-shuffle", "d-spin", "d-party"] as const;
export type ClawdMove = (typeof MOVES)[number];
let nextMove = 0;

const CSS = `
.clawd { display: inline-block; position: relative; cursor: pointer; transform-origin: 50% 100%; line-height: 0; vertical-align: middle; -webkit-tap-highlight-color: transparent; }
.clawd svg { display: block; overflow: visible; shape-rendering: crispEdges; }
.clawd .c-body, .clawd .c-arm, .clawd .c-leg { fill: var(--clawd, #d97757); }
.clawd .c-eye { fill: var(--clawd-ink, #1a1613); transform-box: fill-box; transform-origin: center; animation: clawd-blink 4.2s infinite; }
.clawd .c-arm { transform-box: fill-box; }
.clawd .c-arm.l { transform-origin: 100% 50%; } .clawd .c-arm.r { transform-origin: 0% 50%; }
.clawd .c-leg { transform-box: fill-box; transform-origin: 50% 0; }
.clawd .c-q { display: none; position: absolute; top: -.9em; right: -.35em; font: 700 11px/1 system-ui, sans-serif; color: var(--clawd, #d97757); }
.clawd .c-z { display: none; position: absolute; top: -.8em; right: -.4em; font: 700 10px/1 system-ui, sans-serif; color: var(--text-3, #8a8078); animation: clawd-z 2.4s ease-in-out infinite; }
@keyframes clawd-blink { 0%, 94%, 100% { transform: scaleY(1); } 97% { transform: scaleY(.1); } }
@keyframes clawd-bob { 50% { transform: translateY(-1.5px); } }
@keyframes clawd-step-a { 50% { transform: translateY(-2px); } }
@keyframes clawd-step-b { 0%, 100% { transform: translateY(-2px); } 50% { transform: none; } }
@keyframes clawd-z { 0% { opacity: 0; transform: translate(0, 2px); } 40% { opacity: 1; } 100% { opacity: 0; transform: translate(4px, -6px); } }
@keyframes clawd-hop { 0%, 100% { transform: translateY(0) scale(1, 1); } 15% { transform: translateY(0) scale(1.15, .85); } 40% { transform: translateY(-40%) scale(.92, 1.1); } 65% { transform: translateY(0) scale(1.1, .9); } }
@keyframes clawd-wiggle { 0%, 100% { transform: rotate(0); } 25% { transform: rotate(-14deg); } 75% { transform: rotate(14deg); } }
@keyframes clawd-shuffle { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-12%) rotate(-6deg); } 75% { transform: translateX(12%) rotate(6deg); } }
@keyframes clawd-spin { to { transform: rotateY(360deg); } }
@keyframes clawd-wave-l { 0%, 100% { transform: rotate(0); } 50% { transform: rotate(-70deg); } }
@keyframes clawd-wave-r { 0%, 100% { transform: rotate(0); } 50% { transform: rotate(70deg); } }
@media (prefers-reduced-motion: no-preference) {
  .clawd.idle svg { animation: clawd-bob 2.4s ease-in-out infinite; }
  .clawd.walk svg { animation: clawd-bob .36s steps(2) infinite; }
  .clawd.walk .c-leg:nth-of-type(odd), .clawd.d-shuffle .c-leg:nth-of-type(odd) { animation: clawd-step-a .36s steps(2) infinite; }
  .clawd.walk .c-leg:nth-of-type(even), .clawd.d-shuffle .c-leg:nth-of-type(even) { animation: clawd-step-b .36s steps(2) infinite; }
  .clawd.d-hop svg { animation: clawd-hop .55s ease-in-out 4; }
  .clawd.d-wiggle svg { animation: clawd-wiggle .4s ease-in-out 6; }
  .clawd.d-wiggle .c-arm.l, .clawd.d-party .c-arm.l, .clawd.d-spin .c-arm.l { animation: clawd-wave-l .4s ease-in-out 6; }
  .clawd.d-wiggle .c-arm.r, .clawd.d-party .c-arm.r, .clawd.d-spin .c-arm.r { animation: clawd-wave-r .4s ease-in-out 6 .2s; }
  .clawd.d-shuffle svg { animation: clawd-shuffle .5s ease-in-out 5; }
  .clawd.d-spin svg { animation: clawd-spin .7s cubic-bezier(.5,0,.5,1) 3; }
  .clawd.d-party svg { animation: clawd-hop .45s ease-in-out 3, clawd-wiggle .3s ease-in-out 1.35s 4; }
  .clawd.needs .c-arm.r { animation: clawd-wave-r .8s ease-in-out infinite; }
}
.clawd.needs .c-q { display: block; }
.clawd.sleep .c-z { display: block; }
.clawd.sleep .c-eye { animation: none; transform: scaleY(.15); }
.ct-confetti { position: fixed; top: -16px; width: 8px; height: 12px; z-index: 10000; pointer-events: none; animation: ct-fall 1.6s ease-in forwards; }
@keyframes ct-fall { to { transform: translate(var(--dx), 110vh) rotate(720deg); opacity: .7; } }
@media (prefers-reduced-motion: reduce) { .ct-confetti { display: none; } }
.ct-elapsed { font-variant-numeric: tabular-nums; }
`;
let injected = false;
function injectCss() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.id = "clawd-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

// A burst of confetti across the viewport. Used by the "party" move and when a long task finishes.
export function confetti(n = 60) {
  const colors = ["#d97757", "#f6c453", "#7bd389", "#6cb4ff", "#ff6bd6"];
  for (let i = 0; i < n; i++) {
    const s = document.createElement("i");
    s.className = "ct-confetti";
    s.style.left = Math.random() * 100 + "vw";
    s.style.background = colors[i % colors.length];
    s.style.setProperty("--dx", Math.random() * 160 - 80 + "px");
    s.style.animationDelay = Math.random() * 0.5 + "s";
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 2400);
  }
}

// `danceKey`: each change starts a dance, so a parent can make Clawd celebrate (a task finishing)
// without holding a ref. A tap starts the next move in the cycle.
export function Clawd({ size = 2, mood = "idle", danceKey, move, title, className }: {
  size?: number; mood?: ClawdMood; danceKey?: number; move?: ClawdMove; title?: string; className?: string;
}) {
  injectCss();
  const [dancing, setDancing] = useState<ClawdMove | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = (m?: ClawdMove) => {
    const mv = m || MOVES[nextMove++ % MOVES.length];
    setDancing(null);
    // Re-set on the next frame so the same move restarts its animation.
    requestAnimationFrame(() => setDancing(mv));
    if (mv === "d-party") confetti();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDancing(null), 2400);
  };
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (danceKey !== undefined) start(move);
  }, [danceKey]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const w = 22 * size, h = 15 * size;
  return (
    <span className={"clawd " + (dancing || mood) + (className ? " " + className : "")} title={title ?? "Clawd (tap to dance)"}
      role="img" aria-label="Clawd" onClick={(e) => { e.stopPropagation(); start(); }}>
      <svg width={w} height={h} viewBox="0 0 22 15" aria-hidden="true">
        <rect className="c-arm l" x="0.5" y="5" width="2.5" height="3" />
        <rect className="c-arm r" x="19" y="5" width="2.5" height="3" />
        <rect className="c-body" x="3" y="1" width="16" height="10" />
        <rect className="c-eye" x="7" y="3.5" width="1.6" height="3.2" />
        <rect className="c-eye" x="13.4" y="3.5" width="1.6" height="3.2" />
        <rect className="c-leg" x="4.5" y="11" width="1.6" height="3" />
        <rect className="c-leg" x="7.6" y="11" width="1.6" height="3" />
        <rect className="c-leg" x="12.8" y="11" width="1.6" height="3" />
        <rect className="c-leg" x="15.9" y="11" width="1.6" height="3" />
      </svg>
      <span className="c-q" aria-hidden="true">?</span>
      <span className="c-z" aria-hidden="true">z</span>
    </span>
  );
}

// 0:07, 4:32, 1:02:09.
export function fmtElapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// How long a task has been running, ticking once a second from `since` (epoch ms). Renders nothing
// when `since` is missing, so callers can pass the field straight through.
export function Elapsed({ since, className }: { since?: number | null; className?: string }) {
  injectCss();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return null;
  return <span className={"ct-elapsed" + (className ? " " + className : "")} title={"Running since " + new Date(since).toLocaleTimeString()}>{fmtElapsed(now - since)}</span>;
}
