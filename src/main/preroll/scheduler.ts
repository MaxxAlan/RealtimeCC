import { AudioSource, AsrBackend, Translator, PrerollStatus, PrerollState, Ms, TranslationUnit } from './types';
import { CueStore } from './cue-store';
import { Segmenter } from './segmenter';
import { formatCue } from './cue-format';

export interface SchedulerOptions {
  prerollMs?: Ms;          // default 300 000 (5 min)
  maxAheadMs?: Ms;         // default 600 000 (10 min)
  startGateMs?: Ms;        // default 300 000
  holdPlaybackUntilReady?: boolean; // default true
  srcLang?: string;
  tgtLang?: string;
}

export type StatusListener = (status: PrerollStatus) => void;

export class PrerollScheduler {
  private state: PrerollState = 'idle';
  private playheadMs: Ms = 0;
  private isPaused = true;
  private durationMs: Ms | null = null;
  private gateOpened = false;
  private underruns = 0;
  private activeEpochController: AbortController | null = null;
  private translationQueue: TranslationUnit[] = [];
  private isTranslating = false;
  private listeners: Set<StatusListener> = new Set();
  private gateOpenCallbacks: Set<() => void> = new Set();
  private lastMessage?: string;
  private totalTranslatedUnits = 0;
  private translationStartTime = 0;

  private readonly prerollMs: Ms;
  private readonly maxAheadMs: Ms;
  private readonly startGateMs: Ms;
  private readonly holdPlaybackUntilReady: boolean;
  private readonly srcLang: string;
  private readonly tgtLang: string;

  constructor(
    private readonly audioSource: AudioSource,
    private readonly asrBackend: AsrBackend,
    private readonly translator: Translator,
    public readonly cueStore: CueStore,
    options: SchedulerOptions = {}
  ) {
    this.prerollMs = options.prerollMs ?? 300000;
    this.maxAheadMs = options.maxAheadMs ?? 600000;
    this.startGateMs = options.startGateMs ?? this.prerollMs;
    this.holdPlaybackUntilReady = options.holdPlaybackUntilReady ?? true;
    this.srcLang = options.srcLang ?? 'en';
    this.tgtLang = options.tgtLang ?? 'vi';
  }

  public onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onGateOpen(callback: () => void): () => void {
    this.gateOpenCallbacks.add(callback);
    return () => this.gateOpenCallbacks.delete(callback);
  }

  public getStatus(): PrerollStatus {
    const readyAheadMs = this.cueStore.readyAheadMs(this.playheadMs);
    const stats = this.translator.stats();
    const asrClient = this.asrBackend as any;
    const asrRtf = typeof asrClient?.rtf === 'number' ? asrClient.rtf : undefined;

    const elapsedSec = this.translationStartTime > 0 ? (Date.now() - this.translationStartTime) / 1000 : 0;
    const unitsPerSecond = elapsedSec > 0 ? Number((this.totalTranslatedUnits / elapsedSec).toFixed(1)) : undefined;

    return {
      state: this.state,
      readyAheadMs,
      playheadMs: this.playheadMs,
      underruns: this.underruns,
      asrRtf,
      unitsPerSecond,
      backend: stats.backend,
      message: this.lastMessage
    };
  }

  private emitStatus(state?: PrerollState, message?: string): void {
    if (state) this.state = state;
    if (message !== undefined) this.lastMessage = message;
    const status = this.getStatus();
    for (const listener of this.listeners) {
      try { listener(status); } catch {}
    }
  }

