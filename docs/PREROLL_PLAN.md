# RealtimeCC — Offline Translation (TranslateGemma 4B) & Pre-roll Subtitles Architecture Plan

## 1. System Overview

RealtimeCC currently provides live captions for Windows desktop audio using a local CPU-based streaming ASR model (Nemotron 3.5 0.6B INT8) or Google Live cloud streaming.
This plan introduces:
1. **Offline on-device translation** using Google's **TranslateGemma 4B** (quantized GGUF via `node-llama-cpp`).
2. **Audio-first pre-roll subtitle pipeline** for online video playback: pre-fetching lowest-bitrate audio ahead of the video playhead, running high-throughput local ASR and sentence-level translation, accumulating timestamped cues in video media time, and presenting cues with zero delay aligned to the browser's playback position.

```
 Browser tab (Chrome/Edge)                         RealtimeCC (Electron)
 ┌──────────────────────────┐   ws://127.0.0.1    ┌──────────────────────────────────────────────────────────────┐
 │ MV3 extension            │ ──────────────────► │ ExtensionBridge  (ws, token + Origin check)                  │
 │  content script: <video> │  tick/event/media   │    │ pageUrl, position, paused, rate, seeking, ad, drm       │
 │  background SW: socket   │ ◄────────────────── │    ▼                                                         │
 └──────────────────────────┘  pause/play cmds    │ PlaybackClock  (extrapolated media-time, rate-aware)         │
                                                  │    │                         ▲                              │
                                                  │    ▼                         │ readyAhead / coverage         │
                                                  │ PrerollScheduler ───────────────────────────────┐           │
                                                  │    │ plan windows around playhead, handle seek   │           │
                                                  │    ▼                                             │           │
                                                  │ AudioSource: yt-dlp(JSON→direct URL, worst audio)│           │
                                                  │   → ffmpeg -ss T -i URL → 16 kHz mono s16le pipe │           │
                                                  │    ▼  (as fast as network/decoder allow,         │           │
                                                  │        bounded by back-pressure)                 │           │
                                                  │ AsrBatchWorker (sherpa-onnx, throughput config)  │           │
                                                  │    ▼  segments {startMs,endMs,text} in VIDEO time│           │
                                                  │ Segmenter (merge to sentence-like units)         │           │
                                                  │    ▼                                             │           │
                                                  │ TranslatorClient ─► utilityProcess(.mjs):        │           │
                                                  │   node-llama-cpp + TranslateGemma-4B GGUF        │           │
                                                  │    ▼                                             ▼           │
                                                  │ CueStore (cues + coverage intervals + disk cache)────────────┘
                                                  │    ▼                                                         │
                                                  │ CuePlayer: setTimeout to next cue boundary → broadcast       │
                                                  │            ('caption', {source:'media'}) → overlay window    │
                                                  └──────────────────────────────────────────────────────────────┘
```

---

## 2. Target Modules & Seams

All new logic will reside under `src/main/preroll/` (with pure modules unit-tested in `tests/`) to preserve the minimal, surgical edit requirement for `src/main/index.ts` and `src/renderer/main.tsx`.

| Module Path | Primary Responsibility | Seams & Interfaces |
| --- | --- | --- |
| `src/main/preroll/types.ts` | Shared domain types and interfaces | `Ms`, `Interval`, `AsrSegment`, `TranslationUnit`, `MediaCue`, `AudioSource`, `AsrBackend`, `Translator`, `Clock`, `PrerollStatus` |
| `src/main/preroll/translategemma-languages.ts` | 55 official language codes, BCP-47 mapping, validation | `toTranslateGemmaCode()`, `isSupportedPair()`, `getTranslateGemmaLanguages()` |
| `src/main/preroll/translategemma-prompt.ts` | Exact turn-based prompt construction and output sanitization | `buildPrompt()`, `cleanOutput()` |
| `src/main/preroll/model-manager.ts` | Resumable downloads, SHA-256 checksums, model paths & status | `downloadModelWithChecksum()`, `verifyChecksum()`, `getTranslatorModelStatus()` |
| `src/main/preroll/translator-worker.mjs` | Standalone ESM worker running `node-llama-cpp` | Spun up via Electron `utilityProcess.fork()`; JSON-RPC style messages over IPC |
| `src/main/preroll/translator-client.ts` | Main process facade managing worker lifecycle & requests | `Translator` interface, crash auto-restart, request abort, batching |
| `src/main/preroll/audio-source.ts` | `yt-dlp` metadata resolution & `ffmpeg` PCM streaming | `AudioSource` interface, non-reconnect s16le stdout streaming |
| `src/main/preroll/asr-batch-worker.ts` | Sherpa-onnx batch worker tuned for throughput (1120ms chunk) | `AsrBackend` interface, operates in absolute media time |
| `src/main/preroll/segmenter.ts` | Combines raw ASR fragments into sentence-sized units | Pure function/class, punctuation + silence gap heuristics |
| `src/main/preroll/cue-format.ts` | Formats and wraps translated text into compliant subtitles | Max 2 lines, Latin ≤42 chars/line, CJK ≤20 chars/line, min duration |
| `src/main/preroll/cue-store.ts` | In-memory cue collection, interval coverage, disk cache, SRT export | Interval arithmetic, binary search `cueAt()`, LRU file caching |
| `src/main/preroll/playback-clock.ts` | Media playhead tracking with rate and monotonic extrapolation | `Clock` interface, drift slewing vs hard jump logic |
| `src/main/preroll/cue-player.ts` | Event/timer-driven cue emitter targeting the overlay window | Zero-polling boundary timer (`setTimeout`), sync offset & lead adjustments |
| `src/main/preroll/scheduler.ts` | Pipeline state coordinator and buffer gatekeeper | State machine managing 5-min gate, seek re-planning, back-pressure |
| `src/main/preroll/extension-bridge.ts` | WebSocket server on 127.0.0.1 for browser extension | Token auth, origin validation, message rate-limiting |
| `src/main/preroll/index.ts` | `PrerollSession` facade wiring pipeline components | Clean entry point consumed by `src/main/index.ts` |

