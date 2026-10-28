import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Interval, MediaCue, Ms } from './types';

export class IntervalSet {
  private intervals: Interval[] = [];

  constructor(initial: Interval[] = []) {
    for (const inv of initial) {
      this.add(inv.startMs, inv.endMs);
    }
  }

  public get all(): readonly Interval[] {
    return this.intervals;
  }

  public add(startMs: Ms, endMs: Ms): void {
    if (startMs >= endMs) return;

    let newStart = startMs;
    let newEnd = endMs;
    const merged: Interval[] = [];
    let inserted = false;

    for (const inv of this.intervals) {
      // Current interval is entirely before new interval (not touching)
      if (inv.endMs < newStart) {
        merged.push(inv);
        continue;
      }
      // Current interval is entirely after new interval (not touching)
      if (inv.startMs > newEnd) {
        if (!inserted) {
          merged.push({ startMs: newStart, endMs: newEnd });
          inserted = true;
        }
        merged.push(inv);
        continue;
      }
      // Overlapping or touching: merge
      newStart = Math.min(newStart, inv.startMs);
      newEnd = Math.max(newEnd, inv.endMs);
    }

    if (!inserted) {
      merged.push({ startMs: newStart, endMs: newEnd });
    }

    this.intervals = merged;
  }

  public contains(ms: Ms): boolean {
    return this.intervals.some((inv) => ms >= inv.startMs && ms < inv.endMs);
  }

  public contiguousAhead(playheadMs: Ms): Ms {
    for (const inv of this.intervals) {
      if (playheadMs >= inv.startMs && playheadMs < inv.endMs) {
        return inv.endMs - playheadMs;
      }
      // If playhead is right at start of video (< 500ms) and interval starts within 500ms
      if (playheadMs < inv.startMs && inv.startMs <= 500 && playheadMs <= 500) {
        return inv.endMs - playheadMs;
      }
    }
    return 0;
  }

  public totalCoverage(): Ms {
    return this.intervals.reduce((sum, inv) => sum + (inv.endMs - inv.startMs), 0);
  }
}

export function srtTimestamp(ms: Ms): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

export interface CueStoreOptions {
  cacheDir?: string;
  cacheEnabled?: boolean;
}

export interface CacheMetadata {
  id: string;
  url: string;
  srcLang: string;
  tgtLang: string;
  asrModelId: string;
  translatorModelId: string;
  promptVersion: string;
  createdAt: number;
}

export class CueStore {
  private cues: MediaCue[] = [];
  public readonly transcribed = new IntervalSet();
  public readonly translated = new IntervalSet();
  private readonly cacheDir: string | null;
  private readonly cacheEnabled: boolean;

  constructor(options: CueStoreOptions = {}) {
    this.cacheDir = options.cacheDir ?? null;
    this.cacheEnabled = options.cacheEnabled ?? true;
  }

  public get allCues(): readonly MediaCue[] {
    return this.cues;
  }

  /**
   * Add a new translated media cue. Maintains sorted order and prevents overlapping.
   */
  public addCue(cue: MediaCue): void {
    if (cue.endMs <= cue.startMs) return;

    // Binary search for insertion position
    let low = 0;
    let high = this.cues.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.cues[mid].startMs <= cue.startMs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    // Insert cue at index low
    this.cues.splice(low, 0, cue);

    // Adjust any adjacent overlapping cues
    this.resolveOverlaps();

    // Update translated coverage
    this.translated.add(cue.startMs, cue.endMs);
  }

  /**
   * Add transcribed coverage range without cues yet.
   */
  public addTranscribed(startMs: Ms, endMs: Ms): void {
    this.transcribed.add(startMs, endMs);
  }

  /**
   * Contiguous translated coverage ahead of playhead (in milliseconds).
   */
  public readyAheadMs(playheadMs: Ms): Ms {
    return this.translated.contiguousAhead(playheadMs);
  }

