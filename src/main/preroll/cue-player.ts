import { Clock, Ms, MediaCue } from './types';
import { CueStore } from './cue-store';

export interface CaptionPayload {
  final: string;
  partial: string;
  source: 'media';
  startAt?: Ms;
  endAt?: Ms;
  captureAt?: number;
  cueId?: string;
}

export interface CuePlayerOptions {
  clock: Clock;
  cueStore: CueStore;
  syncOffsetMs?: number;   // -3000 to +3000 ms
  displayLeadMs?: number;  // 0 to 300 ms
  onCaption: (payload: CaptionPayload) => void;
  onUnderrun?: (count: number) => void;
}

export class CuePlayer {
  private clock: Clock;
  private cueStore: CueStore;
  private syncOffsetMs: number;
  private displayLeadMs: number;
  private onCaption: (payload: CaptionPayload) => void;
  private onUnderrunCallback?: (count: number) => void;

  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmittedCueId: string | null = null;
  private underrunCount = 0;
  private inUnderrun = false;
  private unsubscribeClock?: () => void;

  // Cue onset error instrumentation
  private onsetErrors: number[] = [];
  private expectedStartTimes: Map<string, number> = new Map();

  constructor(options: CuePlayerOptions) {
    this.clock = options.clock;
    this.cueStore = options.cueStore;
    this.syncOffsetMs = options.syncOffsetMs ?? 0;
    this.displayLeadMs = options.displayLeadMs ?? 0;
    this.onCaption = options.onCaption;
    this.onUnderrunCallback = options.onUnderrun;

    this.unsubscribeClock = this.clock.onChange((kind) => {
      this.handleClockChange(kind);
    });

    this.scheduleNext();
  }

  public setSyncOffsetMs(offsetMs: number): void {
    this.syncOffsetMs = Math.max(-3000, Math.min(3000, offsetMs));
    this.scheduleNext();
  }

  public getSyncOffsetMs(): number {
    return this.syncOffsetMs;
  }

  public setDisplayLeadMs(leadMs: number): void {
    this.displayLeadMs = Math.max(0, Math.min(300, leadMs));
    this.scheduleNext();
  }

  public getDisplayLeadMs(): number {
    return this.displayLeadMs;
  }

  public getUnderruns(): number {
    return this.underrunCount;
  }

  public getOnsetStats(): { p50Ms: number; p95Ms: number; count: number } {
    if (this.onsetErrors.length === 0) {
      return { p50Ms: 0, p95Ms: 0, count: 0 };
    }
    const sorted = [...this.onsetErrors].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    return { p50Ms: Math.round(p50), p95Ms: Math.round(p95), count: sorted.length };
  }

  public reportPaint(cueId: string, paintMonotonicMs: number): void {
    const expected = this.expectedStartTimes.get(cueId);
    if (expected !== undefined) {
      const errorMs = Math.abs(paintMonotonicMs - expected);
      this.onsetErrors.push(errorMs);
      if (this.onsetErrors.length > 1000) {
        this.onsetErrors.shift();
      }
      this.expectedStartTimes.delete(cueId);
    }
  }

  private handleClockChange(kind: 'seek' | 'pause' | 'play' | 'rate'): void {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }

    if (kind === 'pause') {
      // Keep displaying current cue when paused
      return;
    }

    // On seek, play, or rate change: immediately evaluate and schedule
    this.scheduleNext();
  }

  public scheduleNext(): void {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }

    if (this.clock.paused()) {
      return;
    }

    const rawMs = this.clock.nowMs();
    const effectiveMs = rawMs + this.syncOffsetMs + this.displayLeadMs;
    const activeCue = this.cueStore.cueAt(effectiveMs);
    const isCovered = this.cueStore.translated.contains(effectiveMs);

    // Check underrun: playhead in uncovered media territory
    if (!activeCue && !isCovered && effectiveMs > 2000) {
      if (!this.inUnderrun) {
        this.inUnderrun = true;
        this.underrunCount++;
        this.onUnderrunCallback?.(this.underrunCount);
        this.onCaption({
          final: '',
          partial: 'Captions catching up...',
          source: 'media'
        });
        this.lastEmittedCueId = null;
      }
    } else {
      this.inUnderrun = false;
    }

    // Emit caption if active cue changed
    const currentCueId = activeCue ? activeCue.id : null;
    if (currentCueId !== this.lastEmittedCueId && !this.inUnderrun) {
      this.lastEmittedCueId = currentCueId;

      if (activeCue) {
        const wallNow = performance.now();
        this.expectedStartTimes.set(activeCue.id, wallNow);
        this.onCaption({
          final: activeCue.text,
          partial: '',
          source: 'media',
          startAt: activeCue.startMs,
          endAt: activeCue.endMs,
          cueId: activeCue.id,
          captureAt: activeCue.startMs
        });
      } else {
        this.onCaption({
          final: '',
          partial: '',
          source: 'media'
        });
      }
    }

    // Determine when next boundary occurs
    const nextBoundary = this.cueStore.nextBoundaryAfter(effectiveMs);
    const rate = Math.max(0.25, this.clock.rate());

    if (nextBoundary !== null) {
      const mediaDelayMs = nextBoundary - effectiveMs;
      const wallDelayMs = Math.max(5, Math.round(mediaDelayMs / rate));

      this.activeTimer = setTimeout(() => {
        this.activeTimer = null;
        this.scheduleNext();
      }, wallDelayMs);
    } else {
      // No further boundary known currently; if not fully covered, poll lightly (500ms) for newly arrived translated cues
      if (!isCovered) {
        this.activeTimer = setTimeout(() => {
          this.activeTimer = null;
          this.scheduleNext();
        }, 500);
      }
    }
  }

  public dispose(): void {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }
    this.unsubscribeClock?.();
    this.expectedStartTimes.clear();
  }
}
