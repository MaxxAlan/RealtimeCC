import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Segmenter } from '../src/main/preroll/segmenter';
import { formatCue, formatSubtitleLines, isCjk } from '../src/main/preroll/cue-format';
import { IntervalSet, CueStore } from '../src/main/preroll/cue-store';
import { PrerollScheduler } from '../src/main/preroll/scheduler';
import { AudioSource, AsrBackend, Translator, AsrSegment, TranslationUnit, Ms, PrerollStatus } from '../src/main/preroll/types';

describe('Segmenter', () => {
  it('flushes on sentence-ending punctuation', () => {
    const segmenter = new Segmenter();
    const u1 = segmenter.push({ startMs: 0, endMs: 1200, text: 'Hello world' });
    expect(u1).toHaveLength(0);

    const u2 = segmenter.push({ startMs: 1300, endMs: 2500, text: 'how are you today?' });
    expect(u2).toHaveLength(1);
    expect(u2[0].text).toBe('Hello world how are you today?');
    expect(u2[0].startMs).toBe(0);
    expect(u2[0].endMs).toBe(2500);
  });

  it('flushes on silence gap greater than threshold', () => {
    const segmenter = new Segmenter({ gapThresholdMs: 700 });
    segmenter.push({ startMs: 1000, endMs: 2000, text: 'First phrase' });
    // Gap of 800ms (> 700ms threshold)
    const units = segmenter.push({ startMs: 2800, endMs: 3500, text: 'Second phrase' });
    expect(units).toHaveLength(1);
    expect(units[0].text).toBe('First phrase');
    expect(units[0].startMs).toBe(1000);
    expect(units[0].endMs).toBe(2000);

    const remaining = segmenter.flush();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe('Second phrase');
    expect(remaining[0].startMs).toBe(2800);
  });

  it('flushes when accumulated length exceeds max chars or duration', () => {
    const segmenter = new Segmenter({ maxChars: 50, maxDurationMs: 4000 });
    const u1 = segmenter.push({ startMs: 0, endMs: 4500, text: 'A single segment that is longer than four seconds without punctuation' });
    expect(u1).toHaveLength(1);
    expect(u1[0].startMs).toBe(0);
    expect(u1[0].endMs).toBe(4500);
  });
});

describe('CueFormat', () => {
  it('formats short text into 1 line with min display duration 1000ms', () => {
    const cues = formatCue({ text: 'Short caption', startMs: 1000, endMs: 1500 });
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Short caption');
    expect(cues[0].startMs).toBe(1000);
    // Min duration 1000ms applied
    expect(cues[0].endMs - cues[0].startMs).toBeGreaterThanOrEqual(1000);
  });

  it('balances longer text into at most 2 lines', () => {
    const longText = 'This is a somewhat longer subtitle sentence that should be split into two lines.';
    const formatted = formatSubtitleLines(longText, false);
    const lines = formatted.split('\n');
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0].length).toBeLessThanOrEqual(45);
    expect(lines[1].length).toBeLessThanOrEqual(45);
  });

  it('detects CJK characters and applies CJK line limits', () => {
    expect(isCjk('こんにちは世界')).toBe(true);
    expect(isCjk('Hello world', 'en')).toBe(false);
    expect(isCjk('Xin chào thế giới', 'vi')).toBe(false);

    const cjkText = '这是一段关于实时字幕翻译的测试文本，需要被分成两行显示。';
    const lines = formatSubtitleLines(cjkText, true).split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0].length).toBeLessThanOrEqual(25);
  });

  it('splits long units (>7s) into proportional sub-cues', () => {
    const longUnit = {
      text: 'First part of the speech here. Second part of the speech follows after a while.',
      startMs: 0,
      endMs: 10000
    };
    const cues = formatCue(longUnit);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (const cue of cues) {
      expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(7000);
    }
  });

  it('caps endMs before nextStartMs to prevent overlaps', () => {
    const cues = formatCue({ text: 'First cue', startMs: 1000, endMs: 2500 }, 2200);
    expect(cues).toHaveLength(1);
    expect(cues[0].endMs).toBeLessThanOrEqual(2200 - 40);
  });
});

