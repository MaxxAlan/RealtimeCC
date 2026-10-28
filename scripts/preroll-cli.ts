#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';
import { OnlineAudioSource } from '../src/main/preroll/audio-source';
import { AsrBatchClient } from '../src/main/preroll/asr-batch-client';
import { CueStore } from '../src/main/preroll/cue-store';
import { PrerollScheduler } from '../src/main/preroll/scheduler';
import { Translator, TranslationUnit } from '../src/main/preroll/types';
import { TranslatorClient } from '../src/main/preroll/translator-client';
import { getTranslatorModelPath, isTranslatorModelInstalled } from '../src/main/preroll/model-manager';

const HELP_TEXT = `
RealtimeCC Pre-roll Pipeline CLI
Transcribes and translates online video ahead of time and exports SubRip (.srt) subtitles.

Usage:
  npx tsx scripts/preroll-cli.ts <url> [options]

Arguments:
  <url>                Online video URL (YouTube, Vimeo, HLS stream, etc.)

Options:
  --from <seconds>     Start offset in seconds (default: 0)
  --seconds <seconds>  Total duration to process in seconds (default: 300)
  --src <lang>         Source language code (default: en)
  --tgt <lang>         Target translation language code (default: vi)
  --out <path>         Output .srt file path (default: out.srt)
  --threads <n>        ASR thread count (default: 4)
  --cache              Enable disk caching in preroll-cache/ (default: true)
  --help               Show this help message

Example:
  npx tsx scripts/preroll-cli.ts "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --from 0 --seconds 300 --src en --tgt vi --out out.srt
`;

class EchoTranslator implements Translator {
  async ready(): Promise<void> {}
  async translate(units: TranslationUnit[]): Promise<Array<{ id: string; text: string; ok: boolean }>> {
    return units.map((u) => ({ id: u.id, text: `[${u.tgt.toUpperCase()}] ${u.text}`, ok: true }));
  }
  stats() { return { backend: 'cpu' as const, queued: 0 }; }
  async dispose(): Promise<void> {}
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  function getArg(flag: string): string | undefined {
    const idx = rawArgs.indexOf(flag);
    return idx !== -1 && idx + 1 < rawArgs.length ? rawArgs[idx + 1] : undefined;
  }

  const url = rawArgs.find((a) => !a.startsWith('-')) || getArg('--url');
  if (!url) {
    console.error('Error: Video URL is required.');
    console.log(HELP_TEXT);
    process.exit(1);
  }

  const fromSec = Number(getArg('--from') || 0);
  const secondsToProcess = Number(getArg('--seconds') || 300);
  const srcLang = getArg('--src') || 'en';
  const tgtLang = getArg('--tgt') || 'vi';
  const outPath = path.resolve(process.cwd(), getArg('--out') || 'out.srt');
  const threads = Number(getArg('--threads') || 4);

  const startMs = fromSec * 1000;
  const targetBufferMs = secondsToProcess * 1000;

  console.log('='.repeat(70));
  console.log(' RealtimeCC Audio Pre-roll Pipeline');
  console.log('='.repeat(70));
  console.log(` Target URL : ${url}`);
  console.log(` Start Time : ${fromSec}s`);
  console.log(` Duration   : ${secondsToProcess}s`);
  console.log(` Languages  : ${srcLang} -> ${tgtLang}`);
  console.log(` Output SRT : ${outPath}`);
  console.log('='.repeat(70));

  const audioSource = new OnlineAudioSource(url);
  console.log(' Probing media info via yt-dlp...');
  const info = await audioSource.info();
  console.log(` Media ID   : ${info.id}`);
  console.log(` Title      : ${info.title || '(untitled)'}`);
  console.log(` Duration   : ${info.durationMs ? (info.durationMs / 1000).toFixed(1) + 's' : 'unknown'}`);
  console.log(` Live       : ${info.isLive}`);
  console.log(` DRM        : ${info.drm}`);

  if (info.isLive) {
    console.error('Error: Live streams cannot be pre-rolled.');
    process.exit(1);
  }
  if (info.drm) {
    console.error('Error: DRM-protected videos cannot be pre-rolled.');
    process.exit(1);
  }

  // Model dirs
  const appData = process.env.APPDATA || '';
  const asrModelDir = path.join(
    appData,
    'realtimecc',
    'models',
    'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-80ms-int8-2026-06-11'
  );

  if (!fs.existsSync(asrModelDir)) {
    console.error(`Error: ASR model directory not found at: ${asrModelDir}`);
    console.error('Please download the local speech model first.');
    process.exit(1);
  }

