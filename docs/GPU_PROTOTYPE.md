# GPU prototypes (before choosing a new engine)

**Policy:** Prototype GPU on the **target machine** (Ryzen 5 5600H + GTX 1650 4 GB). Do not replace the production path until fixture E2E (`docs/E2E_BENCHMARK.md`) shows a win. Worker-only RTF is diagnostic only.

**Do not assume sub-400 ms E2E.** whisper.cpp’s official stream example samples on the order of **500 ms+** (`--step 500 --length 5000`). Shorter steps increase encoder load and often hurt accuracy; measure before claiming latency.

---

## A. Sherpa-ONNX CUDA (same Nemotron models)

### Current project state

| Piece | Status |
|-------|--------|
| `sherpa-onnx-node` in app | **CPU** (`provider: 'cpu'`). GPU **not verified** on the target PC. |
| Models | Same INT8 Nemotron streaming packages (80/160/560/1120 ms). |
| Windows CUDA | Documented (build from source / CUDA wheels for **Python**). Node addon GPU is a **separate** integration risk. |

### Recommended approach

1. **Keep CPU as production fallback** (always).
2. **Probe CUDA in an isolated worker** (optional setting `asrProvider: auto | cuda | cpu`).
3. Prefer a **separate** CUDA-enabled runtime (custom Node addon or CLI subprocess) rather than assuming the npm CPU package magically loads `onnxruntime_providers_cuda.dll`.

### Windows CUDA realities

- Match **CUDA toolkit + cuDNN** to the ONNX Runtime GPU build (historically 11.8+cuDNN8 **or** 12.x+cuDNN9 depending on ORT version). Wrong pair → `LoadLibrary` 126/1114, silent crash.
- Windows DLL search order can load a **wrong** `onnxruntime.dll` from System32; prefer package-local DLL directories on `PATH` / `AddDllDirectory`.
- Prebuilt **Python** wheels (`sherpa-onnx==…+cuda` from [cuda index](https://k2-fsa.github.io/sherpa/onnx/cuda.html)) are the fastest smoke test **outside** Electron.
- Official Windows GPU **CMake** path: `BUILD_SHARED_LIBS=ON`, `SHERPA_ONNX_ENABLE_GPU=ON`, shared GPU ORT libs. See k2-fsa docs *Build CUDA on Windows*.

### Smoke test (Python, outside the app)

```powershell
# Example only — pin versions from https://k2-fsa.github.io/sherpa/onnx/cuda.html
pip install "sherpa-onnx==2.0.1+cuda" --no-index -f https://k2-fsa.github.io/sherpa/onnx/cuda.html
# Run any official streaming example with provider=cuda on the Nemotron model dir.
# Confirm nvidia-smi shows process VRAM, then re-run with provider=cpu for RTF delta.
```

### In-app probe

- Setting `asrProvider`: `cpu` | `cuda` | `auto` (default `cpu`).
- Worker tries `provider: 'cuda'` when requested; on constructor/runtime failure, **falls back to CPU** and logs `provider_fallback`.
- Success still requires **fixture E2E**, not only “CUDA session created”.

### GTX 1650 notes

- 4 GB VRAM: INT8 Nemotron 0.6B streaming is the right size class; avoid stacking TranslateGemma GPU + ASR CUDA without measuring VRAM.
- Turing (compute 7.5): supported by current ORT CUDA builds if toolkit matches.

---

## B. whisper.cpp (CUDA / Vulkan) — parallel prototype

### What it is good for

- Strong offline / near-offline accuracy; GPU (CUDA or Vulkan) on Windows is first-class in upstream.
- **Not** a drop-in 80 ms partial engine. Streaming is typically **sliding window** or VAD-triggered chunks.

### Official stream baseline (do not ignore)

```text
whisper-stream -m models/ggml-base.en.bin -t 8 --step 500 --length 5000
```

- `--step 500` → decision granularity ~0.5 s (plus decode time).
- `--length 5000` → context window 5 s.
- Claiming &lt;400 ms E2E without a measured fixture on **this** GPU is invalid.

### Build on the target PC (CUDA)

```powershell
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_CUDA=1 -DCMAKE_CUDA_ARCHITECTURES=75
cmake --build build --config Release -j
# GTX 1650 = sm_75
```

Vulkan alternative if CUDA toolkit is painful: `-DGGML_VULKAN=1` (still measure).

### Models for 4 GB

| Model | Role |
|-------|------|
| `tiny` / `base` (multilingual) | Latency / RTF experiments |
| `small` | Accuracy vs speed trade-off |
| `medium+` | Likely tight or OOM with other GPU users |

Download via upstream `models/download-ggml-model.sh` or release assets.

### Prototype measurement (same rules as E2E doc)

1. Same fixture + word onsets as Nemotron runs.
2. Feed PCM from file first (offline stream simulation), then loopback if integrated.
3. Report: step/length settings, E2E P50/P95 if integrated, WER, VRAM peak, RTF.
4. Compare **side-by-side** with best CPU Nemotron config — not against marketing numbers.

### Integration sketch (not production)

- Prefer **subprocess** `whisper-cli` / custom stream binary + stdin PCM or temp WAV chunks, or a small native addon later.
- Do **not** block the Electron UI thread.
- CPU Nemotron path remains default until E2E proves otherwise.

---

## C. Decision matrix (fill after runs)

| Backend | Provider | Variant / model | RTF (worker) | E2E P50/P95 | WER | VRAM | Notes |
|---------|----------|-----------------|--------------|-------------|-----|------|-------|
| Sherpa Node | cpu | Nemotron 80–1120 | | | | 0 | baseline |
| Sherpa | cuda | same | | | | | |
| whisper.cpp | cuda/vulkan | tiny/base/small | | | | | step/length = ? |

Promote a backend only if **E2E** on the target machine beats the current best **with** acceptable WER and stable VRAM.

---

## D. References

- [sherpa-onnx CUDA Python wheels](https://k2-fsa.github.io/sherpa/onnx/cuda.html)
- [sherpa-onnx Windows CUDA build notes](https://k2-fsa.github.io/sherpa/onnx/install/windows/)
- [ONNX Runtime CUDA EP requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)
- [whisper.cpp CUDA / stream example](https://github.com/ggml-org/whisper.cpp)
- Project: `docs/E2E_BENCHMARK.md`, `scripts/bench-asr.ts`, `scripts/align-e2e.ts`
