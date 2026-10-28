import path from 'node:path';
import { ExtensionBridge, ActiveMediaInfo } from './extension-bridge';
import { PlaybackClock, ClockSample } from './playback-clock';
import { CuePlayer, CaptionPayload } from './cue-player';
import { CueStore } from './cue-store';
import { PrerollScheduler } from './scheduler';
import { OnlineAudioSource } from './audio-source';
import { AsrBackend, Translator, PrerollStatus, Ms } from './types';

export interface PrerollSessionOptions {
  asrBackend: AsrBackend;
  translator: Translator;
  cacheDir?: string;
  port?: number;
  token?: string;
  prerollSeconds?: number;
  holdPlaybackUntilReady?: boolean;
  syncOffsetMs?: number;
  displayLeadMs?: number;
  srcLang?: string;
  tgtLang?: string;
  onCaption: (caption: CaptionPayload) => void;
  onStatusChange?: (status: PrerollStatus) => void;
}

export class PrerollSession {
  public readonly bridge: ExtensionBridge;
  public readonly clock: PlaybackClock;
  public readonly cueStore: CueStore;
  public cuePlayer: CuePlayer;
  private scheduler: PrerollScheduler | null = null;
  private manualUrl: string | null = null;
  private isRunning = false;

  private readonly asrBackend: AsrBackend;
  private readonly translator: Translator;
  private readonly cacheDir?: string;
  private readonly prerollMs: Ms;
  private readonly holdPlaybackUntilReady: boolean;
  private readonly srcLang: string;
  private readonly tgtLang: string;
  private readonly onCaption: (caption: CaptionPayload) => void;
  private readonly onStatusChange?: (status: PrerollStatus) => void;

  constructor(options: PrerollSessionOptions) {
    this.asrBackend = options.asrBackend;
    this.translator = options.translator;
    this.cacheDir = options.cacheDir;
    this.prerollMs = (options.prerollSeconds ?? 300) * 1000;
    this.holdPlaybackUntilReady = options.holdPlaybackUntilReady ?? true;
    this.srcLang = options.srcLang ?? 'en';
    this.tgtLang = options.tgtLang ?? 'vi';
    this.onCaption = options.onCaption;
    this.onStatusChange = options.onStatusChange;

    this.cueStore = new CueStore({
      cacheDir: options.cacheDir,
      cacheEnabled: true
    });

    this.clock = new PlaybackClock();

    this.cuePlayer = new CuePlayer({
      clock: this.clock,
      cueStore: this.cueStore,
      syncOffsetMs: options.syncOffsetMs ?? 0,
      displayLeadMs: options.displayLeadMs ?? 0,
      onCaption: (cap) => this.onCaption(cap)
    });

    this.bridge = new ExtensionBridge({
      port: options.port,
      token: options.token,
      onTick: (sample) => this.handleBridgeTick(sample),
      onActiveMediaChange: (media) => this.handleActiveMediaChange(media),
      onEvent: (ev) => this.handleBridgeEvent(ev),
      onConnectionChange: () => this.onStatusChange?.(this.getStatus())
    });
  }

  public get running(): boolean {
    return this.isRunning;
  }

  public setManualUrl(url: string | null): void {
    this.manualUrl = url;
    this.onStatusChange?.(this.getStatus());
  }

  public getManualUrl(): string | null {
    return this.manualUrl;
  }

  public async initBridge(): Promise<number> {
    return this.bridge.start();
  }

