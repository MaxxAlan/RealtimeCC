# RealtimeCC

RealtimeCC is a Windows live-caption desktop app. It captures the Windows system playback mix and displays partial and final text in a floating overlay. Choose local Nemotron for on-device recognition, or explicitly opt in to Google Live for a broader language list and cloud streaming. Google mode sends captured system audio to Google; it is never enabled by default and requires a per-session consent checkbox.

## Language and provider choice

The provider selector defaults to **Local · private**. Speech input language and caption output language are separate settings. Local mode supports same-language captions for 28 locally ready languages. Select **Google Live · cloud** for the broader speech list or to translate speech into one of 84 supported output languages, enter a Google AI API key, and check the explicit audio-sharing consent before each session. For example, choose French as the input and Japanese as the output, or Japanese input and Vietnamese output. The key is encrypted with Windows secure storage. A selected language is a recognition hint, not a promise of perfect accuracy; use Auto-detect for multilingual speech.

The local Nemotron model is ASR (speech recognition), not machine translation. It can transcribe Vietnamese speech into Vietnamese text, but it cannot translate English speech into Vietnamese. Cross-language output requires Google Live translation. Switching providers while captions are running restarts only the recognition connection and keeps the loopback capture active; changing from translated Cloud mode to Local switches output back to the spoken language.

Google Live receives 80 ms mono PCM chunks and emits interim transcription updates while speech is active. Translation uses Google's dedicated live audio translation model and its translated text transcription. This streaming path is designed to show readable partial captions without waiting for a sentence to finish. Actual end-to-end latency depends on network, service, language, and device conditions. No sub-1-second claim is made until a timestamped loopback benchmark on the target machine confirms it.

The local model is preloaded at application startup when installed and stays warm between caption sessions. For online movies, browser video, and meetings such as Google Meet, do not download the media file: press **Start captions** and RealtimeCC captions the system audio live. **Optional: prepare subtitles for a media file** is only for a local file you choose. It prepares captions before playback and then uses the built-in player to synchronize them. The app decodes the selected file locally through Chromium; supported formats depend on codecs available in this Electron build. Preparation plays audio silently at normal speed and pauses when local recognition needs to catch up, so a long file can take as long as or longer than its playback duration. Cross-language file preparation uses Google Live and streams the selected file audio only after consent. Use **Export SRT** to save completed captions in SubRip format. Closing the floating captions window hides it; the main RealtimeCC app and audio session continue running.

## Local model choice

Qwen3-ASR-0.6B is not used for the latency-critical streaming path. The official Qwen3-ASR README says its streaming inference is currently available only through the vLLM backend, while official vLLM installation requirements are Linux and vLLM does not support Windows natively. Qwen3 through ordinary Transformers is a non-streaming API. This app instead uses sherpa-onnx's Windows x64 Node addon with the multilingual Nemotron 3.5 ASR 0.6B INT8 streaming model, which has published 80 ms, 160 ms, 560 ms and 1120 ms model chunks. The 80 ms variant is selected for earliest partials; its accuracy/latency trade-off has not yet been measured on this PC.

The model files are fetched from the official sherpa-onnx release when the user selects **Download model**. The compressed download is about 475 MB; the extracted model uses about 700 MB. The inference provider runs on CPU in this build. The GTX 1650 has 4 GB VRAM, but a CUDA sherpa-onnx Windows runtime is not currently enabled or verified here.

## Requirements and run

- Windows 10/11 x64 with a shared-mode playback endpoint.
- Node.js 20.19+ and npm for development/build.
- Internet access for npm installation and the one-time ASR model download.

```powershell
npm install
npm run dev
```

In the app, download the local model once, then press **Start captions** and allow the Windows desktop-capture prompt. Electron uses its documented Windows desktop loopback audio path; the small video track is stopped immediately. The app opens a separate always-on-top overlay. `Ctrl+Shift+C` shows or hides it.

