# Voice mode on this box — operator runbook

Upstream's `voice/` ships units tuned for the author's workstation (a 5900X, `*_THREADS=8`,
paths under `/media/nas/filip/...`). This box is 2 vCPU / 3.7 GB with no GPU, shared with
`ct-ttyd`, `ct-sidecar` and live Claude Code sessions. This file is what actually gets it
running here.

**What here is measured, and what is not.** The STT half was genuinely executed on this
box: model timings, RSS, the iOS fragmented-MP4 decode and every `/transcribe` smoke test
below were run and their output pasted in. The TTS half was **not** — the CPU torch stack
was never installed here, so the Kokoro download sizes, the step-3 command, the expected
`/speak` output and the TTS RAM and RTF figures are all *derived or estimated, not
observed*, and are marked **(not yet run here)** where they appear. If reality diverges
from a line carrying that marker, trust reality, not this file.

| | |
|---|---|
| Repo | `/srv/claude-terminal` |
| Sidecar config | `/etc/claude-terminal/config.json` (root-owned — needs sudo) |
| Units to install | `voice/systemd/claude-voice.slice`, `claude-stt.local.service`, `claude-tts.local.service` |
| Model cache | `/home/ctuser/.cache/huggingface` |
| Ports | STT `127.0.0.1:7801`, TTS `127.0.0.1:7802` — loopback only, proxied and owner-gated by the sidecar at `/app/api/stt` and `/app/api/tts` |

---

## What you are installing, and the three upstream traps

**Trap 1 — `voice/tts/uv.lock` installs 2.2 GB of CUDA on a GPU-less box.**
`voice/tts/pyproject.toml` declares `[tool.uv.sources] torch = { index = "pytorch-cpu" }`,
but torch is only a *transitive* dependency there (`kokoro` → `torch`), and uv applies
`tool.uv.sources` to the project's own declared dependencies. The pin is therefore a no-op:
the committed lock resolves torch 2.13.0 from PyPI, which on linux drags in
`nvidia-cublas`, `nvidia-cudnn`, `nvidia-cusolver`, `nvidia-nccl`, `triton` and ten more —
**2,868 MB of wheels, 2,196 MB of it CUDA.** Verified by re-resolving upstream's
`pyproject.toml` from scratch: 15 nvidia packages.

`voice/tts-cpu/` fixes this by listing `torch` as a direct dependency so the source pin
binds. Same versions, same lock discipline, **0 nvidia packages, 338 MB of wheels.** It
contains only `pyproject.toml` + `uv.lock` — no duplicated service code. The systemd unit
keeps `WorkingDirectory=/srv/claude-terminal/voice/tts` and passes
`--project /srv/claude-terminal/voice/tts-cpu`, so upstream's unmodified `main.py` runs
against the CPU-only venv.

**Trap 2 — README.md says `apt install espeak-ng`. You don't need it, and can't do it here.**
`kokoro` → `misaki[en]` → `espeakng-loader`, and `misaki/espeak.py` does:

```python
EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
```

The wheel bundles `libespeak-ng.so` (646 KB) plus 18 MB of `espeak-ng-data`. Verified on
this box: `ctypes.CDLL()` on the bundled library loads clean with no espeak-ng package
installed. **Ignore the apt line in README.md.**

