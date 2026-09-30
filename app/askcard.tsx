// ask_user card — shared by the chat thread (main.tsx) and the voice overlay (voice.tsx),
// so both render the same widget. Supports single-select (tap to answer), multi-select
// (toggle several, then submit), and/or a free-text field. Kept in its own module to avoid a
// circular import between main.tsx and voice.tsx.
import React, { useState } from "react";

export type AskItem = {
  kind: "ask";
  askId: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  allowText?: boolean;
  email?: EmailDraft;
  answered?: string;
};

export type EmailDraft = { from?: string; fromOptions?: string[]; signatures?: Record<string, string>; to: string; cc?: string; bcc?: string; subject: string; body: string };

export function AskCard({ it, onAnswer }: { it: AskItem; onAnswer: (askId: string, answer: string) => void }) {
  if (it.email) return <EmailCard it={it} draft={it.email} onAnswer={onAnswer} />;
  return <OptionsCard it={it} onAnswer={onAnswer} />;
}

// ask_user with `email`: an editable compose card. Send answers with the edited fields as JSON,
// which the server records as the approval for exactly this email. Edits survive a reload.
function EmailCard({ it, draft, onAnswer }: { it: AskItem; draft: EmailDraft; onAnswer: (askId: string, answer: string) => void }) {
  const key = `ct-email-${it.askId}`;
  const [f, setF] = useState<EmailDraft>(() => {
    try { const s = localStorage.getItem(key); if (s) return { ...draft, ...JSON.parse(s) }; } catch {}
    return { ...draft, cc: draft.cc || "", bcc: draft.bcc || "" };
  });
  const set = (k: keyof EmailDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const n = { ...f, [k]: e.target.value };
    setF(n);
    try { localStorage.setItem(key, JSON.stringify(n)); } catch {}
  };
  // The signature follows the From account; it can be edited for this one email.
  const sigFor = (from?: string) => (draft.signatures || {})[(from || "").toLowerCase()] || "";
  const [sig, setSig] = useState<string>(() => sigFor(f.from));
  const pickFrom = (e: React.ChangeEvent<HTMLSelectElement>) => { set("from")(e); setSig(sigFor(e.target.value)); };
  const fullBody = () => f.body.replace(/\s+$/, "") + (sig.trim() ? "\n\n" + sig : "");
  const finish = (a: object) => { try { localStorage.removeItem(key); } catch {} onAnswer(it.askId, JSON.stringify(a)); };

  if (it.answered !== undefined) {
    let a: any = null;
    try { a = JSON.parse(it.answered); } catch {}
    const shown: EmailDraft = a?.action === "send" ? a : draft;
    const status = a?.action === "send" ? "Approved to send" : a?.action === "cancel" ? "Cancelled" : `Changes requested: ${it.answered}`;
    return (
      <div className="ask-card email-card done">
        <div className="email-status">{status}</div>
        {shown.from && <div className="email-ro"><span>From</span>{shown.from}</div>}
        <div className="email-ro"><span>To</span>{shown.to}</div>
        {shown.cc && <div className="email-ro"><span>Cc</span>{shown.cc}</div>}
        <div className="email-ro"><span>Subject</span>{shown.subject}</div>
        <div className="email-ro-body">{shown.body}</div>
      </div>
    );
  }
  const canSend = !!f.from && f.to.trim().length > 0 && f.subject.trim().length > 0 && f.body.trim().length > 0;
  return (
    <div className="ask-card email-card">
      {it.question && <div className="ask-q">{it.question}</div>}
      <div className="email-row"><label>From</label>
        {(draft.fromOptions || []).length > 1
          ? <select className="email-from-select" value={f.from || ""} onChange={pickFrom}>{draft.fromOptions!.map((a) => <option key={a} value={a}>{a}</option>)}</select>
          : <div className="email-from">{f.from || "No account can send"}</div>}
      </div>
      <div className="email-row"><label>To</label><input value={f.to} onChange={set("to")} /></div>
      <div className="email-row"><label>Cc</label><input value={f.cc || ""} onChange={set("cc")} /></div>
      {draft.bcc && <div className="email-row"><label>Bcc</label><input value={f.bcc || ""} onChange={set("bcc")} /></div>}
      <div className="email-row"><label>Subject</label><input value={f.subject} onChange={set("subject")} /></div>
      <textarea className="email-body" value={f.body} onChange={set("body")} rows={Math.min(24, Math.max(6, f.body.split("\n").length + 1))} />
      <div className="email-sig-label">Signature</div>
      <textarea className="email-body email-sig" value={sig} onChange={(e) => setSig(e.target.value)} rows={Math.max(1, sig.split("\n").length)} placeholder="No signature" />
      <div className="ask-actions email-actions">
        <button className="email-cancel" onClick={() => finish({ action: "cancel" })}>Cancel</button>
        <button className="ask-submit" disabled={!canSend}
          onClick={() => finish({ action: "send", from: f.from, to: f.to.trim(), cc: (f.cc || "").trim(), bcc: (f.bcc || "").trim(), subject: f.subject.trim(), body: fullBody() })}>Send</button>
      </div>
    </div>
  );
}

function OptionsCard({ it, onAnswer }: { it: AskItem; onAnswer: (askId: string, answer: string) => void }) {
  const answered = it.answered !== undefined;
  const multi = !!it.multiSelect;
  const allowText = !!it.allowText;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState("");

  const compose = (): string => {
    const parts: string[] = [];
    if (selected.size) parts.push([...selected].join(", "));
    const t = text.trim();
    if (t) parts.push(t);
    return parts.join("; ");
  };
  const canSubmit = multi ? selected.size > 0 || text.trim().length > 0 : text.trim().length > 0;
  const submit = () => { const a = multi ? compose() : text.trim(); if (a) onAnswer(it.askId, a); };
  const toggle = (label: string) => setSelected((s) => { const n = new Set(s); n.has(label) ? n.delete(label) : n.add(label); return n; });
  const showSubmit = !answered && (multi || allowText);

  return (
    <div className="ask-card">
      <div className="ask-q">{it.question}</div>
      {it.options.length > 0 && (
        <div className="ask-opts">
          {it.options.map((o, k) => (
            <button key={k}
              className={"ask-opt" + (answered ? " done" : "") + (answered && it.answered === o.label ? " chosen" : "") + (!answered && multi && selected.has(o.label) ? " sel" : "")}
              disabled={answered}
              onClick={() => (multi ? toggle(o.label) : onAnswer(it.askId, o.label))}>
              {multi && !answered && <span className="ask-check">{selected.has(o.label) ? "✓" : ""}</span>}
              <span className="ask-opt-label">{o.label}</span>
              {o.description && <span className="ask-opt-desc">{o.description}</span>}
            </button>
          ))}
        </div>
      )}
      {!answered && allowText && (
        <input className="ask-text" value={text} onChange={(e) => setText(e.target.value)}
          placeholder={it.options.length ? "Or type your own answer…" : "Type your answer…"}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (canSubmit) submit(); } }} />
      )}
      {showSubmit && (
        <div className="ask-actions">
          <button className="ask-submit" disabled={!canSubmit} onClick={submit}>{multi ? "Submit" : "Send"}</button>
        </div>
      )}
      {answered && (multi || allowText) && <div className="ask-answered">{it.answered}</div>}
    </div>
  );
}