## Build

```powershell
npm run typecheck
npm test
npm run dist:win
```

The installer is written to `release/`. The installer is not code-signed.

## Latency target and current benchmark status

Target: P50 < 500 ms and P95 < 1000 ms from audio entering loopback capture to the first corresponding partial caption becoming visible. This target is **not met**. Two warmed worker-only replays of the model package's 4.017-second WAV, fed in 80 ms PCM chunks on the actual CPU, produced variable results:

| Measurement | Result | Scope |
| --- | ---: | --- |
| P50 / P95 / P99 | Run 1: 614 / 844 / 850 ms; run 2: 980 / 1696 / 1731 ms | Model token timestamp to worker emission; excludes loopback, IPC, and overlay paint |
| First partial | 395 ms / 444 ms | Run 1 / run 2; worker-only, not overlay-visible |
| Replay duration / processing duration | Run 1: 4.017 / 4.696 s (RTF 1.17); run 2: 4.017 / 5.422 s (RTF 1.35) | One included sample, two warmed runs |
| Processed / dropped chunks | Run 1: 51 / 0; run 2: 49 / 2 | Worker replay queue; not live Windows capture |
| Mean inference time | Run 1: 86.7 ms; run 2: 106.5 ms | Per 80 ms input chunk |
| Live loopback trial | 52 dropped chunks | One 4-second playback; live captions appeared, but accuracy and latency were not measured |
| WER | Not measured | No independently timestamped reference transcript was available |
| ASR VRAM | 0 MiB by configuration | CPU provider; total Electron GPU memory was not isolated |
| Loopback-to-painted-overlay P50 / P95 / P99 | Not measured | Requires live loopback and ground-truth speech timestamps |

Both worker-only P50 runs exceed the 500 ms target, and one P95 exceeds 1000 ms. The live loopback trial also dropped 52 chunks. These results fail the current performance acceptance criteria. The smoke runs are too small and exclude rendering, so they do not provide a qualifying end-to-end latency benchmark.

**Diagnostic-only numbers (do not use for acceptance or engine comparison):**
- Worker-only / offline RTF (`scripts/bench-asr.ts`)
- In-app session P50/P95 from `caption:visible` (based on estimated `capturedAt ≈ Date.now() - 80` at send time, not audio sample time)

**Authoritative measurement:** see [`docs/E2E_BENCHMARK.md`](docs/E2E_BENCHMARK.md). Requirements: same fixture with ground-truth word onsets, playback through the Windows default endpoint, overlay-visible timestamps, then alignment with `scripts/align-e2e.ts`. Report E2E P50/P95, WER, dropped chunks, CPU, and VRAM. Until that table exists, the latency target remains **not measured** for acceptance.

## GPU prototypes (Sherpa CUDA · whisper.cpp)

See [`docs/GPU_PROTOTYPE.md`](docs/GPU_PROTOTYPE.md). Stock Node addon is **CPU**; CUDA is optional/`auto` with **CPU fallback**. whisper.cpp stream examples use **≥500 ms** steps — do not assume &lt;400 ms E2E without measurement.

## Tuning Nemotron / chunking (do this before changing engines)

The live path currently defaults to the **80 ms** INT8 Nemotron 3.5 streaming model on CPU. Larger chunk variants trade a bit of latency for higher accuracy and lower per-chunk overhead.

Supported variants (downloadable from the app or manually):

| Variant | Model folder suffix | Typical use |
|---------|---------------------|-------------|
| 80ms    | `…-80ms-int8-2026-06-11`  | Lowest latency partials (current default) |
| 160ms   | `…-160ms-int8-2026-06-11` | Balanced |
| 560ms   | `…-560ms-int8-2026-06-11` | Higher accuracy, good for pre-roll batch |
| 1120ms  | `…-1120ms-int8-2026-06-11`| Highest accuracy / throughput for offline-style |

**Benchmark (worker-only, streaming simulation):**

