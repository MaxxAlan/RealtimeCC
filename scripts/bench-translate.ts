#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { TranslatorClient } from '../src/main/preroll/translator-client';
import { TRANSLATOR_MODEL_INFO, getTranslatorModelPath } from '../src/main/preroll/model-manager';

const BENCH_SAMPLES: Record<string, string[]> = {
  'en-vi': [
    'Good morning, welcome to our presentation on machine learning and artificial intelligence.',
    'The weather forecast for tomorrow calls for heavy rain and thunderstorms across the region.',
    'Could you please explain how the offline translation pipeline operates without an internet connection?',
    'Subtitles must appear in sync with the spoken video audio to provide a zero delay experience.',
    'The quick brown fox jumps over the lazy dog near the riverbank.',
  ],
  'en-ja': [
    'Good morning, welcome to our presentation on machine learning.',
    'The weather forecast predicts rain and thunderstorms tomorrow.',
    'Subtitles must appear with zero delay aligned to playback.',
  ],
  'en-fr': [
    'Good morning, welcome to our presentation on machine learning.',
    'The weather forecast predicts rain and thunderstorms tomorrow.',
    'Subtitles must appear with zero delay aligned to playback.',
  ],
};

function printHelp() {
  console.log(`
TranslateGemma 4B Benchmark Tool

Usage:
  npx ts-node scripts/bench-translate.ts [options]
  npm run bench:translate -- [options]

Options:
  --help, -h          Show this help message and exit
  --model <path>      Path to TranslateGemma GGUF file (default: user data models dir)
  --pair <pair>       Language pair to test (default: en-vi; options: en-vi, en-ja, en-fr, all)
  --gpu <auto|off>    GPU acceleration setting (default: auto)
  --samples <num>     Number of samples per pair (default: 5)
`);
}

async function run() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  let modelPath = '';
  let pairArg = 'en-vi';
  let gpuArg: 'auto' | 'off' = 'auto';
  let samplesArg = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) modelPath = args[++i];
    else if (args[i] === '--pair' && args[i + 1]) pairArg = args[++i];
    else if (args[i] === '--gpu' && args[i + 1]) gpuArg = args[++i] as any;
    else if (args[i] === '--samples' && args[i + 1]) samplesArg = Number(args[++i]);
  }

  if (!modelPath) {
    const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME || '', 'Library/Application Support') : path.join(process.env.HOME || '', '.config'));
    const defaultModelsDir = path.join(appData, 'RealtimeCC', 'models');
    modelPath = getTranslatorModelPath(defaultModelsDir);
  }

  if (!fs.existsSync(modelPath)) {
    console.error(`\n[ERROR] TranslateGemma 4B model was not found at:\n  ${modelPath}`);
    console.error(`Please download the translator model using the RealtimeCC app UI or pass --model <path>.\n`);
    process.exit(1);
  }

  console.log(`\nInitializing TranslateGemma 4B benchmark...`);
  console.log(`Model: ${modelPath}`);
  console.log(`GPU setting: ${gpuArg}`);

  const pairsToTest = pairArg === 'all' ? Object.keys(BENCH_SAMPLES) : [pairArg];

  const client = new TranslatorClient({
    modelPath,
    gpu: gpuArg,
  });

  const benchStarted = Date.now();
  await client.ready();
  const initMs = Date.now() - benchStarted;
  const initialStats = client.stats();

  console.log(`Engine ready in ${initMs} ms. Backend selected: ${initialStats.backend ?? 'unknown'}\n`);

  const resultsTable: any[] = [];
  const logEntries: any[] = [];

  for (const pair of pairsToTest) {
    const [src, tgt] = pair.split('-');
    const sampleList = (BENCH_SAMPLES[pair] || BENCH_SAMPLES['en-vi']).slice(0, samplesArg);

    console.log(`Testing pair [${src} -> ${tgt}] (${sampleList.length} sentences)...`);

    for (let idx = 0; idx < sampleList.length; idx++) {
      const text = sampleList[idx];
      const start = performance.now();
      const res = await client.translate([
        {
          id: `bench-${pair}-${idx}`,
          startMs: idx * 2000,
          endMs: (idx + 1) * 2000,
          text,
          src,
          tgt,
        },
      ]);
      const durationMs = Math.round(performance.now() - start);
      const out = res[0];

      resultsTable.push({
        pair,
        sample: idx + 1,
        charsIn: text.length,
        charsOut: out.text.length,
        durationMs,
        ok: out.ok,
      });

      logEntries.push({
        pair,
        sample: idx + 1,
        input: text,
        output: out.text,
        durationMs,
        ok: out.ok,
        reason: out.reason,
      });
    }
  }

  const finalStats = client.stats();
  await client.dispose();

  console.log('\n--- Benchmark Results ---');
  console.table(resultsTable);

  const totalDuration = resultsTable.reduce((acc, r) => acc + r.durationMs, 0);
  const avgDuration = Math.round(totalDuration / resultsTable.length);
  const successCount = resultsTable.filter((r) => r.ok).length;

  console.log(`Summary:`);
  console.log(`  Backend: ${finalStats.backend}`);
  console.log(`  Tokens/s estimate: ${finalStats.tokensPerSecond ?? 'N/A'}`);
  console.log(`  Mean duration per unit: ${avgDuration} ms`);
  console.log(`  Success rate: ${successCount} / ${resultsTable.length}`);

  // Write bench cache
  const benchDir = path.resolve(__dirname, '../bench-cache');
  fs.mkdirSync(benchDir, { recursive: true });
  const reportPath = path.join(benchDir, `translate-${Date.now()}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        modelPath,
        backend: finalStats.backend,
        tokensPerSecond: finalStats.tokensPerSecond,
        avgDurationMs: avgDuration,
        results: logEntries,
      },
      null,
      2,
    ),
  );
  console.log(`Detailed report written to: ${reportPath}\n`);
}

run().catch((err) => {
  console.error(`\nBenchmark failed: ${err.message}`);
  process.exit(1);
});