**Trap 3 (not in upstream's docs at all) — spaCy's `en_core_web_sm` is a hard dependency of
Kokoro and is not in any lock.** `misaki/en.py` does:

```python
if not spacy.util.is_package(name):   # name == "en_core_web_sm"
    spacy.cli.download(name)
```

That runs `pip install` from *inside the first synthesis request*. Under the unit's
`IPAddressDeny=any` it will hang, and under `ProtectSystem=strict` it would fail anyway.
Step 2 installs it up front, before anything tries to load Kokoro.

---

## 0. Check free memory first

The budget below assumes ~2.4 GB available. `/tmp` on this box is a **1.9 GB tmpfs**, so
anything left there is resident RAM, not disk — a stray model cache or test venv silently
eats the headroom the voice services need.

```bash
free -h                 # want ~2.4G available before starting
df -h /tmp              # want /tmp well under a few hundred MB
```

If `/tmp` is holding hundreds of MB of caches or virtualenvs from earlier experiments,
delete them before installing the units. Otherwise the first TTS cold-load spike lands on
a box with no room and the global OOM killer picks a victim.

## 1. Dependencies

```bash
# Both syncs use the absolute uv path; there is no PATH in the systemd environment.
UV=/home/ctuser/.local/bin/uv

# STT — 133 MB of wheels, ~400 MB installed. No torch, no CUDA.
$UV sync --project /srv/claude-terminal/voice/stt

# TTS — note tts-cpu, NOT tts. 338 MB of wheels (192 MB of that is CPU torch),
# roughly 1.0 GB installed. (not yet run here — estimated from the lock's wheel sizes)
$UV sync --project /srv/claude-terminal/voice/tts-cpu
```

Both `.venv/` directories are already covered by `voice/.gitignore`.

Sanity check that you got the right torch — this must print `+cpu` and `False`:

```bash
/srv/claude-terminal/voice/tts-cpu/.venv/bin/python -c \
  "import torch; print(torch.__version__, torch.cuda.is_available())"
# 2.13.0+cpu False
```

If it prints a bare `2.13.0` you synced `voice/tts` by mistake. `rm -rf
/srv/claude-terminal/voice/tts/.venv` and redo it against `tts-cpu`.

## 2. spaCy model — do this BEFORE any prewarm (see Trap 3)

Two things make this its own step, ahead of the model downloads:

- Kokoro cannot even be *constructed* without it. `KPipeline(lang_code='a')` builds
  misaki's `G2P`, which calls `spacy.load('en_core_web_sm')`. Prewarming Kokoro first just
  walks into the `spacy.cli.download()` path Trap 3 describes.
- **`python -m spacy download` does not work in these venvs.** Both that command and
  misaki's fallback shell out to `python -m pip install`, and uv-created virtualenvs do
  not ship pip. Verified here: `No module named pip`. Install the wheel directly with uv
  instead — `en_core_web_sm` 3.8.0 is the release matching the locked spaCy 3.8.16.

```bash
/home/ctuser/.local/bin/uv pip install \
  --python /srv/claude-terminal/voice/tts-cpu/.venv/bin/python \
  https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
```

> **This install lives outside the lock, so re-running step 1 wipes it.** `uv sync` makes
> the venv match `uv.lock` exactly and prunes anything else, and `en_core_web_sm` is not in
> that lock. After ANY future `uv sync --project voice/tts-cpu` — a lock bump, or just
> reflex — re-run this step. Skip it and every `/speak` returns a 500 whose innermost error
> is `No module named pip`, from misaki trying to self-heal in a venv that has no pip.
> The durable fix, if this bites twice: add the wheel URL as a direct dependency in
> `voice/tts-cpu/pyproject.toml` and re-lock, so step 2 disappears.

Verify — this must print `True` and then a list of POS tags, which is exactly the load
misaki performs:

```bash
/srv/claude-terminal/voice/tts-cpu/.venv/bin/python -c \
  "import spacy; print(spacy.util.is_package('en_core_web_sm')); \
   print(spacy.load('en_core_web_sm', enable=['tok2vec','tagger'])('a test')[0].tag_)"
# True
# DT
```

## 3. First-run model download

Models are **not** in the repo. They land in `HF_HOME=/home/ctuser/.cache/huggingface`
(specifically `.../hub/models--<org>--<repo>/`). Pull them by hand now, because the units
run with `HF_HUB_OFFLINE=1` and `IPAddressDeny=any` and cannot fetch them later.

```bash
export HF_HOME=/home/ctuser/.cache/huggingface

# Whisper base.en, CTranslate2 int8 -> 141 MB on disk
/srv/claude-terminal/voice/stt/.venv/bin/python -c \
  "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8')"

# Kokoro-82M: kokoro-v1_0.pth is 327 MB, plus config.json and the af_heart voice (0.5 MB).
# Requires step 2 to have run.
cd /srv/claude-terminal/voice/tts && \
/srv/claude-terminal/voice/tts-cpu/.venv/bin/python -c \
  "from kokoro import KPipeline; p = KPipeline(lang_code='a'); list(p('warm up', voice='af_heart'))"
```

| Artefact | Size | Destination |
|---|---|---|
| `Systran/faster-whisper-base.en` | **141 MB** | `~/.cache/huggingface/hub/models--Systran--faster-whisper-base.en` |
| `Systran/faster-whisper-tiny.en` (optional) | 75 MB | same tree |
| `hexgrad/Kokoro-82M` weights + `af_heart` | **328 MB** *(not yet run here)* | `~/.cache/huggingface/hub/models--hexgrad--Kokoro-82M` |
| `en_core_web_sm` (step 2) | 12.8 MB wheel, ~33 MB installed | the `tts-cpu` venv |

Grand total for a cold install: **~470 MB of wheels + ~480 MB of models**, about 1.6 GB on
disk. There is 22 GB free, so this is not the constraint — RAM is.

## 4. Install the units (needs sudo)

```bash
sudo install -m644 /srv/claude-terminal/voice/systemd/claude-voice.slice        /etc/systemd/system/
sudo install -m644 /srv/claude-terminal/voice/systemd/claude-stt.local.service  /etc/systemd/system/
sudo install -m644 /srv/claude-terminal/voice/systemd/claude-tts.local.service  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-stt.local.service claude-tts.local.service
```

Watch the first start — STT is ready in a few seconds, TTS takes noticeably longer because
it loads torch, spaCy and 327 MB of weights and then warms the graph:

```bash
journalctl -u claude-stt.local.service -u claude-tts.local.service -f
# [stt] loading base.en device=cpu compute=int8 threads=2
# [stt] model ready in 2.7s
# [tts] loading Kokoro-82M lang=a voice=af_heart
# [tts] ready in ...
```

Do **not** install upstream's `claude-stt.service` / `claude-tts.service`; they are kept in
the repo unmodified for merge sanity and point at `/media/nas/filip/...` with `User=filip`.

## 5. Smoke tests

Run these before touching `config.json`, so a failure is unambiguously the voice service
and not the sidecar.

### STT

```bash
curl -s http://127.0.0.1:7801/health
# {"ok":true,"model":"base.en","device":"cpu","compute":"int8","threads":2}
```

`/transcribe` is `multipart/form-data` with a `file` part and an optional `language` part
(defaults to `en`; `auto` enables language detection). Grab a real speech sample and put a
real utterance through it:

```bash
cd /tmp
curl -sSL -o jfk.flac \
  https://github.com/SYSTRAN/faster-whisper/raw/master/tests/data/jfk.flac

curl -s -X POST -F "file=@jfk.flac" -F "language=en" http://127.0.0.1:7801/transcribe
```

From a run on this box. The `text` must match exactly; `seconds` is wall-clock
transcription time and will vary run to run:

```json
{"text":"And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.","language":"en","seconds":1.315,"audioSeconds":11.029}
```

### STT, iPhone path (the one that matters)

`voice/make-test-clip.py` re-encodes any audio into the exact container iOS Safari's
MediaRecorder emits — *fragmented* MP4 with an AAC-LC track — using the PyAV that
faster-whisper already bundles. No ffmpeg or iPhone required.

```bash
/srv/claude-terminal/voice/stt/.venv/bin/python \
  /srv/claude-terminal/voice/make-test-clip.py /tmp/jfk.flac /tmp/ios.mp4
# wrote /tmp/ios.mp4: mp4/aac, 11.00s mono @ 48000 Hz

curl -s -X POST -F "file=@/tmp/ios.mp4;type=audio/mp4" -F "language=en" \
  http://127.0.0.1:7801/transcribe
```

This must return **the same transcript as the flac**. It does; see "The iOS question"
below. The journal line names the container it sniffed, which is the fastest way to
confirm what a real phone actually sent:

```
[stt] 101473 bytes mp4/m4a (iOS Safari MediaRecorder) 11.03s -> 107 chars in 1.31s (rtf 0.12): 'And so my fellow Americans, ask not ...'
```

Undecodable input is a `415` with a readable body rather than a bare ffmpeg errno:

```bash
head -c 4000 /dev/urandom > /tmp/junk.bin
curl -s -w " [%{http_code}]\n" -X POST -F "file=@/tmp/junk.bin" http://127.0.0.1:7801/transcribe
# {"error":"could not decode the recording: FFmpeg does not accept these bytes (detected
#  unrecognised (starts d459b3a4...)). Check what MediaRecorder produced on this browser —
#  expected webm/opus or mp4/aac.","container":"...","bytes":4000,"detail":"..."} [415]
```

### TTS

```bash
curl -s http://127.0.0.1:7802/health
# {"ok":true,"voice":"af_heart","lang":"a","sr":24000}
```

`/speak` takes JSON `{text, voice?, speed?}` and returns `audio/wav` (24 kHz PCM_16) with
`X-Audio-Seconds` / `X-Synth-Seconds` headers:

```bash
curl -sS -X POST http://127.0.0.1:7802/speak \
  -H 'content-type: application/json' \
  -d '{"text":"Voice mode is running on the little box."}' \
  -D /tmp/tts.headers -o /tmp/tts.wav

grep -i '^x-' /tmp/tts.headers
python3 -c "import wave; w=wave.open('/tmp/tts.wav'); \
print(w.getnchannels(),'ch',w.getframerate(),'Hz',round(w.getnframes()/w.getframerate(),2),'s')"
# 1 ch 24000 Hz 2.4 s     <- expected shape, NOT YET RUN HERE. Channels and rate are read
#                            straight out of voice/tts/main.py; the duration is a guess.
```

`X-Synth-Seconds` divided by `X-Audio-Seconds` is the real-time factor. Anything under
1.0 means synthesis outruns playback, which is what the app needs — it chunks Claude's
reply by sentence and plays each one while the next is still being made.

## 6. Turn it on in the sidecar

`/etc/claude-terminal/config.json` is root-owned, so this needs sudo. Add one key:

```json
{
  "owner": "brandon",
  ...
  "bgColor": "#111318",
  "voice": true
}
```

`voice: true` defaults to `http://127.0.0.1:7801` and `http://127.0.0.1:7802`
(`server.ts:589-590`). Only set `sttUrl` / `ttsUrl` explicitly if you move the ports.

```bash
sudo systemctl restart ct-sidecar.service
curl -s -H 'remote-user: brandon' http://127.0.0.1:7682/app/api/models   # as the owner; expect "voice":true
```

Both URLs must be set or `/app/api/models` reports `voice: false`, the mic button stays
hidden, and `/app/api/stt` and `/app/api/tts` return 503. Every `/app` route is owner-gated
(`app-server.ts:145`), so the phone has to be logged in as `brandon` before the mic button
does anything.

---

## The iOS question — verdict

**An iPhone-recorded clip transcribes correctly. There was no decoding gap.** Verified
end-to-end on this box, not reasoned about:

- `app/voice.tsx:120` probes `["audio/webm;codecs=opus", "audio/webm", "audio/mp4",
  "audio/aac", "audio/ogg;codecs=opus"]` and falls back to `""` (browser's choice) if
  `isTypeSupported` is missing. On iOS Safari that lands on `audio/mp4` — MediaRecorder
  there has no webm encoder and produces AAC-LC in a *fragmented* MP4.
- `voice.tsx:223` posts it as `utt.mp4` in a `file` form part. The sidecar forwards the
  raw multipart body and its `content-type` verbatim to `/transcribe`
  (`app-server.ts:179-192`).
- faster-whisper decodes with PyAV, which **bundles FFmpeg** — no system ffmpeg involved,
  and none is installed here. The wheel in the lock (`av` 18.1.0) carries libavcodec 62
  with the native AAC decoder and the mov/mp4 demuxer, both confirmed present.
- `av.open()` probes the container **from the bytes**, so the filename and extension are
  irrelevant.

Measured, same 11 s speech, same service:

| Input | Result |
|---|---|
| fragmented mp4/AAC (iOS shape) | `And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.` — decode 39 ms |
| webm/Opus (Chrome shape) | byte-identical transcript — decode 38 ms |
| iOS clip deliberately mislabeled `utt.webm` | identical transcript |
| non-fragmented plain mp4/AAC | decodes fine |

That last row matters because of a latent bug in `voice.tsx`: if `isTypeSupported` returns
true for a webm string that `new MediaRecorder(...)` then rejects, the code catches the
throw and retries with `new MediaRecorder(stream)` (`voice.tsx:180-181`) — but
`mimeRef.current` is left holding the *webm* string, so the blob type and the `utt.webm`
filename both lie about mp4 content. Harmless, because nothing on the server ever believed
them; noted so nobody chases it later.

### What was actually changed in `voice/stt/main.py`

Decoding was fine. Three things around it were not:

1. **It round-tripped every utterance through a temp file** whose suffix came from the
   client-supplied `file.filename` (`.webm` when absent). Now it decodes from memory with
   `decode_audio(io.BytesIO(raw))` — the same faster-whisper entry point, one less
   write+read of `/tmp` per turn, and the untrusted filename is out of the path entirely.
2. **Undecodable audio returned a 500 carrying a raw ffmpeg errno.** Now it is a `415`
   naming the container that was sniffed, and the journal logs the same. Worth knowing:
   `voice.tsx` reads `d?.text` and silently resumes listening on any error shape, so a
   phone sending something exotic looks to the user like the mic just not working. The
   journal line is where you will see it.
3. **`STT_THREADS` defaulted to a hardcoded 8.** Now it defaults to the core count capped
   at 8 — unchanged on the author's 5900X, correct here. Oversubscribing CTranslate2's
   pool on 2 vCPUs makes short utterances slower, not faster.

Also added: clips under `STT_MIN_SECONDS` (0.35 s) return empty text instead of being
transcribed. Whisper hallucinates confidently on sub-second noise — "Thank you.", "Bye." —
and a door slam getting past the browser VAD would otherwise submit a junk chat turn.

`voice/tts/main.py` is untouched. It has the same hardcoded `TTS_THREADS=8` default, but
the unit sets `TTS_THREADS=2` explicitly, so leaving it alone keeps the next
`git merge upstream/main` clean.

---

## Model sizing on 2 cores

Measured here: `cpu_threads=2`, `compute_type=int8`, `vad_filter=True`, `beam_size=1`,
`nice 5`, against a real 3.5 s speech clip (a typical voice turn) and an 11 s one.

| | tiny.en | **base.en** (chosen) | small.en |
|---|---|---|---|
| Disk | 75 MB | **141 MB** | ~484 MB |
| Process RSS, steady | 224 MB | **267 MB** | ~800 MB+ (est.) |
| Cold model load | 1.9 s | **2.7 s** | ~8 s |
| 3.5 s utterance | 0.57 s (RTF 0.16) | **1.04 s (RTF 0.30)** | ~3 s |
| 11 s utterance | 0.71 s | **1.32 s** | — |
| Punctuation on the 11 s clip | dropped | **kept** | kept |
| Heard "And so my fellow Americans" as | *"And so am I fellow Americans"* | **correct** | correct |

**base.en is the right default here.** The half-second it costs over tiny.en is small next
to the ~110 ms Ann Arbor round trip plus Claude's own time to first token, and the accuracy
row is not a nitpick: tiny.en's misread is exactly the kind of error that derails a chat
turn and makes you say it again, which costs far more than 0.5 s. `STT_MODEL=tiny.en` in
the unit gets the latency back if you disagree. **Do not use small.en on 2 cores** — ~3 s
per turn and 800 MB, which breaks the memory budget below.

**Kokoro-82M**: 82 M parameters, fp32 weights are 327 MB on disk, and the process also
carries CPU torch and spaCy `en_core_web_sm`. Expect **0.9–1.2 GB RSS** — this is the one
number here that is estimated rather than measured, because the CPU torch stack was too
large to install just for a benchmark. Check the real figure on day one:

```bash
systemctl show claude-tts.local.service -p MemoryPeak -p MemoryCurrent
```

and tighten `MemoryHigh` / `MemoryMax` in the unit to about 1.3× what you see.

Upstream reports RTF ~0.18 on a 5900X. Kokoro is torch-CPU-bound and scales roughly with
core count, so on 2 cores expect **RTF around 0.6–0.9** — synthesis still beats playback,
but only just. Because the app sends one sentence at a time, what you feel is
first-sentence latency, not whole-reply latency, so this should stay usable.

**Honest summary: this will be noticeably slower than the author's workstation, and you
will feel it.** Budget roughly 1.0 s of STT after you stop talking, then Claude's own
latency, then a beat before the first sentence comes back. It is a working hands-free mode,
not a snappy one. The failure mode to watch for is *both* services being hot at once
(barge-in while Claude is still speaking) on 2 cores — that is what `CPUWeight=50` and the
shared slice exist to keep away from the terminal.

## Memory budget

3.7 GB total, ~1.2 GB in use before voice, ~2.6 GB available.

| Unit | `MemoryHigh` | `MemoryMax` | Basis |
|---|---|---|---|
| `claude-stt.local.service` | 420M | 600M | measured ~270 MB |
| `claude-tts.local.service` | 1100M | 1500M | estimated 0.9–1.2 GB — **retune after day one** |
| `claude-voice.slice` (both) | 1500M | 1800M | leaves ~1.8 GB for ttyd, the sidecar and Claude sessions |

`MemoryMax` means a runaway voice service gets cgroup-OOM-killed and restarted by systemd,
instead of the kernel's global OOM killer picking whichever process looks tastiest — which
on this box is usually a Claude session. `OOMScoreAdjust=600`/`700` biases the global
killer the same way if it ever does fire. `MemorySwapMax=0` keeps them out of the 4 GB swap,
where an inference process would thrash rather than degrade.

## Troubleshooting

**Service won't start, no useful log.** The hardening block is the usual suspect. Back it
off in this order, restarting between each:

1. `PrivateUsers=yes` — least load-bearing here, most likely to surprise.
2. `SystemCallFilter=@system-service` — torch's OpenMP pool uses `sched_setaffinity` and
   `mbind`, which are in `@system-service`, but a future wheel may reach further. Comment
   the line and `SystemCallErrorNumber` together.
3. `RestrictAddressFamilies` — add `AF_NETLINK` if a library probes interfaces.
4. `ProtectSystem=strict` — if it is this, the real fix is another `ReadWritePaths` entry,
   not dropping the directive. `journalctl` will name the path.

Never add `MemoryDenyWriteExecute=yes`. CTranslate2, onnxruntime and torch all map
executable pages and will die on load.

**`OfflineModeIsEnabled` or a hang on start.** The unit sets `HF_HUB_OFFLINE=1` and blocks
egress, so a model that was never downloaded cannot be fetched at boot. Re-run step 3 as
`ctuser` with the same `HF_HOME` and restart.

**TTS restart-loops immediately.** Check `MemoryPeak` first — the 1500M ceiling is an
estimate and a cold torch load can spike above steady state. Raise `MemoryMax` before
assuming anything subtler.

**Mic button missing in the PWA.** `curl -s -H 'remote-user: brandon' http://127.0.0.1:7682/app/api/models` as the
owner and look at `voice`. `false` means the sidecar has no `sttUrl`/`ttsUrl` — the
config edit or the restart in step 6 did not take.

**Voice mode "hears nothing" on one device only.** Watch `journalctl -u
claude-stt.local.service -f` while you talk to it. Every request logs its byte count and
the sniffed container. No line at all means the audio never reached the service (owner
gate, or `voice.tsx` dropped the clip — it discards blobs under 1200 bytes at
`voice.tsx:188`). A line with a `415` means the container is genuinely new, and the message
names it.
