// inventory.tsx: the Parts Inventory (FTC accounts, config appInventoryFile). A read-only, searchable
// list of the parts in the shared storage, built from photos of the drawers and bins. The search box
// takes plain questions ("do we have 8mm bearings", "what kind of wheels"): question words are dropped
// and every remaining word must appear somewhere in the part's text. "Ask Claude" puts the question
// in the chat composer, where Claude answers from the same file (/srv/ftc/shared/inventory).
// The desktop shows it as the "Parts Inventory" window; on a phone it is a strip that opens a full sheet.
// Styles are injected from here (like sketch.tsx) with an "inv-" prefix and reuse the styles.css variables.
import React, { useEffect, useMemo, useState } from "react";

type Item = { category: string; part: string; manufacturer: string; partNumber: string; qty: string; qtyBasis: string; location: string; photos: number[]; confidence: string; note: string };
type Inventory = { updated: string; source: string; album: string; photoUrls: Record<string, string>; items: Item[] };

const STOP = new Set(("do does did we our us you i have has got get is are there any some a an the of for to in on with what which "
  + "kind kinds type types sort sorts how many much show me list all find need left still team can could would please").split(" "));
// Words that name a category rather than appear in part names.
const CATEGORY_WORDS: Record<string, string> = {
  wheel: "wheels", tire: "wheels", fastener: "fasteners", tool: "tools", sensor: "sensors", battery: "batteries/power",
  motor: "motors/servos", servo: "motors/servos", gear: "motion", sprocket: "motion", belt: "motion", bearing: "motion",
  shaft: "motion", pulley: "motion", wire: "wiring", cable: "wiring", electronic: "electronics", hub: "electronics",
};
const stem = (w: string) => w.replace(/(ies)$/, "y").replace(/(ches|shes|sses|xes)$/, (m) => m.slice(0, -2)).replace(/([^s])s$/, "$1");

function terms(q: string): string[] {
  return q.toLowerCase().replace(/[?!,]/g, " ").split(/\s+/).filter(Boolean).filter((w) => !STOP.has(w)).map(stem);
}
function haystack(it: Item): string {
  return [it.part, it.manufacturer, it.partNumber, it.category, it.location, it.note].join(" ").toLowerCase();
}
function matches(it: Item, hay: string, ts: string[]): boolean {
  return ts.every((t) => hay.includes(t) || (CATEGORY_WORDS[t] && it.category.startsWith(CATEGORY_WORDS[t])));
}
// Rank a match: a word in the part name or part number counts most, then the category, then anything
// else (a note that merely mentions "wheel" should not put axle pins above the wheels).
function score(it: Item, ts: string[]): number {
  const name = (it.part + " " + it.partNumber).toLowerCase();
  return ts.reduce((n, t) => n + (name.includes(t) ? 3 : 0) + (it.category.includes(t) || (CATEGORY_WORDS[t] && it.category.startsWith(CATEGORY_WORDS[t])) ? 2 : 0), 0);
}

let cache: Promise<Inventory> | null = null;
const load = () => (cache ??= fetch("/app/api/inventory", { credentials: "same-origin" }).then(async (r) => {
  if (!r.ok) { cache = null; throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); }
  return r.json();
}));

