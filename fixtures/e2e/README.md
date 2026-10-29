# E2E fixtures

Place ground-truth packages here (or document an external path). Each fixture needs:

1. `*.wav` — speech audio (prefer 16 kHz mono)
2. `*.json` — word onset map (see template below)

Do **not** commit large WAVs if the repo must stay small; host them elsewhere and record the URL + SHA-256 in this README.

## JSON template

```json
{
  "audioFile": "vi-01.wav",
  "sampleRate": 16000,
  "durationMs": 42150,
  "language": "vi",
  "transcript": "xin chào các bạn ...",
  "words": [
    { "word": "xin", "startMs": 820, "endMs": 1050 },
    { "word": "chào", "startMs": 1080, "endMs": 1420 }
  ]
}
```

Build onsets with forced alignment or manual labels in Audacity. Target ±30 ms accuracy.

## Running a measurement

1. Warm up RealtimeCC and start local captions.
2. Note wall-clock `play0` at the instant fixture playback starts on the default Windows endpoint.
3. Play the WAV once.
4. Stop captions. Session log is written under `%APPDATA%/realtimecc/bench-logs/session-*.jsonl`.
5. Align:

```powershell
npx tsx scripts/align-e2e.ts --fixture fixtures/e2e/vi-01.json --log "%APPDATA%\realtimecc\bench-logs\session-….jsonl" --play0 1730000000000
```

See `docs/E2E_BENCHMARK.md` for the full protocol. Offline RTF and in-app diagnostic P50/P95 are not acceptance metrics.