  public async start(initialPlayheadMs: Ms = 0): Promise<void> {
    if (this.state !== 'idle') {
      this.stop();
    }

    this.playheadMs = initialPlayheadMs;
    this.gateOpened = !this.holdPlaybackUntilReady;
    this.underruns = 0;
    this.totalTranslatedUnits = 0;
    this.translationStartTime = Date.now();

    this.emitStatus('resolving', 'Resolving media audio stream...');

    try {
      const info = await this.audioSource.info();
      this.durationMs = info.durationMs;

      if (info.isLive) {
        this.emitStatus('fallback', 'Live streams cannot be pre-rolled. Falling back to live mode.');
        return;
      }
      if (info.drm) {
        this.emitStatus('fallback', 'DRM media cannot be pre-rolled. Falling back to live mode.');
        return;
      }

      this.emitStatus('warming', 'Initializing local translator...');
      await this.translator.ready();

      const initialGateState = this.gateOpened ? 'buffering' : 'gated';
      this.emitStatus(initialGateState, 'Buffering pre-roll subtitles...');

      this.startEpoch(this.playheadMs);
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('fallback') || err.code === 'LIVE_STREAM' || err.code === 'DRM_PROTECTED') {
        this.emitStatus('fallback', msg);
      } else {
        this.emitStatus('error', `Pre-roll start failed: ${msg}`);
      }
    }
  }

  public updatePlayhead(playheadMs: Ms, paused = false): void {
    this.playheadMs = playheadMs;
    this.isPaused = paused;

    const readyAhead = this.cueStore.readyAheadMs(playheadMs);

    // Check underrun
    if (!paused && readyAhead <= 0 && this.state === 'playing') {
      this.underruns++;
      this.emitStatus(undefined, 'Captions catching up...');
    }

    // Check gate opening condition
    this.checkGateCondition(readyAhead);

    // Back-pressure: if paused and buffer ahead is plenty, we can idle
    if (paused && readyAhead >= this.maxAheadMs && this.state !== 'gated') {
      this.emitStatus('idle', 'Buffer full. Paused.');
    }
  }

  public seek(targetMs: Ms): void {
    this.playheadMs = targetMs;
    const readyAhead = this.cueStore.readyAheadMs(targetMs);

    // If target position already has at least 5s of translated cues, instant seek
    if (readyAhead >= 5000) {
      this.emitStatus(this.gateOpened ? 'playing' : 'gated');
      return;
    }

    // Otherwise, abort in-flight work and re-plan from targetMs
    this.emitStatus('seeking', `Seeking to ${Math.round(targetMs / 1000)}s...`);
    this.translationQueue = [];
    this.startEpoch(Math.max(0, targetMs - 1000));
  }

  public playNow(): void {
    if (!this.gateOpened) {
      this.gateOpened = true;
      for (const cb of this.gateOpenCallbacks) {
        try { cb(); } catch {}
      }
      this.emitStatus('playing', 'Playback started by user.');
    }
  }

  public stop(): void {
    if (this.activeEpochController) {
      this.activeEpochController.abort();
      this.activeEpochController = null;
    }
    this.translationQueue = [];
    this.isTranslating = false;
    this.state = 'idle';
    this.lastMessage = undefined;
    this.emitStatus('idle');
  }

  private startEpoch(fetchStartMs: Ms): void {
    if (this.activeEpochController) {
      this.activeEpochController.abort();
    }
    const controller = new AbortController();
    this.activeEpochController = controller;

    void this.runPipelineEpoch(fetchStartMs, controller.signal);
  }

  private async runPipelineEpoch(startMs: Ms, signal: AbortSignal): Promise<void> {
    try {
      const audioStream = this.audioSource.open(startMs, signal);
      const asrStream = this.asrBackend.transcribe(audioStream, signal);
      const segmenter = new Segmenter({
        srcLang: this.srcLang,
        tgtLang: this.tgtLang
      });

      for await (const segment of asrStream) {
        if (signal.aborted) return;

        this.cueStore.addTranscribed(segment.startMs, segment.endMs);
        const units = segmenter.push(segment);

        for (const u of units) {
          this.enqueueTranslation(u);
        }

        // Check if ready to translate
        void this.processTranslationQueue(signal);

        // Check gate
        const readyAhead = this.cueStore.readyAheadMs(this.playheadMs);
        this.checkGateCondition(readyAhead);

        // Back-pressure check: if buffer is deeply ahead (> maxAheadMs), throttle
        if (readyAhead >= this.maxAheadMs) {
          await this.waitForPlayheadAdvance(signal);
        }
      }

      // Flush remaining segments
      const finalUnits = segmenter.flush();
      for (const u of finalUnits) {
        this.enqueueTranslation(u);
      }
      await this.processTranslationQueue(signal);

      if (!signal.aborted) {
        this.emitStatus('ended', 'End of audio stream reached.');
      }
    } catch (e: any) {
      if (signal.aborted) return;
      this.emitStatus('error', `Pipeline error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private enqueueTranslation(unit: TranslationUnit): void {
    // Drop units that ended behind current playhead by more than 3 seconds
    if (unit.endMs < this.playheadMs - 3000) return;
    this.translationQueue.push(unit);
  }

  private async processTranslationQueue(signal: AbortSignal): Promise<void> {
    if (this.isTranslating || this.translationQueue.length === 0 || signal.aborted) return;
    this.isTranslating = true;

    try {
      while (this.translationQueue.length > 0 && !signal.aborted) {
        // Drop stale units behind playhead
        this.translationQueue = this.translationQueue.filter((u) => u.endMs >= this.playheadMs - 2000);
        if (this.translationQueue.length === 0) break;

        // Sort by distance ahead of playhead (closest first)
        this.translationQueue.sort((a, b) => {
          const distA = Math.abs(a.startMs - this.playheadMs);
          const distB = Math.abs(b.startMs - this.playheadMs);
          return distA - distB;
        });

        // Take a batch of up to 4 units
        const batch = this.translationQueue.splice(0, 4);
        const results = await this.translator.translate(batch, { signal });

        for (let i = 0; i < batch.length; i++) {
          const unit = batch[i];
          const res = results.find((r) => r.id === unit.id);
          const text = res && res.ok ? res.text : unit.text;

          // Format cue
          const formatted = formatCue({
            text,
            startMs: unit.startMs,
            endMs: unit.endMs
          }, undefined, this.tgtLang);

          for (const fc of formatted) {
            this.cueStore.addCue({
              id: `${unit.id}-${fc.startMs}`,
              startMs: fc.startMs,
              endMs: fc.endMs,
              text: fc.text,
              sourceText: unit.text,
              srcLang: unit.src,
              tgtLang: unit.tgt
            });
          }

          this.totalTranslatedUnits++;
        }

        const readyAhead = this.cueStore.readyAheadMs(this.playheadMs);
        this.checkGateCondition(readyAhead);
        this.emitStatus();
      }
    } finally {
      this.isTranslating = false;
    }
  }

  private checkGateCondition(readyAhead: Ms): void {
    if (this.gateOpened) {
      if (this.state === 'gated' || this.state === 'buffering') {
        this.emitStatus(this.isPaused ? 'idle' : 'playing');
      }
      return;
    }

    // Gate opens when readyAhead reaches startGateMs, or video ended / duration reached
    const reachedGate = readyAhead >= this.startGateMs;
    const reachedEnd = this.durationMs !== null && readyAhead >= Math.max(0, this.durationMs - this.playheadMs - 1000);

    if (reachedGate || reachedEnd) {
      this.gateOpened = true;
      for (const cb of this.gateOpenCallbacks) {
        try { cb(); } catch {}
      }
      this.emitStatus(this.isPaused ? 'idle' : 'playing', 'Pre-roll buffer ready.');
    } else {
      const remainingSec = Math.ceil(Math.max(0, this.startGateMs - readyAhead) / 1000);
      this.emitStatus('gated', `Buffering: ${Math.round(readyAhead / 1000)}s / ${Math.round(this.startGateMs / 1000)}s ready (${remainingSec}s remaining)`);
    }
  }

  private async waitForPlayheadAdvance(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const readyAhead = this.cueStore.readyAheadMs(this.playheadMs);
      if (readyAhead < this.maxAheadMs - 30000) {
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
