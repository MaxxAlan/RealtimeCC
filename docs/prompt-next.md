ROLE
You are a senior engineer working inside the existing repository "RealtimeCC" (a realtime closed-caption / subtitle app). Implement two things:
(A) fully offline translation with TranslateGemma 4B, and
(B) an "audio-first prefetch" pipeline that makes translated captions appear with zero perceived delay while watching online videos.

RULES OF ENGAGEMENT

- PHASE 0 FIRST: audit the repo before writing code. Report: language/framework, build system, how video playback works, where captions are currently rendered, how ASR/translation is currently done (if at all), existing config/settings, existing tests. Reuse existing architecture and conventions; do not introduce a new framework unless unavoidable.
- Then post a short plan (files to add/change, dependencies, risks) and WAIT for my "go" before large refactors. Small additive changes can proceed.
- Work in small commits, one per phase. Do not break existing features. Add tests for new logic.
- Never download model weights silently. Put the model path in config and fail fast with a clear message and download instructions if the file is missing.

PART A - OFFLINE TRANSLATION WITH TRANSLATEGEMMA 4B

1. Model: google/translategemma-4b-it (Gemma 3 based, 55 languages). Run it locally as a GGUF (Q4_K_M default for speed, Q8_0 optional for quality) via llama.cpp / llama-cpp-python, or via whatever local runtime fits the repo's language. Zero network calls during translation.
2. Prompt format: TranslateGemma uses a special chat template whose user turn carries source_lang_code and target_lang_code. VERIFY the exact template on the official model card (google/translategemma-4b-it) and in the GGUF metadata before coding. Prefer the runtime's chat-completion API so the embedded template is applied. If you build the prompt manually, <bos> MUST be the first token (outputs degrade without it) and generation must stop on <end_of_turn> (token id 106) as well as <eos>.
3. Create a TranslationEngine abstraction (translate(batch, src, tgt, context) -> list[str]) so the backend is swappable. Settings: model path, quantization, n_ctx (keep small, ~2048), n_threads, GPU layers, batch size, source/target language codes.
4. Decoding: temperature 0 (deterministic), max_tokens bounded relative to source length, output only the translation (strip any extra text), preserve numbers/names/punctuation. Warm up the model at app start (dummy translation, KV-cache for the fixed prefix) so the first real request is fast.
5. Consistency: pass the previous 1-3 translated sentences as context so terminology and pronouns stay consistent across cues. Translate per merged sentence (not per raw ASR fragment).
6. Licensing: add a notice that the model is under the Gemma Terms of Use.

PART B - AUDIO-FIRST PREFETCH ("zero-delay" captions)
Goal: when the user presses Start on an online video, a background pipeline processes the audio AHEAD of the playhead so that translated captions are already timestamped (SRT-like) before the video reaches them. At playback time the UI only looks up and displays cues synced to video.currentTime; it never waits for ASR or translation.