  public async start(): Promise<{ shouldFallback: boolean; reason?: string }> {
    if (this.isRunning) return { shouldFallback: false };

    const activeMedia = this.bridge.getActiveMedia();
    const targetUrl = activeMedia?.pageUrl || this.manualUrl;

    if (!targetUrl) {
      return {
        shouldFallback: true,
        reason: 'No active online video found in browser or manual URL field. Falling back to live audio capture.'
      };
    }

    if (activeMedia?.isLive) {
      return {
        shouldFallback: true,
        reason: 'The online video is a live stream. Pre-roll requires recorded media. Falling back to live audio capture.'
      };
    }

    if (activeMedia?.drm) {
      return {
        shouldFallback: true,
        reason: 'The online video is DRM-protected. Pre-roll cannot access stream directly. Falling back to live audio capture.'
      };
    }

    this.isRunning = true;

    // Ask extension to pause video while buffering if requested
    if (this.holdPlaybackUntilReady) {
      this.bridge.sendCommand({ name: 'pause' });
    }

    const audioSource = new OnlineAudioSource(targetUrl);
    const initialPositionMs = activeMedia?.positionMs ?? 0;
    this.clock.reset(initialPositionMs, true);

    this.scheduler = new PrerollScheduler(
      audioSource,
      this.asrBackend,
      this.translator,
      this.cueStore,
      {
        prerollMs: this.prerollMs,
        startGateMs: this.prerollMs,
        maxAheadMs: this.prerollMs * 2,
        holdPlaybackUntilReady: this.holdPlaybackUntilReady,
        srcLang: this.srcLang,
        tgtLang: this.tgtLang
      }
    );

    this.scheduler.onStatus((status) => {
      this.onStatusChange?.({
        ...status,
        activeMedia: this.bridge.getActiveMedia(),
        extensionConnected: this.bridge.isConnected(),
        manualUrl: this.manualUrl
      });
    });

    this.scheduler.onGateOpen(() => {
      if (this.holdPlaybackUntilReady) {
        this.bridge.sendCommand({ name: 'play' });
      }
      this.clock.update({
        positionMs: this.clock.nowMs(),
        paused: false
      });
      this.cuePlayer.scheduleNext();
    });

    await this.scheduler.start(initialPositionMs);
    return { shouldFallback: false };
  }

  public playNow(): void {
    if (this.scheduler) {
      this.scheduler.playNow();
    }
    this.bridge.sendCommand({ name: 'play' });
    this.clock.update({
      positionMs: this.clock.nowMs(),
      paused: false
    });
    this.cuePlayer.scheduleNext();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
    }
    this.clock.reset(0, true);
    this.cuePlayer.scheduleNext();
  }

  public getStatus(): PrerollStatus {
    const base = this.scheduler ? this.scheduler.getStatus() : {
      state: 'idle' as const,
      readyAheadMs: 0,
      playheadMs: this.clock.nowMs(),
      underruns: this.cuePlayer.getUnderruns()
    };
    return {
      ...base,
      activeMedia: this.bridge.getActiveMedia(),
      extensionConnected: this.bridge.isConnected(),
      manualUrl: this.manualUrl
    };
  }

  private handleBridgeTick(sample: ClockSample & { tabId: number; isAd?: boolean }): void {
    if (sample.isAd) {
      // Hide captions during ads
      this.onCaption({ final: '', partial: '', source: 'media' });
      return;
    }

    this.clock.update({
      positionMs: sample.positionMs,
      paused: sample.paused,
      rate: sample.rate,
      receivedAt: sample.receivedAt
    });

    if (this.scheduler) {
      this.scheduler.updatePlayhead(sample.positionMs, sample.paused);
    }
  }

  private handleActiveMediaChange(media: ActiveMediaInfo | null): void {
    if (!media) return;
    if (media.isAd) {
      this.onCaption({ final: '', partial: '', source: 'media' });
      return;
    }

    this.clock.update({
      positionMs: media.positionMs,
      paused: media.paused,
      rate: media.rate,
      receivedAt: performance.now()
    });

    if (this.scheduler) {
      this.scheduler.updatePlayhead(media.positionMs, media.paused);
    }
    this.onStatusChange?.(this.getStatus());
  }

  private handleBridgeEvent(ev: { tabId: number; name: string; positionMs: number }): void {
    if (ev.name === 'seeking' || ev.name === 'seeked') {
      this.clock.update({ positionMs: ev.positionMs, paused: this.clock.paused() });
      if (this.scheduler) {
        this.scheduler.seek(ev.positionMs);
      }
      this.cuePlayer.scheduleNext();
    }
  }

  public async dispose(): Promise<void> {
    this.stop();
    this.cuePlayer.dispose();
    await this.bridge.stop();
  }
}
