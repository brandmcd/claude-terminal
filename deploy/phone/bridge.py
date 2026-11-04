#!/usr/bin/env python3
"""Phone bridge: Brandon calls the Twilio number and talks to Claude or Codex through an /app chat.

Twilio posts each call event to call.brandmcd.com/twilio/*. Speech becomes a turn in an /app
conversation (via the sidecar's own API), so every call shows up as a chat on the app page and can
be continued from the web. Long turns end the call and phone back when the answer is ready.
"""
import base64, hashlib, hmac, json, re, threading, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import escape

ENV = dict(l.split("=", 1) for l in open("/etc/claude-terminal/twilio.env").read().split("\n")
           if "=" in l and not l.startswith("#"))
ENV = {k.strip(): v.split("#")[0].strip() for k, v in ENV.items()}
SID, TOKEN, FROM, OWNER = ENV["TWILIO_ACCOUNT_SID"], ENV["TWILIO_AUTH_TOKEN"], ENV["TWILIO_FROM"], ENV["TWILIO_OWNER_NUMBER"]
PUBLIC = "https://call.brandmcd.com"
SIDECAR = "http://127.0.0.1:7682"
VOICE = "Polly.Matthew-Neural"
HOLD_SECONDS = 120          # how long a caller waits on the line before we switch to a callback
SAY_LIMIT = 1500            # characters read aloud; the rest stays in the app

