// sketch.tsx: the Sketchpad (FTC accounts, config appSketchDir). A drawing canvas for doodles and
// quick mechanism sketches: pen, eraser, line, box and circle, colours, sizes, undo and redo. Saved
// drawings are PNGs in the team's sketches folder (/app/api/sketches), so Claude in the team's chats
// can open them by path, and "Send to chat" attaches the saved file to the message being written.
// The desktop shows it as the "Sketchpad" window; on a phone it is a strip that opens a full sheet.
//
// The drawing is kept as a list of strokes over an optional background image (a reopened PNG), and
// the canvas is redrawn from that list. Undo is then one pop, and the unsaved work survives a reload
// as a small JSON draft in localStorage. The canvas has a fixed size and a white background, so every
// saved PNG is the same shape and reads cleanly when Claude opens it.
// Styles are injected from here (like board.tsx) with an "sk-" prefix and reuse the styles.css variables.
import React, { useCallback, useEffect, useRef, useState } from "react";

const W = 1600, H = 1100;
const DRAFT_KEY = "ct-sketch-draft";
const COLORS = ["#111111", "#e03131", "#f08c00", "#ffd43b", "#2f9e44", "#1971c2", "#7048e8", "#d6336c", "#868e96"];
const SIZES = [3, 6, 12, 24];
type Tool = "pen" | "eraser" | "line" | "rect" | "ellipse";
type Stroke = { tool: Tool; color: string; size: number; pts: number[] } | { tool: "clear" };
type SketchFile = { name: string; path: string; mtime: number; size: number };

