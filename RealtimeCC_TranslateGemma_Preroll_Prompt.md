# TASK — Offline translation (TranslateGemma 4B) + audio-first "pre-roll" captions for online video in RealtimeCC

<!--
HUMAN NOTE (not for the agent):
- Put this file in the repo, e.g. docs/PREROLL_PROMPT.md, then in Gemini CLI / Gemini Code Assist agent mode say:
  "Read @docs/PREROLL_PROMPT.md fully, then execute Phase 0, then Phase 1, ... in order. Commit after each phase."
- Or paste Sections 0-4 plus ONE phase at a time if you want to review between phases.
-->

You are a senior TypeScript / Electron / native-addon engineer working on **RealtimeCC** (https://github.com/MaxxAlan/RealtimeCC), a Windows live-caption desktop app. Implement the feature described below end to end, in phases, verifying each phase before moving on.

---

## 0. Operating rules (read first)

1. **Read before you write.** Read `README.md`, `package.json`, `tsconfig.*.json`, every file in `src/main/`, `src/renderer/` and `tests/` before changing anything. The summary in Section 2 is a map, not a substitute.
2. **Minimal, surgical edits to existing files.** `src/main/index.ts` and `src/renderer/main.tsx` are written as dense one-line statements. Do NOT reformat or restructure them. Put new logic in new, readable, well-named modules and only wire them in from the existing files with small edits.
3. **Build constraints you must respect**
   - Main process is **CommonJS** (`tsconfig.main.json`: `module: CommonJS`, `rootDir: src/main`, `strict: true`). All new main-process TypeScript must live under `src/main/`. Renderer is ESM via Vite.
   - Some native/LLM packages are **ESM-only** (`node-llama-cpp` v3 is, to our knowledge — confirm in its `package.json`). `await import('x')` in TS with `module: CommonJS` is compiled to `require()` and will fail at runtime. Solve it properly: run the translator in a separate **`utilityProcess`** (or child process) whose entry is an `.mjs` file, copied into `dist/` by the build script. This also isolates native crashes from the Electron main process. Whatever you choose, prove it with `npm run build` and a packaged-path check (`asarUnpack` for native binaries).
4. **Keep the security posture**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `devTools: false`. Every new IPC channel must be validated like the existing handlers (type/range checks, throw on invalid), added to `src/main/preload.ts` and `src/renderer/types.d.ts`.
5. **Never fabricate performance numbers.** The README is deliberately strict about benchmarks ("not measured" is a valid state). You will probably not have the target hardware (Ryzen 5 5600H, GTX 1650 4 GB VRAM, Windows 10/11 x64). Build everything so it is testable with fakes, and add scripts the user can run on the real machine (Section 8). Put only *measured* numbers in the README, with machine info and scope, as the current README does.
6. **Privacy / offline guarantee.** ASR and translation workers must open **no network connections**. The only network use allowed: (a) user-initiated model downloads, (b) fetching the audio of the video the user is watching (Phase 2). No telemetry. Document how the user can verify offline operation.
7. **Tests & checks.** After every phase run `npm run typecheck && npm test` and fix failures before continuing. Use Vitest (already configured). Make each new module dependency-injectable so the scheduler/clock/cue logic is unit-testable without models, ffmpeg or a browser.
8. **Git.** Create a branch `feature/preroll-translategemma`. One commit per phase, message `phaseN: <summary>`. Do not push.
9. **Don't stall.** If something is ambiguous or a URL/package changed, pick the most reasonable option, record it in `docs/PREROLL_DECISIONS.md` (decision, alternatives, why), and continue. Ask the user only if a decision is irreversible and could reasonably go either way.
10. **Scope guardrails.** Do not circumvent DRM; do not scrape cookies/credentials from browsers; do not download or store video streams (audio only, streamed in memory, never written to disk; only text cues are cached). Show a one-time notice in the UI that fetching audio from a site may be subject to that site's terms and is intended for personal accessibility use.

---

## 1. Product requirement

Original request (Vietnamese, keep this intent exactly):

> Dùng **TranslateGemma 4B** để dịch thuật **offline**.
> Trong các video **online**, xây dựng cơ chế **request audio trước** (load trước **ít nhất 5 phút** khi bấm Start, rồi **xử lý tiếp tục trong lúc xem phim**) để người dùng có trải nghiệm trực quan nhất và **zero-delay**.
> "Load trước 5 phút" = load trước *tiến độ* của video, **trong nền**, **chỉ load âm thanh**, với **chất lượng âm thanh thấp nhất** để xử lý nhanh nhất.
> Xong rồi app **gán thời gian như file .srt** rồi **phát lại phụ đề (CC) đúng theo tiến độ video** → cảm giác zero delay.

English summary of what must exist when you are done:

- **A. Offline translation.** With the Local provider, the user can pick an output language and captions are translated on-device with TranslateGemma 4B (GGUF, llama.cpp-based). No cloud call is made.
- **B. Pre-roll mode for online video.** When the user presses **Start captions** while watching an online video:
  1. The app obtains **only the audio**, at the **lowest-bitrate audio format**, from the video's position onward, in the **background**, **faster than real time**.
  2. It runs local ASR → segments → TranslateGemma → produces **timestamped cues in video time** (like an .srt, held in memory).
  3. It guarantees **≥ 5 minutes of translated cues ahead of the playhead** before playback is allowed to proceed (configurable "gate", with a "Play now" override), then **keeps working while the user watches** so the buffer never runs dry.
  4. During playback the overlay shows each cue **exactly when the video's own timeline reaches it** (driven by the real playback position, pause, seek and speed), so captions feel zero-delay.
- **C. Graceful fallback.** If pre-roll is impossible (DRM, live stream, URL not resolvable, no browser bridge), fall back automatically to the existing live loopback mode with a clear notice. Never leave the user at a dead end.

---

## 2. What exists today (verified from the repo — use as a map)

Stack: Electron 45, TypeScript, React 18 + Vite, Vitest, `sherpa-onnx-node`, `@google/genai`, `ws` (**declared in package.json but not used yet** → use it for the browser bridge).

| Area | Where | Facts that matter |
| --- | --- | --- |
| Settings | `src/main/index.ts` ~L12-13, L43-57 | `Settings` type + `defaults`; `validateSettingsPatch` allow-lists fields and rejects unknown ones → every new setting must be added there with strict validation. `provider: 'local' \| 'gemini'`; `outputLanguage: 'same' \| <code>`. |
| **Translation is blocked locally** | `index.ts` ~L198 and ~L239 | `if (settings.outputLanguage !== 'same') throw …'Choose Google Live to translate'` and the same rule in `session:reconfigure`. Must become: local + output language ⇒ TranslateGemma (if installed and language supported), otherwise a clear actionable error. |
| Live audio path | `src/renderer/main.tsx` ~L31-38, `src/renderer/audio-worklet.js` | `getDisplayMedia` Windows loopback → AudioWorklet `pcm16` → 16 kHz mono Int16, 1280 frames (80 ms) per chunk → IPC `audio:chunk` → `handleAudio` (`index.ts` ~L130). |
| Local ASR | `src/main/asr-worker.ts` | sherpa-onnx `OnlineRecognizer`, Nemotron 3.5 ASR streaming 0.6B **80 ms int8**, `provider: 'cpu'`, `numThreads` default 4, one stream, emits `caption` / `final` / `processed`. Timestamps are wall-clock `capturedAt`-based. |
| ASR perf (from README) | README "Latency target…" | Worker replay RTF **1.17 / 1.35** (slower than real time), mean 87-106 ms per 80 ms chunk, 2 of 51 chunks dropped; live loopback trial dropped 52 chunks. **Consequence: the existing 80 ms CPU path cannot "get ahead" of playback. Pre-roll needs a different ASR configuration (Section 5, Phase 2).** |
| Local-file subtitle prep | `index.ts` ~L252-273 (`media:*`), `main.tsx` ~L44-75 | Plays an `<audio>` element silently at 1× into the ASR and pauses when queue ≥ 6 → takes ≥ playback duration. Cues are built in **media time** and synced by `requestAnimationFrame` + linear `find` (`startCueSync`, ~L74). Reuse the idea, not the 1× mechanism. |
| Cues & export | `index.ts` `commitCaption`, `sessionCaptions`, `exportCues`, `srtTimestamp`, `captions:export-srt` | Live cues use **wall-clock ms since session start**. Pre-roll cues must use **video media time**; keep both timelines separate. |
| Overlay | `index.ts` (`overlayWindow`), `main.tsx` overlay branch, IPC `media:caption`, channel `caption` | `broadcast('caption', { final, partial, source: 'media' })` already renders arbitrary text in the overlay. Reuse it. Overlay is always-on-top (`'screen-saver'`, visible on fullscreen). |
| Languages | `src/main/languages.ts` | `translationLanguages` (84 Google codes, e.g. `vi`, `zh-Hans`, `pt-BR`), `liveLanguages` (BCP-47 like `en-US`, `vi-VN`), `localReadyLanguages`, `nemotronLanguage()`. In `auto` mode the multilingual Nemotron model emits language tags that sherpa **strips**, so the source language is unknown unless the user picks it. |
| Model download | `index.ts` `download()` / `installModel()` ~L95-129 | HTTPS download with resume (`Range`), progress via `model-progress`, `tar -xjf` extract. Reuse the pattern (extract into a shared `model-manager.ts`) for the TranslateGemma GGUF, plus SHA-256 verification. |
| Reference machine | README "Actual machine inspected" | Ryzen 5 5600H (6C/12T), GTX 1650 **4 GB VRAM**, no CUDA ASR runtime verified, no C++ toolchain on the box → **prefer prebuilt binaries** (npm packages / release zips), avoid anything that compiles from source at install time. |

---

## 3. Target architecture ("Pre-roll pipeline")

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

Design principles:

- **One time base for pre-roll: video media time in milliseconds.** Wall-clock time appears only inside the clock/scheduler.
- **Streaming pipeline with bounded queues** (back-pressure), not "transcribe 5 minutes, then translate 5 minutes". The first cue must appear as soon as the first sentence is translated.
- **The playhead drives everything.** Work is prioritized by distance ahead of the playhead; seeking cancels and re-plans; already-covered ranges are never recomputed.
- **Everything is replaceable behind an interface** (`AudioSource`, `AsrBackend`, `Translator`, `Clock`) so tests use fakes.

New files (suggested; names may be adjusted, seams may not):

```
src/main/preroll/types.ts
src/main/preroll/translategemma-languages.ts   # supported list + RealtimeCC-code → TranslateGemma-code/name
src/main/preroll/translategemma-prompt.ts      # pure prompt builder + output post-processing
src/main/preroll/translator-client.ts          # main-side client, spawns utilityProcess, req/resp ids, abort, restart
src/main/preroll/translator-worker.mjs         # ESM worker: node-llama-cpp, model load, translate loop
src/main/preroll/model-manager.ts              # download (resume) + sha256 + install paths, shared with ASR model
src/main/preroll/audio-source.ts               # yt-dlp resolve + ffmpeg PCM stream
src/main/preroll/asr-batch-worker.ts           # sherpa worker tuned for throughput, absolute media time
src/main/preroll/segmenter.ts                  # ASR segments → translation units
src/main/preroll/cue-format.ts                 # line breaking, min/max duration, no overlaps
src/main/preroll/cue-store.ts                  # cues, coverage intervals, lookup, SRT export, disk cache
src/main/preroll/scheduler.ts                  # state machine, windows, seek handling, gating
src/main/preroll/playback-clock.ts             # extrapolating clock
src/main/preroll/cue-player.ts                 # boundary-timer driven overlay updates
src/main/preroll/extension-bridge.ts           # ws server + protocol
src/main/preroll/index.ts                      # PrerollSession facade used by main/index.ts IPC handlers
extension/                                     # MV3 browser extension (plain JS, no build step)
scripts/bench-translate.ts  scripts/bench-asr.ts  scripts/preroll-cli.ts
docs/PREROLL_DECISIONS.md   docs/PREROLL_PLAN.md
tests/…                                        # one test file per pure module
```

---

## 4. TranslateGemma 4B — verified facts and what you must verify

**Verified from public sources (Ollama library page, Hugging Face model card, Google blog, community GGUF card):**

- TranslateGemma is Google's translation fine-tune of Gemma 3 (4B / 12B / 27B), trained and evaluated on **55 languages**. The 4B model is the one meant for on-device/edge use. License: **Gemma Terms of Use** (the app must show this notice and link when offering the download; do not bundle weights in the installer).
- Official HF repo `google/translategemma-4b-it` is gated. Community GGUF conversions exist, e.g. `42ailab/TranslateGemma-4B-GGUF`: `translategemma-4b-it-Q4_K_M.gguf` ≈ **2.49 GB**, `…Q8_0.gguf` ≈ 4.13 GB, **text-only**. Ollama's `translategemma:4b` is Q4_K_M ≈ 3.3 GB (includes the vision part). For a 4 GB-VRAM GPU, **use the text-only Q4_K_M (≈2.5 GB)** and keep `n_ctx` small (1024-2048).
- The model card says the tuned context is **~2K tokens per call** → translate **one sentence-sized unit per call**, never long passages.
- Decoding: the model card examples use greedy decoding. Use **temperature 0 / greedy** by default for subtitle stability (Ollama's suggested sampling is top_k 64, top_p 0.95 if you need sampling). Stop on `<end_of_turn>` **and** `<eos>`.
- **Prompt format.** The official chat template takes a single user message whose content carries `source_lang_code`, `target_lang_code` and `text`. In practice (Ollama's `translategemma` page and public demos) it renders to this plain instruction inside the Gemma turn markers. **Two blank lines** precede the text:

```
<bos><start_of_turn>user
You are a professional {SRC_NAME} ({src_code}) to {TGT_NAME} ({tgt_code}) translator. Your goal is to accurately convey the meaning and nuances of the original {SRC_NAME} text while adhering to {TGT_NAME} grammar, vocabulary, and cultural sensitivities.
Produce only the {TGT_NAME} translation, without any additional explanations or commentary. Please translate the following {SRC_NAME} text into {TGT_NAME}:


{TEXT}<end_of_turn>
<start_of_turn>model
```

  Notes: exactly one BOS (check what your tokenizer call adds — do not double it); `{SRC_NAME}` is the English language name (`English`, `Vietnamese`, `Japanese`, `French`, `Chinese`), codes look like `en`, `vi`, `ja`, `fr`, `zh-Hans`, `zh-Hant`, `pt-BR`, `pt-PT`, `fil-PH`. Unsupported codes must be **blocked in the UI**, not sent to the model.
- Language support is **55 languages**, not the 84 in `translationLanguages` (that list is Google Live's). Do not reuse it for the Local provider.

**You must verify (do not assume):**

1. Fetch the official language list (HF model card / Google blog / TranslateGemma technical report) and encode it in `translategemma-languages.ts` with a source comment. Public demos suggest roughly: ar, bg, bn, ca, cs, da, de, el, en, es, et, fa, fi, fil, fr, gu, he, hi, hr, hu, id, is, it, ja, kn, ko, lt, lv, ml, mr, nl, no, pa, pl, pt(-BR/-PT), ro, ru, sk, sl, sr, sv, sw, ta, te, th, tr, uk, ur, vi, zh(-Hans/-Hant), zu — **treat this only as a hint**; the official list wins. `vi`, `ja`, `fr`, `en` must be supported or you must report it.
2. Read the GGUF's embedded `tokenizer.chat_template` (node-llama-cpp exposes GGUF metadata). Render it for a sample with a Jinja engine (e.g. `@huggingface/jinja`) and **diff against your prompt builder's output**. Community conversions sometimes ship a plain Gemma-3 template; your builder (raw completion, no chat-template dependency) is the source of truth, but report any mismatch in `docs/PREROLL_DECISIONS.md`.
3. Pick the GGUF mirror, verify the exact file URL and **pin its SHA-256** in code; fail closed on mismatch. Prefer an ungated mirror; if you must use a gated one, surface the license-acceptance step in the UI.
4. node-llama-cpp specifics: prebuilt Windows x64 binaries exist; backend selection is automatic (CUDA / Vulkan / CPU). **Prefer Vulkan** as the default GPU backend on Windows for portability (works on a GTX 1650 without a CUDA toolkit), allow CUDA if detected, and fall back to CPU. Report which backend was selected in the UI diagnostics. Use `gpuLayers: 'auto'`, `contextSize ≤ 2048`, and test 1, 2 and 4 parallel sequences for throughput.

---

## 5. Phases

### Phase 0 — Recon & plan (no feature code)
- Read the repo as per rule 1. Write `docs/PREROLL_PLAN.md`: module list, IPC channels, settings additions, risks (ESM-only package, Windows native binaries, ASR RTF, HLS timestamp offsets, ads), and the order you will implement.
- Add `scripts/` and `docs/` folders, extend `.gitignore` (`bench-cache/` exists already; add `preroll-cache/` if it lives in the repo during tests).
- **Done when:** the plan exists and `npm run typecheck && npm test` still pass.

### Phase 1 — TranslateGemma engine + translation in the existing flows
1. `translategemma-languages.ts`, `translategemma-prompt.ts` (pure). Functions: `toTranslateGemmaCode(realtimeCcCode)`, `isSupportedPair(src, tgt)`, `buildPrompt({src, tgt, text})`, `cleanOutput(raw, srcText)` (trim, strip wrapping quotes/markdown fences, reject obvious chatter such as "Here is the translation", detect empty / runaway-repetition / absurd length ratio and signal `{ok:false, reason}` so the caller can retry once, then fall back to showing the source text).
2. `model-manager.ts`: generalize the existing resume-capable `download()` (keep `installModel()` behavior unchanged for ASR). Add SHA-256 verification, `translator:download` + `translator:status` IPC, progress channel, and a UI card mirroring the existing "Local speech model" card (size, license notice + link, **Download translator** button, ready state).
3. `translator-worker.mjs` + `translator-client.ts`: load GGUF once and keep it warm; API `translate(units: {id, src, tgt, text}[], {signal}) → results`; per-request abort; automatic restart on worker crash with exponential back-off; `maxTokens = clamp(ceil(srcTokens*3)+16, 32, 256)`; parallel sequences per benchmark; report `{tokensPerSecond, promptMs, decodeMs, backend, vramMiB?}` for diagnostics. Optional optimization (only after correctness): reuse the KV-cached instruction prefix across requests of the same language pair.
4. Wire into the **existing** flows with minimal edits:
   - Remove the two "local cannot translate" blocks; for `provider === 'local' && outputLanguage !== 'same'`, require translator installed + supported pair, else throw an actionable message (e.g. "Download the translator model first").
   - Live loopback mode: translate each `final` segment from the local ASR; keep source partials dimmed, replace with the translation when ready; track that the displayed latency now includes translation time.
   - Local-file subtitle preparation (`media:finish`): translate `mediaCues` before returning them.
   - `languages.ts`/UI: for the Local provider the output-language dropdown lists only TranslateGemma-supported languages (others shown disabled, as the UI already does for Google-only items).
   - Source language rule: translation needs a source language. If the user left input language on `auto`, try to read the language from the recognizer result if sherpa exposes it; otherwise use a small **offline** text language-ID with hysteresis (majority over last N segments); if still uncertain, ask the user to choose the input language instead of guessing.
5. Tests: golden prompt string (exact bytes incl. the two blank lines), language mapping (`en-US→en`, `vi-VN→vi`, `nb-NO→no`, `cmn-Hans-CN→zh-Hans`, `pt-BR→pt-BR`, unsupported → null), `cleanOutput` cases, translator client with a fake worker (ordering, abort, crash-restart).
6. `scripts/bench-translate.ts`: runs N sample sentences per language pair through the real worker, prints tokens/s, ms per unit, backend, peak VRAM if available; writes JSON into `bench-cache/`.
- **Done when:** with a fake worker everything passes in CI; with the real model, `npm run bench:translate` runs (user-run on their PC); Local provider + output language "Vietnamese" translates a live final segment; no code path in the translator or ASR worker opens a network socket (grep + review noted in `docs/PREROLL_DECISIONS.md`).

### Phase 2 — Audio-first pre-roll pipeline (headless first)
Build and verify it **without UI and without the browser extension** using `scripts/preroll-cli.ts <url> --from 0 --seconds 300 --src en --tgt vi --out out.srt`.

1. **AudioSource** (`audio-source.ts`)
   - Resolve with a bundled/located `yt-dlp.exe`: `yt-dlp --no-playlist --no-warnings --no-cache-dir -f "wa/w" -J <pageUrl>`; read `url`, `http_headers`, `duration`, `id`, `is_live`/`live_status`, `protocol`, DRM flags. Reject (→ fallback to live mode) when live, DRM-protected, or unresolved. `wa` = worst audio-only; `/w` falls back to worst muxed when the site has no audio-only rendition. If measured ASR accuracy at the lowest bitrate is clearly worse on the fixture, change the default to `wa[abr>=48?]/wa/w` and record it in the decisions log. The user explicitly wants the **lowest quality audio** for speed.
   - Stream with ffmpeg directly from the resolved URL, from an arbitrary start:
     `ffmpeg -hide_banner -loglevel error -nostdin -headers "<k: v\r\n…>" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -ss <startSec> -i <url> -vn -sn -dn -ac 1 -ar 16000 -f s16le -acodec pcm_s16le pipe:1`
     Read stdout in ~1 s blocks (32000 bytes/s). Do **not** use `-re` (we want faster than real time). Absolute media time of a block = `startMs + sampleIndex / 16`.
   - If the format is fragment-based and ffmpeg cannot open the URL directly, fall back to `yt-dlp --download-sections "*START-END" -f "wa/w" -o - <url> | ffmpeg -i pipe:0 …`.
   - Resolved URLs expire (hours): re-resolve on HTTP 403/410 and resume from the last processed ms.
   - Check `ffprobe` `format.start_time`; HLS/MPEG-TS often start at a non-zero PTS while `video.currentTime` starts at 0 → subtract it so cue time equals `HTMLMediaElement.currentTime`.
   - Never write audio to disk; kill child processes on abort/stop/quit; no zombie processes.
   - Locate binaries: `resources/bin/` (electron-builder `extraResources`) with an env/user-setting override. Provide a "Check / update yt-dlp" action (`yt-dlp -U` or re-download) because extractors break often.
2. **AsrBatchWorker** (`asr-batch-worker.ts`) — a **separate** sherpa worker from the live `asr-worker.ts` (do not change the live worker's behavior):
   - Goal is **throughput**, not latency. Input: PCM blocks tagged with absolute `startMs`; output: `{startMs, endMs, text}` segments in **video time**.
   - Benchmark the Nemotron 3.5 multilingual variants **80 / 160 / 560 / 1120 ms** (same release family, e.g. `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-1120ms-int8-2026-06-11.tar.bz2`; the sherpa-onnx docs state larger chunks are more accurate, and they should also cut per-chunk overhead — measure it) and thread counts (reserve ≥ 2 logical cores for the browser, Electron and ffmpeg). `scripts/bench-asr.ts` prints RTF and WER-proxy per variant on a fixture WAV. Choose the variant with **RTF ≤ 0.5** (target; measured, not assumed) and make it selectable/downloadable (reuse `model-manager`).
   - Tune endpointing for **subtitle-sized** units (verify sherpa's `enableEndpoint` / `rule1..3` options in the Node API): trailing silence ≈ 0.6-0.8 s, hard max utterance ≈ 8-10 s.
   - Feed blocks as fast as they arrive; no per-80 ms IPC round trips (transfer ~1 s ArrayBuffers).
   - **If RTF ≤ 0.5 cannot be reached**, climb this ladder and stop at the first step that works, logging each result: (1) bigger-chunk variant → (2) thread tuning → (3) energy/Silero VAD to skip silence & music → (4) GPU execution provider only if it can be verified on the target PC → (5) report the shortfall clearly in the final report instead of hiding it. Do not silently swap the ASR engine.
3. **Segmenter** (`segmenter.ts`, pure): merge ASR segments into translation units — flush on sentence-final punctuation (when the model emits it), on gap > ~700 ms, or when the unit exceeds ~180 characters / ~8 s; never split mid-word; keep the first segment's `startMs` and the last one's `endMs`. If ASR emits no punctuation, rely on gaps/length. Optionally include the previous unit as *context only if* a test shows it improves quality without breaking the "only the translation" output.
4. **CueFormat** (`cue-format.ts`, pure): ≤ 2 lines; ≈ 42 chars/line for Latin scripts, ≈ 20 for CJK; break at spaces/punctuation, balanced lines; min display 1000 ms, reading speed ≈ 17 chars/s (extend `endMs` up to `nextStart − 40 ms`, never overlap); max 7 s (split long units proportionally to character counts).
5. **CueStore** (`cue-store.ts`):
   - Sorted non-overlapping `MediaCue {id, startMs, endMs, text, sourceText, srcLang, tgtLang}`.
   - Two interval sets: `transcribed` and `translated` (coverage), with `readyAheadMs(playheadMs)` = distance from playhead to the end of the contiguous translated coverage.
   - O(log n) `cueAt(ms)` and `nextBoundaryAfter(ms)`.
   - `exportSrt()` (reuse `srtTimestamp` semantics; UTF-8 BOM as the app already does) and optional bilingual export.
   - **Disk cache** in `userData/preroll-cache/<sha256>.json`, key = canonical video id/URL (strip `t=`, tracking params) + src/tgt + ASR model id + translator model id + prompt version; LRU cap (default 30 entries / 100 MB); setting to disable; "Clear cache" action; document that it stores transcripts of watched videos.
6. **PrerollScheduler** (`scheduler.ts`): states `idle → resolving → warming → buffering → gated → playing → seeking → ended | error | fallback`.
   - Inputs: `playheadMs` (from the clock; in the CLI it is simulated), `prerollMs` (default **300 000**), `maxAheadMs` (default 2×preroll, then pause work to save CPU), `startGateMs` (default = preroll).
   - Behavior: start at `max(0, playhead − 3000)`; keep `readyAheadMs ≥ prerollMs` during playback; skip ranges already in the store; on **seek** abort in-flight ffmpeg/ASR/translation, re-plan from the new position (if the target is already covered → nothing to do); when the video is paused and `readyAhead ≥ maxAheadMs`, idle; when the end of media is reached, mark `ended`.
   - Translation queue is **ordered by distance ahead of the playhead**; stale (behind playhead) work is dropped.
   - **Gate:** on Start, report `gated` until `readyAheadMs ≥ startGateMs` (or the video is shorter / ended / user clicked **Play now**). With the extension (Phase 4) the scheduler asks the browser to pause until the gate opens; without it, the UI shows progress and tells the user to press play when ready.
   - Emits `PrerollStatus` events: state, `readyAheadMs`, ASR RTF, translation units/s, queue depths, underrun count, backend.
7. `scripts/preroll-cli.ts`: runs the real pipeline on a URL and writes an SRT; prints time-to-ready for the first 300 s and sustained RTF per stage. Used by the user for benchmarks.
8. Tests (fakes for audio/ASR/translator, fake timers): gate opens only at ≥ 300 s of translated coverage; seek forward re-plans and aborts old work; seek backward into covered range is instant; no overlapping cues; ordering by distance; stage back-pressure bounds memory; abort leaves no pending promises/processes; cache key stability.
- **Done when:** the CLI works against a public non-DRM test URL on a normal machine; all unit tests pass; the README documents measured results only (or explicitly "not measured on target PC").

### Phase 3 — Playback clock + cue player + overlay ("zero-delay" rendering)
1. `playback-clock.ts`: input samples `{positionMs, paused, rate, receivedAtMonotonicMs}`; `nowMs()` extrapolates with `performance.now()` × `rate` while playing; small error (< ~120 ms) is slewed smoothly, large error hard-sets (seek); exposes `onChange` for `seek | pause | play | rate`. Stamp samples on **receipt** in the main process (loopback hop ≈ ms).
2. `cue-player.ts`: **no polling.** Compute the next boundary from `CueStore.nextBoundaryAfter(clock.nowMs())`, `setTimeout` until then, emit `broadcast('caption', {final: text, partial: '', source: 'media'})` only when the active cue changes; recompute on every clock change (pause cancels the timer; seek recomputes immediately). Settings: `syncOffsetMs` (−3000…+3000, user adjustable with hotkeys such as Ctrl+Alt+← / →, persisted) and `displayLeadMs` (default 0, max 300, to compensate IPC+paint).
3. If the playhead enters a range with no cue yet but `translated` coverage hasn't reached it (**underrun**), show a subtle "Captions catching up…" state in the overlay, increment the underrun metric, and never show a stale cue.
4. Reuse `reportCaptionVisible`-style measurement to compute **cue onset error** = (overlay paint time) − (time the clock reached `cue.startMs`); expose p50/p95 in diagnostics.
5. Tests with fake timers: boundaries exact; pause/seek/rate changes; no flicker (no emit when the cue is unchanged); offset/lead applied; underrun state.
- **Done when:** with a simulated clock the overlay receives the right text at the right ms (unit-tested), and the existing live/loopback behavior is unchanged.

### Phase 4 — Browser bridge (extension) for real playback position
Without the browser's real playhead the app cannot know pause/seek/speed, so a tiny extension is the primary sync source.

1. `extension/` — Manifest V3 (Chrome/Edge), plain JS, minimal permissions (`storage`; content script matches `<all_urls>` but only attaches to `<video>`). 
   - **Content script:** choose the "main" `<video>` (largest visible area, `readyState > 0`, prefer playing); re-evaluate on DOM mutations and SPA navigation (e.g. YouTube `yt-navigate-finish`). Send `tick` every 250 ms while playing (1 Hz while paused) and events: `loadedmetadata, play, pause, seeking, seeked, ratechange, waiting, ended, navigated`. Detect `drm` (`video.mediaKeys != null` or `encrypted` event) and best-effort `isAd` (e.g. YouTube player ad class) → while an ad plays, report `isAd: true` and the app **hides captions and ignores positions**. Accept `pause`/`play` commands (handle `play()` rejection due to autoplay policy by notifying the app, which shows "Captions ready — press play").
   - **Background service worker** owns the WebSocket (content scripts are subject to the page's CSP/mixed-content rules; the service worker is not). Content script ↔ SW via `chrome.runtime` ports. Reconnect with back-off; keep-alive while a tab is playing.
   - Popup: enter port + pairing token once (stored in `chrome.storage.local`), show connection status.
2. `extension-bridge.ts` (uses the existing `ws` dependency):
   - Bind **127.0.0.1 only**. Require a per-install random **128-bit token** (generate in main, show in UI) compared in constant time; verify `Origin` starts with `chrome-extension://` (optionally pin the extension id); max message 4 KB; drop binary frames; basic rate limiting. A random web page must not be able to talk to it.
   - Protocol v1 (JSON): ext→app `hello{v,token,browser}`, `media{tabId,pageUrl,title,durationMs|null,isLive,drm,positionMs,paused,rate,isAd}`, `tick{tabId,positionMs,paused,rate}`, `event{tabId,name,positionMs}`; app→ext `hello-ack`, `command{name:'pause'|'play',tabId}`.
   - Active media = most recently playing tab; expose `getActiveMedia()` and events to `PrerollSession`.
3. `PrerollSession` facade + IPC (validated): `preroll:start`, `preroll:stop`, `preroll:play-now`, `preroll:set-manual-url` (for when the user pastes a URL instead of using the extension), `extension:pairing`, channel `preroll-status`. **Start captions** flow:
   1. Provider Local + (translation requested or pre-roll enabled) and an active resolvable video exists (extension-reported, else manual URL) → pre-roll.
   2. Otherwise → existing loopback live mode with a visible reason ("DRM", "live stream", "no browser connected", …).
   Never run loopback ASR and pre-roll cues for the same session at once (double captions).
4. Tests: protocol parsing/validation, token + Origin rejection, tick→clock integration, active-tab selection, ad/DRM handling, `PrerollSession` state transitions with fakes.
- **Done when:** with the extension loaded unpacked in Chrome/Edge and the app running, Start captions pauses the video, the gate opens at ≥ 5 min of cues, playback starts, and cues follow pause, seek and speed changes. (User-verified; you provide a manual test script in `docs/PREROLL_MANUAL_TEST.md`.)

### Phase 5 — UI, settings, diagnostics
- Settings (extend `Settings`, `defaults`, `validateSettingsPatch`, `settings:get`): `preroll: { enabled, prerollSeconds (60–1800, default 300), holdPlaybackUntilReady (default true), syncOffsetMs, displayLeadMs, cacheEnabled }`, `translator: { quant: 'Q4_K_M' | 'Q8_0', gpu: 'auto' | 'off' }`, ASR pre-roll variant. Strict ranges, unknown keys rejected as today.
- New card "Smart pre-roll (online video)": toggle; detected video title/URL (or manual URL field); extension pairing instructions (port + token + copy button); status line (`Resolving audio → Transcribing → Translating → Ready 4:32 ahead`); progress bar showing buffered range relative to playhead; **Play now** button; "Hold playback until ready" toggle; sync offset ± buttons; cache controls; the one-time ToS/privacy notice. Match the existing visual style (`style.css`, lucide icons).
- Diagnostics (extend the existing "Latency diagnostics" card): ASR RTF, translator tokens/s + backend (CUDA/Vulkan/CPU), queue depths, `readyAhead`, underruns, onset error p50/p95, time-to-ready. Label everything "diagnostic, not calibrated" like the existing metrics.
- Export SRT: in pre-roll mode export the video-time cues (translation, optionally bilingual).
- **Done when:** typecheck/tests/build pass; all settings round-trip; every new string is English like the rest of the UI.

### Phase 6 (optional spike, only after Phases 1-5 pass) — Position tracking without the extension
Audio-fingerprint alignment between the live loopback capture and the pre-fetched PCM: coarse log-energy envelope at ~50 Hz, normalized cross-correlation over a ~20 s window around the expected position, confidence threshold, drift re-check every few seconds; silence ⇒ "unknown", not "paused". Deliver as a clearly-labeled experimental mode with measured accuracy, or write up why it is not reliable enough.

### Phase 7 — Hardening, packaging, docs
- Packaging: `electron-builder` `asarUnpack` for `node-llama-cpp` + its platform binaries; `extraResources` for `yt-dlp.exe` and an `ffmpeg.exe` build whose license you have checked (prefer LGPL; record it); build script copies the `.mjs` worker; verify `npm run build` output layout and a packaged-app smoke check path. Add `THIRD_PARTY_NOTICES.md` (node-llama-cpp/llama.cpp MIT, yt-dlp Unlicense, ffmpeg, sherpa-onnx, Gemma Terms of Use for the weights).
- Robustness: offline mid-session (keep showing already-translated cues; resume prefetch on reconnect), translator crash (auto-restart, units retried once, then source text shown), GPU out-of-memory (reload with fewer layers / CPU), low disk, ffmpeg/yt-dlp missing (clear message + fallback to live mode), app quit (kill children), multiple videos/tabs, SPA navigation, playback-rate 0.5-2×.
- Docs: update README (new feature, setup of extension, requirements, limitations such as "DRM and live streams use the live loopback mode", licenses, offline verification), keep the "benchmark status" section honest (fill only with measured values).
- **Done when:** `npm run typecheck && npm test && npm run build` pass and the final report (Section 9) is written.

---

## 6. Key interfaces (adjust names if needed; keep the seams)

```ts
// src/main/preroll/types.ts
export type Ms = number;                       // video media time, milliseconds
export type Interval = { startMs: Ms; endMs: Ms };
export type AsrSegment = { startMs: Ms; endMs: Ms; text: string };
export type TranslationUnit = { id: string; startMs: Ms; endMs: Ms; text: string; src: string; tgt: string };
export type MediaCue = { id: string; startMs: Ms; endMs: Ms; text: string; sourceText: string; srcLang: string; tgtLang: string };

export interface AudioSource {
  /** 16 kHz mono s16le blocks starting at startMs, as fast as the network/decoder allow. Abortable. */
  open(startMs: Ms, signal: AbortSignal): AsyncIterable<{ startMs: Ms; pcm: Int16Array }>;
  info(): Promise<{ durationMs: Ms | null; isLive: boolean; drm: boolean; id: string }>;
}
export interface AsrBackend { transcribe(blocks: AsyncIterable<{ startMs: Ms; pcm: Int16Array }>, signal: AbortSignal): AsyncIterable<AsrSegment>; }
export interface Translator {
  ready(): Promise<void>;
  translate(units: TranslationUnit[], opts: { signal: AbortSignal }): Promise<Array<{ id: string; text: string; ok: boolean }>>;
  stats(): { tokensPerSecond?: number; backend?: 'cuda' | 'vulkan' | 'cpu'; queued: number };
  dispose(): Promise<void>;
}
export interface Clock { nowMs(): Ms; paused(): boolean; rate(): number; onChange(cb: (kind: 'seek' | 'pause' | 'play' | 'rate') => void): () => void; }

export type PrerollState = 'idle' | 'resolving' | 'warming' | 'buffering' | 'gated' | 'playing' | 'seeking' | 'ended' | 'error' | 'fallback';
export type PrerollStatus = { state: PrerollState; readyAheadMs: Ms; playheadMs: Ms; underruns: number; asrRtf?: number; unitsPerSecond?: number; message?: string };
```

---

## 7. Targets (these are acceptance *targets to measure*, not claims)

| Metric | Target | How to measure |
| --- | --- | --- |
| ASR pre-roll throughput | RTF ≤ 0.5 on the reference PC | `scripts/bench-asr.ts` |
| Translation throughput | ≥ 2× speech rate (1 min of speech translated in ≤ 30 s) | `scripts/bench-translate.ts`, `preroll-cli` |
| Time-to-ready for the 5-min gate | report actual; aim ≈ ≤ 3 min | `preroll-cli`, UI diagnostics |
| Steady state | `readyAhead ≥ prerollMs` for a 20-min video at 1× after the gate | 20-min soak run; underruns = 0 |
| Cue onset error | p95 ≤ 100 ms (clock reaches `startMs` → overlay painted) | cue-player instrumentation |
| After a seek into uncovered range | first cue visible ≲ 8 s | manual + status logs |
| Memory | no unbounded growth over a 2 h session | soak test, queue bounds |

State "not measured" wherever you could not run on the target hardware.

---

## 8. Scripts to add (so the user can verify on their own PC)

`package.json` scripts: `bench:translate`, `bench:asr`, `preroll:cli`. Each prints a compact table and writes JSON under `bench-cache/`. Each must run with `--help`, never download models silently (point to the in-app download), and exit non-zero with a clear message if a prerequisite is missing.

---

## 9. Final report (your last message)

1. What was built per phase (one line each) and the list of new/changed files.
2. Exact commands: install, dev, test, build, run the three bench scripts, load the extension unpacked, first-run walkthrough.
3. A results table: every metric from Section 7 as **measured value + machine + scope**, or "not measured — run `<command>`".
4. Decisions log highlights (GGUF mirror + SHA-256, backend choice, ASR variant, yt-dlp format selector, anything you deviated on).
5. Known limitations and risks (DRM/live fallback, ads, site breakage of yt-dlp, Gemma license, HLS offsets, 4 GB VRAM headroom).
6. What you recommend next, at most three items.

Be honest: if a target is not met, say so and show the numbers.