---

## 3. IPC Channels and Communication

### Existing Channels Extended / Updated
- `settings:get`: Returns extended settings including pre-roll, translator model status, and extension pairing token.
- `settings:save`: Validates and saves new settings patch keys with strict type/range checking.
- `session:start` / `session:stop`: Handles provider transitions and initiates pre-roll if online video is active.
- `session:reconfigure`: Permits runtime language reconfiguration for local translator without raising "unsupported" error.
- `captions:export-srt`: Exports media-time pre-roll subtitles when in pre-roll mode.

### New IPC Channels
- `translator:download`: Starts background resumable download of TranslateGemma GGUF with progress emissions.
- `translator:status`: Checks local presence and SHA-256 validity of the GGUF model.
- `preroll:start`: Explicitly initiates pre-roll processing for a target URL (or current extension-reported URL).
- `preroll:stop`: Stops active pre-roll pipeline and releases child processes/workers.
- `preroll:play-now`: Opens the gate immediately before the 5-minute pre-roll threshold is satisfied.
- `preroll:set-manual-url`: Sets a manual video URL when the browser extension is not installed.
- `preroll:cache-clear`: Flushes local cached transcripts from `userData/preroll-cache/`.
- `extension:pairing`: Returns port and authentication token for Chrome/Edge extension pairing.

### Event Channels (Main → Renderer Broadcast)
- `translator-progress`: `{ state: 'idle'|'downloading'|'verifying'|'ready'|'error', received, total, percent, message }`
- `preroll-status`: `PrerollStatus` (`state`, `readyAheadMs`, `playheadMs`, `underruns`, `asrRtf`, `unitsPerSecond`, `message`)
- `caption`: Existing channel, extended with `source: 'media' | 'live'` to differentiate zero-delay pre-roll cues from live ASR text.

---

## 4. Settings Schema Additions

Additions to `Settings` type:
```ts
interface Settings {
  // Existing fields
  model: string;
  provider: 'local' | 'gemini';
  language: string;
  outputLanguage: string;
  fontSize: number;
  opacity: number;
  historySeconds: number;
  clickThrough: boolean;
  hotkey?: string;
  overlay: { x?: number; y?: number; width: number; height: number };

  // New fields
  preroll: {
    enabled: boolean;              // default: true
    prerollSeconds: number;        // range: 60..1800, default: 300 (5 minutes)
    holdPlaybackUntilReady: boolean; // default: true (gate pause)
    syncOffsetMs: number;          // range: -3000..3000, default: 0
    displayLeadMs: number;         // range: 0..300, default: 0
    cacheEnabled: boolean;         // default: true
    asrVariant: string;            // default: '1120ms'
  };
  translator: {
    quant: 'Q4_K_M' | 'Q8_0';     // default: 'Q4_K_M'
    gpu: 'auto' | 'off';           // default: 'auto'
  };
}
```

Validation in `validateSettingsPatch`:
- Allow-list keys `preroll` and `translator`.
- Strict validation of nested numerical bounds (`prerollSeconds` ∈ [60, 1800], `syncOffsetMs` ∈ [-3000, 3000], `displayLeadMs` ∈ [0, 300]).
- Reject unlisted properties or invalid enumerations.

---

## 5. Architectural Risks & Mitigations