Pipeline: audio fetch -> decode -> VAD segmentation -> ASR (reuse the repo's existing ASR; if none, propose a local one such as whisper.cpp / faster-whisper in Phase 0) -> sentence merge -> TranslationEngine -> CueStore -> Renderer (+ .srt export).

1. Audio-only fetch: do NOT download video. Extract only the audio track for the target time range (HTTP range requests / HLS audio segments / yt-dlp + ffmpeg, whichever suits the sources the app supports). Choose the lowest-bitrate audio-only format that still keeps speech intelligible, then decode to 16 kHz mono PCM. Expose a configurable quality floor, because extremely low quality hurts ASR accuracy. Fetch in chunks (e.g. 30-60 s) so processing can start before the download finishes.
2. Prefetch policy (all values configurable):
   - TARGET_LEAD = 300 s (5 minutes) of captions ready ahead of the playhead.
   - START_GATE: on Start, show a "Preparing captions..." state with a progress bar and begin playback only when the first START_GATE seconds of translated cues are ready. Default = 300 s to match the requirement; also offer a "fast start" preset (e.g. 60 s) because the gate time depends on hardware speed.
   - MAX_LEAD (e.g. 10-15 min): stop prefetching beyond it to save CPU/GPU, resume when the lead drops below TARGET_LEAD
   - On pause: keep prefetching until MAX_LEAD, then idle. On resume: continue immediately.
   - On playbackRate change: scale the required lead (needed = TARGET_LEAD \* playbackRate).
   - Lead is measured in VIDEO time: lead = (end of the contiguous processed range that contains the playhead) - currentTime.

3. Seek handling

- Maintain an interval set of processed time ranges. Seek inside a processed range: do nothing special, continue from that range's end.
- Seek outside processed ranges: cancel queued jobs, re-prioritise so processing starts at the new playhead, show a short "Preparing captions..." state gated by a smaller SEEK_GATE (default 20-30 s), then keep filling forward up to TARGET_LEAD. Never discard already-processed ranges; they stay in the CueStore.
- Job priority: (1) range at/just after the playhead, (2) forward fill, (3) optional background fill of the rest of the video when idle (off by default).

4. CueStore (SRT-like)
   Cue = { id, startMs, endMs, srcText, dstText, srcLang, dstLang, status: asr_done | translated | failed }

- Sorted by startMs, non-overlapping within a track; lookup by time in O(log n) (binary search).
- Segmentation rules: break at sentence ends and long pauses; max ~7 s per cue, ~42 chars per line, max 2 lines. Split long sentences with word-level timestamps if available, otherwise proportionally by character count.
- Timestamps are always absolute video time: chunkOffsetMs + local timestamp. Chunks overlap by 1-2 s; dedupe cues in overlap zones (keep the one that is not at a chunk edge).
- Export standard .srt (optionally .vtt) at any time; import an existing .srt to skip ASR/translation.
- Persistent cache keyed by (video id or URL hash, ASR model+version, translation model+version, language pair). On replay, load cached cues instantly and process only the missing ranges.

5. Zero-delay renderer

- The renderer is driven ONLY by the video element's currentTime (requestAnimationFrame or the player's time event). It does a CueStore lookup and shows dstText. It must never block on ASR, translation or network.
- Global caption offset setting (+/- ms) for manual sync correction. Show each cue exactly at startMs and clear it when no cue covers the playhead.
- Handle seek/pause/rate changes without flicker.
- Fallback when translation is late for the current playhead (lead < 0): show srcText styled as "untranslated" (or nothing if ASR is also missing) and swap in the translation when ready. Log a "lead underrun" metric.

6. Concurrency and resources

- ASR and translation run off the UI thread (worker threads/processes), pipelined: translating chunk N overlaps with ASR on chunk N+1, with bounded queues for backpressure.
- Avoid GPU/CPU contention: configurable device assignment (ASR and LLM on different devices, or sequential if only one GPU). Cap threads so the video player stays smooth.
- All jobs are cancellable. No leaked ffmpeg/child processes on stop, close or seek.
- Batch several sentences per translation call if it raises throughput, but keep per-batch latency small.

7. Settings and UI

- Settings: language pair, model paths, TARGET_LEAD, MAX_LEAD, START_GATE, SEEK_GATE, audio quality floor, caption offset.
- UI states: Idle -> Preparing (progress: seconds ready / gate) -> Playing (small lead indicator, e.g. "Ready +4:32") -> Underrun (subtle warning). Error states with actionable messages (model missing, fetch failed, unsupported URL).

8. Offline and scope notes

- "Offline" means ASR and translation run locally. Fetching the audio of an ONLINE video still needs network. Local video files must work with the network fully disabled (same pipeline, audio read from disk).
- Keep the audio fetcher behind an AudioSource interface so sources can be added or removed, and respect the terms of service of each source you support.

DELIVERY PHASES (one commit each, run tests after each)
P0 audit + plan (wait for my "go")
P1 TranslationEngine + TranslateGemma local backend + a small script that translates sample sentences; report speed (tokens/s, sentences/s)
P2 CueStore + SRT export/import + cache + unit tests
P3 AudioSource (audio-only chunk fetch) + ASR integration + absolute timestamps
P4 Prefetch scheduler (lead, gates, pause, seek) + tests with a simulated clock
P5 Renderer + UI states + settings
P6 Benchmark + docs (README: setup, model download, config, troubleshooting)

ACCEPTANCE CRITERIA

- Measure and report the real-time factor (processing time / audio time) for ASR and for translation on this machine. Combined RTF must stay below 1; otherwise print a warning and suggest a lighter preset (smaller ASR model, Q4 quant, larger START_GATE).
- After START_GATE, a 60-minute video never shows a "waiting" state during normal playback; lead underruns are logged.
- A caption appears within +/-100 ms of its cue startMs (rendering side).
- A seek outside the prefetched range recovers within SEEK_GATE + processing time, with correct cues and no duplicates.
- All translation-related functionality works with the network disabled.
- No regressions in existing features or tests.

Start with Phase 0 now. Output the audit findings and the plan, then stop and wait for my approval.
