# RealtimeCC — Pre-roll Subtitles & TranslateGemma Architectural Decisions Log

This document records technical decisions, alternatives evaluated, and the rationale for choices made during development.

---

## Decision 1: Model Execution Strategy (utilityProcess vs Worker Threads)
- **Decision:** Execute `node-llama-cpp` inside an Electron `utilityProcess` running an `.mjs` script (`translator-worker.mjs`), rather than a Node `worker_threads` Worker or inline in the main process.
- **Alternatives Considered:**
  1. *Direct execution in main process:* Unacceptable because `node-llama-cpp` is native and ESM-only; any native crash or unhandled segmentation fault would kill the entire RealtimeCC app.
  2. *Node.js `worker_threads`:* Would share the main process executable environment and requires complex loader hooks in CommonJS Electron to load ESM native packages.
  3. *Separate CLI subprocess via child_process:* Adds overhead of spawning and serializing JSON over stdio rather than Electron's high-speed structured clone IPC.
- **Why:** Electron's `utilityProcess` is purpose-built for native Node.js tasks. It provides process isolation, dedicated V8 engine, native crash resilience, and easy lifecycle management (`utilityProcess.fork()`).

---

## Decision 2: Quantization Format & Context Size for TranslateGemma 4B
- **Decision:** Target `translategemma-4b-it-Q4_K_M.gguf` (approx. 2.49 GB) with a small context window (`n_ctx: 1024` to `2048`).
- **Alternatives Considered:**
  1. *Q8_0 quantization (~4.13 GB):* Exceeds the target GTX 1650 VRAM capacity (4 GB) when accounting for display buffer and OS memory.
  2. *Full multimodal weights (~3.3 GB):* Unnecessary vision encoder layers increase memory footprint and download size without providing translation benefits.
- **Why:** The Q4_K_M text-only build provides optimal perplexity and quality for translation while fitting comfortably inside the 4 GB VRAM envelope.

---

## Decision 3: GPU Acceleration Backend on Windows
- **Decision:** Default to Vulkan GPU backend with automatic fallback to CPU. Allow CUDA if dynamic runtime checks confirm CUDA libraries are present.
- **Alternatives Considered:**
  1. *CUDA-only:* The target machine does not have the CUDA Toolkit installed and vLLM/CUDA passthrough was absent. Requiring CUDA would lead to initialization failures.
  2. *CPU-only:* Degrades translation throughput and prevents reaching the ≥2× speech rate target.
- **Why:** Vulkan operates across NVIDIA GeForce, AMD Radeon, and Intel GPUs on Windows with pre-installed graphics drivers without requiring external SDKs or C++ toolchains.

---

## Decision 4: ASR Model Variant for Pre-roll Batching
- **Decision:** Use a separate `AsrBatchWorker` using the 1120ms INT8 Nemotron 3.5 variant, keeping the live 80ms worker intact for live loopback capture.
- **Alternatives Considered:**
  1. *Reuse existing 80ms ASR worker:* In real tests, 80ms streaming chunks had RTF of 1.17–1.35 on CPU (slower than real time). A pre-roll buffer can never get ahead with RTF > 1.0.
  2. *Replace 80ms live worker with 1120ms:* Would harm first-partial latency in live capture mode.
- **Why:** Pre-roll prioritizes batch throughput (RTF ≤ 0.5) over sub-second partial latency. Decoupling the workers preserves live performance while maximizing pre-roll throughput.

---

## Decision 5: Audio Ingestion Strategy
- **Decision:** Ingest worst audio stream (`wa/w`) via `yt-dlp` metadata resolution piped directly through `ffmpeg` into 16 kHz mono s16le PCM, buffered strictly in-memory.
- **Alternatives Considered:**
  1. *Download full audio file to disk:* Violates privacy guidelines and delays startup time by forcing a multi-minute download before processing begins.
  2. *High-bitrate audio stream:* Wastes network bandwidth and decoder CPU cycles without improving 16 kHz ASR accuracy.
- **Why:** The user explicitly requested lowest quality audio for fastest processing. Streaming directly from URL to ffmpeg stdout allows processing to commence within seconds of pressing Start.
