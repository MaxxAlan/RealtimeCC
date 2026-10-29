# GPU prototype runbook (target PC)

See `docs/GPU_PROTOTYPE.md` for full context. This file is the short checklist.

## 0. Baseline (already in app)

```powershell
npx tsx scripts/bench-asr.ts --variant 80 --threads 4 --chunk-ms 80
# also 160/240 aggregate, other variants
```

Record RTF / first-partial. Then fixture E2E when ready.

## 1. Sherpa CUDA smoke (Python first — fastest signal)

1. Install CUDA **matching** the wheel’s ORT (11.8+cuDNN8 or 12.x+cuDNN9 — check wheel docs).
2. `pip install "sherpa-onnx==…+cuda" --no-index -f https://k2-fsa.github.io/sherpa/onnx/cuda.html`
3. Run streaming decode on the same Nemotron folder with `provider="cuda"` vs `provider="cpu"`.
4. Watch `nvidia-smi` for VRAM. If CUDA fails to load, stop — do not assume Node will work.

## 2. In-app probe

Set settings:

```json
{ "asrProvider": "auto", "asrThreads": 4, "asrAggregateMs": 80 }
```

Restart captions. Check status toast / `bench-logs` for `asr_ready` / `provider_fallback`.  
**Note:** stock `sherpa-onnx-node` may still be CPU-only binaries; `auto` then always falls back. A real CUDA Node build is a separate packaging task.

## 3. whisper.cpp CUDA (parallel)

```powershell
cmake -B build -DGGML_CUDA=1 -DCMAKE_CUDA_ARCHITECTURES=75
cmake --build build --config Release -j
.\build\bin\Release\whisper-stream.exe -m models\ggml-base.bin -l vi --step 500 --length 5000
```

Do **not** treat default `--step 500` as sub-400 ms E2E. Measure with the same fixture protocol.

## 4. Compare

Fill the decision table in `docs/GPU_PROTOTYPE.md`. Promote only on **E2E** gains.
