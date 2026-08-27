# claude-stt — local Whisper speech-to-text for the chat app's hands-free voice mode.
#
# Records mic audio in the browser (MediaRecorder -> webm/opus on Chrome/Android,
# mp4/aac on iOS Safari), POSTs the blob here, faster-whisper transcribes it -> text.
# All server-side so it works identically on iOS (no Web Speech API there) and Android.
#
# Binds loopback only; the claude-terminal sidecar proxies it at /app/api/stt and
# owner-gates the request. Never exposed directly.
import io
import os
import time

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

# base.en, not upstream's small.en: on 2 cores small.en is ~3s per turn at ~800MB RSS,
# which does not fit this box's memory budget. The systemd unit sets STT_MODEL too,
# but the default has to be safe on its own for hand-run debugging sessions.
MODEL_SIZE = os.environ.get("STT_MODEL", "base.en")
DEVICE = os.environ.get("STT_DEVICE", "cpu")
COMPUTE = os.environ.get("STT_COMPUTE", "int8")
# faster-whisper is CPU-thread-bound. Default to the core count (capped at 8) rather than
# a hardcoded 8: on a 2-vCPU box, oversubscribing CTranslate2's thread pool makes short
# utterances *slower*, not faster. STT_THREADS overrides.
CPU_THREADS = int(os.environ.get("STT_THREADS", "0")) or max(1, min(8, os.cpu_count() or 4))

SAMPLE_RATE = 16000  # what decode_audio() resamples everything to, and what Whisper wants
# Clips shorter than this are almost always a door slam or a keyboard clack that slipped
# past the browser's VAD. Whisper hallucinates confidently on sub-second noise ("Thank
# you.", "Bye."), which would submit a junk chat turn, so return empty text instead and
# let the caller resume listening.
MIN_SPEECH_SECONDS = float(os.environ.get("STT_MIN_SECONDS", "0.35"))

print(f"[stt] loading {MODEL_SIZE} device={DEVICE} compute={COMPUTE} threads={CPU_THREADS}", flush=True)
_t0 = time.time()
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE, cpu_threads=CPU_THREADS)
print(f"[stt] model ready in {time.time() - _t0:.1f}s", flush=True)

app = FastAPI()


# Container sniffing is *diagnostic only* — PyAV probes the bytes itself and ignores both
# the filename and this guess. It exists so the log line and the 415 body can name what
# the phone actually sent, which is the one thing you want to know when voice mode breaks
# on one device and works on another.
_MAGIC = (
    (b"\x1a\x45\xdf\xa3", 0, "webm/matroska"),
    (b"OggS", 0, "ogg"),
    (b"fLaC", 0, "flac"),
    (b"ID3", 0, "mp3"),
    (b"ftyp", 4, "mp4/m4a (iOS Safari MediaRecorder)"),
    (b"RIFF", 0, "wav"),
    (b"caff", 0, "caf"),
    (b"#!AMR", 0, "amr"),
)


def sniff(raw: bytes) -> str:
    for magic, off, name in _MAGIC:
        if raw[off:off + len(magic)] == magic:
            return name
    if len(raw) > 1 and raw[0] == 0xFF and (raw[1] & 0xE0) == 0xE0:
        return "mpeg audio"
    return f"unrecognised (starts {raw[:12].hex()})"


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_SIZE, "device": DEVICE, "compute": COMPUTE, "threads": CPU_THREADS}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = Form("en")):
    raw = await file.read()
    if not raw:
        return JSONResponse({"error": "empty audio"}, status_code=400)

    container = sniff(raw)

    # Decode straight from memory. faster-whisper's decode_audio() hands the bytes to
    # PyAV, which bundles FFmpeg — it probes the container from the byte stream, so
    # webm/opus (Chrome, Android) and fragmented mp4/aac (iOS Safari) both decode with no
    # branching here and no ffmpeg on the box. Doing it in memory also means we never
    # trust the client-supplied filename, which is the only thing the old temp-file path
    # used it for, and it drops a write+read of every utterance through /tmp.
    try:
        audio = decode_audio(io.BytesIO(raw), sampling_rate=SAMPLE_RATE)
    except Exception as e:  # noqa: BLE001 — PyAV raises several unrelated error types
        print(f"[stt] undecodable {len(raw)}B {container}: {e}", flush=True)
        return JSONResponse(
            {
                "error": (
                    f"could not decode the recording: FFmpeg does not accept these bytes "
                    f"(detected {container}). Check what MediaRecorder produced on this "
                    f"browser — expected webm/opus or mp4/aac."
                ),
                "container": container,
                "bytes": len(raw),
                "detail": str(e),
            },
            status_code=415,
        )

    seconds = len(audio) / SAMPLE_RATE
    if seconds < MIN_SPEECH_SECONDS:
        print(f"[stt] {len(raw)}B {container} -> {seconds:.2f}s, below floor, dropped", flush=True)
        return {"text": "", "language": language, "seconds": 0.0, "audioSeconds": round(seconds, 3)}

    t0 = time.time()
    try:
        segments, info = model.transcribe(
            audio,
            language=None if language == "auto" else language,
            beam_size=1,           # greedy — fastest, plenty accurate for short turns
            vad_filter=True,       # drop leading/trailing silence -> faster + cleaner
            vad_parameters={"min_silence_duration_ms": 300},
            condition_on_previous_text=False,
        )
        text = "".join(s.text for s in segments).strip()
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"transcribe failed: {e}"}, status_code=500)

    dt = time.time() - t0
    print(
        f"[stt] {len(raw)} bytes {container} {seconds:.2f}s -> {len(text)} chars "
        f"in {dt:.2f}s (rtf {dt / max(seconds, 0.01):.2f}): {text[:80]!r}",
        flush=True,
    )
    return {"text": text, "language": info.language, "seconds": round(dt, 3), "audioSeconds": round(seconds, 3)}
