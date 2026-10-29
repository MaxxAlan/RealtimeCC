#!/usr/bin/env tsx
/**
 * Align fixture word onsets with a RealtimeCC bench JSONL session log.
 *
 * Usage:
 *   npx tsx scripts/align-e2e.ts --fixture fixtures/e2e/vi-01.json --log path/to/session-….jsonl --play0 <epochMs>
 *
 * --play0 is the wall-clock (Date.now()-style) moment when the first sample of
 * the fixture was played to the default output device. Without a trustworthy
 * play0, results are not valid for acceptance (see docs/E2E_BENCHMARK.md).
 *
 * Outputs P50/P95/P99 E2E latency for matched words and a simple WER estimate.
 */
import fs from 'node:fs';
import path from 'node:path';

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

type Word = { word: string; startMs: number; endMs?: number };
type Fixture = { words: Word[]; transcript?: string; durationMs?: number };
type LogEvent = {
  t: number;
  type: string;
  text?: string;
  partial?: boolean;
  captureAt?: number;
  producedAt?: number;
  visibleAt?: number;
  endToEndMs?: number;
};

function main() {
  const fixturePath = getArg('--fixture');
  const logPath = getArg('--log');
  const play0Arg = getArg('--play0');

  if (!fixturePath || !logPath || !play0Arg) {
    console.error('Usage: npx tsx scripts/align-e2e.ts --fixture <json> --log <jsonl> --play0 <epochMs>');
    console.error('See docs/E2E_BENCHMARK.md');
    process.exit(1);
  }

  const play0 = Number(play0Arg);
  if (!Number.isFinite(play0)) {
    console.error('--play0 must be a finite epoch ms number');
    process.exit(1);
  }

  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Fixture;
  if (!Array.isArray(fixture.words) || fixture.words.length === 0) {
    console.error('Fixture must contain a non-empty words[] with startMs');
    process.exit(1);
  }

  const lines = fs.readFileSync(logPath, 'utf8').split(/\n/).filter(Boolean);
  const events: LogEvent[] = lines.map((l) => JSON.parse(l));

  // Prefer caption_visible events; fall back to caption text events with producedAt
  const visibles = events.filter((e) => e.type === 'caption_visible' && typeof e.visibleAt === 'number');
  const captions = events.filter((e) => e.type === 'caption' && e.text);

  // Build cumulative hypothesis timeline from caption events
  type Hyp = { t: number; text: string };
  const hyps: Hyp[] = [];
  for (const c of captions) {
    if (c.text) hyps.push({ t: c.producedAt ?? c.t, text: c.text });
  }
  for (const v of visibles) {
    // visible events may not carry text; pair by time with nearest caption
    const nearest = [...captions].reverse().find((c) => (c.producedAt ?? c.t) <= (v.visibleAt ?? v.t) + 50);
    if (nearest?.text) hyps.push({ t: v.visibleAt ?? v.t, text: nearest.text });
  }
  hyps.sort((a, b) => a.t - b.t);

  const latencies: number[] = [];
  const matched: Array<{ word: string; startMs: number; latencyMs: number }> = [];
  const missed: string[] = [];

  for (const w of fixture.words) {
    const tAudio = play0 + w.startMs;
    const needle = w.word.toLowerCase().normalize('NFC');
    let found: Hyp | undefined;
    for (const h of hyps) {
      if (h.t < tAudio - 200) continue; // too early
      if (h.text.toLowerCase().normalize('NFC').includes(needle)) {
        found = h;
        break;
      }
    }
    if (!found) {
      missed.push(w.word);
      continue;
    }
    const latency = found.t - tAudio;
    if (latency < -100 || latency > 5000) {
      missed.push(w.word);
      continue;
    }
    latencies.push(latency);
    matched.push({ word: w.word, startMs: w.startMs, latencyMs: Math.round(latency) });
  }

  // Simple WER from last hypothesis vs full transcript
  const lastText = hyps.length ? hyps[hyps.length - 1].text : '';
  const refTokens = tokenize(fixture.transcript || fixture.words.map((w) => w.word).join(' '));
  const hypTokens = tokenize(lastText);
  // Levenshtein
  const n = refTokens.length;
  const m = hypTokens.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = refTokens[i - 1] === hypTokens[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  const wer = n === 0 ? 0 : dp[n][m] / n;

  console.log('='.repeat(64));
  console.log(' E2E alignment report (fixture-based)');
  console.log('='.repeat(64));
  console.log(` Fixture words : ${fixture.words.length}`);
  console.log(` Matched       : ${matched.length}`);
  console.log(` Missed        : ${missed.length}${missed.length ? ' (' + missed.slice(0, 10).join(', ') + (missed.length > 10 ? '…' : '') + ')' : ''}`);
  if (latencies.length) {
    console.log(` E2E P50       : ${percentile(latencies, 0.5).toFixed(0)} ms`);
    console.log(` E2E P95       : ${percentile(latencies, 0.95).toFixed(0)} ms`);
    console.log(` E2E P99       : ${percentile(latencies, 0.99).toFixed(0)} ms`);
    console.log(` E2E mean      : ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)} ms`);
  } else {
    console.log(' E2E latency   : n/a (no matched words)');
  }
  console.log(` WER (approx)  : ${(wer * 100).toFixed(1)}%  (ref ${n} words, hyp ${m} words)`);
  console.log('='.repeat(64));
  console.log(' Note: Valid only if --play0 is the true wall-clock start of fixture playback.');
  console.log('       In-app diagnostic p50/p95 must not be used for acceptance.');
  console.log('='.repeat(64));

  const out = {
    play0,
    matched,
    missed,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      mean: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
      n: latencies.length,
    },
    wer,
    refWordCount: n,
    hypWordCount: m,
  };
  const outPath = path.join(path.dirname(logPath), `align-${path.basename(logPath, '.jsonl')}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(` Wrote ${outPath}`);
}

main();
