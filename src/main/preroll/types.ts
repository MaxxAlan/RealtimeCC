export type Ms = number; // video media time, milliseconds
export type Interval = { startMs: Ms; endMs: Ms };
export type AsrSegment = { startMs: Ms; endMs: Ms; text: string };
export type TranslationUnit = { id: string; startMs: Ms; endMs: Ms; text: string; src: string; tgt: string };
export type MediaCue = { id: string; startMs: Ms; endMs: Ms; text: string; sourceText: string; srcLang: string; tgtLang: string };

export interface AudioSource {
  /** 16 kHz mono s16le blocks starting at startMs, as fast as the network/decoder allow. Abortable. */
  open(startMs: Ms, signal: AbortSignal): AsyncIterable<{ startMs: Ms; pcm: Int16Array }>;
  info(): Promise<{ durationMs: Ms | null; isLive: boolean; drm: boolean; id: string }>;
}

export interface AsrBackend {
  transcribe(blocks: AsyncIterable<{ startMs: Ms; pcm: Int16Array }>, signal: AbortSignal): AsyncIterable<AsrSegment>;
}

export interface Translator {
  ready(): Promise<void>;
  translate(units: TranslationUnit[], opts: { signal: AbortSignal }): Promise<Array<{ id: string; text: string; ok: boolean }>>;
  stats(): { tokensPerSecond?: number; backend?: 'cuda' | 'vulkan' | 'cpu'; queued: number };
  dispose(): Promise<void>;
}

export interface Clock {
  nowMs(): Ms;
  paused(): boolean;
  rate(): number;
  onChange(cb: (kind: 'seek' | 'pause' | 'play' | 'rate') => void): () => void;
}

export type PrerollState = 'idle' | 'resolving' | 'warming' | 'buffering' | 'gated' | 'playing' | 'seeking' | 'ended' | 'error' | 'fallback';

export type PrerollStatus = {
  state: PrerollState;
  readyAheadMs: Ms;
  playheadMs: Ms;
  underruns: number;
  asrRtf?: number;
  unitsPerSecond?: number;
  backend?: 'cuda' | 'vulkan' | 'cpu';
  message?: string;
  activeMedia?: any;
  extensionConnected?: boolean;
  manualUrl?: string | null;
};
