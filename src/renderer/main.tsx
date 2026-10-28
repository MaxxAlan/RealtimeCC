import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, AudioLines, Captions, Check, ChevronDown, CircleHelp, Copy, Cpu, Download, Eye, EyeOff, Headphones, Languages, MonitorUp, Move, Play, Radio, Settings2, ShieldCheck, Square, Tv, Wifi, X } from 'lucide-react';
import './style.css';
import { isTranslateGemmaLanguage, liveLanguages, localReadyLanguages, translationLanguages } from '../main/languages';

type Status = { state: string; message?: string };
type Settings = {
  model: string;
  provider: 'local' | 'gemini';
  language: string;
  outputLanguage: string;
  fontSize: number;
  opacity: number;
  historySeconds: number;
  clickThrough: boolean;
  overlay: { width: number; height: number };
  modelInstalled: boolean;
  translatorInstalled?: boolean;
  hasGeminiKey: boolean;
  preroll?: {
    enabled: boolean;
    prerollSeconds: number;
    holdPlaybackUntilReady: boolean;
    syncOffsetMs: number;
    displayLeadMs: number;
    cacheEnabled: boolean;
  };
  translator?: {
    quant: 'Q4_K_M' | 'Q8_0';
    gpu: 'auto' | 'off';
  };
  asrPrerollVariant?: string;
  extensionPort?: number;
  extensionToken?: string;
  extensionConnected?: boolean;
  activeMedia?: {
    tabId: number;
    pageUrl: string;
    title: string;
    durationMs: number | null;
    isLive: boolean;
    drm: boolean;
    positionMs: number;
    paused: boolean;
    rate: number;
    isAd: boolean;
  } | null;
};

type PrerollStatus = {
  state: string;
  readyAheadMs: number;
  playheadMs: number;
  underruns: number;
  asrRtf?: number;
  unitsPerSecond?: number;
  backend?: 'cuda' | 'vulkan' | 'cpu';
  message?: string;
  activeMedia?: any;
  extensionConnected?: boolean;
  manualUrl?: string | null;
};

const initial: Settings = {
  model: 'nemotron-3.5-asr-streaming-0.6b-80ms-int8',
  provider: 'local',
  language: 'auto',
  outputLanguage: 'same',
  fontSize: 24,
  opacity: 82,
  historySeconds: 8,
  clickThrough: false,
  overlay: { width: 760, height: 180 },
  modelInstalled: false,
  translatorInstalled: false,
  hasGeminiKey: false,
  preroll: {
    enabled: true,
    prerollSeconds: 300,
    holdPlaybackUntilReady: true,
    syncOffsetMs: 0,
    displayLeadMs: 0,
    cacheEnabled: true
  }
};