  /**
   * Find cue active at the given media time in O(log n).
   */
  public cueAt(ms: Ms): MediaCue | null {
    if (this.cues.length === 0) return null;

    let low = 0;
    let high = this.cues.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const c = this.cues[mid];
      if (ms < c.startMs) {
        high = mid - 1;
      } else if (ms >= c.endMs) {
        low = mid + 1;
      } else {
        return c;
      }
    }
    return null;
  }

  /**
   * Find the next time boundary (either cue start or end) strictly after ms in O(log n).
   */
  public nextBoundaryAfter(ms: Ms): Ms | null {
    if (this.cues.length === 0) return null;

    let candidate: Ms | null = null;
    let low = 0;
    let high = this.cues.length - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const c = this.cues[mid];

      if (c.startMs > ms) {
        if (candidate === null || c.startMs < candidate) {
          candidate = c.startMs;
        }
        high = mid - 1;
      } else if (c.endMs > ms) {
        if (candidate === null || c.endMs < candidate) {
          candidate = c.endMs;
        }
        low = mid + 1;
      } else {
        low = mid + 1;
      }
    }

    return candidate;
  }

  /**
   * Export cues as SubRip (.srt) format with UTF-8 BOM.
   */
  public exportSrt(options: { bilingual?: boolean } = {}): string {
    const lines: string[] = [];
    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i];
      lines.push(String(i + 1));
      lines.push(`${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}`);
      if (options.bilingual && cue.sourceText && cue.sourceText !== cue.text) {
        lines.push(`${cue.text}\r\n${cue.sourceText}`);
      } else {
        lines.push(cue.text);
      }
      lines.push('');
    }
    return `\uFEFF${lines.join('\r\n')}`;
  }

  /**
   * Build canonical cache key from input metadata.
   */
  public static computeCacheKey(meta: {
    canonicalUrlOrId: string;
    srcLang: string;
    tgtLang: string;
    asrModelId: string;
    translatorModelId: string;
    promptVersion: string;
  }): string {
    // Strip query parameters like &t=, ?si=, &list= from canonical id
    const cleanId = meta.canonicalUrlOrId
      .replace(/[?&](t|start|si|feature)=[^&]*/g, '')
      .replace(/[?&]$/, '')
      .trim();

    const payload = [
      cleanId,
      meta.srcLang,
      meta.tgtLang,
      meta.asrModelId,
      meta.translatorModelId,
      meta.promptVersion
    ].join('::');

    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  /**
   * Save current store to disk cache.
   */
  public saveToCache(meta: CacheMetadata): void {
    if (!this.cacheEnabled || !this.cacheDir) return;

    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }

      const key = CueStore.computeCacheKey({
        canonicalUrlOrId: meta.url || meta.id,
        srcLang: meta.srcLang,
        tgtLang: meta.tgtLang,
        asrModelId: meta.asrModelId,
        translatorModelId: meta.translatorModelId,
        promptVersion: meta.promptVersion
      });

      const filePath = path.join(this.cacheDir, `${key}.json`);
      const data = {
        key,
        metadata: meta,
        cues: this.cues,
        transcribed: this.transcribed.all,
        translated: this.translated.all
      };

      fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
      CueStore.pruneCache(this.cacheDir, 30, 100 * 1024 * 1024);
    } catch {
      // Ignore cache write errors
    }
  }

  /**
   * Load store from disk cache if it exists.
   */
  public static loadFromCache(
    cacheDir: string,
    meta: {
      canonicalUrlOrId: string;
      srcLang: string;
      tgtLang: string;
      asrModelId: string;
      translatorModelId: string;
      promptVersion: string;
    }
  ): CueStore | null {
    try {
      const key = CueStore.computeCacheKey(meta);
      const filePath = path.join(cacheDir, `${key}.json`);
      if (!fs.existsSync(filePath)) return null;

      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.cues)) return null;

      const store = new CueStore({ cacheDir, cacheEnabled: true });
      for (const cue of parsed.cues) {
        store.cues.push(cue);
      }
      if (Array.isArray(parsed.transcribed)) {
        for (const inv of parsed.transcribed) {
          store.transcribed.add(inv.startMs, inv.endMs);
        }
      }
      if (Array.isArray(parsed.translated)) {
        for (const inv of parsed.translated) {
          store.translated.add(inv.startMs, inv.endMs);
        }
      }
      // Touch file for LRU update
      const now = new Date();
      fs.utimesSync(filePath, now, now);
      return store;
    } catch {
      return null;
    }
  }

  /**
   * Prune cache directory using LRU policy (max entries or max bytes).
   */
  public static pruneCache(cacheDir: string, maxEntries = 30, maxBytes = 100 * 1024 * 1024): void {
    try {
      if (!fs.existsSync(cacheDir)) return;
      const files = fs.readdirSync(cacheDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const p = path.join(cacheDir, f);
          const stat = fs.statSync(p);
          return { path: p, size: stat.size, mtimeMs: stat.mtimeMs };
        });

      // Sort oldest first
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let totalBytes = files.reduce((s, f) => s + f.size, 0);
      let count = files.length;

      for (const f of files) {
        if (count > maxEntries || totalBytes > maxBytes) {
          try {
            fs.unlinkSync(f.path);
            totalBytes -= f.size;
            count--;
          } catch {
            // Ignore individual delete errors
          }
        } else {
          break;
        }
      }
    } catch {
      // Ignore prune errors
    }
  }

  /**
   * Clear all cached files.
   */
  public static clearCache(cacheDir: string): void {
    try {
      if (!fs.existsSync(cacheDir)) return;
      const files = fs.readdirSync(cacheDir);
      for (const f of files) {
        if (f.endsWith('.json')) {
          try {
            fs.unlinkSync(path.join(cacheDir, f));
          } catch {}
        }
      }
    } catch {}
  }

  private resolveOverlaps(): void {
    for (let i = 0; i < this.cues.length - 1; i++) {
      const current = this.cues[i];
      const next = this.cues[i + 1];
      if (current.endMs > next.startMs) {
        current.endMs = Math.max(current.startMs + 200, next.startMs - 40);
      }
    }
  }
}
