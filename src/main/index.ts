import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { promisify } from 'node:util';
import { percentile } from './metrics';
import { GoogleGenAI, Modality } from '@google/genai';
import { isLiveLanguage, localReadyLanguages, nemotronLanguage, translationLanguages } from './languages';
import { TranslatorClient } from './preroll/translator-client';
import { getTranslatorModelPath, isTranslatorModelInstalled, downloadFile, TRANSLATOR_MODEL_INFO } from './preroll/model-manager';
import { toTranslateGemmaCode, isSupportedPair } from './preroll/translategemma-languages';
import { LanguageIdentifier } from './preroll/language-id';
import { PrerollSession } from './preroll/preroll-session';
import { AsrBatchClient } from './preroll/asr-batch-client';
import { CueStore } from './preroll/cue-store';

export type PrerollSettings = {
  enabled: boolean;
  prerollSeconds: number;
  holdPlaybackUntilReady: boolean;
  syncOffsetMs: number;
  displayLeadMs: number;
  cacheEnabled: boolean;
};

export type TranslatorSettings = {
  quant: 'Q4_K_M' | 'Q8_0';
  gpu: 'auto' | 'off';
};

type Settings = {
  model: string;
  provider: 'local' | 'gemini';
  language: string;
  outputLanguage: string;
  fontSize: number;
  opacity: number;
  historySeconds: number;
  clickThrough: boolean;
  hotkey?: string;
  overlay: { x?: number; y?: number; width: number; height: number };
  preroll: PrerollSettings;
  translator: TranslatorSettings;
  asrPrerollVariant: string;
  /** CPU threads for sherpa-onnx (1..logicalCores). Default 4. */
  asrThreads: number;
  /** Coalesce 80 ms capture frames into larger IPC/inference blocks: 80 | 160 | 240. */
  asrAggregateMs: number;
};