  const asrBackend = new AsrBatchClient({
    modelDir: asrModelDir,
    language: srcLang,
    numThreads: threads,
    workerPath: path.resolve(__dirname, '..', 'src', 'main', 'preroll', 'asr-batch-worker.ts')
  });

  const modelsDir = path.join(appData, 'realtimecc', 'models');
  let translator: Translator;

  if (isTranslatorModelInstalled(modelsDir)) {
    console.log(' Local TranslateGemma model detected. Loading worker...');
    translator = new TranslatorClient({
      modelPath: getTranslatorModelPath(modelsDir),
      workerPath: path.resolve(__dirname, '..', 'src', 'main', 'preroll', 'translator-worker.mjs')
    });
  } else {
    console.log(' [Notice] TranslateGemma model not yet downloaded in AppData.');
    console.log(' Using simulation translator so pre-roll pipeline can be fully verified.');
    translator = new EchoTranslator();
  }

  const cacheDir = path.join(process.cwd(), 'preroll-cache');
  const cueStore = new CueStore({ cacheDir, cacheEnabled: true });

  const scheduler = new PrerollScheduler(
    audioSource,
    asrBackend,
    translator,
    cueStore,
    {
      prerollMs: targetBufferMs,
      startGateMs: targetBufferMs,
      maxAheadMs: targetBufferMs * 2,
      srcLang,
      tgtLang
    }
  );

  const t0 = performance.now();
  let timeToReadyMs: number | null = null;

  scheduler.onStatus((status) => {
    const readySec = (status.readyAheadMs / 1000).toFixed(1);
    const targetSec = (targetBufferMs / 1000).toFixed(0);
    const rtf = typeof status.asrRtf === 'number' ? ` | ASR RTF: ${status.asrRtf.toFixed(2)}` : '';
    const ups = typeof status.unitsPerSecond === 'number' ? ` | Tr: ${status.unitsPerSecond} units/s` : '';
    process.stdout.write(`\r State: [${status.state.toUpperCase()}] Ready: ${readySec}s / ${targetSec}s${rtf}${ups}   `);

    if (status.state === 'playing' || status.readyAheadMs >= targetBufferMs) {
      if (timeToReadyMs === null) {
        timeToReadyMs = performance.now() - t0;
      }
    }
  });

  console.log('\n Starting pre-roll pipeline...\n');
  await scheduler.start(startMs);

  // Poll until gate opens or target duration reached or ended
  while (true) {
    const status = scheduler.getStatus();
    if (status.state === 'playing' || status.state === 'ended' || status.state === 'error' || status.state === 'fallback') {
      break;
    }
    if (status.readyAheadMs >= targetBufferMs) {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const totalElapsedMs = performance.now() - t0;
  scheduler.stop();

  console.log('\n' + '='.repeat(70));
  console.log(' Pre-roll Pipeline Complete');
  console.log('='.repeat(70));
  console.log(` Time to ready (gate) : ${timeToReadyMs ? (timeToReadyMs / 1000).toFixed(2) + 's' : 'N/A'}`);
  console.log(` Total processing time : ${(totalElapsedMs / 1000).toFixed(2)}s`);
  console.log(` Translated Cues       : ${cueStore.allCues.length}`);
  console.log(` Final Ready Ahead     : ${(cueStore.readyAheadMs(startMs) / 1000).toFixed(1)}s`);

  // Write SRT
  const srtContent = cueStore.exportSrt({ bilingual: true });
  fs.writeFileSync(outPath, srtContent, 'utf8');
  console.log(` Subtitles exported to : ${outPath}`);

  // Write JSON benchmark report
  const benchCacheDir = path.join(process.cwd(), 'bench-cache');
  if (!fs.existsSync(benchCacheDir)) {
    fs.mkdirSync(benchCacheDir, { recursive: true });
  }

  const report = {
    timestamp: new Date().toISOString(),
    url,
    targetDurationSec: secondsToProcess,
    cuesCount: cueStore.allCues.length,
    timeToReadySec: timeToReadyMs ? timeToReadyMs / 1000 : null,
    totalProcessingSec: totalElapsedMs / 1000,
    speedup: targetBufferMs / Math.max(1, totalElapsedMs),
    outputSrt: outPath
  };

  const reportFile = path.join(benchCacheDir, `preroll-${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(` Benchmark data saved to: ${reportFile}`);
  console.log('='.repeat(70));

  await asrBackend.dispose();
  await translator.dispose();
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFatal error in preroll-cli:', e);
  process.exit(1);
});