function App() {
  const isOverlay = location.hash === '#overlay';
  const [settings, setSettings] = useState<Settings>(initial);
  const [status, setStatus] = useState<Status>({ state: 'stopped' });
  const [error, setError] = useState('');
  const [cloudConsent, setCloudConsent] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [keyMessage, setKeyMessage] = useState('');
  const [modelProgress, setModelProgress] = useState<any>({ state: 'idle' });
  const [translatorProgress, setTranslatorProgress] = useState<any>({ state: 'idle' });
  const [metrics, setMetrics] = useState<any>({ droppedChunks: 0 });

  const [prerollStatus, setPrerollStatus] = useState<PrerollStatus>({ state: 'idle', readyAheadMs: 0, playheadMs: 0, underruns: 0 });
  const [manualUrlInput, setManualUrlInput] = useState('');
  const [tokenCopied, setTokenCopied] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [prerollExportMsg, setPrerollExportMsg] = useState('');
  const [isBilingualSrt, setIsBilingualSrt] = useState(false);

  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaCues, setMediaCues] = useState<Array<{ startMs: number; endMs: number; text: string }>>([]);
  const [preloadingMedia, setPreloadingMedia] = useState(false);
  const [mediaProgress, setMediaProgress] = useState({ currentMs: 0, durationMs: 0, queuedChunks: 0 });
  const [mediaError, setMediaError] = useState('');
  const [exportMessage, setExportMessage] = useState('');

  const [caption, setCaption] = useState<{ final: string; partial: string; captureAt?: number; inferenceMs?: number; producedAt?: number; finalizedAt?: number }>({ final: '', partial: '' });
  const [level, setLevel] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const captureRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);
  const mediaAudioRef = useRef<HTMLAudioElement | null>(null);
  const mediaContextRef = useRef<AudioContext | null>(null);
  const mediaSendChainRef = useRef<Promise<void>>(Promise.resolve());
  const mediaAbortRef = useRef<AbortController | null>(null);
  const playerRef = useRef<HTMLMediaElement | null>(null);
  const cueRafRef = useRef<number | null>(null);
  const activeCueRef = useRef('');

  const refresh = useCallback(async () => {
    try {
      const s = await window.captionApi.getSettings();
      setSettings(s);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const a = window.captionApi.on('status', (s: Status) => {
      setStatus(s);
      if (s.state === 'error') setError(s.message ?? 'Unknown local ASR error');
      else if (s.state === 'connected') setError('');
    });
    const b = window.captionApi.on('caption', (next: any) =>
      setCaption((prev) =>
        next.source === 'media'
          ? { final: next.final ?? '', partial: '', finalizedAt: next.final ? Date.now() : prev.finalizedAt }
          : {
              final: next.final ? `${prev.final} ${next.final}`.trim().slice(-1200) : prev.final,
              partial: next.partial ?? '',
              captureAt: next.captureAt,
              producedAt: next.producedAt,
              inferenceMs: next.inferenceMs,
              finalizedAt: next.final ? Date.now() : prev.finalizedAt
            }
      )
    );
    const c = window.captionApi.on('metrics', setMetrics);
    const d = window.captionApi.on('model-progress', setModelProgress);
    const e = window.captionApi.on('media-progress', (p: any) => {
      setMediaProgress(p);
      const audio = mediaAudioRef.current;
      if (audio) {
        if (p.queuedChunks >= 6 && !audio.paused) audio.pause();
        else if (p.queuedChunks <= 2 && audio.paused && preloadingMedia) void audio.play().catch(() => {});
      }
    });
    const f = window.captionApi.on('translator-progress', setTranslatorProgress);
    const g = window.captionApi.on('preroll-status', (status: PrerollStatus) => {
      setPrerollStatus(status);
    });
    return () => {
      a(); b(); c(); d(); e(); f(); g();
    };
  }, [refresh, preloadingMedia]);

  useEffect(() => {
    if (!caption.finalizedAt || mediaCues.length) return;
    const remaining = Math.max(0, settings.historySeconds * 1000 - (Date.now() - caption.finalizedAt));
    timerRef.current = window.setTimeout(() => setCaption((prev) => ({ ...prev, final: '', finalizedAt: undefined })), remaining);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [caption.finalizedAt, settings.historySeconds, mediaCues.length]);

  useEffect(() => {
    if (!isOverlay || caption.captureAt == null || caption.producedAt == null) return;
    const payload = { captureAt: caption.captureAt, inferenceMs: caption.inferenceMs ?? 0, producedAt: caption.producedAt };
    const first = requestAnimationFrame(() => requestAnimationFrame(() => window.captionApi.reportCaptionVisible(payload)));
    return () => cancelAnimationFrame(first);
  }, [caption, isOverlay]);

  const patch = async (next: Partial<Settings>) => {
    try {
      const reconfigure = startedAt !== null && (next.language !== undefined || next.outputLanguage !== undefined);
      const s = reconfigure ? await window.captionApi.reconfigureSession(next) : await window.captionApi.saveSettings(next);
      setSettings(s);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const start = async () => {
    setError('');
    setCaption({ final: '', partial: '' });
    try {
      if (settings.provider === 'local' && !settings.modelInstalled) throw new Error('Download the local speech model first.');
      if (settings.provider === 'local' && settings.outputLanguage !== 'same' && !settings.translatorInstalled) throw new Error('Download the local translator model first.');
      if (settings.provider === 'gemini' && !cloudConsent) throw new Error('Confirm cloud audio sharing before starting.');
      if (settings.provider === 'gemini' && !settings.hasGeminiKey) throw new Error('Add your Google AI API key first.');

      const startRes = await window.captionApi.start(settings.provider === 'gemini' && cloudConsent);
      if (startRes && typeof startRes === 'object' && (startRes as any).mode === 'preroll') {
        setStartedAt(Date.now());
        setStatus({ state: 'connected', message: 'Smart pre-roll active.' });
        await window.captionApi.showOverlay();
        return;
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1, width: 16, height: 16 }, audio: true });
      captureRef.current = stream;
      for (const track of stream.getVideoTracks()) track.stop();
      const context = new AudioContext();
      audioRef.current = context;
      await context.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'pcm16');
      const mute = context.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
      node.port.onmessage = (event) => {
        const data: ArrayBuffer = event.data;
        const samples = new Int16Array(data);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 8) sum += samples[i] * samples[i];
        setLevel(Math.min(100, Math.sqrt(sum / Math.ceil(samples.length / 8)) / 327.68));
        void window.captionApi.sendAudio({ buffer: data, capturedAt: Date.now() - 80 });
      };
      for (const track of stream.getAudioTracks()) track.onended = () => void stop();
      setStartedAt(Date.now());
      setStatus({ state: 'connected' });
      await window.captionApi.showOverlay();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await window.captionApi.stop().catch(() => {});
      setStatus({ state: 'error' });
    }
  };

  const stop = async () => {
    captureRef.current?.getTracks().forEach((t) => t.stop());
    captureRef.current = null;
    await audioRef.current?.close().catch(() => {});
    audioRef.current = null;
    await window.captionApi.stop();
    setStartedAt(null);
    setLevel(0);
  };

  const downloadModel = async () => {
    setError('');
    try {
      await window.captionApi.downloadModel();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const prepareMedia = async () => {
    if (!mediaUrl || !mediaFile) return;
    if (startedAt !== null) {
      setMediaError('Stop live captions before preparing a media file.');
      return;
    }
    setMediaError('');
    setMediaCues([]);
    setPreloadingMedia(true);
    setMediaProgress({ currentMs: 0, durationMs: 0, queuedChunks: 0 });
    const abortController = new AbortController();
    mediaAbortRef.current = abortController;
    const audio = new Audio(mediaUrl);
    audio.preload = 'auto';
    audio.playbackRate = 1;
    mediaAudioRef.current = audio;
    let began = false;
    try {
      if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve, reject) => {
          audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
          audio.addEventListener('error', () => reject(new Error('This file audio format is not supported by the built-in media decoder.')), { once: true });
          abortController.signal.addEventListener('abort', () => reject(new Error('Media preparation cancelled.')), { once: true });
          audio.load();
        });
      }
      if (abortController.signal.aborted) throw new Error('Media preparation cancelled.');
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new Error('Could not read the duration or audio track from this media file.');
      await window.captionApi.beginMediaPreload({ durationMs: audio.duration * 1000, cloudConsent: settings.provider === 'gemini' && cloudConsent });
      began = true;
      if (abortController.signal.aborted) throw new Error('Media preparation cancelled.');
      const context = new AudioContext();
      mediaContextRef.current = context;
      await context.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
      const source = context.createMediaElementSource(audio);
      const node = new AudioWorkletNode(context, 'pcm16');
      const mute = context.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
      mediaSendChainRef.current = Promise.resolve();
      node.port.onmessage = (event) => {
        const buffer: ArrayBuffer = event.data;
        const capturedAt = Math.max(1, audio.currentTime * 1000 - 80);
        mediaSendChainRef.current = mediaSendChainRef.current.then(() => window.captionApi.sendMediaAudio({ buffer, capturedAt }));
      };
      const ended = new Promise<void>((resolve, reject) => {
        audio.addEventListener('ended', () => resolve(), { once: true });
        audio.addEventListener('error', () => reject(new Error('The media audio decoder stopped unexpectedly.')), { once: true });
        abortController.signal.addEventListener('abort', () => reject(new Error('Media preparation cancelled.')), { once: true });
      });
      await context.resume();
      await audio.play();
      await ended;
      if (abortController.signal.aborted) throw new Error('Media preparation cancelled.');
      await mediaSendChainRef.current;
      const silence = new Int16Array(1280);
      for (let i = 0; i < 7; i++) await window.captionApi.sendMediaAudio({ buffer: silence.slice().buffer, capturedAt: audio.duration * 1000 + i * 80 });
      const cues = (await window.captionApi.finishMediaPreload()).sort((a, b) => a.startMs - b.startMs).map((cue, i, list) => ({ ...cue, endMs: Math.max(cue.startMs + 150, Math.min(cue.endMs, list[i + 1]?.startMs ?? cue.endMs)) }));
      began = false;
      setMediaCues(cues);
      setMediaProgress({ currentMs: audio.duration * 1000, durationMs: audio.duration * 1000, queuedChunks: 0 });
    } catch (e) {
      if (began) await window.captionApi.cancelMediaPreload().catch(() => {});
      if (!abortController.signal.aborted) setMediaError(e instanceof Error ? e.message : String(e));
    } finally {
      audio.pause();
      audio.src = '';
      mediaAudioRef.current = null;
      await mediaContextRef.current?.close().catch(() => {});
      mediaContextRef.current = null;
      mediaAbortRef.current = null;
      setPreloadingMedia(false);
    }
  };

  const cancelMedia = async () => {
    mediaAbortRef.current?.abort();
    mediaAudioRef.current?.pause();
    mediaAudioRef.current = null;
    await mediaContextRef.current?.close().catch(() => {});
    mediaContextRef.current = null;
    await window.captionApi.cancelMediaPreload();
    setPreloadingMedia(false);
  };

  const selectMediaFile = (file: File | undefined) => {
    if (!file) return;
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    setMediaFile(file);
    setMediaUrl(URL.createObjectURL(file));
    setMediaCues([]);
    setMediaError('');
    setCaption({ final: '', partial: '' });
  };

  const startCueSync = () => {
    if (cueRafRef.current != null) cancelAnimationFrame(cueRafRef.current);
    const tick = () => {
      const player = playerRef.current;
      if (!player) return;
      const now = player.currentTime * 1000;
      const cue = mediaCues.find((item) => now >= item.startMs && now < item.endMs);
      const text = cue?.text ?? '';
      if (text !== activeCueRef.current) {
        activeCueRef.current = text;
        setCaption({ final: text, partial: '' });
        window.captionApi.showMediaCaption(text);
      }
      if (!player.paused && !player.ended) cueRafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  const clearMediaCaption = () => {
    if (cueRafRef.current != null) cancelAnimationFrame(cueRafRef.current);
    cueRafRef.current = null;
    activeCueRef.current = '';
    setCaption({ final: '', partial: '' });
    window.captionApi.showMediaCaption('');
  };

  const clearHistory = () => {
    setCaption({ final: '', partial: '' });
  };

  const isBridgeConnected = prerollStatus.extensionConnected ?? settings.extensionConnected ?? false;
  const currentMedia = prerollStatus.activeMedia || settings.activeMedia;
  const gateTargetSec = settings.preroll?.prerollSeconds ?? 300;
  const readyAheadSec = (prerollStatus.readyAheadMs || 0) / 1000;
  const gatePercent = Math.min(100, Math.max(0, (readyAheadSec / gateTargetSec) * 100));

  if (isOverlay) {
    return (
      <div className="overlay" style={{ fontSize: settings.fontSize, backgroundColor: `rgba(5,7,11,${settings.opacity / 100})` }}>
        <div className="overlay-title">
          <span><Captions size={14}/> RealtimeCC</span>
          <span className="drag">● LIVE CAPTIONS</span>
          <button className="overlay-close" aria-label="Hide captions" title="Hide captions" onClick={() => void window.captionApi.hideOverlay()}>
            <X size={15}/>
          </button>
        </div>
        <div className="overlay-text">{caption.final} <span className="partial">{caption.partial}</span></div>
      </div>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brandmark"><AudioLines size={23}/></div>
        <div className="brand">Realtime<span>CC</span><small>LIVE CAPTIONS</small></div>
        <div className="top-spacer"/>
        <div className={`status-pill ${status.state}`}>
          <i/>
          {status.state === 'connected' ? 'Model ready' : status.state === 'connecting' ? 'Warming up' : status.state === 'error' ? 'Needs attention' : 'Ready'}
        </div>
        <button className="icon-button" title="Help" onClick={() => setError('This app runs local streaming speech recognition and TranslateGemma offline translation. Captured audio stays on this PC. Use Ctrl+Shift+C to show or hide the overlay.')}>
          <CircleHelp size={18}/>
        </button>
      </header>

      <div className="content">
        <section className="hero">
          <div className="eyebrow"><span className="pulse"/> {settings.provider === 'local' ? 'PRIVATE ON-DEVICE CAPTIONING' : 'LIVE CLOUD CAPTIONING'}</div>
          <h1>Hear every word.<br/><em>On your screen.</em></h1>
          <p>Live captions and smart pre-roll translation from the sound your PC is already playing.</p>
          <div className="hero-actions">
            <button className={`start-button ${startedAt ? 'stop' : ''}`} onClick={() => startedAt ? void stop() : void start()}>
              {startedAt ? <><Square size={16} fill="currentColor"/> Stop captions</> : <><Play size={17} fill="currentColor"/> Start captions</>}
            </button>
            <button className="secondary-button" onClick={() => void window.captionApi.showOverlay()}><MonitorUp size={17}/> Show overlay</button>
          </div>
          <div className="privacy-note">
            <ShieldCheck size={15}/> {settings.provider === 'local' ? 'Speech recognition and translation run 100% locally. Audio stays on this PC.' : 'Cloud mode streams system audio to Google for transcription or translation.'}
          </div>
        </section>

        {/* Smart pre-roll online video card */}
        <section className="preroll-card">
          <div className="card-heading">
            <div className="round-icon"><Tv size={17}/></div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <b>Smart pre-roll (online video)</b>
                {isBridgeConnected ? (
                  <span className="preroll-badge connected">● Bridge connected</span>
                ) : (
                  <span className="preroll-badge disconnected">○ Bridge disconnected</span>
                )}
              </div>
              <small>Zero-delay subtitle overlay ahead of browser playhead · YouTube, Vimeo, Twitch VOD, and direct web video</small>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer', color: '#ccd1d9' }}>
              <input
                type="checkbox"
                checked={settings.preroll?.enabled ?? true}
                onChange={(e) => void patch({ preroll: { ...(settings.preroll ?? initial.preroll!), enabled: e.target.checked } })}
              />
              Enabled
            </label>
          </div>

          {currentMedia ? (
            <div className="active-media-box">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                <b>Active video:</b>
                <a href={currentMedia.pageUrl} target="_blank" rel="noreferrer" title={currentMedia.pageUrl}>
                  {currentMedia.title || currentMedia.pageUrl}
                </a>
                {currentMedia.durationMs ? (
                  <small style={{ color: '#828a94', flexShrink: 0 }}>
                    ({Math.floor(currentMedia.durationMs / 60000)}m {Math.floor((currentMedia.durationMs % 60000) / 1000)}s)
                  </small>
                ) : null}
              </div>
              {currentMedia.drm ? (
                <span className="preroll-badge disconnected">DRM detected · live fallback</span>
              ) : currentMedia.isLive ? (
                <span className="preroll-badge disconnected">Live stream · live fallback</span>
              ) : (
                <span className="preroll-badge active">Tracked by extension</span>
              )}
            </div>
          ) : (
            <div className="preroll-row">
              <div className="preroll-input-wrap">
                <input
                  className="preroll-input"
                  type="text"
                  value={manualUrlInput}
                  onChange={(e) => setManualUrlInput(e.target.value)}
                  placeholder="Or paste video URL (YouTube, Vimeo, Twitch VOD, direct mp4/m3u8)..."
                />
                <button
                  className="secondary-button small"
                  onClick={async () => {
                    if (!manualUrlInput.trim()) return;
                    await window.captionApi.setManualUrl(manualUrlInput.trim());
                    setPrerollExportMsg('Video URL queued for pre-roll.');
                  }}
                >
                  Queue pre-roll
                </button>
                {manualUrlInput && (
                  <button
                    className="secondary-button small"
                    onClick={async () => {
                      setManualUrlInput('');
                      await window.captionApi.setManualUrl(null);
                      setPrerollExportMsg('Cleared manual URL.');
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
              <span style={{ color: '#a0eccc', fontFamily: 'Consolas, monospace', textTransform: 'uppercase' }}>
                Status: {prerollStatus.state || 'idle'} {prerollStatus.message ? `(${prerollStatus.message})` : ''}
              </span>
              <span style={{ color: '#828a94', fontSize: 10 }}>
                {readyAheadSec.toFixed(1)}s ready ahead · buffer gate: {gateTargetSec}s
              </span>
            </div>
            <div className="meter" style={{ margin: '8px 0 10px' }}>
              <div style={{ width: `${gatePercent}%` }} />
            </div>
          </div>

          <div className="preroll-row">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {(prerollStatus.state === 'buffering' || prerollStatus.state === 'gated') && (
                <button
                  className="start-button small"
                  style={{ height: 30, fontSize: 11, padding: '0 12px' }}
                  title="Skipping full buffer may cause caption underruns on fast speech"
                  onClick={() => void window.captionApi.playNowPreroll()}
                >
                  <Play size={12} fill="currentColor"/> Play now
                </button>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#828a94', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.preroll?.holdPlaybackUntilReady ?? true}
                  onChange={(e) => void patch({ preroll: { ...(settings.preroll ?? initial.preroll!), holdPlaybackUntilReady: e.target.checked } })}
                />
                Hold playback until ready
              </label>
            </div>

            <div className="offset-group">
              <small style={{ color: '#828a94', fontSize: 10, marginRight: 4 }}>Sync:</small>
              <button
                className="offset-btn"
                onClick={async () => {
                  const next = (settings.preroll?.syncOffsetMs ?? 0) - 100;
                  await window.captionApi.setSyncOffset(next);
                  await refresh();
                }}
              >
                -100ms
              </button>
              <button
                className="offset-btn"
                onClick={async () => {
                  const next = (settings.preroll?.syncOffsetMs ?? 0) + 100;
                  await window.captionApi.setSyncOffset(next);
                  await refresh();
                }}
              >
                +100ms
              </button>
              <button
                className="offset-btn"
                onClick={async () => {
                  await window.captionApi.setSyncOffset(0);
                  await refresh();
                }}
              >
                Reset
              </button>
              <span style={{ fontFamily: 'Consolas, monospace', fontSize: 10, color: '#92e3c2', marginLeft: 4 }}>
                {(settings.preroll?.syncOffsetMs ?? 0) > 0 ? `+${settings.preroll?.syncOffsetMs}ms` : `${settings.preroll?.syncOffsetMs ?? 0}ms`}
              </span>
            </div>
          </div>

          <div className="preroll-row" style={{ borderTop: '1px solid #1f242c', paddingTop: 9, marginTop: 11 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="secondary-button small"
                onClick={async () => {
                  const res = await window.captionApi.exportPrerollSrt(isBilingualSrt);
                  if (res.message) setPrerollExportMsg(res.message);
                  else if (res.saved) setPrerollExportMsg(`Exported: ${res.filePath}`);
                }}
              >
                <Download size={13}/> Export pre-roll SRT
              </button>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#828a94', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={isBilingualSrt}
                  onChange={(e) => setIsBilingualSrt(e.target.checked)}
                />
                Bilingual
              </label>
              <button
                className="secondary-button small"
                onClick={async () => {
                  await window.captionApi.clearPrerollCache();
                  setPrerollExportMsg('Pre-roll cache cleared.');
                }}
              >
                Clear cache
              </button>
            </div>

            <div>
              <button className="text-button" onClick={() => setPairingOpen(!pairingOpen)}>
                {pairingOpen ? 'Hide extension pairing' : 'Bridge setup & pairing'}
              </button>
            </div>
          </div>

          {prerollExportMsg && <div style={{ fontSize: 10, color: '#92e3c2', marginTop: 6 }}>{prerollExportMsg}</div>}

          {pairingOpen && (
            <div className="pairing-box">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <b style={{ color: '#e8eaf0' }}>Browser Extension Pairing (Manifest V3)</b>
                <button
                  className="secondary-button small"
                  onClick={() => {
                    const token = settings.extensionToken || '';
                    navigator.clipboard.writeText(token);
                    setTokenCopied(true);
                    setTimeout(() => setTokenCopied(false), 2000);
                  }}
                >
                  {tokenCopied ? <><Check size={12}/> Copied</> : <><Copy size={12}/> Copy token</>}
                </button>
              </div>
              <div>
                1. Open Chrome or Edge at <code>chrome://extensions</code> and turn on <b>Developer mode</b>.<br/>
                2. Click <b>Load unpacked</b> and select the <code>extension</code> folder in the RealtimeCC root.<br/>
                3. Click the extension toolbar icon, verify Port <code>{settings.extensionPort ?? 9876}</code>, paste the pairing token, and click Save & Connect.
              </div>
              <div style={{ wordBreak: 'break-all' }}>
                Token: <code>{settings.extensionToken || 'Loading token…'}</code>
              </div>
            </div>
          )}
        </section>

        {/* Local media file card */}
        <section className="media-card">
          <div className="card-heading">
            <div className="round-icon amber"><Captions size={17}/></div>
            <div>
              <b>Optional: prepare subtitles for a local media file</b>
              <small>Optional for offline files. For streaming online video, use Smart Pre-roll above.</small>
            </div>
          </div>
          <input type="file" accept="audio/*,video/*,.mkv,.mp4,.mov,.webm,.mp3,.wav,.m4a,.flac,.ogg" hidden id="media-file" onChange={(e) => selectMediaFile(e.target.files?.[0])}/>
          <div className="media-actions">
            <button className="secondary-button small" onClick={() => document.getElementById('media-file')?.click()}>
              <Download size={14}/>{mediaFile ? mediaFile.name : 'Choose audio or video'}
            </button>
            {preloadingMedia ? (
              <button className="secondary-button small" onClick={() => void cancelMedia()}>Cancel preparation</button>
            ) : (
              <button
                className="start-button media-start"
                disabled={!mediaFile || (settings.provider === 'local' && !settings.modelInstalled) || (settings.provider === 'gemini' && (!settings.hasGeminiKey || !cloudConsent))}
                onClick={() => void prepareMedia()}
              >
                <Play size={14} fill="currentColor"/>Prepare subtitles
              </button>
            )}
          </div>
          {preloadingMedia && (
            <>
              <div className="meter"><div style={{ width: `${mediaProgress.durationMs ? (mediaProgress.currentMs / mediaProgress.durationMs) * 100 : 0}%` }}/></div>
              <div className="key-foot">Preparing {Math.floor(mediaProgress.currentMs / 60000)} of {Math.ceil(mediaProgress.durationMs / 60000)} minutes · audio plays silently while captions are prepared</div>
            </>
          )}
          {mediaCues.length > 0 && mediaUrl && (
            <div className="media-player">
              {mediaFile?.type.startsWith('video/') ? (
                <video ref={(element) => { playerRef.current = element; }} src={mediaUrl} controls preload="metadata" onPlay={startCueSync} onPause={() => { if (cueRafRef.current != null) cancelAnimationFrame(cueRafRef.current); }} onEnded={clearMediaCaption}/>
              ) : (
                <audio ref={(element) => { playerRef.current = element; }} src={mediaUrl} controls preload="metadata" onPlay={startCueSync} onPause={() => { if (cueRafRef.current != null) cancelAnimationFrame(cueRafRef.current); }} onEnded={clearMediaCaption}/>
              )}
              <small>{mediaCues.length} caption segments ready · {settings.outputLanguage === 'same' ? 'spoken language' : `translated to ${translationLanguages.find((l) => l.code === settings.outputLanguage)?.label ?? settings.outputLanguage}`}</small>
            </div>
          )}
          {mediaError && <div className="error-banner"><X size={15}/><span>{mediaError}</span></div>}
          <div className="key-foot media-hint">Media is decoded on this PC. Cloud mode streams the selected file audio to Google only after consent.</div>
        </section>

        {/* Audio monitor card */}
        <section className="monitor-card">
          <div className="card-heading">
            <div className="round-icon"><Activity size={17}/></div>
            <div><b>Audio activity</b><small>Windows system output · default device</small></div>
            <span className="live-indicator">{startedAt ? 'LISTENING' : 'IDLE'}</span>
          </div>
          <div className="meter"><div style={{ width: `${level}%` }}/></div>
          <div className="monitor-footer"><span><Headphones size={14}/> System output</span><span>{level ? `${Math.round(level)}%` : 'No audio detected'}</span></div>
        </section>

        {/* Transcript preview card */}
        <section className="transcript-card">
          <div className="card-heading">
            <div className="round-icon amber"><Captions size={17}/></div>
            <div>
              <b>Caption preview</b>
              <small>{settings.provider === 'local' ? 'Local model language coverage' : 'Google Live supported languages'}</small>
            </div>
            <button className="text-button" onClick={async () => { const result = await window.captionApi.exportCaptions(); if (result.message) setError(result.message); else if (result.saved) setExportMessage(`SRT saved: ${result.filePath}`); }}>Export SRT</button>
            <button className="text-button" onClick={clearHistory}>Clear</button>
          </div>
          <div className="transcript">
            {caption.final || caption.partial ? (
              <>{caption.final} <span className="partial">{caption.partial}</span></>
            ) : (
              <span className="placeholder">Your captions will appear here when you start listening.</span>
            )}
          </div>
          <div className="transcript-meta">
            {exportMessage && <span>{exportMessage}</span>}
            <span><Radio size={13}/> LIVE PARTIAL CAPTIONS</span>
            <span><Wifi size={13}/> {status.state === 'connected' ? 'Running on this device' : 'Model not running'}</span>
          </div>
        </section>

        {/* Settings card */}
        <section className="settings-card">
          <div className="section-title"><Settings2 size={17}/><h2>Caption settings</h2></div>
          <div className="setting-row">
            <div className="setting-label">
              <Radio size={16}/>
              <div><b>Speech recognition</b><small>Local stays on this PC · Local recognizes speech but does not translate; Google Live offers translation.</small></div>
            </div>
            <div className="select-wrap">
              <select
                disabled={preloadingMedia}
                value={settings.provider}
                onChange={async (e) => {
                  const provider = e.target.value as 'local' | 'gemini';
                  if (preloadingMedia) return;
                  if (startedAt !== null) {
                    const accepted = provider !== 'gemini' || window.confirm('Switching to Google Live streams system audio to Google. Continue?');
                    if (!accepted) return;
                    try {
                      const next = await window.captionApi.switchProvider(provider, accepted && provider === 'gemini');
                      setSettings(next);
                      setCloudConsent(provider === 'gemini');
                      setError(provider === 'local' && settings.outputLanguage !== 'same' ? 'Local mode transcribes speech but cannot translate it; captions will use the spoken language.' : '');
                    } catch (error) {
                      setError(error instanceof Error ? error.message : String(error));
                    }
                  } else {
                    setCloudConsent(false);
                    void patch({ provider, outputLanguage: provider === 'local' ? 'same' : settings.outputLanguage });
                  }
                }}
              >
                <option value="local">Local · private</option>
                <option value="gemini">Google Live · cloud</option>
              </select>
              <ChevronDown size={14}/>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <Languages size={16}/>
              <div><b>Speech input language</b><small>{settings.provider === 'local' ? 'Auto or 28 local-ready languages' : 'Google Live language list and auto-detect'}</small></div>
            </div>
            <div className="select-wrap">
              <select value={settings.language} onChange={(e) => void patch({ language: e.target.value })}>
                <option value="auto">Auto-detect</option>
                {liveLanguages.map((language) => (
                  <option key={language.code} value={language.code} disabled={settings.provider === 'local' && !localReadyLanguages.has(language.code)}>
                    {language.label}{settings.provider === 'local' && !localReadyLanguages.has(language.code) ? ' · Google Live' : ''}
                  </option>
                ))}
              </select>
              <ChevronDown size={14}/>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <Languages size={16}/>
              <div><b>Caption output language</b><small>{settings.outputLanguage === 'same' ? 'Keep the spoken language' : 'Translate the speech in real time'}</small></div>
            </div>
            <div className="select-wrap">
              <select value={settings.outputLanguage} onChange={(e) => void patch({ outputLanguage: e.target.value })}>
                <option value="same">Same as speech</option>
                {translationLanguages.map((language) => (
                  <option key={language.code} value={language.code} disabled={settings.provider === 'local' ? !isTranslateGemmaLanguage(language.code) : false}>
                    {language.label}{settings.provider === 'local' && !isTranslateGemmaLanguage(language.code) ? ' · Cloud only' : ''}
                  </option>
                ))}
              </select>
              <ChevronDown size={14}/>
            </div>
          </div>

          {settings.provider === 'gemini' && (
            <div className="cloud-settings">
              <div className="key-entry">
                <input
                  className="key-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={settings.hasGeminiKey ? 'Saved securely · enter a new key to replace' : 'Google AI API key'}
                />
                <button
                  className="save-key"
                  onClick={async () => {
                    try {
                      await window.captionApi.saveGeminiKey(apiKey);
                      setApiKey('');
                      setKeyMessage('Key stored securely on this PC.');
                      await refresh();
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  Save key
                </button>
                {settings.hasGeminiKey && (
                  <button
                    className="clear-key"
                    onClick={async () => {
                      await window.captionApi.clearGeminiKey();
                      setKeyMessage('Key removed.');
                      await refresh();
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
              <label className="consent">
                <input type="checkbox" checked={cloudConsent} onChange={(e) => setCloudConsent(e.target.checked)}/> I understand system audio or selected media audio is streamed to Google for transcription or translation.
              </label>
              {keyMessage && <small>{keyMessage}</small>}
            </div>
          )}

          <div className="setting-row">
            <div className="setting-label">
              <Captions size={16}/>
              <div><b>Text size</b><small>Adjust overlay readability</small></div>
            </div>
            <div className="range-control">
              <input type="range" min="16" max="40" value={settings.fontSize} onChange={(e) => void patch({ fontSize: Number(e.target.value) })}/>
              <strong>{settings.fontSize}px</strong>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <Eye size={16}/>
              <div><b>Background opacity</b><small>Overlay background shade</small></div>
            </div>
            <div className="range-control">
              <input type="range" min="20" max="100" value={settings.opacity} onChange={(e) => void patch({ opacity: Number(e.target.value) })}/>
              <strong>{settings.opacity}%</strong>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <Move size={16}/>
              <div><b>Overlay controls</b><small>Always on top · Ctrl + Shift + C to toggle</small></div>
            </div>
            <button
              className="secondary-button small"
              onClick={() =>
                settings.clickThrough
                  ? (void window.captionApi.setClickThrough(false), void patch({ clickThrough: false }))
                  : (void window.captionApi.setClickThrough(true), void patch({ clickThrough: true }))
              }
            >
              {settings.clickThrough ? <><Eye size={15}/> Click-through on</> : <><EyeOff size={15}/> Click-through off</>}
            </button>
          </div>
        </section>

        {/* Local ASR speech model card */}
        <section className="key-card">
          <div className="key-copy">
            <div className="round-icon violet"><Cpu size={17}/></div>
            <div>
              <b>Local speech model</b>
              <small>{settings.modelInstalled ? 'Nemotron 3.5 ASR · preloaded and kept warm · audio stays on this PC' : 'One-time download required · about 650 MB'}</small>
            </div>
            <button className="save-key" onClick={() => void downloadModel()} disabled={settings.modelInstalled || modelProgress.state === 'downloading' || modelProgress.state === 'extracting'}>
              {settings.modelInstalled ? <><ShieldCheck size={14}/> Ready</> : <><Download size={14}/> {modelProgress.state === 'downloading' ? `${modelProgress.percent ?? ''}%` : modelProgress.state === 'extracting' ? 'Installing…' : 'Download model'}</>}
            </button>
          </div>
          {!settings.modelInstalled && modelProgress.state !== 'idle' && (
            <>
              <div className="meter"><div style={{ width: `${modelProgress.percent ?? 0}%` }}/></div>
              <div className="key-foot">{modelProgress.state === 'extracting' ? 'Checking and installing the model files…' : modelProgress.state === 'error' ? modelProgress.message : 'Downloading from the sherpa-onnx official release.'}</div>
            </>
          )}
        </section>

        {/* Local translator model card */}
        <section className="key-card">
          <div className="key-copy">
            <div className="round-icon violet"><Languages size={17}/></div>
            <div>
              <b>Local translator model (TranslateGemma 4B)</b>
              <small>{settings.translatorInstalled ? 'TranslateGemma 4B Q4_K_M · on-device translation warm & ready' : 'One-time download ~2.49 GB · Subject to Gemma Terms of Use'}</small>
            </div>
            <button
              className="save-key"
              onClick={async () => {
                setError('');
                try {
                  await window.captionApi.downloadTranslator();
                  await refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
              disabled={settings.translatorInstalled || translatorProgress.state === 'downloading' || translatorProgress.state === 'verifying'}
            >
              {settings.translatorInstalled ? <><ShieldCheck size={14}/> Ready</> : <><Download size={14}/> {translatorProgress.state === 'downloading' ? `${translatorProgress.percent ?? ''}%` : translatorProgress.state === 'verifying' ? 'Verifying…' : 'Download translator'}</>}
            </button>
          </div>
          {!settings.translatorInstalled && translatorProgress.state !== 'idle' && (
            <>
              <div className="meter"><div style={{ width: `${translatorProgress.percent ?? 0}%` }}/></div>
              <div className="key-foot">{translatorProgress.state === 'verifying' ? 'Verifying SHA-256 checksum…' : translatorProgress.state === 'error' ? translatorProgress.message : 'Downloading TranslateGemma 4B GGUF weights.'}</div>
            </>
          )}
          <div className="key-foot media-hint"><a href="https://ai.google.dev/gemma/terms" target="_blank" rel="noreferrer" style={{ color: '#8892b0', textDecoration: 'underline' }}>Gemma Terms of Use</a> · Offline on-device translation</div>
        </section>

        {/* Latency diagnostics card */}
        <section className="transcript-card">
          <div className="card-heading">
            <div className="round-icon"><Activity size={17}/></div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b>Latency diagnostics</b>
                {prerollStatus.state === 'fallback' ? (
                  <span className="diag-badge fallback">LIVE CAPTURE FALLBACK</span>
                ) : (prerollStatus.state !== 'idle' && prerollStatus.state !== 'ended') ? (
                  <span className="diag-badge preroll">ONLINE PRE-ROLL (zero playback delay)</span>
                ) : null}
              </div>
              <small>
                {prerollStatus.state !== 'idle' && prerollStatus.state !== 'fallback'
                  ? 'Pre-roll buffer extrapolation & boundary scheduled cue playback'
                  : settings.provider === 'local'
                    ? 'Model timestamps → overlay paint (not ground-truth calibrated)'
                    : 'Approximate stream start → overlay paint (not ground-truth calibrated)'}
              </small>
            </div>
            <span className="live-indicator">
              {prerollStatus.state !== 'idle' && prerollStatus.state !== 'fallback'
                ? `${prerollStatus.underruns ?? 0} UNDERRUNS`
                : `${metrics.droppedChunks ?? 0} DROPPED`}
            </span>
          </div>

          {prerollStatus.state !== 'idle' && prerollStatus.state !== 'fallback' ? (
            <>
              <div className="monitor-footer">
                <span>Playhead: {Math.floor(prerollStatus.playheadMs / 60000)}m {Math.floor((prerollStatus.playheadMs % 60000) / 1000)}s</span>
                <span>Buffer ready ahead: +{Math.floor(prerollStatus.readyAheadMs / 60000)}m {Math.floor((prerollStatus.readyAheadMs % 60000) / 1000)}s</span>
              </div>
              <div className="monitor-footer">
                <span>Display lead: +{settings.preroll?.displayLeadMs ?? 0} ms</span>
                <span>Sync offset: {settings.preroll?.syncOffsetMs ?? 0} ms</span>
              </div>
              <div className="monitor-footer">
                <span>ASR rate: {prerollStatus.asrRtf ? `${prerollStatus.asrRtf.toFixed(2)}x RTF` : '—'}</span>
                <span>Translate: {prerollStatus.unitsPerSecond ? `${prerollStatus.unitsPerSecond.toFixed(1)} units/s` : '—'} ({prerollStatus.backend ?? 'CPU'})</span>
              </div>
              <div className="monitor-footer">
                <span>Underrun count: {prerollStatus.underruns ?? 0}</span>
                <span>Status: {prerollStatus.state}</span>
              </div>
            </>
          ) : (
            <>
              <div className="monitor-footer"><span>Buffer + IPC: {metrics.bufferingMs ?? '—'} ms</span><span>Model inference: {metrics.inferenceMs ?? '—'} ms</span></div>
              <div className="monitor-footer"><span>Overlay update: {metrics.renderMs ?? '—'} ms</span><span>Queued chunks: {metrics.queuedChunks ?? 0}</span></div>
              <div className="monitor-footer"><span>Latest end-to-end: {metrics.endToEndMs ?? '—'} ms</span><span>Audio drops: {metrics.droppedChunks ?? 0}</span></div>
              {metrics.p50Ms != null && <div className="monitor-footer"><span>Session P50 / P95 / P99</span><span>{metrics.p50Ms} / {metrics.p95Ms} / {metrics.p99Ms} ms</span></div>}
            </>
          )}
        </section>

        {error && (
          <div className="error-banner">
            <X size={16}/>
            <span>{error}</span>
            <button onClick={() => setError('')}><X size={15}/></button>
          </div>
        )}

        <footer>
          <span>{settings.provider === 'local' ? 'Local streaming ASR · Nemotron 3.5 0.6B + TranslateGemma 4B' : 'Cloud streaming ASR · Google Live'}</span>
          <span>Language: auto-detected · Ctrl+Shift+C toggles overlay</span>
        </footer>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App/>);
