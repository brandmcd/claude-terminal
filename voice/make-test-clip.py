#!/usr/bin/env python3
"""Re-encode an audio file into the exact container iOS Safari's MediaRecorder produces.

Safari on iOS has no webm encoder: MediaRecorder there emits *fragmented* MP4 with an
AAC-LC track (ftyp + empty moov + moof/mdat), not the webm/opus every other browser
gives. This script reproduces that shape so you can prove the STT service handles an
iPhone recording without owning an iPhone or installing ffmpeg — it runs on the PyAV that
faster-whisper already bundles.

    voice/stt/.venv/bin/python voice/make-test-clip.py speech.flac ios.mp4
    voice/stt/.venv/bin/python voice/make-test-clip.py speech.flac chrome.webm --webm

See voice/README-thisbox.md ("Smoke tests").
"""
import argparse
import sys
from fractions import Fraction

import av
import numpy as np

RATE = 48000  # what a phone mic actually hands MediaRecorder


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="any audio file ffmpeg can read")
    ap.add_argument("dst", help="output path")
    ap.add_argument("--webm", action="store_true", help="emit webm/opus (Chrome/Android) instead")
    args = ap.parse_args()

    # Decode to mono s16 at RATE.
    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=RATE)
    parts = []
    with av.open(args.src) as inp:
        for frame in inp.decode(audio=0):
            for r in resampler.resample(frame):
                parts.append(r.to_ndarray())
        for r in resampler.resample(None):
            parts.append(r.to_ndarray())
    if not parts:
        print(f"no audio stream in {args.src}", file=sys.stderr)
        return 1
    pcm = np.concatenate(parts, axis=1).astype(np.int16)

    if args.webm:
        fmt, codec, opts = "webm", "libopus", {}
    else:
        # empty_moov + frag_keyframe + default_base_moof is what a streaming recorder
        # writes: the moov carries no sample table and every chunk is its own fragment.
        fmt, codec = "mp4", "aac"
        opts = {"movflags": "frag_keyframe+empty_moov+default_base_moof"}

    with av.open(args.dst, mode="w", format=fmt, options=opts) as out:
        stream = out.add_stream(codec, rate=RATE, layout="mono")
        frame = av.AudioFrame.from_ndarray(pcm, format="s16", layout="mono")
        frame.sample_rate = RATE
        frame.pts = 0
        frame.time_base = Fraction(1, RATE)
        for packet in stream.encode(frame):
            out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)

    seconds = pcm.shape[1] / RATE
    print(f"wrote {args.dst}: {fmt}/{codec}, {seconds:.2f}s mono @ {RATE} Hz")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
