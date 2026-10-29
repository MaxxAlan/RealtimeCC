# End-to-End Latency & Accuracy Benchmark (authoritative)

**Rule:** Do **not** claim realtime or compare engines using offline RTF, worker-only smoke, or the in-app diagnostic percentiles. Those numbers exclude loopback, IPC, and overlay paint, and their `capturedAt` is estimated from the renderer send time (`Date.now() - 80`), not from audio sample time.

This document defines the only measurement that may be used for acceptance or engine comparison.

---

## 1. Goal metrics (all required)

| Metric | Definition | Target (acceptance) |
|--------|------------|---------------------|
| **E2E latency P50** | Time from *audio sample present at loopback* to *first corresponding partial visible on overlay* | < 500 ms |
| **E2E latency P95** | Same, 95th percentile over matched words | < 1000 ms |
| **WER** | Word Error Rate vs ground-truth transcript of the fixture | Report; no hard gate yet |
| **Dropped chunks** | Chunks rejected by the in-flight queue during the run | Report (ideally 0) |
| **CPU / process** | Peak % of logical cores used by RealtimeCC during the run | Report |
| **GPU / VRAM** | Peak VRAM of RealtimeCC (or 0 if CPU provider) | Report |

Secondary (diagnostic only, never for acceptance): worker inference ms, RTF, session `p50Ms`/`p95Ms` from `caption:visible`.

---

## 2. Ground-truth fixture

### Required contents

1. **Audio file** — 16 kHz mono WAV (or any rate; the player resamples). Duration 30–90 s of continuous speech in the target language (e.g. Vietnamese).
2. **Reference transcript** — plain text, one utterance per line or a single block. Must match the spoken content.
3. **Word onset map** (JSON) — absolute times relative to **file start** (t = 0 = first sample):

```json
{
  "audioFile": "fixture-vi-01.wav",
  "sampleRate": 16000,
  "durationMs": 42150,
  "language": "vi",
  "words": [
    { "word": "xin", "startMs": 820, "endMs": 1050 },
    { "word": "chào", "startMs": 1080, "endMs": 1420 },
    ...
  ],
  "transcript": "xin chào ..."
}
```

How to build the onset map:

- Prefer forced alignment (e.g. Whisper timestamped, Montreal Forced Aligner, or manual marking in Audacity).
- Onsets must be accurate to ~±30 ms; coarser maps inflate latency variance and are not acceptable for engine comparison.

Place fixtures under `fixtures/e2e/` (not committed if large; document download path).

### Playback

- Play the WAV through the **Windows default shared-mode playback endpoint** (same device loopback will capture).
- Use a player that does not apply large buffers (e.g. `ffplay -nodisp -autoexit fixture.wav` or the system player with known start).
- Record **playback start wall-clock** (`t_play0`) with high resolution at the moment the first sample is written to the device (or as close as the tool allows; document the method).

---

## 3. Measurement procedure

1. **Warm-up**  
   Start RealtimeCC, download the model under test, run 10–15 s of any speech so the worker and Electron paths are hot. Stop.

2. **Start captions**  
   Start local (or cloud) captions. Allow the desktop-capture prompt. Overlay visible.

3. **Start recording of diagnostics**  
   - Enable any in-app metrics log if present.  
   - Optionally attach Performance Monitor / `nvidia-smi -l 1` for CPU/GPU/VRAM.

4. **Play fixture**  
   Note `t_play0`. Play the full fixture once without pause.

5. **Collect overlay events**  
   For every partial/final that appears on the overlay, record:
   - `t_visible` — wall-clock when the text was painted (rAF double-buffer callback is acceptable).
   - `text` — the string shown.

6. **Align words**  
   For each reference word `w` with `startMs`:
   - Expected audio time: `t_audio = t_play0 + startMs`
   - Find the **first** overlay event whose text contains `w` (or the cumulative hypothesis that first includes `w`) after `t_audio - 200 ms` (tolerance for early partials).
   - Latency for that word: `L = t_visible - t_audio`
   - Discard matches that are clearly wrong (e.g. latency < −100 ms or > 5000 ms) and log them as alignment failures.

7. **Compute**  
   - P50 / P95 / P99 of all valid `L` values.  
   - WER on the final session transcript vs reference transcript (standard word tokenization for the language).  
   - Dropped chunks from the app metrics at session end.  
   - Peak CPU % and VRAM from the external monitor.

8. **Repeat**  
   At least **5 full runs** after warm-up. Report median of the run-level P50/P95, or pool all word latencies and report overall percentiles. State which method was used.

---

## 4. Why current in-app numbers are not acceptance

| Source | What it measures | Missing |
|--------|------------------|---------|
| `scripts/bench-asr.ts` | Worker decode only, file → recognizer | Loopback, IPC, overlay paint, true audio time |
| Worker `inferenceMs` | Time inside `acceptWaveform` + `decode` | Everything outside the worker |
| `caption:visible` → `endToEndMs` | `Date.now() - captureAt` where `captureAt ≈ Date.now() - 80` at send | Not tied to sample time at the sound card; clock skew between processes |
| Session P50/P95 in UI | Same as above | Diagnostic only |

Until a fixture-based run is recorded, the README must continue to state that the latency target is **not met** / **not measured**.

---

## 5. Fair engine comparison

When comparing Nemotron 80 ms vs 160/560/1120 ms, Sherpa CUDA, or whisper.cpp:

1. Same fixture, same `t_play0` method, same machine, same Windows audio endpoint.
2. Same warm-up policy.
3. Report the full table: E2E P50/P95, WER, drops, CPU, VRAM.
4. Do not mix offline RTF of one engine with E2E of another.

---

## 6. Implementation checklist (code)

- [ ] Fixture package + onset JSON under `fixtures/e2e/` (or documented external path).
- [ ] Overlay path reports `t_visible` with a stable clock (already uses double rAF).
- [ ] Optional: log every caption event to a JSONL file during a “benchmark session” mode for offline alignment.
- [ ] Document how `t_play0` was obtained (ffplay start, WASAPI event, etc.).
- [ ] Script `scripts/align-e2e.ts` (or Python) that reads reference onsets + caption JSONL and prints P50/P95/WER.
- [ ] README latency section links here and forbids using worker-only numbers for acceptance.

---

## 7. Minimal first run (practical)

1. Pick one 30–60 s Vietnamese clip you can transcribe by hand.
2. Mark 20–40 clear word onsets in Audacity (label track → export).
3. Play via ffplay; start captions beforehand; video-record the overlay or use the caption JSONL log.
4. Manually or with a small script compute latencies for those words.
5. Publish the table in the README under “E2E measurement (fixture-based)” with date, machine, variant, and method for `t_play0`.

That single table becomes the baseline. All future engine changes must beat or match it on the same fixture.