lock = threading.Lock()
calls = {}   # CallSid -> {"conv": id or None, "turn": turn or None}
turns = {}   # turn id -> {"conv", "users_before", "started", "done", "answer", "callback", "starting", "failed"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def sidecar(method, path, body=None):
    req = urllib.request.Request(SIDECAR + path, method=method, headers={"remote-user": "brandon", "Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def spoken(text):
    text = re.sub(r"<title>.*?</title>", "", text, flags=re.S)
    text = re.sub(r"```.*?```", " (code is in the app) ", text, flags=re.S)
    text = re.sub(r"https?://\S+", "a link in the app", text)
    text = re.sub(r"[*_`#>|]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > SAY_LIMIT:
        text = text[:SAY_LIMIT].rsplit(" ", 1)[0] + ". The rest is in the app."
    return text or "Done. Details are in the app."


def session_id(temp):
    """A new chat gets a temp key; the real session id arrives on the stream's init event."""
    req = urllib.request.Request(f"{SIDECAR}/app/stream/{temp}", headers={"remote-user": "brandon"})
    with urllib.request.urlopen(req, timeout=60) as r:
        for line in r:
            if line.startswith(b"data: "):
                e = json.loads(line[6:])
                if e.get("t") == "init" and e.get("sessionId"):
                    return e["sessionId"]
                if e.get("t") in ("error", "closed"):
                    break
    raise RuntimeError("no session id for " + temp)


def turn_state(t):
    """Poll the transcript: the turn is done once our user message is in and the chat is idle."""
    conv = sidecar("GET", f"/app/api/conversation/{t['conv']}")
    if not conv:
        return False
    ev = conv.get("events", [])
    users = [i for i, e in enumerate(ev) if e.get("t") == "user"]
    if len(users) <= t["users_before"] or conv.get("busy"):
        return False
    tail = ev[users[-1] + 1:]
    last_tool = max([i for i, e in enumerate(tail) if e.get("t") in ("tool_use", "tool_result")], default=-1)
    t["answer"] = spoken(" ".join(e.get("text", "") for e in tail[last_tool + 1:] if e.get("t") == "text"))
    return True


def selected_model(name):
    """Resolve a spoken provider or family against the app's current model catalog."""
    catalog = sidecar("GET", "/app/api/models") or {}
    models = catalog.get("models", []) + catalog.get("moreModels", [])
    name = name.lower().strip()
    if name in ("codex", "openai", "open ai"):
        matches = [m for m in models if m.get("provider") == "codex"]
    elif name == "claude":
        matches = [m for m in models if m.get("provider", "claude") == "claude"]
    else:
        family = re.fullmatch(r"(.+?)(?:\s+(\d+(?:\.\d+)?))?", name)
        def contains(value, term):
            normalize = lambda value: re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
            return re.search(r"\b" + re.escape(normalize(term)) + r"\b", normalize(value)) is not None
        matches = []
        for model in models:
            names = [model.get(key, "") or "" for key in ("label", "id", "resolvedModel")]
            if any(contains(value, family.group(1)) for value in names) and (not family.group(2) or any(contains(value, family.group(2)) for value in names)):
                matches.append(model)
    if not matches:
        raise RuntimeError("Requested phone model is unavailable: " + name)
    return matches[0]["id"]


def start_turn(call, text):
    """Register the turn and hand it to the sidecar in a thread: Twilio drops a webhook after 15 s,
    and a sidecar under memory pressure can take longer than that to start a chat."""
    tid = f"{call['conv'] or 'new'}-{time.time():.3f}"
    t = turns[tid] = {"conv": call["conv"], "users_before": 0, "started": time.time(), "done": False, "answer": "",
                      "callback": False, "starting": True, "failed": False}
    call["turn"] = tid
    threading.Thread(target=begin_turn, args=(call, t, tid, text), daemon=True).start()
    return tid


def begin_turn(call, t, tid, text):
    try:
        conv = t["conv"]
        choice = re.match(r"^(?:switch to|use|ask|talk to)\s+(codex|open\s?ai|claude|astra|sol|luna|terra|fable|opus|sonnet|haiku)(?:\s+(\d+(?:\.\d+)?))?\b[,.!:]?\s*(.*)$", text, re.I)
        if choice:
            requested = choice.group(1) + (" " + choice.group(2) if choice.group(2) else "")
            model = selected_model(requested)
            if conv:
                switched = sidecar("POST", "/app/api/model", {"id": conv, "model": model})
                if not switched or switched.get("error") or switched.get("ok") is False:
                    raise RuntimeError((switched or {}).get("error", "Model switch failed"))
                conv = switched.get("id", conv)
                t["conv"] = call["conv"] = conv
            call["model"] = model
            text = choice.group(3) or "Briefly confirm which model I am speaking with."
        text = "(phone call) " + text
        if conv:
            full = sidecar("GET", f"/app/api/conversation/{conv}") or {}
            t["users_before"] = sum(1 for e in full.get("events", []) if e.get("t") == "user")
            try:
                r = sidecar("POST", "/app/api/send", {"id": conv, "text": text, "voice": True})
            except Exception:
                r = None
            if not r or r.get("error") or r.get("ok") is False:  # chat was closed: resume it by id
                r = sidecar("POST", "/app/api/start", {"resume": conv, "text": text, "voice": True, "model": call.get("model")})
                if not r or r.get("error") or r.get("ok") is False or not r.get("id"):
                    raise RuntimeError((r or {}).get("error", "Could not resume phone chat"))
                if r["id"] != conv:
                    t["conv"] = call["conv"] = session_id(r["id"])
        else:
            r = sidecar("POST", "/app/api/start", {"text": text, "voice": True, "cwd": "/home/ctuser/work", "model": call.get("model")})
            if not r or r.get("error") or r.get("ok") is False or not r.get("id"):
                raise RuntimeError((r or {}).get("error", "Could not start phone chat"))
            t["conv"] = call["conv"] = session_id(r["id"])
        t["starting"] = False
        log("turn", tid, t["conv"], repr(text[:80]))
    except Exception as e:
        t["failed"] = t["done"] = True  # done, so the watcher never phones back with an empty answer
        log("start error", tid, repr(e))


def watcher():
    """Finish turns in the background and phone back for any the caller stopped waiting on."""
    while True:
        time.sleep(3)
        with lock:
            pending = [(k, t) for k, t in turns.items() if not t["done"] and not t["starting"]]
        for tid, t in pending:
            try:
                if turn_state(t):
                    t["done"] = True
                    log("done", tid, "callback" if t["callback"] else "")
                    if t["callback"]:
                        place_callback(tid)
            except Exception as e:
                log("watch error", tid, e)


def place_callback(tid):
    data = urllib.parse.urlencode({"To": OWNER, "From": FROM, "Url": f"{PUBLIC}/twilio/callback?turn={urllib.parse.quote(tid)}",
                                   "StatusCallback": f"{PUBLIC}/twilio/status"}).encode()
    req = urllib.request.Request(f"https://api.twilio.com/2010-04-01/Accounts/{SID}/Calls.json", data=data,
                                 headers={"Authorization": "Basic " + base64.b64encode(f"{SID}:{TOKEN}".encode()).decode()})
    urllib.request.urlopen(req, timeout=20).read()


def twiml(*parts):
    return '<?xml version="1.0" encoding="UTF-8"?><Response>' + "".join(parts) + "</Response>"


def say(text):
    return f'<Say voice="{VOICE}">{escape(text)}</Say>'


def play(name):
    """Fixed lines are pre-rendered with Kokoro (/var/www/twilio-audio/make_audio.py) instead of billed Polly."""
    return f'<Play>{PUBLIC}/twilio/audio/{name}.wav</Play>'


def gather(prompt=None, timeout=6):
    inner = prompt or ""
    return (f'<Gather input="speech" action="/twilio/heard" speechTimeout="3" timeout="{timeout}" '
            f'speechModel="phone_call" enhanced="true" actionOnEmptyResult="true">{inner}</Gather>')


GOODBYE = play("goodbye") + "<Hangup/>"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, body, code=200):
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/xml")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        p = dict(urllib.parse.parse_qsl(raw, keep_blank_values=True))
        url = PUBLIC + self.path
        sig = base64.b64encode(hmac.new(TOKEN.encode(), (url + "".join(k + p[k] for k in sorted(p))).encode(), hashlib.sha1).digest()).decode()
        if not hmac.compare_digest(sig, self.headers.get("X-Twilio-Signature", "")):
            log("bad signature", self.path)
            return self.reply("forbidden", 403)
        path, _, qs = self.path.partition("?")
        q = dict(urllib.parse.parse_qsl(qs))
        sid = p.get("CallSid", "")
        try:
            with lock:
                self.reply(self.route(path, q, p, sid))
        except Exception as e:
            log("error", path, repr(e))
            self.reply(twiml(play("broke"), "<Hangup/>"))

    def route(self, path, q, p, sid):
        if path == "/twilio/status":
            c = calls.get(sid)
            if p.get("CallStatus") in ("completed", "busy", "failed", "no-answer", "canceled") and c and c["turn"]:
                t = turns.get(c["turn"])
                if t and not t["done"]:
                    t["callback"] = True
            return twiml()
        if path == "/twilio/voice":
            caller = p.get("From", "")
            log("incoming", caller, "stir", p.get("StirVerstat", "-"))
            if caller != OWNER:
                return twiml(play("private"), "<Hangup/>")
            calls[sid] = {"conv": None, "turn": None}
            return twiml(gather(play("greet")), GOODBYE)
        if path == "/twilio/callback":
            t = turns.get(q.get("turn", ""))
            if not t:
                return twiml(play("result_in_app"), "<Hangup/>")
            calls[sid] = {"conv": t["conv"], "turn": None}
            return twiml(play("answer_intro"), say(t["answer"]), gather(play("anything_else")), GOODBYE)
        c = calls.get(sid)
        if not c:
            return twiml(play("lost_track"), "<Hangup/>")
        if path == "/twilio/heard":
            text = p.get("SpeechResult", "").strip()
            if not text:
                return twiml(GOODBYE) if c["conv"] else twiml(gather(play("sorry_catch")), GOODBYE)
            if re.fullmatch(r"(no|nope|that's it|that's all|bye|goodbye|nothing)[.!]?( thanks?( you)?)?[.!]?", text.lower()):
                return twiml(GOODBYE)
            start_turn(c, text)
            return twiml(play("on_it"), '<Pause length="2"/>', '<Redirect>/twilio/wait</Redirect>')
        if path == "/twilio/wait":
            t = turns[c["turn"]]  # the watcher marks it done; polling the sidecar here could outlast Twilio's timeout
            if t["failed"]:
                return twiml(play("broke"), "<Hangup/>")
            if t["done"]:
                return twiml(say(t["answer"]), gather(None, timeout=8), GOODBYE)
            waited = time.time() - t["started"]
            if waited > HOLD_SECONDS:
                t["callback"] = True
                return twiml(play("callback_later"), "<Hangup/>")
            filler = [play("still_working")] if int(waited) % 30 < 4 and waited > 20 else []
            return twiml(*filler, '<Pause length="4"/>', '<Redirect>/twilio/wait</Redirect>')
        return twiml("<Hangup/>")


if __name__ == "__main__":
    threading.Thread(target=watcher, daemon=True).start()
    log("listening on 127.0.0.1:7710")
    ThreadingHTTPServer(("127.0.0.1", 7710), H).serve_forever()