```powershell
# After downloading a model inside the app
npx tsx scripts/bench-asr.ts --variant 80
npx tsx scripts/bench-asr.ts --variant 160
npx tsx scripts/bench-asr.ts --variant 560 --chunk-ms 80
npx tsx scripts/bench-asr.ts --variant 1120 --threads 4
```

Reports RTF, first-partial latency, per-chunk inference P50/P95, and simulated drop rate under a live-like 80 ms feed. JSON reports land in `bench-cache/`.

**Settings (local ASR path):**
- `asrPrerollVariant`: `80ms` | `160ms` | `560ms` | `1120ms` (model files must match)
- `asrThreads`: CPU threads for sherpa-onnx (default 4; try 2–6 on a 6-core laptop)
- `asrAggregateMs`: `80` | `160` | `240` — coalesce capture frames before IPC/inference. Larger values cut IPC and decode calls but delay the first partial of each block. Trade-off experiment, not a free lunch.

**Queue:** bounded by **audio duration in flight** (max 960 ms), not an unbounded message pile. Drops when the engine falls behind real time — the goal is RTF &lt; 1 (process faster than audio), not raising the limit to hide lag.

**Suggested sweep on the target PC** (worker-only, still not E2E acceptance):

```powershell
foreach ($v in 80,160,560,1120) {
  foreach ($t in 2,4,6) {
    foreach ($c in 80,160,240) {
      npx tsx scripts/bench-asr.ts --variant $v --threads $t --chunk-ms $c --runs 2
    }
  }
}
```

Pick the best (variant, threads, aggregate) by RTF and first-partial, then confirm with the fixture E2E protocol in `docs/E2E_BENCHMARK.md`. Only after that should CUDA Sherpa or whisper.cpp prototypes start.

## Actual machine inspected


- AMD Ryzen 5 5600H
- NVIDIA GeForce GTX 1650, 4 GB VRAM
- Python 3.14.6 is present; PyTorch is not installed.
- vLLM native Windows support is not available; WSL2/CUDA passthrough has not been configured or verified.
- .NET runtimes are installed, but no .NET SDK or C++ compiler was found.

## Known limitations

- Capture uses the default playback endpoint. Electron's loopback capture path here does not provide output-device selection or automatic device-switch recovery.
- Exclusive-mode playback, protected content, disconnected devices, remote audio routing, and driver limitations can prevent loopback capture.
- Model inference currently uses the CPU provider. ASR is configured for 0 MiB VRAM; total application GPU memory, long-session memory behavior, and loopback-to-overlay target latency are unmeasured.
- The local selector exposes locally ready languages and automatic detection. Google Live offers a much broader published BCP-47 list; language support does not guarantee equal accuracy for every language.
- Latency markers and session percentiles are diagnostic estimates, not calibrated ground-truth measurements. Google Live does not provide word-level timestamps, so cloud onset-to-overlay figures are approximate. Do not use them to claim the acceptance threshold.
- Google Live sessions are limited to the service's session duration and require a new connection after disconnection. The app does not yet automatically reconnect a long-running cloud session.
- Model download/extraction requires sufficient disk space for the compressed archive and extracted model.

## References

- [Qwen3-ASR official README](https://github.com/QwenLM/Qwen3-ASR) (streaming is vLLM-only)
- [vLLM GPU installation requirements](https://docs.vllm.ai/en/latest/getting_started/installation/gpu.html) (Linux; no native Windows support)
- [sherpa-onnx multilingual Nemotron streaming model](https://k2-fsa.github.io/sherpa/onnx/nemo/nemotron-streaming.html)
- [sherpa-onnx Node addon](https://k2-fsa.github.io/sherpa/onnx/javascript-api/install.html) (Windows x64)
- [Google Gemini Live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe) (interim transcription, audio chunk format, and supported languages)
- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer/)
- [Microsoft WASAPI loopback capture](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)