const defaults: Settings = {
  model: 'nemotron-3.5-asr-streaming-0.6b-80ms-int8',
  provider: 'local',
  language: 'auto',
  outputLanguage: 'same',
  fontSize: 24,
  opacity: 82,
  historySeconds: 8,
  clickThrough: false,
  overlay: { width: 760, height: 180 },
  preroll: {
    enabled: true,
    prerollSeconds: 300,
    holdPlaybackUntilReady: true,
    syncOffsetMs: 0,
    displayLeadMs: 0,
    cacheEnabled: true
  },
  translator: {
    quant: 'Q4_K_M',
    gpu: 'auto'
  },
  asrPrerollVariant: '80ms',
  asrThreads: 4,
  asrAggregateMs: 80
};

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let asrWorker: Worker | null = null;
let localWorkerReady: Promise<void> | null = null;
let translatorClient: TranslatorClient | null = null;
let translatorInstallPromise: Promise<void> | null = null;
let prerollSession: PrerollSession | null = null;
const languageId = new LanguageIdentifier(5);
let liveSession: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
let liveClient: GoogleGenAI | null = null;
let liveSpeechCaptureAt = 0;
let mediaPreloading = false;
let mediaDurationMs = 0;
let mediaCurrentMs = 0;
let mediaCues: Array<{ startMs: number; endMs: number; text: string }> = [];
let sessionCaptions: Array<{ startMs: number; endMs: number; text: string }> = [];
let exportCues: Array<{ startMs: number; endMs: number; text: string }> = [];
let sessionTimelineStart = Date.now();
let running = false;
let quitting = false;
let inFlightChunks = 0;
let inFlightAudioMs = 0;
let droppedChunks = 0;
/** Max audio duration allowed in-flight to the worker (keeps latency bounded). */
const MAX_IN_FLIGHT_AUDIO_MS = 960;
type AggBuf = { parts: Int16Array[]; capturedAt: number; samples: number };
let aggBuf: AggBuf | null = null;
let visibleLatencies: number[] = [];
let benchLogStream: fs.WriteStream | null = null;
function benchLog(event: Record<string, unknown>) {
  if (!benchLogStream) return;
  try { benchLogStream.write(JSON.stringify({ t: Date.now(), ...event }) + '\n'); } catch { /* ignore */ }
}
let activeHotkey = 'CommandOrControl+Shift+C';
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const geminiKeyPath = () => path.join(app.getPath('userData'), 'gemini-api-key.enc');
const NEMOTRON_VARIANTS: Record<string, string> = {
  '80ms': 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-80ms-int8-2026-06-11',
  '160ms': 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11',
  '560ms': 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11',
  '1120ms': 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-1120ms-int8-2026-06-11',
};
const DEFAULT_VARIANT = '80ms';
function resolveModelName(variant?: string): string {
  const key = (variant || DEFAULT_VARIANT).toLowerCase().replace(/\s/g, '');
  return NEMOTRON_VARIANTS[key] || NEMOTRON_VARIANTS[DEFAULT_VARIANT];
}
const modelPath = (variant?: string) => path.join(app.getPath('userData'), 'models', resolveModelName(variant || readSettings().asrPrerollVariant || DEFAULT_VARIANT));
const execFileAsync = promisify(execFile);
const translatorInstalled = () => isTranslatorModelInstalled(path.join(app.getPath('userData'), 'models'));
function ensureTranslator(): Promise<void> { if (!translatorClient) translatorClient = new TranslatorClient({ modelPath: getTranslatorModelPath(path.join(app.getPath('userData'), 'models')) }); return translatorClient.ready(); }
function readSettings(): Settings { try { return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch { return defaults; } }
function hasGeminiKey() { return fs.existsSync(geminiKeyPath()) && safeStorage.isEncryptionAvailable(); }
function readGeminiKey() { if (!hasGeminiKey()) return ''; return safeStorage.decryptString(fs.readFileSync(geminiKeyPath())); }
function saveSettings(value: Settings) { fs.writeFileSync(settingsPath(), JSON.stringify(value, null, 2), { mode: 0o600 }); }
function validateSettingsPatch(patch: unknown): Partial<Settings> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings update.');
  const value = patch as Record<string, unknown>; const allowed = new Set(['model', 'provider', 'language', 'outputLanguage', 'fontSize', 'opacity', 'historySeconds', 'clickThrough', 'hotkey', 'preroll', 'translator', 'asrPrerollVariant', 'asrThreads', 'asrAggregateMs']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('Unsupported settings field.');
  if (value.model !== undefined && value.model !== defaults.model) throw new Error('Unsupported transcription model.');
  if (value.provider !== undefined && value.provider !== 'local' && value.provider !== 'gemini') throw new Error('Unsupported speech provider.');
  if (value.language !== undefined && !isLiveLanguage(String(value.language))) throw new Error('Unsupported caption language.');
  if (value.outputLanguage !== undefined && value.outputLanguage !== 'same' && !translationLanguages.some((language) => language.code === value.outputLanguage)) throw new Error('Unsupported translated caption language.');
  if (value.fontSize !== undefined && (typeof value.fontSize !== 'number' || value.fontSize < 16 || value.fontSize > 40)) throw new Error('Font size must be 16 to 40.');
  if (value.opacity !== undefined && (typeof value.opacity !== 'number' || value.opacity < 20 || value.opacity > 100)) throw new Error('Opacity must be 20 to 100.');
  if (value.historySeconds !== undefined && (typeof value.historySeconds !== 'number' || value.historySeconds < 1 || value.historySeconds > 60)) throw new Error('Caption history must be 1 to 60 seconds.');
  if (value.clickThrough !== undefined && typeof value.clickThrough !== 'boolean') throw new Error('Invalid click-through setting.');
  if (value.hotkey !== undefined && (typeof value.hotkey !== 'string' || value.hotkey.length > 64)) throw new Error('Invalid hotkey.');
  if (value.preroll !== undefined) {
    if (!value.preroll || typeof value.preroll !== 'object') throw new Error('Invalid preroll settings.');
    const p = value.preroll as Record<string, unknown>;
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new Error('Preroll enabled must be boolean.');
    if (p.prerollSeconds !== undefined && (typeof p.prerollSeconds !== 'number' || p.prerollSeconds < 60 || p.prerollSeconds > 1800)) throw new Error('Preroll seconds must be between 60 and 1800.');
    if (p.holdPlaybackUntilReady !== undefined && typeof p.holdPlaybackUntilReady !== 'boolean') throw new Error('holdPlaybackUntilReady must be boolean.');
    if (p.syncOffsetMs !== undefined && (typeof p.syncOffsetMs !== 'number' || p.syncOffsetMs < -3000 || p.syncOffsetMs > 3000)) throw new Error('syncOffsetMs must be between -3000 and 3000.');
    if (p.displayLeadMs !== undefined && (typeof p.displayLeadMs !== 'number' || p.displayLeadMs < 0 || p.displayLeadMs > 300)) throw new Error('displayLeadMs must be between 0 and 300.');
    if (p.cacheEnabled !== undefined && typeof p.cacheEnabled !== 'boolean') throw new Error('cacheEnabled must be boolean.');
  }
  if (value.translator !== undefined) {
    if (!value.translator || typeof value.translator !== 'object') throw new Error('Invalid translator settings.');
    const t = value.translator as Record<string, unknown>;
    if (t.quant !== undefined && t.quant !== 'Q4_K_M' && t.quant !== 'Q8_0') throw new Error('Invalid translator quant.');
    if (t.gpu !== undefined && t.gpu !== 'auto' && t.gpu !== 'off') throw new Error('Invalid translator gpu setting.');
  }
  if (value.asrPrerollVariant !== undefined) { const v = String(value.asrPrerollVariant).toLowerCase(); if (!['80ms','160ms','560ms','1120ms'].includes(v)) throw new Error('ASR variant must be 80ms, 160ms, 560ms or 1120ms.'); value.asrPrerollVariant = v; }
  if (value.asrThreads !== undefined) {
    if (typeof value.asrThreads !== 'number' || !Number.isInteger(value.asrThreads) || value.asrThreads < 1 || value.asrThreads > 32)
      throw new Error('asrThreads must be an integer between 1 and 32.');
  }
  if (value.asrAggregateMs !== undefined) {
    if (![80, 160, 240].includes(Number(value.asrAggregateMs)))
      throw new Error('asrAggregateMs must be 80, 160 or 240.');
    value.asrAggregateMs = Number(value.asrAggregateMs);
  }
  return value as Partial<Settings>;
}
function broadcast(channel: string, data: unknown) { for (const win of [mainWindow, overlayWindow]) if (win && !win.isDestroyed()) win.webContents.send(channel, data); }
function commitCaption(text: string, startAt: number, endAt: number) {
  const startMs = Math.max(0, Math.round(startAt - sessionTimelineStart));
  const end = Math.max(startAt + 250, endAt);
  const cue = { startMs, endMs: Math.max(startMs + 250, Math.round(end - sessionTimelineStart)), text: text.trim() };
  if (!cue.text) return;
  sessionCaptions.push(cue); exportCues = sessionCaptions.slice();
}
function srtTimestamp(milliseconds: number) {
  const ms = Math.max(0, Math.floor(milliseconds)); const hours = Math.floor(ms / 3_600_000); const minutes = Math.floor(ms / 60_000) % 60; const seconds = Math.floor(ms / 1000) % 60; const fraction = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(fraction).padStart(3, '0')}`;
}
function createWindows() {
  const settings = readSettings();
  mainWindow = new BrowserWindow({ width: 1000, height: 760, minWidth: 820, minHeight: 640, title: 'RealtimeCC', backgroundColor: '#0c0e12', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false } });
  overlayWindow = new BrowserWindow({ ...settings.overlay, x: settings.overlay.x, y: settings.overlay.y, minWidth: 320, minHeight: 90, frame: false, transparent: true, alwaysOnTop: true, show: false, skipTaskbar: true, backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false } });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver'); overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); overlayWindow?.hide(); } });
  overlayWindow.on('closed', () => { overlayWindow = null; });
  if (app.isPackaged) { mainWindow.loadFile(path.join(__dirname, '../renderer/index.html')); overlayWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'overlay' }); }
  else { mainWindow.loadURL('http://127.0.0.1:5173'); overlayWindow.loadURL('http://127.0.0.1:5173/#overlay'); }
  overlayWindow.on('move', persistOverlay); overlayWindow.on('resize', persistOverlay);
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('focus', () => overlayWindow?.hide());
  for (const win of [mainWindow, overlayWindow]) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, target) => { const allowed = app.isPackaged ? target.startsWith('file:') : target.startsWith('http://127.0.0.1:5173'); if (!allowed) event.preventDefault(); });
  }
}
let persistTimer: NodeJS.Timeout | undefined;
function persistOverlay() { if (!overlayWindow) return; clearTimeout(persistTimer); persistTimer = setTimeout(() => { const s = readSettings(); s.overlay = { ...overlayWindow!.getBounds() }; saveSettings(s); }, 250); }
function setHotkey(accelerator: string) {
  globalShortcut.unregister(activeHotkey); activeHotkey = accelerator;
  const ok = globalShortcut.register(accelerator, () => { if (overlayWindow?.isVisible()) overlayWindow.hide(); else overlayWindow?.show(); });
  if (!ok) { activeHotkey = 'CommandOrControl+Shift+C'; globalShortcut.register(activeHotkey, () => overlayWindow?.isVisible() ? overlayWindow.hide() : overlayWindow?.show()); throw new Error('That hotkey is unavailable. Reverted to Ctrl+Shift+C.'); }
}
function modelInstalled(variant?: string) { const dir = modelPath(variant); return ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'].every((file) => fs.existsSync(path.join(dir, file))); }
function download(url: string, destination: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Model download redirected too many times.'));
    const offset = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
    const request = https.get(url, { headers: { 'User-Agent': 'RealtimeCC/0.1', ...(offset ? { Range: `bytes=${offset}-` } : {}) } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) { response.resume(); void download(response.headers.location, destination, redirects + 1).then(resolve, reject); return; }
      const existing = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
      const resume = existing > 0 && response.statusCode === 206;
      if (response.statusCode !== 200 && !resume) { response.resume(); reject(new Error(`Model download failed (HTTP ${response.statusCode ?? 'unknown'}).`)); return; }
      const total = Number(response.headers['content-length'] ?? 0) + (resume ? existing : 0); let received = resume ? existing : 0; const output = fs.createWriteStream(destination, { flags: resume ? 'a' : 'w' });
      response.on('data', (chunk: Buffer) => { received += chunk.length; broadcast('model-progress', { state: 'downloading', received, total, percent: total ? Math.floor(received * 100 / total) : null }); });
      response.pipe(output); output.on('finish', () => output.close(() => resolve())); output.on('error', reject);
    });
    request.setTimeout(120000, () => request.destroy(new Error('Model download timed out.'))); request.on('error', reject);
  });
}
let modelInstallPromise: Promise<void> | null = null;
function installModel(variant?: string): Promise<void> {
  const v = variant || readSettings().asrPrerollVariant || DEFAULT_VARIANT;
  if (modelInstalled(v)) return Promise.resolve();
  if (modelInstallPromise) return modelInstallPromise;
  modelInstallPromise = (async () => {
    const name = resolveModelName(v);
    const modelRoot = path.dirname(modelPath(v)); fs.mkdirSync(modelRoot, { recursive: true });
    const archive = path.join(modelRoot, `${name}.tar.bz2`);
    broadcast('model-progress', { state: 'downloading', received: 0, total: 0, percent: null, variant: v });
    try {
      await download(`https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${name}.tar.bz2`, archive);
      broadcast('model-progress', { state: 'extracting', percent: null, variant: v });
      await execFileAsync('tar', ['-xjf', archive, '-C', modelRoot], { windowsHide: true, maxBuffer: 1024 * 1024 });
      if (!modelInstalled(v)) throw new Error('The downloaded ASR model is incomplete. Remove the model files and try again.');
      try { fs.unlinkSync(archive); } catch {}
      broadcast('model-progress', { state: 'ready', percent: 100, variant: v });
    } catch (error) { broadcast('model-progress', { state: 'error', message: error instanceof Error ? error.message : String(error), variant: v }); throw error; }
    finally { modelInstallPromise = null; }
  })();
  return modelInstallPromise;
}
function flushAggregate(force = false) {
  if (!aggBuf || !asrWorker) return;
  const targetSamples = Math.round(16000 * (readSettings().asrAggregateMs || 80) / 1000);
  if (!force && aggBuf.samples < targetSamples) return;
  const total = aggBuf.samples;
  const merged = new Int16Array(total);
  let off = 0;
  for (const p of aggBuf.parts) { merged.set(p, off); off += p.length; }
  const audioMs = Math.round(total / 16);
  const capturedAt = aggBuf.capturedAt;
  aggBuf = null;
  if (inFlightAudioMs + audioMs > MAX_IN_FLIGHT_AUDIO_MS) {
    droppedChunks += 1;
    benchLog({ type: 'drop', reason: 'in_flight_audio_ms', inFlightAudioMs, audioMs, droppedChunks });
    broadcast('metrics', { droppedChunks, queuedChunks: inFlightChunks, inFlightAudioMs });
    return;
  }
  inFlightChunks += 1;
  inFlightAudioMs += audioMs;
  asrWorker.postMessage({ buffer: merged.buffer, capturedAt, audioMs }, [merged.buffer]);
  if (mediaPreloading) {
    mediaCurrentMs = Math.min(capturedAt, mediaDurationMs);
    broadcast('media-progress', { currentMs: mediaCurrentMs, durationMs: mediaDurationMs, queuedChunks: inFlightChunks });
  }
}

function handleAudio(data: { buffer: ArrayBuffer; capturedAt: number }) {
  if (!running) return;
  if (liveSession) {
    const pcm = Buffer.from(data.buffer);
    if (liveSpeechCaptureAt === 0) liveSpeechCaptureAt = data.capturedAt || 1;
    if (mediaPreloading) { mediaCurrentMs = data.capturedAt; broadcast('media-progress', { currentMs: mediaCurrentMs, durationMs: mediaDurationMs, queuedChunks: 0 }); }
    try { liveSession.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }); }
    catch (error) { broadcast('status', { state: 'error', message: `Live transcription send failed: ${error instanceof Error ? error.message : String(error)}` }); }
    return;
  }
  if (!asrWorker) return;
  const pcm = new Int16Array(data.buffer.slice(0));
  if (!aggBuf) aggBuf = { parts: [], capturedAt: data.capturedAt, samples: 0 };
  aggBuf.parts.push(pcm);
  aggBuf.samples += pcm.length;
  // Keep earliest capture time for the aggregated block (onset of the first frame).
  if (data.capturedAt < aggBuf.capturedAt) aggBuf.capturedAt = data.capturedAt;
  flushAggregate(false);
}
function ensureLocalWorker(language: string): Promise<void> {
  if (asrWorker) { asrWorker.postMessage({ control: 'configure', language: nemotronLanguage(language) }); return localWorkerReady ?? Promise.resolve(); }
  if (localWorkerReady) return localWorkerReady;
  const worker = new Worker(path.join(__dirname, 'asr-worker.js'), { workerData: { modelDir: modelPath(), language: nemotronLanguage(language), numThreads: readSettings().asrThreads || 4 } });
  asrWorker = worker;
  localWorkerReady = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { localWorkerReady = null; if (asrWorker === worker) asrWorker = null; void worker.terminate(); reject(new Error('The local model did not finish loading in time.')); }, 120000);
    worker.on('message', (message) => {
      if (message.type === 'ready') { clearTimeout(timeout); broadcast('status', { state: running ? 'connected' : 'stopped', message: 'Local speech model is loaded and warm.' }); resolve(); }
      if (message.type === 'processed') {
        inFlightChunks = Math.max(0, inFlightChunks - 1);
        inFlightAudioMs = Math.max(0, inFlightAudioMs - (Number(message.audioMs) || 80));
        broadcast('metrics', { captureToInferenceMs: Math.max(0, message.producedAt - message.capturedAt), inferenceMs: message.inferenceMs, queuedChunks: inFlightChunks, inFlightAudioMs, droppedChunks });
        if (mediaPreloading) broadcast('media-progress', { currentMs: mediaCurrentMs, durationMs: mediaDurationMs, queuedChunks: inFlightChunks });
      }
      if (message.type === 'final' && message.text) {
        if (mediaPreloading) mediaCues.push({ startMs: message.startAt ?? 0, endMs: Math.max(message.endAt ?? 0, (message.startAt ?? 0) + 250), text: message.text });
        else {
          const s = readSettings();
          if (s.provider === 'local' && s.outputLanguage !== 'same' && translatorClient) {
            const src = s.language !== 'auto' ? (toTranslateGemmaCode(s.language) || 'en') : languageId.vote(message.text);
            const tgt = toTranslateGemmaCode(s.outputLanguage) || 'vi';
            const startAt = message.startAt ?? message.capturedAt ?? Date.now(); const endAt = message.endAt ?? Date.now();
            void translatorClient.translate([{ id: `live-${startAt}`, startMs: startAt, endMs: endAt, text: message.text, src, tgt }]).then((res) => {
              const out = res[0]?.text || message.text; commitCaption(out, startAt, endAt);
              broadcast('caption', { final: out, partial: '', captureAt: startAt, producedAt: Date.now(), inferenceMs: 0 });
            }).catch(() => commitCaption(message.text, startAt, endAt));
          } else commitCaption(message.text, message.startAt ?? message.capturedAt ?? Date.now(), message.endAt ?? Date.now());
        }
      }
      if (message.type === 'caption' && running && !mediaPreloading) {
        const payload = { final: message.partial ? '' : message.text, partial: message.partial ? message.text : '', captureAt: message.captureAt, producedAt: message.producedAt, inferenceMs: message.inferenceMs };
        benchLog({ type: 'caption', text: message.text, partial: !!message.partial, captureAt: message.captureAt, producedAt: message.producedAt, inferenceMs: message.inferenceMs });
        broadcast('caption', payload);
      }
    });
    worker.once('error', (error) => { clearTimeout(timeout); localWorkerReady = null; reject(error); if (running) { broadcast('status', { state: 'error', message: `Local ASR failed: ${error.message}` }); void stopTranscription(); } });
    worker.on('exit', (code) => { if (asrWorker === worker) asrWorker = null; localWorkerReady = null; if (running && code !== 0) broadcast('status', { state: 'error', message: `Local ASR worker exited (${code}).` }); });
  });
  return localWorkerReady;
}
async function startTranscription() {
  if (running) return;
  const settings = readSettings();
  if (settings.provider === 'gemini') {
    const key = readGeminiKey();
    if (!key) throw new Error('Add a Google AI API key before starting live cloud captions.');
    running = true; inFlightChunks = 0; inFlightAudioMs = 0; droppedChunks = 0; visibleLatencies = []; liveSpeechCaptureAt = 0; aggBuf = null;
  try {
    const logDir = path.join(app.getPath('userData'), 'bench-logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `session-${Date.now()}.jsonl`);
    benchLogStream = fs.createWriteStream(logFile, { flags: 'a' });
    benchLog({ type: 'session_start', provider: 'local', logFile });
  } catch { benchLogStream = null; }
    const client = new GoogleGenAI({ apiKey: key }); liveClient = client;
    broadcast('status', { state: 'connecting', message: 'Connecting to Google Live captions. System audio will be streamed to Google.' });
    try {
      const translating = settings.outputLanguage !== 'same';
      liveSession = await client.live.connect({ model: translating ? 'gemini-3.5-live-translate-preview' : 'gemini-3.5-transcribe-live', config: translating
        ? { responseModalities: [Modality.AUDIO], inputAudioTranscription: { languageCodes: settings.language === 'auto' ? [] : [settings.language] }, outputAudioTranscription: {}, translationConfig: { targetLanguageCode: settings.outputLanguage, echoTargetLanguage: true } }
        : { responseModalities: [Modality.TEXT], inputAudioTranscription: { languageCodes: settings.language === 'auto' ? [] : [settings.language] } }, callbacks: {
        onopen: () => broadcast('status', { state: 'connected', message: 'Google Live captions connected.' }),
        onmessage: (event) => {
          const content = event.serverContent; if (!content) return;
          const producedAt = Date.now(); const captureAt = liveSpeechCaptureAt || producedAt;
          if (translating) {
            if (content.outputTranscription?.text) { const final = Boolean(content.outputTranscription.finished); if (mediaPreloading) { if (final) mediaCues.push({ startMs: Math.max(0, liveSpeechCaptureAt - 1), endMs: Math.max(mediaCurrentMs, liveSpeechCaptureAt + 250), text: content.outputTranscription.text }); } else { if (final) commitCaption(content.outputTranscription.text, liveSpeechCaptureAt || producedAt, producedAt); broadcast('caption', { final: final ? content.outputTranscription.text : '', partial: final ? '' : content.outputTranscription.text, captureAt, producedAt, inferenceMs: 0 }); } if (final) liveSpeechCaptureAt = 0; }
            return;
          }
          if (content.interimInputTranscription?.text && !mediaPreloading) broadcast('caption', { final: '', partial: content.interimInputTranscription.text, captureAt, producedAt, inferenceMs: 0 });
          if (content.inputTranscription?.text) { if (mediaPreloading) mediaCues.push({ startMs: Math.max(0, liveSpeechCaptureAt - 1), endMs: Math.max(mediaCurrentMs, liveSpeechCaptureAt + 250), text: content.inputTranscription.text }); else { commitCaption(content.inputTranscription.text, liveSpeechCaptureAt || producedAt, producedAt); broadcast('caption', { final: content.inputTranscription.text, partial: '', captureAt, producedAt, inferenceMs: 0 }); } liveSpeechCaptureAt = 0; }
        },
        onerror: (event) => broadcast('status', { state: 'error', message: `Google Live captions failed: ${event.message}` }),
        onclose: () => { if (running) broadcast('status', { state: 'error', message: 'Google Live captions connection closed.' }); },
      } });
      return;
    } catch (error) { running = false; liveSession = null; liveClient = null; throw new Error(`Could not connect to Google Live captions: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!modelInstalled()) throw new Error('Download the local speech model before starting.');
  if (settings.outputLanguage !== 'same') { if (!translatorInstalled()) throw new Error('Download the local translator model before starting.'); const src = settings.language === 'auto' ? 'en' : (toTranslateGemmaCode(settings.language) || 'en'); const tgt = toTranslateGemmaCode(settings.outputLanguage); if (!tgt || !isSupportedPair(src, tgt)) throw new Error('That language pair is not supported by the local translator.'); await ensureTranslator(); }
  if (settings.language !== 'auto' && !localReadyLanguages.has(settings.language)) throw new Error('That language is not available with the local model. Choose a local-ready language or select Google Live captions.');
  running = true; inFlightChunks = 0; inFlightAudioMs = 0; droppedChunks = 0; visibleLatencies = []; aggBuf = null;
  broadcast('status', { state: 'connecting', message: 'Loading local speech model.' });
  await ensureLocalWorker(settings.language);
}
async function stopTranscription() {
  running = false;
  if (liveSession) { try { liveSession.sendRealtimeInput({ audioStreamEnd: true }); liveSession.close(); } catch { /* connection already closed */ } liveSession = null; liveClient = null; }
  flushAggregate(true); asrWorker?.postMessage({ control: 'reset' });
  broadcast('metrics', { droppedChunks, queuedChunks: 0, p50Ms: percentile(visibleLatencies, .5), p95Ms: percentile(visibleLatencies, .95), p99Ms: percentile(visibleLatencies, .99) });
  inFlightChunks = 0;
  benchLog({ type: 'session_stop', droppedChunks, p50Ms: percentile(visibleLatencies, .5), p95Ms: percentile(visibleLatencies, .95), p99Ms: percentile(visibleLatencies, .99) });
  try { benchLogStream?.end(); } catch {}
  benchLogStream = null;
  broadcast('status', { state: 'stopped' });
}
function getPrerollSession(): PrerollSession {
  if (prerollSession) return prerollSession;
  const s = readSettings();
  const tokenFile = path.join(app.getPath('userData'), 'pairing-token.txt');
  let token = '';
  try {
    if (fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {}
  if (!token) {
    const crypto = require('node:crypto');
    token = crypto.randomBytes(16).toString('hex');
    try { fs.writeFileSync(tokenFile, token, 'utf8'); } catch {}
  }
  const asrBackend = new AsrBatchClient({
    modelDir: modelPath(),
    language: nemotronLanguage(s.language)
  });
  prerollSession = new PrerollSession({
    asrBackend,
    translator: translatorClient || new TranslatorClient({ modelPath: getTranslatorModelPath(path.join(app.getPath('userData'), 'models')) }),
    cacheDir: path.join(app.getPath('userData'), 'preroll-cache'),
    port: 9876,
    token,
    prerollSeconds: s.preroll?.prerollSeconds ?? 300,
    holdPlaybackUntilReady: s.preroll?.holdPlaybackUntilReady ?? true,
    syncOffsetMs: s.preroll?.syncOffsetMs ?? 0,
    displayLeadMs: s.preroll?.displayLeadMs ?? 0,
    srcLang: s.language !== 'auto' ? (toTranslateGemmaCode(s.language) || 'en') : 'en',
    tgtLang: s.outputLanguage !== 'same' ? (toTranslateGemmaCode(s.outputLanguage) || 'vi') : 'vi',
    onCaption: (cap) => broadcast('caption', cap),
    onStatusChange: (status) => broadcast('preroll-status', status)
  });
  return prerollSession;
}
app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      if (!sources[0]) { callback({}); return; } callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  });
  ipcMain.handle('settings:get', () => {
    const session = getPrerollSession();
    return {
      ...readSettings(),
      modelInstalled: modelInstalled(),
      translatorInstalled: translatorInstalled(),
      hasGeminiKey: hasGeminiKey(),
      captionCount: exportCues.length,
      audioCapture: 'Windows system loopback (default output)',
      extensionPort: session.bridge.getPort(),
      extensionToken: session.bridge.getToken(),
      extensionConnected: session.bridge.isConnected(),
      activeMedia: session.bridge.getActiveMedia()
    };
  });
  ipcMain.handle('translator:status', () => ({ installed: translatorInstalled(), modelPath: getTranslatorModelPath(path.join(app.getPath('userData'), 'models')), sizeBytes: TRANSLATOR_MODEL_INFO.sizeBytes, licenseName: TRANSLATOR_MODEL_INFO.licenseName, licenseUrl: TRANSLATOR_MODEL_INFO.licenseUrl }));
  ipcMain.handle('translator:download', async () => {
    if (translatorInstalled()) return true;
    if (translatorInstallPromise) return translatorInstallPromise;
    translatorInstallPromise = (async () => {
      const dest = getTranslatorModelPath(path.join(app.getPath('userData'), 'models'));
      broadcast('translator-progress', { state: 'downloading', received: 0, total: TRANSLATOR_MODEL_INFO.sizeBytes, percent: 0 });
      try {
        await downloadFile(TRANSLATOR_MODEL_INFO.url, dest, { expectedSha256: TRANSLATOR_MODEL_INFO.sha256, onProgress: (p) => broadcast('translator-progress', p) });
        if (readSettings().provider === 'local' && readSettings().outputLanguage !== 'same') await ensureTranslator();
        broadcast('translator-progress', { state: 'ready', percent: 100 });
      } catch (e) { broadcast('translator-progress', { state: 'error', message: e instanceof Error ? e.message : String(e) }); throw e; }
      finally { translatorInstallPromise = null; }
    })();
    return translatorInstallPromise;
  });
  ipcMain.handle('gemini:key:save', (_e, key: unknown) => { if (typeof key !== 'string' || key.trim().length < 20 || key.length > 512) throw new Error('Enter a valid Google AI API key.'); if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable.'); fs.writeFileSync(geminiKeyPath(), safeStorage.encryptString(key.trim()), { mode: 0o600 }); return true; });
  ipcMain.handle('gemini:key:clear', () => { if (fs.existsSync(geminiKeyPath())) fs.unlinkSync(geminiKeyPath()); return true; });
  ipcMain.handle('settings:save', (_e, patch) => { const valid = validateSettingsPatch(patch); const s = { ...readSettings(), ...valid }; saveSettings(s); if (valid.hotkey && valid.hotkey !== activeHotkey) setHotkey(valid.hotkey); return { ...s, modelInstalled: modelInstalled(), translatorInstalled: translatorInstalled(), hasGeminiKey: hasGeminiKey(), captionCount: exportCues.length }; });
  ipcMain.handle('model:download', async () => { await installModel(); if (readSettings().provider === 'local') await ensureLocalWorker(readSettings().language); return true; });
  ipcMain.handle('session:start', async (_e, cloudConsent: unknown) => {
    if (readSettings().provider === 'gemini' && cloudConsent !== true) throw new Error('Confirm that system audio will be sent to Google before starting.');
    const s = readSettings();
    if (s.provider === 'local' && s.preroll?.enabled) {
      const session = getPrerollSession();
      try {
        if (!translatorInstalled() && s.outputLanguage !== 'same') {
          throw new Error('Download the local translator model before starting pre-roll translation.');
        }
        await ensureTranslator();
        const startRes = await session.start();
        if (!startRes.shouldFallback) {
          running = true;
          broadcast('status', { state: 'connected', message: 'Smart pre-roll active.' });
          return { mode: 'preroll' };
        } else {
          broadcast('status', { state: 'connecting', message: startRes.reason });
        }
      } catch (err) {
        broadcast('status', { state: 'connecting', message: `Pre-roll unavailable (${err instanceof Error ? err.message : String(err)}). Using live audio capture.` });
      }
    }
    if (!running) { sessionCaptions = []; exportCues = []; sessionTimelineStart = Date.now(); }
    await startTranscription();
    return { mode: 'live' };
  });
  ipcMain.handle('session:stop', () => {
    if (prerollSession?.running) prerollSession.stop();
    stopTranscription();
    return true;
  });
  ipcMain.handle('preroll:start', async () => getPrerollSession().start());
  ipcMain.handle('preroll:stop', () => { prerollSession?.stop(); return true; });
  ipcMain.handle('preroll:play-now', () => { prerollSession?.playNow(); return true; });
  ipcMain.handle('preroll:set-manual-url', (_e, url: unknown) => { getPrerollSession().setManualUrl(typeof url === 'string' && url.trim() ? url.trim() : null); return true; });
  ipcMain.handle('preroll:set-offset', (_e, offsetMs: unknown) => {
    if (typeof offsetMs !== 'number') throw new Error('Invalid offset');
    const session = getPrerollSession();
    session.cuePlayer.setSyncOffsetMs(offsetMs);
    const s = readSettings();
    if (s.preroll) { s.preroll.syncOffsetMs = offsetMs; saveSettings(s); }
    return offsetMs;
  });
  ipcMain.handle('preroll:clear-cache', () => {
    const cacheDir = path.join(app.getPath('userData'), 'preroll-cache');
    CueStore.clearCache(cacheDir);
    return true;
  });
  ipcMain.handle('extension:pairing', () => {
    const session = getPrerollSession();
    return { port: session.bridge.getPort(), token: session.bridge.getToken(), connected: session.bridge.isConnected() };
  });
  ipcMain.handle('preroll:export-srt', async (_e, bilingual: unknown) => {
    const session = getPrerollSession();
    if (session.cueStore.allCues.length === 0) return { saved: false, message: 'No pre-rolled subtitles available to export.' };
    const options = { title: 'Export pre-rolled subtitles', defaultPath: 'preroll-subtitles.srt', filters: [{ name: 'SubRip subtitles', extensions: ['srt'] }] };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false, cancelled: true };
    const content = session.cueStore.exportSrt({ bilingual: Boolean(bilingual) });
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { saved: true, filePath: result.filePath };
  });
  ipcMain.handle('session:switch-provider', async (_e, provider: unknown, cloudConsent: unknown) => {
    if (provider !== 'local' && provider !== 'gemini') throw new Error('Unsupported speech provider.');
    const targetProvider = provider as Settings['provider'];
    if (provider === 'gemini' && cloudConsent !== true) throw new Error('Confirm cloud audio sharing before switching to Google Live.');
    if (mediaPreloading) throw new Error('Wait for media subtitle preparation to finish before switching providers.');
    const previous = readSettings(); if (previous.provider === targetProvider) return { ...previous, modelInstalled: modelInstalled(), translatorInstalled: translatorInstalled(), hasGeminiKey: hasGeminiKey(), captionCount: exportCues.length };
    const next: Settings = { ...previous, provider: targetProvider, ...(targetProvider === 'local' && previous.outputLanguage !== 'same' && !translatorInstalled() ? { outputLanguage: 'same' } : {}), ...(targetProvider === 'local' && previous.language !== 'auto' && !localReadyLanguages.has(previous.language) ? { language: 'auto' } : {}) };
    if (targetProvider === 'local' && !modelInstalled()) throw new Error('Download the local speech model before switching to local recognition.');
    if (targetProvider === 'local' && next.outputLanguage !== 'same' && !translatorInstalled()) throw new Error('Download the local translator model before switching to local translation.');
    if (targetProvider === 'gemini' && !hasGeminiKey()) throw new Error('Add a Google AI API key before switching to Google Live.');
    const wasRunning = running; if (wasRunning) await stopTranscription(); saveSettings(next);
    try { if (wasRunning) await startTranscription(); return { ...next, modelInstalled: modelInstalled(), translatorInstalled: translatorInstalled(), hasGeminiKey: hasGeminiKey(), captionCount: exportCues.length }; }
    catch (error) { saveSettings(previous); if (wasRunning) await startTranscription().catch(() => {}); throw error; }
  });
  ipcMain.handle('session:reconfigure', async (_e, patch: unknown) => {
    const valid = validateSettingsPatch(patch); const previous = readSettings(); const next = { ...previous, ...valid };
    if (mediaPreloading) throw new Error('Wait for media subtitle preparation to finish before changing language settings.');
    if (next.provider === 'local' && next.outputLanguage !== 'same') {
      if (!translatorInstalled()) throw new Error('Download the local translator model before selecting a translated language.');
      const src = next.language === 'auto' ? 'en' : (toTranslateGemmaCode(next.language) || 'en');
      const tgt = toTranslateGemmaCode(next.outputLanguage);
      if (!tgt || !isSupportedPair(src, tgt)) throw new Error('That language pair is not supported by the local translator.');
      await ensureTranslator();
    }
    const wasRunning = running; if (wasRunning) await stopTranscription(); saveSettings(next);
    try { if (wasRunning) await startTranscription(); return { ...next, modelInstalled: modelInstalled(), translatorInstalled: translatorInstalled(), hasGeminiKey: hasGeminiKey(), captionCount: exportCues.length }; }
    catch (error) { saveSettings(previous); if (wasRunning) await startTranscription().catch(() => {}); throw error; }
  });
  ipcMain.handle('captions:export-srt', async () => {
    if (!exportCues.length) return { saved: false, message: 'There are no completed captions to export yet.' };
    const options = { title: 'Export captions as SubRip', defaultPath: 'RealtimeCC-captions.srt', filters: [{ name: 'SubRip subtitles', extensions: ['srt'] }] };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false, cancelled: true };
    const body = [...exportCues].sort((a, b) => a.startMs - b.startMs).map((cue, index) => `${index + 1}\r\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(Math.max(cue.endMs, cue.startMs + 150))}\r\n${cue.text.replace(/\r?\n/g, ' ')}\r\n`).join('\r\n');
    fs.writeFileSync(result.filePath, `\uFEFF${body}`, 'utf8'); return { saved: true, filePath: result.filePath };
  });
  ipcMain.handle('media:begin', async (_e, args: { durationMs?: number; cloudConsent?: boolean }) => {
    if (running) throw new Error('Stop live captions before preparing a media file.');
    if (!args || typeof args.durationMs !== 'number' || !Number.isFinite(args.durationMs) || args.durationMs <= 0 || args.durationMs > 24 * 60 * 60 * 1000) throw new Error('Invalid media duration.');
    if (readSettings().provider === 'gemini' && args.cloudConsent !== true) throw new Error('Confirm cloud audio sharing before preparing translated subtitles.');
    mediaPreloading = true; mediaDurationMs = args.durationMs; mediaCurrentMs = 0; mediaCues = []; liveSpeechCaptureAt = 0;
    try { await startTranscription(); return true; } catch (error) { mediaPreloading = false; throw error; }
  });
  ipcMain.handle('media:chunk', async (_e, chunk: { buffer: ArrayBuffer; capturedAt: number }) => {
    if (!chunk || !(chunk.buffer instanceof ArrayBuffer) || chunk.buffer.byteLength > 16384 || typeof chunk.capturedAt !== 'number' || !Number.isFinite(chunk.capturedAt)) throw new Error('Invalid media audio chunk.');
    while (running && !liveSession && inFlightChunks >= 12) await new Promise((resolve) => setTimeout(resolve, 12));
    handleAudio(chunk);
  });
  ipcMain.handle('media:finish', async () => {
    for (let i = 0; i < 200 && inFlightChunks > 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    await new Promise((resolve) => setTimeout(resolve, liveSession ? 900 : 0));
    const cues = mediaCues; mediaCues = []; mediaPreloading = false; await stopTranscription();
    if (!cues.length) throw new Error('No speech was detected in this media file. Check that it contains an audio track and try another supported format.');
    if (readSettings().provider === 'local' && readSettings().outputLanguage !== 'same' && cues.length > 0) {
      try {
        await ensureTranslator();
        const src = readSettings().language !== 'auto' ? (toTranslateGemmaCode(readSettings().language) || 'en') : 'en';
        const tgt = toTranslateGemmaCode(readSettings().outputLanguage) || 'vi';
        const res = await translatorClient!.translate(cues.map((c, i) => ({ id: String(i), startMs: c.startMs, endMs: c.endMs, text: c.text, src, tgt })));
        for (let i = 0; i < cues.length; i++) if (res[i]?.ok) cues[i].text = res[i].text;
      } catch { /* keep source cues on error */ }
    }
    exportCues = cues.slice();
    return cues;
  });
  ipcMain.handle('media:cancel', async () => { mediaPreloading = false; mediaCues = []; await stopTranscription(); return true; });
  ipcMain.on('media:caption', (_e, text: unknown) => { if (typeof text !== 'string' || text.length > 2000) return; broadcast('caption', { final: text, partial: '', source: 'media' }); });
  ipcMain.handle('audio:chunk', (_e, chunk: { buffer: ArrayBuffer; capturedAt: number }) => { if (!chunk || !(chunk.buffer instanceof ArrayBuffer) || chunk.buffer.byteLength > 16384 || typeof chunk.capturedAt !== 'number' || !Number.isFinite(chunk.capturedAt)) throw new Error('Invalid audio chunk.'); handleAudio(chunk); });
  ipcMain.on('caption:visible', (_e, payload: { captureAt: number; inferenceMs: number; producedAt: number }) => {
    if (!payload || typeof payload.captureAt !== 'number' || !Number.isFinite(payload.captureAt)) return;
    const visibleAt = Date.now();
    const endToEndMs = Math.max(0, visibleAt - payload.captureAt); visibleLatencies.push(endToEndMs); if (visibleLatencies.length > 5000) visibleLatencies.shift();
    const captureToInferenceMs = Math.max(0, payload.producedAt - payload.captureAt);
    benchLog({ type: 'caption_visible', captureAt: payload.captureAt, producedAt: payload.producedAt, visibleAt, inferenceMs: payload.inferenceMs, endToEndMs });
    broadcast('metrics', { endToEndMs, captureToInferenceMs, bufferingMs: Math.max(0, captureToInferenceMs - payload.inferenceMs), renderMs: Math.max(0, visibleAt - payload.producedAt), inferenceMs: payload.inferenceMs, p50Ms: percentile(visibleLatencies, .5), p95Ms: percentile(visibleLatencies, .95), p99Ms: percentile(visibleLatencies, .99), droppedChunks, queuedChunks: inFlightChunks });
  });
  ipcMain.handle('overlay:show', () => overlayWindow?.show()); ipcMain.handle('overlay:hide', () => overlayWindow?.hide());
  ipcMain.handle('overlay:clickthrough', (_e, on: unknown) => { if (typeof on !== 'boolean') throw new Error('Invalid click-through setting.'); overlayWindow?.setIgnoreMouseEvents(on, { forward: true }); const s = readSettings(); s.clickThrough = on; saveSettings(s); });
  ipcMain.handle('overlay:bounds', () => overlayWindow?.getBounds()); ipcMain.handle('overlay:move', (_e, x: unknown, y: unknown) => { if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid position.'); const nearest = screen.getDisplayNearestPoint({ x, y }); const b = overlayWindow!.getBounds(); overlayWindow!.setBounds({ ...b, x: Math.max(nearest.bounds.x - b.width + 80, Math.min(x, nearest.bounds.x + nearest.bounds.width - 80)), y: Math.max(nearest.bounds.y, Math.min(y, nearest.bounds.y + nearest.bounds.height - 50)) }); });
  ipcMain.handle('hotkey:set', (_e, key: unknown) => { if (typeof key !== 'string' || key.length > 64) throw new Error('Invalid hotkey.'); setHotkey(key); return activeHotkey; });
  createWindows(); try { setHotkey(readSettings().hotkey ?? activeHotkey); } catch { /* use default */ }
  void getPrerollSession().initBridge().catch(() => {});
  if (readSettings().provider === 'local' && modelInstalled()) void ensureLocalWorker(readSettings().language).catch((error) => broadcast('status', { state: 'error', message: `Local model preload failed: ${error instanceof Error ? error.message : String(error)}` }));
  app.on('activate', () => { if (!mainWindow) createWindows(); });
});
app.on('before-quit', () => { quitting = true; void stopTranscription(); if (prerollSession) void prerollSession.dispose(); if (translatorClient) void translatorClient.dispose(); const worker = asrWorker; asrWorker = null; localWorkerReady = null; if (worker) void worker.terminate(); globalShortcut.unregisterAll(); });
