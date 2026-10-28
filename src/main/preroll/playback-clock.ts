import { Clock, Ms } from './types';

export interface ClockSample {
  positionMs: Ms;
  paused: boolean;
  rate?: number;
  receivedAt?: number; // monotonic performance.now() timestamp
}

export type ClockChangeKind = 'seek' | 'pause' | 'play' | 'rate';
export type ClockChangeListener = (kind: ClockChangeKind) => void;

export class PlaybackClock implements Clock {
  private lastSample: {
    positionMs: Ms;
    paused: boolean;
    rate: number;
    receivedAt: number;
  };

  private slewOffsetMs = 0;
  private lastSlewDecayAt: number;
  private listeners: Set<ClockChangeListener> = new Set();

  constructor(initialSample?: ClockSample) {
    const now = performance.now();
    this.lastSample = {
      positionMs: initialSample?.positionMs ?? 0,
      paused: initialSample?.paused ?? true,
      rate: initialSample?.rate ?? 1.0,
      receivedAt: initialSample?.receivedAt ?? now
    };
    this.lastSlewDecayAt = now;
  }

  public nowMs(): Ms {
    const now = performance.now();
    if (this.lastSample.paused) {
      return this.lastSample.positionMs;
    }

    // Extrapolate position with rate
    const elapsedWallMs = Math.max(0, now - this.lastSample.receivedAt);
    const mediaElapsedMs = elapsedWallMs * this.lastSample.rate;

    // Decay slew offset smoothly towards 0 over time
    const decayElapsed = Math.max(0, now - this.lastSlewDecayAt);
    if (decayElapsed > 0 && Math.abs(this.slewOffsetMs) > 0.1) {
      const decayFactor = Math.exp(-decayElapsed / 250); // decay half-life ~250ms
      this.slewOffsetMs *= decayFactor;
      this.lastSlewDecayAt = now;
    }

    return Math.max(0, this.lastSample.positionMs + mediaElapsedMs + this.slewOffsetMs);
  }

  public paused(): boolean {
    return this.lastSample.paused;
  }

  public rate(): number {
    return this.lastSample.rate;
  }

  public onChange(cb: ClockChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(kind: ClockChangeKind): void {
    for (const cb of this.listeners) {
      try { cb(kind); } catch {}
    }
  }

  /**
   * Ingest a sample from browser extension or simulated clock.
   * Small errors (< 120ms) are slewed smoothly; large errors (> 120ms) hard-set (seek).
   */
  public update(sample: ClockSample): void {
    const now = sample.receivedAt ?? performance.now();
    const rate = typeof sample.rate === 'number' && sample.rate > 0 ? sample.rate : 1.0;
    const prevPaused = this.lastSample.paused;
    const prevRate = this.lastSample.rate;

    const currentCalculated = this.nowMs();
    const error = sample.positionMs - currentCalculated;

    let seekTriggered = false;
    let rateTriggered = false;
    let pauseTriggered = false;
    let playTriggered = false;

    // Detect play/pause change
    if (prevPaused !== sample.paused) {
      if (sample.paused) pauseTriggered = true;
      else playTriggered = true;
    }

    // Detect rate change
    if (Math.abs(prevRate - rate) > 0.01) {
      rateTriggered = true;
    }

    // Check position error
    if (Math.abs(error) > 120 || sample.paused) {
      // Hard set on seek or pause
      this.lastSample = {
        positionMs: sample.positionMs,
        paused: sample.paused,
        rate,
        receivedAt: now
      };
      this.slewOffsetMs = 0;
      this.lastSlewDecayAt = now;
      if (Math.abs(error) > 120) {
        seekTriggered = true;
      }
    } else {
      // Small drift: slew smoothly via inverse offset decaying to 0
      this.slewOffsetMs = -error * 0.5;
      this.lastSample = {
        positionMs: sample.positionMs,
        paused: sample.paused,
        rate,
        receivedAt: now
      };
      this.lastSlewDecayAt = now;
    }

    // Emit events in priority order
    if (seekTriggered) this.notify('seek');
    if (pauseTriggered) this.notify('pause');
    if (playTriggered) this.notify('play');
    if (rateTriggered) this.notify('rate');
  }

  /**
   * Reset clock state to a given media time.
   */
  public reset(positionMs: Ms = 0, paused = true): void {
    const now = performance.now();
    this.lastSample = {
      positionMs,
      paused,
      rate: 1.0,
      receivedAt: now
    };
    this.slewOffsetMs = 0;
    this.lastSlewDecayAt = now;
    this.notify('seek');
  }
}