### 1. ESM-Only Native Package (`node-llama-cpp` v3)
- **Risk:** Main process is compiled as CommonJS (`tsconfig.main.json`). Attempting `await import('node-llama-cpp')` in CommonJS gets transpiled to `require()`, throwing `ERR_REQUIRE_ESM`. Furthermore, native crashes in llama.cpp would take down the entire Electron application.
- **Mitigation:** Execute the model engine inside an Electron `utilityProcess` running a native `.mjs` entrypoint (`translator-worker.mjs`). The build script ensures this `.mjs` file is copied to `dist/main/preroll/`. `utilityProcess` provides isolated process memory, separate V8 instance, native crash isolation, and bidirectional Node MessagePort communication.

### 2. Windows Native Binaries & VRAM Headroom (GTX 1650 4 GB)
- **Risk:** The target device has 4 GB VRAM and no CUDA toolkit installed. Large models or unmanaged GPU allocations will trigger CUDA Out Of Memory or crash.
- **Mitigation:**
  - Standardize on `translategemma-4b-it-Q4_K_M.gguf` (approx. 2.49 GB text-only weights).
  - Configure `node-llama-cpp` with Vulkan backend preference on Windows (supported natively by NVIDIA drivers without CUDA SDK).
  - Set context size `n_ctx` strictly between 1024 and 2048 tokens; translate one sentence at a time.
  - Gracefully fallback to CPU if Vulkan device initialization fails.
  - Package `yt-dlp.exe` and `ffmpeg.exe` via `extraResources` and `asarUnpack`.

### 3. ASR Real-Time Factor (RTF)
- **Risk:** The live 80ms Nemotron model runs at RTF 1.17–1.35 on CPU, which is slower than real time. A pre-roll pipeline cannot get 5 minutes ahead if transcribing 5 minutes takes 6+ minutes.
- **Mitigation:**
  - Create a dedicated `AsrBatchWorker` using the 1120ms or 560ms INT8 Nemotron variant instead of 80ms. Larger chunk sizes significantly cut per-frame inference overhead.
  - Process large continuous audio buffers (~1 second chunks) rather than 80ms IPC round-trips.
  - Allocate dedicated worker threads (e.g., 4 threads) while reserving logical cores for the browser and system.

### 4. HLS / MPEG-TS Timestamp Offsets
- **Risk:** Web video streams (HLS, DASH, MPEG-TS) often start at an arbitrary presentation timestamp (PTS, e.g. PTS = 1432.5s) while `HTMLMediaElement.currentTime` in Chrome starts at 0.0s.
- **Mitigation:** Run `ffprobe` format probe on the stream URL to detect `start_time`. Normalize all decoded audio timestamps relative to the detected start: `videoMediaMs = decodedPtsMs - (startTimeSec * 1000)`.

### 5. Browser Ads, DRM, and Dynamic Navigation
- **Risk:** Encrypted streams (DRM/Widevine) cannot be resolved by `yt-dlp`. Video advertisements insert uncaptioned audio and skew media timestamps.
- **Mitigation:**
  - Detect DRM flags via `yt-dlp -J` and `video.mediaKeys` in the extension. When DRM is detected, fall back immediately to live loopback mode with a non-intrusive explanatory notification.
  - Extension content script inspects ad containers (e.g. `.ad-showing`) and reports `isAd: true`. During ads, the scheduler suspends cue rendering and preserves timeline integrity.

---

## 6. Implementation Order

1. **Phase 0:** Recon, planning documentation (`PREROLL_PLAN.md`, `PREROLL_DECISIONS.md`), git branch setup, gitignore configuration.
2. **Phase 1:** TranslateGemma core engine (`translategemma-languages.ts`, `translategemma-prompt.ts`, `model-manager.ts`, `translator-worker.mjs`, `translator-client.ts`, wire into existing live/media flows, tests, benchmark script).
3. **Phase 2:** Headless audio-first pre-roll pipeline (`audio-source.ts`, `asr-batch-worker.ts`, `segmenter.ts`, `cue-format.ts`, `cue-store.ts`, `scheduler.ts`, `scripts/preroll-cli.ts`, unit tests with fakes).
4. **Phase 3:** High-precision playback clock & zero-delay cue player (`playback-clock.ts`, `cue-player.ts`, overlay integration, timing tests).
5. **Phase 4:** Browser extension bridge (`extension/` MV3 extension, `extension-bridge.ts` WebSocket server, token authentication, `PrerollSession` orchestration).
6. **Phase 5:** UI, Settings, and Diagnostics (React settings controls, progress meters, diagnostics card, bilingual SRT export).
7. **Phase 6:** Position tracking without extension (feasibility evaluation and spike).
8. **Phase 7:** Hardening, packaging configuration (`electron-builder`, `asarUnpack`, `extraResources`), documentation, and final validation report.