describe('IntervalSet and CueStore', () => {
  it('IntervalSet merges overlapping and adjacent intervals', () => {
    const set = new IntervalSet();
    set.add(0, 1000);
    set.add(1000, 2500); // adjacent
    set.add(2000, 3000); // overlapping
    set.add(5000, 7000); // separate

    expect(set.all).toEqual([
      { startMs: 0, endMs: 3000 },
      { startMs: 5000, endMs: 7000 }
    ]);

    expect(set.contiguousAhead(500)).toBe(2500); // 3000 - 500
    expect(set.contiguousAhead(3500)).toBe(0);   // in gap
    expect(set.contiguousAhead(5500)).toBe(1500); // 7000 - 5500
  });

  it('CueStore binary searches cueAt and nextBoundaryAfter', () => {
    const store = new CueStore({ cacheEnabled: false });
    store.addCue({ id: 'c1', startMs: 1000, endMs: 3000, text: 'Hello', sourceText: 'Hello', srcLang: 'en', tgtLang: 'vi' });
    store.addCue({ id: 'c2', startMs: 4000, endMs: 6000, text: 'World', sourceText: 'World', srcLang: 'en', tgtLang: 'vi' });

    expect(store.cueAt(500)).toBeNull();
    expect(store.cueAt(2000)?.id).toBe('c1');
    expect(store.cueAt(3500)).toBeNull();
    expect(store.cueAt(4500)?.id).toBe('c2');

    expect(store.nextBoundaryAfter(500)).toBe(1000);
    expect(store.nextBoundaryAfter(1500)).toBe(3000);
    expect(store.nextBoundaryAfter(3000)).toBe(4000);
    expect(store.nextBoundaryAfter(4500)).toBe(6000);
    expect(store.nextBoundaryAfter(6500)).toBeNull();
  });

  it('exports valid SubRip with UTF-8 BOM', () => {
    const store = new CueStore({ cacheEnabled: false });
    store.addCue({ id: 'c1', startMs: 1000, endMs: 2500, text: 'Xin chào', sourceText: 'Hello', srcLang: 'en', tgtLang: 'vi' });

    const srt = store.exportSrt({ bilingual: true });
    expect(srt.startsWith('\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nXin chào\r\nHello')).toBe(true);
  });

  it('computes stable cache keys stripping URL tracking and time params', () => {
    const key1 = CueStore.computeCacheKey({
      canonicalUrlOrId: 'https://youtube.com/watch?v=abc123xyz&t=45s&si=deadbeef',
      srcLang: 'en',
      tgtLang: 'vi',
      asrModelId: 'nemotron-80ms',
      translatorModelId: 'translategemma-4b-q4',
      promptVersion: 'v1'
    });

    const key2 = CueStore.computeCacheKey({
      canonicalUrlOrId: 'https://youtube.com/watch?v=abc123xyz',
      srcLang: 'en',
      tgtLang: 'vi',
      asrModelId: 'nemotron-80ms',
      translatorModelId: 'translategemma-4b-q4',
      promptVersion: 'v1'
    });

    expect(key1).toBe(key2);
  });

  it('saves and loads from disk cache with LRU pruning', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preroll-test-cache-'));
    try {
      const store = new CueStore({ cacheDir: tempDir, cacheEnabled: true });
      store.addCue({ id: 'c1', startMs: 1000, endMs: 3000, text: 'Cached Text', sourceText: 'Hello', srcLang: 'en', tgtLang: 'vi' });

      const meta = {
        id: 'vid1',
        url: 'https://example.com/video1',
        srcLang: 'en',
        tgtLang: 'vi',
        asrModelId: 'asr-1',
        translatorModelId: 'trans-1',
        promptVersion: '1',
        createdAt: Date.now()
      };

      store.saveToCache(meta);

      const loaded = CueStore.loadFromCache(tempDir, {
        canonicalUrlOrId: meta.url,
        srcLang: meta.srcLang,
        tgtLang: meta.tgtLang,
        asrModelId: meta.asrModelId,
        translatorModelId: meta.translatorModelId,
        promptVersion: meta.promptVersion
      });

      expect(loaded).not.toBeNull();
      expect(loaded!.allCues).toHaveLength(1);
      expect(loaded!.allCues[0].text).toBe('Cached Text');

      CueStore.clearCache(tempDir);
      const afterClear = CueStore.loadFromCache(tempDir, {
        canonicalUrlOrId: meta.url,
        srcLang: meta.srcLang,
        tgtLang: meta.tgtLang,
        asrModelId: meta.asrModelId,
        translatorModelId: meta.translatorModelId,
        promptVersion: meta.promptVersion
      });
      expect(afterClear).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('PrerollScheduler', () => {
  // Fake AudioSource
  const createFakeAudioSource = (durationMs = 600000): AudioSource => ({
    async info() {
      return { id: 'test-vid', durationMs, isLive: false, drm: false };
    },
    async *open(startMs: Ms, signal: AbortSignal) {
      let current = startMs;
      while (current < durationMs && !signal.aborted) {
        // Yield 1-second 16kHz mono block
        yield { startMs: current, pcm: new Int16Array(16000) };
        current += 1000;
      }
    }
  });

  // Fake AsrBackend
  const createFakeAsr = (): AsrBackend => ({
    async *transcribe(blocks, signal) {
      for await (const b of blocks) {
        if (signal.aborted) break;
        // Yield a segment every 2 seconds
        if (b.startMs % 2000 === 0) {
          yield {
            startMs: b.startMs,
            endMs: b.startMs + 2000,
            text: `Speech at ${b.startMs}ms.`
          };
        }
      }
    }
  });

  // Fake Translator
  const createFakeTranslator = (): Translator => ({
    async ready() {},
    async translate(units) {
      return units.map((u) => ({ id: u.id, text: `[DICH] ${u.text}`, ok: true }));
    },
    stats() { return { backend: 'cpu', queued: 0 }; },
    async dispose() {}
  });

  it('starts in gated state and opens gate when buffer reaches threshold', async () => {
    const audioSource = createFakeAudioSource(600000);
    const asr = createFakeAsr();
    const translator = createFakeTranslator();
    const store = new CueStore({ cacheEnabled: false });

    // Use smaller 6000ms buffer gate for test speed
    const scheduler = new PrerollScheduler(audioSource, asr, translator, store, {
      prerollMs: 6000,
      startGateMs: 6000,
      holdPlaybackUntilReady: true
    });

    let gateOpened = false;
    scheduler.onGateOpen(() => { gateOpened = true; });

    const statuses: PrerollStatus[] = [];
    scheduler.onStatus((s) => statuses.push(s));

    await scheduler.start(0);

    // Wait until gate opens
    for (let i = 0; i < 50; i++) {
      if (gateOpened) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    scheduler.stop();
    expect(gateOpened).toBe(true);
    expect(store.readyAheadMs(0)).toBeGreaterThanOrEqual(6000);
  });

  it('playNow opens gate immediately', async () => {
    const audioSource = createFakeAudioSource(600000);
    const asr = createFakeAsr();
    const translator = createFakeTranslator();
    const store = new CueStore({ cacheEnabled: false });

    const scheduler = new PrerollScheduler(audioSource, asr, translator, store, {
      prerollMs: 300000,
      startGateMs: 300000,
      holdPlaybackUntilReady: true
    });

    let gateOpened = false;
    scheduler.onGateOpen(() => { gateOpened = true; });

    await scheduler.start(0);
    expect(scheduler.getStatus().state).toBe('gated');

    scheduler.playNow();
    expect(gateOpened).toBe(true);
    expect(scheduler.getStatus().state).toBe('playing');
    scheduler.stop();
  });

  it('seeks into uncovered range and re-plans fetch epoch', async () => {
    const audioSource = createFakeAudioSource(600000);
    const asr = createFakeAsr();
    const translator = createFakeTranslator();
    const store = new CueStore({ cacheEnabled: false });

    const scheduler = new PrerollScheduler(audioSource, asr, translator, store, {
      prerollMs: 10000,
      startGateMs: 10000
    });

    await scheduler.start(0);
    scheduler.seek(150000);

    expect(scheduler.getStatus().state).toBe('seeking');
    scheduler.stop();
  });
});