// #region InventoryPanel
export function InventoryPanel({ onAsk }: { onAsk?: () => void }) {
  injectCss();
  const [inv, setInv] = useState<Inventory | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { load().then(setInv, (e) => setErr(String(e?.message || e))); }, []);

  const hays = useMemo(() => (inv ? inv.items.map(haystack) : []), [inv]);
  const cats = useMemo(() => (inv ? [...new Set(inv.items.map((i) => i.category))].sort() : []), [inv]);
  const ts = terms(q);
  const shown = useMemo(() => {
    if (!inv) return [];
    const hit = inv.items.map((it, i) => ({ it, i, sc: score(it, ts) })).filter(({ it, i }) => (!cat || it.category === cat) && matches(it, hays[i], ts));
    if (!ts.length) return hit;
    // Keep the category headings together: order categories by their best match, then items by score.
    const best: Record<string, number> = {};
    for (const h of hit) best[h.it.category] = Math.max(best[h.it.category] ?? 0, h.sc);
    return hit.sort((a, b) => best[b.it.category] - best[a.it.category] || a.it.category.localeCompare(b.it.category) || b.sc - a.sc || a.i - b.i);
  }, [inv, hays, cat, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = () => {
    const text = q.trim();
    if (!text) return;
    window.dispatchEvent(new CustomEvent("ct-ask", { detail: { text: `${text}\n\n(Answer from the parts inventory in ~/work/ftc-shared/inventory/parts-inventory.json.)` } }));
    onAsk?.();
  };

  if (err) return <div className="inv-root"><div className="inv-msg inv-err">Could not load the inventory: {err}</div></div>;
  if (!inv) return <div className="inv-root"><div className="inv-msg">Loading…</div></div>;

  let lastCat = "";
  return (
    <div className="inv-root">
      <div className="inv-bar">
        <input className="inv-search" type="search" value={q} placeholder="Do we have… (e.g. 8mm bearings, mecanum wheels, 2800-0004)"
          onChange={(e) => { setQ(e.target.value); setOpen(null); }} onKeyDown={(e) => { if (e.key === "Enter" && e.shiftKey) ask(); }} autoFocus />
        <button type="button" className="inv-btn inv-primary" disabled={!q.trim()} onClick={ask} title="Send this question to Claude (Shift+Enter)">Ask Claude</button>
      </div>
      <div className="inv-cats">
        <button type="button" className={"inv-chip" + (!cat ? " inv-on" : "")} onClick={() => setCat("")}>All</button>
        {cats.map((c) => <button key={c} type="button" className={"inv-chip" + (cat === c ? " inv-on" : "")} onClick={() => setCat(cat === c ? "" : c)}>{c.replace(/ \(.*\)/, "")}</button>)}
      </div>
      <div className="inv-count">
        {ts.length || cat ? (shown.length ? `${shown.length} match${shown.length === 1 ? "" : "es"}` : "No match. Try fewer or different words, or Ask Claude.") : `${inv.items.length} part types`}
      </div>
      <div className="inv-list">
        {shown.map(({ it, i }) => {
          const head = it.category !== lastCat ? (lastCat = it.category) : null;
          return (
            <React.Fragment key={i}>
              {head && <div className="inv-cat">{head}</div>}
              <button type="button" className={"inv-row" + (open === i ? " inv-row-open" : "")} onClick={() => setOpen(open === i ? null : i)}>
                <span className="inv-part">{it.part}{it.partNumber && <span className="inv-pn">{it.partNumber}</span>}</span>
                <span className="inv-qty">{it.qty}</span>
                <span className={"inv-dot inv-" + it.confidence} title={`${it.confidence} confidence`} />
              </button>
              {open === i && (
                <div className="inv-detail">
                  <div><b>Maker:</b> {it.manufacturer || "unknown"}</div>
                  <div><b>Where:</b> {it.location || "not recorded"}</div>
                  {it.qtyBasis && <div><b>How counted:</b> {it.qtyBasis}</div>}
                  {it.note && <div><b>Note:</b> {it.note}</div>}
                  <div><b>Confidence:</b> {it.confidence}</div>
                  <div className="inv-photos">
                    {it.photos.map((p) => inv.photoUrls[p] && (
                      <a key={p} href={inv.photoUrls[p] + "=w2048-h2048"} target="_blank" rel="noreferrer" title={`Photo ${p}`}>
                        <img src={inv.photoUrls[p] + "=w240-h240-c"} alt={`Photo ${p}`} loading="lazy" /><span>#{p}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
      <div className="inv-foot">From photos taken {inv.updated}. Counts are estimates; recount before you order. <a href={inv.album} target="_blank" rel="noreferrer">All photos</a></div>
    </div>
  );
}
// #endregion

// #region InventoryStrip (phone)
export function InventoryStrip() {
  injectCss();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="inv-strip" onClick={() => setOpen(true)}>📦 Parts Inventory<span className="inv-strip-hint">do we have…?</span></button>
      {open && (
        <div className="inv-sheet">
          <div className="inv-sheet-bar"><button type="button" className="inv-btn" onClick={() => setOpen(false)}>Back to chat</button></div>
          <InventoryPanel onAsk={() => setOpen(false)} />
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
.inv-root{height:100%;display:flex;flex-direction:column;background:var(--panel,#fff);color:var(--text,#000);font-size:13.5px;min-height:0;}
.inv-bar{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--line,#ccc);background:var(--bg-2,#eee);}
.inv-search{flex:1;min-width:0;font:inherit;font-size:15px;padding:6px 8px;border:1px solid var(--line,#999);border-radius:4px;background:var(--bg,#fff);color:var(--text,#000);}
.inv-btn{font:inherit;font-size:12.5px;min-height:30px;padding:4px 10px;border:1px solid var(--line,#999);border-radius:4px;background:var(--panel,#fff);color:var(--text,#000);cursor:pointer;white-space:nowrap;}
.inv-btn:disabled{opacity:.45;cursor:default;}
.inv-primary{background:var(--accent,#d97757);border-color:var(--accent,#d97757);color:#fff;font-weight:600;}
.inv-cats{display:flex;flex-wrap:wrap;gap:4px;padding:6px 10px;border-bottom:1px solid var(--line,#ccc);}
.inv-chip{font:inherit;font-size:12px;padding:2px 9px;border:1px solid var(--line,#999);border-radius:12px;background:var(--panel,#fff);color:var(--text,#000);cursor:pointer;}
.inv-on{background:var(--accent,#d97757);border-color:var(--accent,#d97757);color:#fff;font-weight:600;}
.inv-count{padding:5px 10px;font-size:12px;color:var(--text-3,#666);}
.inv-list{flex:1;min-height:0;overflow:auto;padding:0 10px 10px;}
.inv-cat{position:sticky;top:0;background:var(--bg-2,#eee);font-weight:700;font-size:12px;text-transform:capitalize;padding:4px 6px;margin-top:6px;border-radius:3px;z-index:1;}
.inv-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;font:inherit;padding:6px;border:0;border-bottom:1px solid var(--line,#ddd);background:none;color:inherit;cursor:pointer;}
.inv-row:hover,.inv-row-open{background:var(--bg-2,#f3f3f3);}
.inv-part{flex:1;min-width:0;}
.inv-pn{margin-left:6px;font-family:ui-monospace,monospace;font-size:11.5px;color:var(--text-3,#666);}
.inv-qty{flex:0 0 auto;max-width:40%;text-align:right;font-weight:600;font-size:12.5px;}
.inv-dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;}
.inv-high{background:#2f9e44;}.inv-medium{background:#f08c00;}.inv-low{background:#e03131;}
.inv-detail{padding:6px 8px 10px 14px;font-size:12.5px;display:flex;flex-direction:column;gap:3px;border-bottom:1px solid var(--line,#ddd);background:var(--bg-2,#f7f7f7);}
.inv-photos{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;}
.inv-photos a{display:flex;flex-direction:column;align-items:center;font-size:11px;color:var(--text-3,#666);text-decoration:none;}
.inv-photos img{width:96px;height:96px;object-fit:cover;border-radius:4px;border:1px solid var(--line,#ccc);}
.inv-foot{padding:6px 10px;border-top:1px solid var(--line,#ccc);font-size:11.5px;color:var(--text-3,#666);}
.inv-msg{padding:16px;color:var(--text-3,#666);}
.inv-err{color:var(--danger,#c00);font-weight:600;}
.inv-strip{display:flex;align-items:center;gap:8px;width:100%;padding:7px 12px;border:0;border-bottom:1px solid var(--line,#ccc);background:var(--bg-2,#eee);color:var(--text,#000);font:inherit;font-weight:800;font-size:14px;cursor:pointer;text-align:left;}
.inv-strip-hint{margin-left:auto;font-weight:400;font-size:12px;color:var(--text-3,#666);}
.inv-sheet{position:fixed;inset:0;z-index:5000;display:flex;flex-direction:column;background:var(--panel,#fff);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);}
.inv-sheet-bar{padding:6px 10px;border-bottom:1px solid var(--line,#ccc);}
.inv-sheet .inv-root{flex:1;}
.inv-sheet .inv-search{font-size:16px;}
`;
  document.head.appendChild(s);
}
// #endregion
