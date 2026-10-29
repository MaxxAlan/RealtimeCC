#!/usr/bin/env tsx
/**
 * RealtimeCC ASR Benchmark — streaming-aware
 *
 * Measures RTF, first-partial latency, per-chunk inference, and simulated
 * drop rate under a live-like 80 ms chunk feed. Supports all published
 * Nemotron 3.5 streaming INT8 variants (80 / 160 / 560 / 1120 ms).
 *
 * Usage:
 *   npx tsx scripts/bench-asr.ts [options]
 *
 * Options:
 *   --model-dir <path>     Directory of a Nemotron model (default: auto)
 *   --variant <ms>         80 | 160 | 560 | 1120  (default: 80)
 *   --wav <path>           16 kHz mono test WAV
 *   --threads <n>          Thread count (default: cpus-2)
 *   --lang <code>          Language hint (default: vi)
 *   --chunk-ms <n>         Feed chunk size in ms (default: 80)
 *   --runs <n>             Number of full runs (default: 3)
 *   --queue-limit <n>      Simulated in-flight limit (default: 8)
 *   --help
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VARIANTS: Record<string, string> = {
  '80': 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-80ms-int8-2026-06-11',
  '160': 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11',
  '560': 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11',
  '1120': 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-1120ms-int8-2026-06-11',
};

const HELP = `
RealtimeCC ASR Benchmark (streaming-aware)

Usage:
  npx tsx scripts/bench-asr.ts [options]

Options:
  --model-dir <path>   Explicit model directory
  --variant <ms>       80 | 160 | 560 | 1120  (default: 80)
  --wav <path>         16 kHz mono test WAV
  --threads <n>        Thread count (default: cpus-2)
  --lang <code>        Language code (default: vi)
  --chunk-ms <n>       Simulated live chunk size in ms (default: 80)
  --runs <n>           Full runs after warm-up (default: 3)
  --queue-limit <n>    Simulated in-flight drop limit (default: 8)
  --help
`;

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[idx];
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  const sherpa = require('sherpa-onnx-node');

  const variantKey = getArg('--variant') || '80';
  const modelFolder = VARIANTS[variantKey];
  if (!modelFolder) {
    console.error(`Unknown variant "${variantKey}". Use 80, 160, 560 or 1120.`);
    process.exit(1);
  }

  const defaultModelDir = path.join(
    process.env.APPDATA || process.env.HOME || '',
    process.platform === 'win32' ? 'realtimecc/models' : '.config/realtimecc/models',
    modelFolder
  );
  const appDataCandidates = [
    path.join(process.env.APPDATA || '', 'realtimecc', 'models', modelFolder),
    path.join(process.env.LOCALAPPDATA || '', 'realtimecc', 'models', modelFolder),
    defaultModelDir,
  ];

  let modelDir = getArg('--model-dir');
  if (!modelDir) {
    for (const c of appDataCandidates) {
      if (fs.existsSync(path.join(c, 'encoder.int8.onnx'))) {
        modelDir = c;
        break;
      }
    }
  }
  if (!modelDir || !fs.existsSync(path.join(modelDir, 'encoder.int8.onnx'))) {
    console.error(`Model not found for variant ${variantKey}ms.`);
    console.error(`Expected directory containing encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt`);
    console.error(`Tried: ${appDataCandidates.join('\n       ')}`);
    console.error(`Download the model inside RealtimeCC first, or pass --model-dir.`);
    process.exit(1);
  }

  const defaultWav = path.join(modelDir, 'test_wavs', 'vi.wav');
  const wavPath = getArg('--wav') || (fs.existsSync(defaultWav) ? defaultWav : path.join(modelDir, 'test_wavs', '0.wav'));
  if (!fs.existsSync(wavPath)) {
    console.error(`Test WAV not found: ${wavPath}`);
    process.exit(1);
  }

  const threads = Number(getArg('--threads') || Math.max(1, os.cpus().length - 2));
  const lang = getArg('--lang') || 'vi';
  const chunkMs = Number(getArg('--chunk-ms') || 80);
  const runs = Number(getArg('--runs') || 3);
  const queueLimit = Number(getArg('--queue-limit') || 8);

  console.log('='.repeat(72));
  console.log(' RealtimeCC ASR Benchmark (streaming simulation)');
  console.log('='.repeat(72));
  console.log(` Variant     : ${variantKey} ms  (${modelFolder})`);
  console.log(` Model Dir   : ${modelDir}`);
  console.log(` Test WAV    : ${wavPath}`);
  console.log(` Language    : ${lang}`);
  console.log(` Threads     : ${threads}`);
  console.log(` Chunk feed  : ${chunkMs} ms`);
  console.log(` Queue limit : ${queueLimit} (simulated drop threshold)`);
  console.log(` Runs        : ${runs} (+ 1 warm-up)`);
  console.log('='.repeat(72));

  const wave = sherpa.readWave(wavPath);
  const audioDurationSec = wave.samples.length / wave.sampleRate;
  const samplesPerChunk = Math.round((wave.sampleRate * chunkMs) / 1000);
  console.log(` Audio       : ${audioDurationSec.toFixed(3)} s @ ${wave.sampleRate} Hz`);
  console.log(` Chunks      : ${Math.ceil(wave.samples.length / samplesPerChunk)} × ${chunkMs} ms`);

  function createRecognizer() {
    return new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 128 },
      modelConfig: {
        transducer: {
          encoder: path.join(modelDir!, 'encoder.int8.onnx'),
          decoder: path.join(modelDir!, 'decoder.int8.onnx'),
          joiner: path.join(modelDir!, 'joiner.int8.onnx'),
        },
        tokens: path.join(modelDir!, 'tokens.txt'),
        numThreads: threads,
        provider: 'cpu',
        debug: 0,
      },
      endpointConfig: {
        rule1: { mustContainANonSilenceFrame: true, minTrailingSilence: 0.8, minUtteranceLength: 0 },
        rule2: { mustContainANonSilenceFrame: true, minTrailingSilence: 0.6, minUtteranceLength: 2.0 },
        rule3: { mustContainANonSilenceFrame: false, minTrailingSilence: 0.0, minUtteranceLength: 8.0 },
      },
      enableEndpoint: true,
    });
  }

  type RunResult = {
    firstPartialMs: number | null;
    totalDecodeMs: number;
    rtf: number;
    inferenceTimes: number[];
    dropped: number;
    processed: number;
    transcript: string;
  };

  function runOnce(label: string, warm: boolean): RunResult {
    const recognizer = createRecognizer();
    const stream = recognizer.createStream();
    if (lang && lang !== 'auto') stream.setOption('language', lang);

    const inferenceTimes: number[] = [];
    let firstPartialMs: number | null = null;
    let lastText = '';
    let dropped = 0;
    let processed = 0;
    let inFlight = 0;
    let transcript = '';
    const t0 = performance.now();

    for (let offset = 0; offset < wave.samples.length; offset += samplesPerChunk) {
      const end = Math.min(offset + samplesPerChunk, wave.samples.length);
      const chunk = wave.samples.subarray(offset, end);

      if (inFlight >= queueLimit) {
        dropped += 1;
        continue;
      }
      inFlight += 1;

      const tChunk = performance.now();
      stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: chunk });
      while (recognizer.isReady(stream)) {
        recognizer.decode(stream);
      }
      const inferenceMs = performance.now() - tChunk;
      inferenceTimes.push(inferenceMs);
      inFlight = Math.max(0, inFlight - 1);
      processed += 1;

      const result = recognizer.getResult(stream);
      if (result.text && result.text !== lastText) {
        const text = result.text.trim();
        const endpoint = recognizer.isEndpoint(stream);
        if (text && (endpoint || /\s|\p{P}/u.test(result.text))) {
          if (firstPartialMs === null) {
            firstPartialMs = performance.now() - t0;
          }
          lastText = result.text;
          transcript = text;
        }
      }
      if (recognizer.isEndpoint(stream)) {
        recognizer.reset(stream);
        lastText = '';
      }
    }

    try {
      stream.inputFinished();
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      const res = recognizer.getResult(stream);
      if (res.text?.trim()) transcript = res.text.trim();
    } catch { /* ignore */ }

    const totalDecodeMs = performance.now() - t0;
    const rtf = (totalDecodeMs / 1000) / audioDurationSec;

    if (!warm) {
      console.log(
        ` ${label}: firstPartial=${firstPartialMs?.toFixed(0) ?? 'n/a'} ms  ` +
        `RTF=${rtf.toFixed(3)}  meanInfer=${(inferenceTimes.reduce((a, b) => a + b, 0) / Math.max(1, inferenceTimes.length)).toFixed(1)} ms  ` +
        `proc=${processed} drop=${dropped}`
      );
    }
    return { firstPartialMs, totalDecodeMs, rtf, inferenceTimes, dropped, processed, transcript };
  }

  console.log('\n Warm-up run…');
  runOnce('warm', true);

  const results: RunResult[] = [];
  for (let r = 1; r <= runs; r++) {
    results.push(runOnce(`Run ${r}`, false));
  }

  const rtfs = results.map((r) => r.rtf);
  const firsts = results.map((r) => r.firstPartialMs).filter((v): v is number => v != null);
  const allInfer = results.flatMap((r) => r.inferenceTimes);
  const totalDropped = results.reduce((s, r) => s + r.dropped, 0);
  const totalProcessed = results.reduce((s, r) => s + r.processed, 0);
  const avgRtf = rtfs.reduce((a, b) => a + b, 0) / rtfs.length;

  console.log('-'.repeat(72));
  console.log(` Avg RTF              : ${avgRtf.toFixed(3)}  (${(1 / avgRtf).toFixed(2)}× real-time)  ${avgRtf <= 0.5 ? '[PASS ≤0.5]' : avgRtf <= 1.0 ? '[MARGINAL]' : '[FAIL >1.0]'}`);
  console.log(` RTF P50 / P95        : ${percentile(rtfs, 0.5).toFixed(3)} / ${percentile(rtfs, 0.95).toFixed(3)}`);
  if (firsts.length) {
    console.log(` First partial P50/P95: ${percentile(firsts, 0.5).toFixed(0)} / ${percentile(firsts, 0.95).toFixed(0)} ms`);
  }
  console.log(` Infer/chunk P50/P95  : ${percentile(allInfer, 0.5).toFixed(1)} / ${percentile(allInfer, 0.95).toFixed(1)} ms`);
  console.log(` Processed / Dropped  : ${totalProcessed} / ${totalDropped}  (queue-limit=${queueLimit})`);
  console.log(` Last transcript      : "${results[results.length - 1]?.transcript || ''}"`);
  console.log('='.repeat(72));
  console.log(' Note: This is worker-only (no loopback / IPC / overlay paint).');
  console.log('       For true E2E numbers, use the live app + ground-truth fixture.');
  console.log('='.repeat(72));

  const benchCacheDir = path.join(process.cwd(), 'bench-cache');
  if (!fs.existsSync(benchCacheDir)) fs.mkdirSync(benchCacheDir, { recursive: true });

  const report = {
    timestamp: new Date().toISOString(),
    hardware: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model || 'unknown',
      logicalCores: os.cpus().length,
    },
    config: {
      variantMs: Number(variantKey),
      modelDir,
      wavPath,
      threads,
      lang,
      chunkMs,
      queueLimit,
      audioDurationSec,
      runs,
    },
    results: {
      avgRtf,
      rtfP50: percentile(rtfs, 0.5),
      rtfP95: percentile(rtfs, 0.95),
      firstPartialP50: firsts.length ? percentile(firsts, 0.5) : null,
      firstPartialP95: firsts.length ? percentile(firsts, 0.95) : null,
      inferP50: percentile(allInfer, 0.5),
      inferP95: percentile(allInfer, 0.95),
      totalProcessed,
      totalDropped,
      perRun: results.map((r) => ({
        rtf: r.rtf,
        firstPartialMs: r.firstPartialMs,
        meanInferMs: r.inferenceTimes.reduce((a, b) => a + b, 0) / Math.max(1, r.inferenceTimes.length),
        processed: r.processed,
        dropped: r.dropped,
        transcript: r.transcript,
      })),
    },
  };

  const outFile = path.join(benchCacheDir, `asr-bench-${variantKey}ms-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(` Saved: ${outFile}`);
}

main().catch((e) => {
  console.error('Fatal benchmark error:', e);
  process.exit(1);
});
