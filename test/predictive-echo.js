// Regression test for reconcile()'s partial-confirm path in overlay.js's
// "#region predictive local echo". Run: bun test/predictive-echo.js
//
// Both cases below FAIL against the original guard, which read the contradiction cell at
// anchor.col + k after the retire had already advanced anchor.col past the confirmed
// prefix - so it tested `k < N-k` and probed col + 2k. Case A is the miss it swallowed;
// case B is the spurious miss it invented. Neither can corrupt the display (this layer
// never writes to xterm), but both poison the hit-rate that the measure-only ship exists
// to collect, which is the whole basis for deciding whether to turn painting on.
//
// The terminal is stubbed rather than real: these assert the reconciliation arithmetic,
// not xterm's behaviour.

// Focused regression test for the reconcile() partial-confirm path.
// Builds a fake xterm buffer we control cell-by-cell, drives the predict region through
// the send-wrapper, and asserts hit/miss accounting after a PARTIAL confirmation —
// the N=2,k=1 case where the old `k < pending.length` guard silently skipped the check.

function makeTerm(cols) {
  const grid = [];
  for (let r = 0; r < 4; r++) { grid.push(new Array(cols).fill("")); }
  const listeners = {};
  const on = (name) => (fn) => { (listeners[name] ||= []).push(fn); return { dispose() {} }; };
  const line = (row) => ({
    getCell: (col) => (col < cols ? {
      getChars: () => grid[row][col],
      isBgDefault: () => true,
    } : undefined),
  });
  const term = {
    cols, rows: 4,
    options: { fontSize: 14, fontFamily: "monospace", fontWeight: "normal", letterSpacing: 0 },
    textarea: { TEXTAREA: 1 },
    buffer: { onBufferChange: on("buf"), active: { type: "alternate", baseY: 0, cursorX: 0, cursorY: 0, getLine: line } },
    onWriteParsed: on("wp"), onResize: on("rs"), onSelectionChange: on("sel"), onScroll: on("scr"),
    _core: {
      screenElement: mkEl(),
      _renderService: { dimensions: { css: { cell: { width: 9.6, height: 20.4 } } } },
      _themeService: { colors: {
        foreground: { css: "#e6e6e6" }, background: { css: "#0d1117" },
        cursor: { css: "#e6e6e6" }, cursorAccent: { css: "#0d1117" } } },
    },
    _grid: grid,
    _fire: (name) => (listeners[name] || []).forEach((f) => f()),
  };
  return term;
}
function mkEl() {
  return { children: [], style: {}, appendChild(c) { this.children.push(c); return c; },
           removeChild(c) { this.children = this.children.filter(x => x !== c); },
           set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ""; } };
}
globalThis.document = { createElement: mkEl, documentElement: mkEl(), head: mkEl(),
                        activeElement: null, addEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.location = { search: "" };
globalThis.window = globalThis;
globalThis.visualViewport = null;
globalThis.__TRACE = 1;
function log() {}
function sendToTerminal() { return true; }

const fs = require("fs");
const overlay = fs.readFileSync(__dirname + "/../overlay.js", "utf8").split("\n");
const regionStart = overlay.findIndex((l) => l.includes("#region predictive local echo"));
const regionEnd = overlay.findIndex((l, i) => i > regionStart && l.trim() === "// #endregion");
if (regionStart < 0 || regionEnd < 0) { console.log("could not locate the predictive echo region"); process.exit(1); }
const src = overlay.slice(regionStart, regionEnd + 1).join("\n");
eval(src + "\n;globalThis.predict = predict;");  // lift it out of eval scope


function run(label, fn) {
  const term = makeTerm(40);
  document.activeElement = term.textarea;
  const ws = { send() {}, addEventListener() {} };
  predict.attach(ws, term);
  term._grid[0][4] = "x";                 // non-blank to the left: first-char rule satisfied
  term.buffer.active.cursorX = 5; term.buffer.active.cursorY = 0;
  const b4 = predict.stats();
  const st = () => { const n = predict.stats();
                     return { hits: n.hits - b4.hits, misses: n.misses - b4.misses }; };
  const r = fn(term, (ch) => ws.send("0" + ch), st, () => term._fire("wp"));
  console.log((r.ok ? "  PASS  " : "  FAIL  ") + label + "  -> " + r.note);
  return r.ok;
}

// CASE A: the server frame confirms our 1st character and CONTRADICTS our 2nd in the SAME
// write. Old guard evaluated `k < pending.length` == `1 < 1` == false and never looked,
// leaving a wrong glyph up until the watchdog. It must score a miss immediately.
const a = run("A: confirm+contradict in one frame scores a miss", (term, type, st, fire) => {
  type("a"); type("b");
  term._grid[0][5] = "a";                 // ours, confirmed
  term._grid[0][6] = "Z";                 // NOT ours - the server disagrees
  term.buffer.active.cursorX = 7;
  fire();
  const s = st();
  return { ok: s.hits === 1 && s.misses === 1,
           note: "hits=" + s.hits + " misses=" + s.misses + " (want 1/1)" };
});

// CASE B: partial confirm while a STALE non-blank cell sits two columns ahead of the
// anchor. Old guard probed anchor.col + k (== col + 2k), landed on that stale cell and
// scored a SPURIOUS miss, resetting the confidence streak and poisoning the very hit-rate
// this measure-only ship exists to collect. The correct cell (anchor.col) is still blank,
// so the right answer is "frame has not landed yet" - no miss.
const b = run("B: stale cell 2 ahead does not fake a miss", (term, type, st, fire) => {
  term._grid[0][7] = "#";                 // leftover from a previous render
  type("a"); type("b"); type("c");
  term._grid[0][5] = "a";                 // only the first lands
  term.buffer.active.cursorX = 6;
  fire();
  const s = st();
  return { ok: s.hits === 1 && s.misses === 0,
           note: "hits=" + s.hits + " misses=" + s.misses + " (want 1/0)" };
});

process.exit(a && b ? 0 : 1);
