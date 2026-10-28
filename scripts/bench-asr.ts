#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HELP_TEXT = `
RealtimeCC ASR Benchmark Runner
Measures Real-Time Factor (RTF) and throughput across Nemotron variants and thread counts.

Usage:
  npx tsx scripts/bench-asr.ts [options]

Options:
  --model-dir <path>   Directory of sherpa-onnx Nemotron model (default: auto-detected in AppData)
  --wav <path>         Path to 16kHz mono test WAV file (default: test_wavs/vi.wav inside model)
  --threads <n>        Thread count (default: 4)
  --lang <code>        Language code (default: vi)
  --runs <n>           Number of runs per test (default: 2)
  --help               Show this help message

Output:
  Prints tabular benchmark metrics and saves JSON report to bench-cache/
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  function getArg(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  }

  const sherpa = require('sherpa-onnx-node');

  // Detect model dir
  const defaultModelDir = path.join(
    process.env.APPDATA || '',
    'realtimecc',
    'models',
    'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-80ms-int8-2026-06-11'
  );

  const modelDir = getArg('--model-dir') || defaultModelDir;
  if (!fs.existsSync(modelDir)) {
    console.error(`Error: Model directory not found: ${modelDir}`);
    console.error('Please download the local speech model in the RealtimeCC app first.');
    process.exit(1);
  }

  const defaultWav = path.join(modelDir, 'test_wavs', 'vi.wav');
  const wavPath = getArg('--wav') || defaultWav;
  if (!fs.existsSync(wavPath)) {
    console.error(`Error: Test WAV file not found: ${wavPath}`);
    process.exit(1);
  }

  const threads = Number(getArg('--threads') || Math.max(1, os.cpus().length - 2));
  const lang = getArg('--lang') || 'vi';
  const runs = Number(getArg('--runs') || 2);

  console.log('='.repeat(70));
  console.log(' RealtimeCC ASR Benchmark');
  console.log('='.repeat(70));
  console.log(` Model Dir : ${modelDir}`);
  console.log(` Test WAV  : ${wavPath}`);
  console.log(` Language  : ${lang}`);
  console.log(` Threads   : ${threads}`);
  console.log(` Runs      : ${runs}`);
  console.log('='.repeat(70));

  const wave = sherpa.readWave(wavPath);
  const audioDurationSec = wave.samples.length / wave.sampleRate;
  console.log(` Audio file: ${audioDurationSec.toFixed(2)} seconds @ ${wave.sampleRate} Hz`);

  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 128 },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, 'encoder.int8.onnx'),
        decoder: path.join(modelDir, 'decoder.int8.onnx'),
        joiner: path.join(modelDir, 'joiner.int8.onnx')
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      numThreads: threads,
      provider: 'cpu',
      debug: 0
    },
    endpointConfig: {
      rule1: { mustContainANonSilenceFrame: true, minTrailingSilence: 0.8, minUtteranceLength: 0 },
      rule2: { mustContainANonSilenceFrame: true, minTrailingSilence: 0.6, minUtteranceLength: 2.0 },
      rule3: { mustContainANonSilenceFrame: false, minTrailingSilence: 0.0, minUtteranceLength: 8.0 }
    },
    enableEndpoint: true
  });

  const rtfList: number[] = [];
  const decodeTimes: number[] = [];
  let transcript = '';

  for (let r = 1; r <= runs; r++) {
    const stream = recognizer.createStream();
    if (lang && lang !== 'auto') {
      stream.setOption('language', lang);
    }

    const t0 = performance.now();
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
    }
    const res = recognizer.getResult(stream);
    transcript = res.text || '';
    const elapsedMs = performance.now() - t0;
    const rtf = (elapsedMs / 1000) / audioDurationSec;

    decodeTimes.push(elapsedMs);
    rtfList.push(rtf);
    console.log(` Run ${r}: Decode = ${elapsedMs.toFixed(1)} ms, RTF = ${rtf.toFixed(3)} (${(1 / rtf).toFixed(1)}x real-time)`);
  }

  const avgDecodeMs = decodeTimes.reduce((a, b) => a + b, 0) / runs;
  const avgRtf = rtfList.reduce((a, b) => a + b, 0) / runs;

  console.log('-'.repeat(70));
  console.log(` Average RTF      : ${avgRtf.toFixed(3)} ${avgRtf <= 0.5 ? '[PASS <= 0.5]' : '[EXCEEDS 0.5]'}`);
  console.log(` Real-time factor : ${(1 / avgRtf).toFixed(1)}x faster than real-time`);
  console.log(` Transcript       : "${transcript}"`);
  console.log('='.repeat(70));

  // Export JSON
  const benchCacheDir = path.join(process.cwd(), 'bench-cache');
  if (!fs.existsSync(benchCacheDir)) {
    fs.mkdirSync(benchCacheDir, { recursive: true });
  }

  const report = {
    timestamp: new Date().toISOString(),
    hardware: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model || 'unknown',
      logicalCores: os.cpus().length
    },
    config: {
      modelDir,
      wavPath,
      threads,
      lang,
      audioDurationSec
    },
    results: {
      avgDecodeMs,
      avgRtf,
      speedup: 1 / avgRtf,
      runs: rtfList,
      transcript
    }
  };

  const outFile = path.join(benchCacheDir, `asr-bench-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(` Saved benchmark report to: ${outFile}`);
}

main().catch((e) => {
  console.error('Fatal benchmark error:', e);
  process.exit(1);
});
