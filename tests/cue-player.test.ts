import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybackClock } from '../src/main/preroll/playback-clock';
import { CuePlayer, CaptionPayload } from '../src/main/preroll/cue-player';
import { CueStore } from '../src/main/preroll/cue-store';

describe('PlaybackClock', () => {
  it('extrapolates position based on rate and elapsed monotonic time', () => {
    let mockTime = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

    const clock = new PlaybackClock({ positionMs: 5000, paused: false, rate: 1.0, receivedAt: 1000 });
    expect(clock.nowMs()).toBe(5000);

    mockTime = 2500; // 1500ms wall elapsed
    expect(clock.nowMs()).toBe(6500);

    // With 1.5x speed
    clock.update({ positionMs: 6500, paused: false, rate: 1.5, receivedAt: 2500 });
    mockTime = 3500; // 1000ms wall elapsed * 1.5 = 1500ms media elapsed
    expect(clock.nowMs()).toBe(8000);

    vi.restoreAllMocks();
  });

  it('slews small drift (<120ms) smoothly without jumping', () => {
    let mockTime = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

    const clock = new PlaybackClock({ positionMs: 5000, paused: false, rate: 1.0, receivedAt: 1000 });

    const events: string[] = [];
    clock.onChange((kind) => events.push(kind));

    // Sample arrives with 50ms drift (< 120ms)
    mockTime = 2000;
    clock.update({ positionMs: 6050, paused: false, rate: 1.0, receivedAt: 2000 });

    // Should NOT have triggered a seek event
    expect(events).not.toContain('seek');
    // Position slewed smoothly between extrapolated and target
    expect(clock.nowMs()).toBeGreaterThanOrEqual(6000);
    expect(clock.nowMs()).toBeLessThanOrEqual(6050);

    vi.restoreAllMocks();
  });

  it('triggers seek event and hard-sets for large drift (>120ms)', () => {
    let mockTime = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

    const clock = new PlaybackClock({ positionMs: 5000, paused: false, rate: 1.0, receivedAt: 1000 });

    const events: string[] = [];
    clock.onChange((kind) => events.push(kind));

    // Sample arrives with 2000ms jump (> 120ms seek)
    mockTime = 2000;
    clock.update({ positionMs: 35000, paused: false, rate: 1.0, receivedAt: 2000 });

    expect(events).toContain('seek');
    expect(clock.nowMs()).toBe(35000);

    vi.restoreAllMocks();
  });
});

describe('CuePlayer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('schedules exact boundaries without polling and avoids flicker', () => {
    let mockTime = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

    const clock = new PlaybackClock({ positionMs: 0, paused: false, rate: 1.0, receivedAt: 0 });
    const store = new CueStore({ cacheEnabled: false });

    store.addCue({ id: 'cue-1', startMs: 1000, endMs: 3000, text: 'Hello', sourceText: 'Hello', srcLang: 'en', tgtLang: 'vi' });
    store.addCue({ id: 'cue-2', startMs: 4000, endMs: 6000, text: 'World', sourceText: 'World', srcLang: 'en', tgtLang: 'vi' });

    const emittedCaptions: CaptionPayload[] = [];
    const player = new CuePlayer({
      clock,
      cueStore: store,
      onCaption: (c) => emittedCaptions.push(c)
    });

    // At t=0: no cue active
    expect(emittedCaptions).toHaveLength(0);

    // Advance to t=1000ms: cue-1 boundary
    mockTime = 1000;
    vi.advanceTimersByTime(1000);

    expect(emittedCaptions).toHaveLength(1);
    expect(emittedCaptions[0].final).toBe('Hello');

    // Advance to t=2000ms: middle of cue-1, should NOT re-emit (no flicker)
    mockTime = 2000;
    vi.advanceTimersByTime(1000);
    expect(emittedCaptions).toHaveLength(1);

    // Advance to t=3000ms: cue-1 end
    mockTime = 3000;
    vi.advanceTimersByTime(1000);
    expect(emittedCaptions).toHaveLength(2);
    expect(emittedCaptions[1].final).toBe('');

    // Advance to t=4000ms: cue-2 start
    mockTime = 4000;
    vi.advanceTimersByTime(1000);
    expect(emittedCaptions).toHaveLength(3);
    expect(emittedCaptions[2].final).toBe('World');

    player.dispose();
  });

  it('applies syncOffsetMs and displayLeadMs to caption delivery', () => {
    let mockTime = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

    const clock = new PlaybackClock({ positionMs: 0, paused: false, rate: 1.0, receivedAt: 0 });
    const store = new CueStore({ cacheEnabled: false });

    store.addCue({ id: 'cue-1', startMs: 2000, endMs: 4000, text: 'Offset Test', sourceText: 'Test', srcLang: 'en', tgtLang: 'vi' });

    const emittedCaptions: CaptionPayload[] = [];
    const player = new CuePlayer({
      clock,
      cueStore: store,
      syncOffsetMs: 500, // shifts playhead forward by 500ms (captions show 500ms earlier)
      onCaption: (c) => emittedCaptions.push(c)
    });

    // At wall time 1500ms, effective media time is 1500 + 500 = 2000ms (cue start!)
    mockTime = 1500;
    vi.advanceTimersByTime(1500);

    expect(emittedCaptions).toHaveLength(1);
    expect(emittedCaptions[0].final).toBe('Offset Test');

    player.dispose();
  });

  it('detects underrun when playhead enters uncovered media time', () => {
    let mockTime = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

    // Playhead is at 10000ms, but coverage is empty
    const clock = new PlaybackClock({ positionMs: 10000, paused: false, rate: 1.0, receivedAt: 0 });
    const store = new CueStore({ cacheEnabled: false });

    let underrunReported = 0;
    const emittedCaptions: CaptionPayload[] = [];

    const player = new CuePlayer({
      clock,
      cueStore: store,
      onCaption: (c) => emittedCaptions.push(c),
      onUnderrun: (count) => { underrunReported = count; }
    });

    expect(underrunReported).toBe(1);
    expect(emittedCaptions[0].partial).toBe('Captions catching up...');

    player.dispose();
  });
});