const fileUrl = (f: { path: string; mtime?: number }) => `/app/api/download?path=${encodeURIComponent(f.path)}${f.mtime ? `&v=${Math.round(f.mtime)}` : ""}`;
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, "0"); return `sketch-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

function paint(ctx: CanvasRenderingContext2D, s: Stroke) {
  if (s.tool === "clear") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); return; }
  const p = s.pts;
  ctx.strokeStyle = s.tool === "eraser" ? "#fff" : s.color;
  ctx.lineWidth = s.tool === "eraser" ? s.size * 3 : s.size;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  if (s.tool === "pen" || s.tool === "eraser") {
    ctx.moveTo(p[0], p[1]);
    if (p.length === 2) ctx.lineTo(p[0] + 0.01, p[1]); // a tap leaves a dot
    // Curve through the midpoints, so fast strokes come out smooth rather than as straight segments.
    for (let i = 2; i < p.length - 2; i += 2) ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
    if (p.length > 2) ctx.lineTo(p[p.length - 2], p[p.length - 1]);
  } else {
    const [x0, y0] = p, x1 = p[p.length - 2], y1 = p[p.length - 1];
    if (s.tool === "line") { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
    else if (s.tool === "rect") ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    else ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
}

function loadDraft(): { name: string; base: SketchFile | null; strokes: Stroke[] } | null {
  try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); return d && Array.isArray(d.strokes) ? d : null; } catch { return null; }
}

// #region SketchPad
export function SketchPad({ onSent }: { onSent?: () => void }) {
  injectCss();
  const draft = useRef(loadDraft()).current;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null); // on-screen canvas size
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(SIZES[1]);
  const [strokes, setStrokes] = useState<Stroke[]>(draft?.strokes || []);
  const [redo, setRedo] = useState<Stroke[]>([]);
  const [name, setName] = useState(draft?.name || stamp());
  const [base, setBase] = useState<SketchFile | null>(draft?.base || null); // reopened drawing under the strokes
  const [baseImg, setBaseImg] = useState<HTMLImageElement | null>(null);
  const [files, setFiles] = useState<SketchFile[]>([]);
  const [showFiles, setShowFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const live = useRef<Stroke | null>(null); // the stroke under the pointer, not yet in `strokes`
  const dirty = strokes.length > 0;

  const list = useCallback(async () => {
    try { const r = await fetch("/app/api/sketches", { cache: "no-store" }); const j = await r.json(); setFiles(j.files || []); } catch { /* */ }
  }, []);
  useEffect(() => { void list(); }, [list]);

  useEffect(() => {
    if (!base) { setBaseImg(null); return; }
    const img = new Image();
    img.onload = () => setBaseImg(img);
    img.onerror = () => { setBase(null); setMsg({ text: `Could not open ${base.name}`, err: true }); };
    img.src = fileUrl(base);
  }, [base]);

  const redraw = useCallback(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    if (baseImg) ctx.drawImage(baseImg, 0, 0, W, H);
    for (const s of strokes) paint(ctx, s);
    if (live.current) paint(ctx, live.current);
  }, [strokes, baseImg]);
  useEffect(redraw, [redraw]);

  // Fit the fixed-size canvas into whatever space the window or sheet leaves, keeping its shape.
  useEffect(() => {
    const el = stageRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth - 16, h = el.clientHeight - 16;
      if (w > 0 && h > 0) { const k = Math.min(w / W, h / H); setFit({ w: Math.floor(W * k), h: Math.floor(H * k) }); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ name, base, strokes })); } catch { /* full: the drawing still saves */ }
  }, [name, base, strokes]);

  const point = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) * W) / r.width), Math.round(((e.clientY - r.top) * H) / r.height)];
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    live.current = { tool, color, size, pts: point(e) };
    redraw();
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = live.current; if (!s || s.tool === "clear") return;
    const [x, y] = point(e);
    if (s.tool === "pen" || s.tool === "eraser") s.pts.push(x, y);
    else s.pts = [s.pts[0], s.pts[1], x, y];
    redraw();
  };
  const onUp = () => {
    const s = live.current; if (!s) return;
    live.current = null;
    setStrokes((a) => [...a, s]); setRedo([]);
  };

  const undo = () => { if (!strokes.length) return; setRedo((r) => [...r, strokes[strokes.length - 1]]); setStrokes((a) => a.slice(0, -1)); };
  const redoOne = () => { if (!redo.length) return; setStrokes((a) => [...a, redo[redo.length - 1]]); setRedo((r) => r.slice(0, -1)); };
  const clear = () => { setStrokes((a) => [...a, { tool: "clear" }]); setRedo([]); };
  const fresh = () => {
    if (dirty && !confirm("Start a new drawing? Unsaved changes to this one will be lost.")) return;
    setStrokes([]); setRedo([]); setBase(null); setName(stamp()); setMsg(null);
  };
  const open = (f: SketchFile) => {
    if (dirty && !confirm(`Open ${f.name}? Unsaved changes to this drawing will be lost.`)) return;
    setStrokes([]); setRedo([]); setBase(f); setName(f.name.replace(/\.png$/i, "")); setShowFiles(false); setMsg(null);
  };
  const remove = async (f: SketchFile) => {
    if (!confirm(`Delete ${f.name} for the whole team?`)) return;
    await fetch("/app/api/sketches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "delete", name: f.name }) });
    if (base?.name === f.name) setBase(null);
    void list();
  };

  // Saving bakes the strokes into the PNG, then reopens it as the base, so undo starts fresh from
  // what is on disk and the draft stays small.
  const save = async (): Promise<SketchFile | null> => {
    const c = canvasRef.current; if (!c) return null;
    const target = name.trim() || stamp();
    if (files.some((f) => f.name.replace(/\.png$/i, "") === target) && base?.name.replace(/\.png$/i, "") !== target
      && !confirm(`A sketch named ${target} already exists. Replace it?`)) return null;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/app/api/sketches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: target, dataUrl: c.toDataURL("image/png") }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.path) throw new Error(j.error || `HTTP ${r.status}`);
      const f: SketchFile = { name: j.name, path: j.path, mtime: Date.now(), size: 0 };
      setName(j.name.replace(/\.png$/i, "")); setStrokes([]); setRedo([]); setBase(f);
      setMsg({ text: `Saved ${j.name}` });
      void list();
      return f;
    } catch (e: any) { setMsg({ text: `Save failed: ${e?.message || e}`, err: true }); return null; }
    finally { setBusy(false); }
  };
  // Hand the saved file to the chat composer (main.tsx listens for ct-attach), like an uploaded image.
  const send = async () => {
    const f = dirty || !base ? await save() : base;
    if (!f) return;
    window.dispatchEvent(new CustomEvent("ct-attach", { detail: { name: f.name, path: f.path, isImage: true, preview: fileUrl(f) } }));
    setMsg({ text: `Attached ${f.name} to your next message` });
    onSent?.();
  };

  const tools: [Tool, string, string][] = [["pen", "✏️", "Pen"], ["eraser", "🧽", "Eraser"], ["line", "╱", "Line"], ["rect", "▭", "Box"], ["ellipse", "◯", "Circle"]];
  return (
    <div className="sk-root">
      <div className="sk-bar">
        <span className="sk-group">
          {tools.map(([t, icon, label]) => (
            <button key={t} type="button" className={"sk-btn" + (tool === t ? " sk-on" : "")} onClick={() => setTool(t)} title={label}>{icon}<span className="sk-lbl"> {label}</span></button>
          ))}
        </span>
        <span className="sk-group">
          {COLORS.map((c) => (
            <button key={c} type="button" className={"sk-swatch" + (color === c ? " sk-on" : "")} style={{ background: c }} onClick={() => { setColor(c); if (tool === "eraser") setTool("pen"); }} title={c} />
          ))}
          <input type="color" className="sk-picker" value={color} onChange={(e) => { setColor(e.target.value); if (tool === "eraser") setTool("pen"); }} title="Any colour" />
        </span>
        <span className="sk-group">
          {SIZES.map((s) => (
            <button key={s} type="button" className={"sk-btn sk-size" + (size === s ? " sk-on" : "")} onClick={() => setSize(s)} title={`Size ${s}`}>
              <span style={{ width: Math.min(s, 18), height: Math.min(s, 18), background: tool === "eraser" ? "#999" : color }} />
            </button>
          ))}
        </span>
        <span className="sk-group">
          <button type="button" className="sk-btn" onClick={undo} disabled={!strokes.length} title="Undo">↶<span className="sk-lbl"> Undo</span></button>
          <button type="button" className="sk-btn" onClick={redoOne} disabled={!redo.length} title="Redo">↷</button>
          <button type="button" className="sk-btn" onClick={clear} title="Clear the page (undo brings it back)">Clear</button>
        </span>
      </div>
      <div className="sk-stage" ref={stageRef}>
        <canvas ref={canvasRef} width={W} height={H} className={"sk-canvas sk-c-" + tool} style={fit ? { width: fit.w, height: fit.h } : undefined}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
        {showFiles && (
          <div className="sk-files">
            {files.length === 0 && <div className="sk-empty">No saved sketches yet. Save one and it shows up here for the whole team.</div>}
            {files.map((f) => (
              <div key={f.name} className={"sk-file" + (base?.name === f.name ? " sk-file-on" : "")}>
                <button type="button" className="sk-thumb" onClick={() => open(f)} title={`Open ${f.name}`}><img src={fileUrl(f)} alt={f.name} loading="lazy" /></button>
                <div className="sk-file-name" title={f.name}>{f.name.replace(/\.png$/i, "")}</div>
                <div className="sk-file-meta">{new Date(f.mtime).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  <button type="button" className="sk-link" onClick={() => void remove(f)}>Delete</button></div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="sk-foot">
        <input className="sk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Sketch name" maxLength={80} />
        <button type="button" className="sk-btn sk-primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="sk-btn" onClick={() => void send()} disabled={busy} title="Save, then attach it to your next chat message">Send to chat</button>
        <button type="button" className="sk-btn" onClick={fresh}>New</button>
        <button type="button" className={"sk-btn" + (showFiles ? " sk-on" : "")} onClick={() => { setShowFiles((v) => !v); void list(); }}>Saved ({files.length})</button>
        {msg && <span className={"sk-msg" + (msg.err ? " sk-err" : "")}>{msg.text}</span>}
        {!msg && dirty && <span className="sk-msg">Unsaved changes</span>}
      </div>
    </div>
  );
}
// #endregion

// #region phone strip
export function SketchStrip() {
  injectCss();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="sk-strip" onClick={() => setOpen(true)}>✏️ Sketchpad<span className="sk-strip-hint">draw and save sketches</span></button>
      {open && (
        <div className="sk-sheet">
          <div className="sk-sheet-bar"><button type="button" className="sk-btn" onClick={() => setOpen(false)}>Back to chat</button></div>
          <SketchPad onSent={() => setOpen(false)} />
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
.sk-root{container-type:inline-size;height:100%;display:flex;flex-direction:column;background:var(--panel,#fff);color:var(--text,#000);font-size:13.5px;min-height:0;}
.sk-bar{display:flex;flex-wrap:wrap;gap:6px 12px;padding:8px 10px;border-bottom:1px solid var(--line,#ccc);background:var(--bg-2,#eee);}
.sk-group{display:flex;flex-wrap:wrap;align-items:center;gap:4px;}
.sk-btn{font:inherit;font-size:12.5px;min-height:30px;padding:4px 9px;border:1px solid var(--line,#999);border-radius:4px;background:var(--panel,#fff);color:var(--text,#000);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;}
.sk-btn:disabled{opacity:.45;cursor:default;}
.sk-on{outline:2px solid var(--accent,#d97757);outline-offset:1px;font-weight:700;}
.sk-primary{background:var(--accent,#d97757);border-color:var(--accent,#d97757);color:#fff;font-weight:600;}
.sk-swatch{width:26px;height:26px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px var(--line,#999);cursor:pointer;padding:0;}
.sk-swatch.sk-on{outline:2px solid var(--accent,#d97757);outline-offset:2px;}
.sk-picker{width:30px;height:28px;padding:0;border:1px solid var(--line,#999);border-radius:4px;background:none;cursor:pointer;}
.sk-size{width:34px;padding:0;}
.sk-size span{display:block;border-radius:50%;}
.sk-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:8px;background:var(--bg-3,#ddd);overflow:hidden;}
.sk-canvas{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.3);touch-action:none;cursor:crosshair;}
.sk-c-eraser{cursor:cell;}
.sk-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 10px;border-top:1px solid var(--line,#ccc);}
.sk-name{flex:1 1 140px;min-width:0;font:inherit;font-size:14px;padding:5px 7px;border:1px solid var(--line,#999);border-radius:4px;background:var(--bg,#fff);color:var(--text,#000);}
.sk-msg{font-size:12px;color:var(--text-3,#666);}
.sk-err{color:var(--danger,#c00);font-weight:600;}
.sk-files{position:absolute;inset:0;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));grid-auto-rows:max-content;gap:10px;padding:10px;background:var(--panel,#fff);}
.sk-empty{grid-column:1/-1;color:var(--text-3,#666);text-align:center;padding:12px;}
.sk-file{display:flex;flex-direction:column;gap:3px;font-size:12px;}
.sk-file-on .sk-thumb{outline:2px solid var(--accent,#d97757);}
.sk-thumb{padding:0;border:1px solid var(--line,#999);border-radius:4px;background:#fff;cursor:pointer;aspect-ratio:${W}/${H};overflow:hidden;}
.sk-thumb img{width:100%;height:100%;object-fit:contain;display:block;}
.sk-file-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sk-file-meta{display:flex;justify-content:space-between;color:var(--text-3,#666);}
.sk-link{background:none;border:0;padding:0;text-decoration:underline;cursor:pointer;color:var(--danger,#c00);font:inherit;}
@container (max-width:560px){.sk-lbl{display:none;}.sk-bar{gap:5px 8px;}}
.sk-strip{display:flex;align-items:center;gap:8px;width:100%;padding:7px 12px;border:0;border-bottom:1px solid var(--line,#ccc);background:var(--bg-2,#eee);color:var(--text,#000);font:inherit;font-weight:800;font-size:14px;cursor:pointer;text-align:left;}
.sk-strip-hint{margin-left:auto;font-weight:400;font-size:12px;color:var(--text-3,#666);}
.sk-sheet{position:fixed;inset:0;z-index:5000;display:flex;flex-direction:column;background:var(--panel,#fff);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);}
.sk-sheet-bar{padding:6px 10px;border-bottom:1px solid var(--line,#ccc);}
.sk-sheet .sk-root{flex:1;}
.sk-sheet .sk-name{font-size:16px;}
`;
  document.head.appendChild(s);
}
// #endregion
