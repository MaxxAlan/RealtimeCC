import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';

const dir = workerData.modelDir as string;
const requestedProvider = String(workerData.provider || 'cpu').toLowerCase(); // cpu | cuda | auto
const numThreads = Number(workerData.numThreads ?? 4);
const sherpa = require('sherpa-onnx-node');

function createRecognizer(provider: string) {
  return new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 128 },
    modelConfig: {
      transducer: {
        encoder: path.join(dir, 'encoder.int8.onnx'),
        decoder: path.join(dir, 'decoder.int8.onnx'),
        joiner: path.join(dir, 'joiner.int8.onnx'),
      },
      tokens: path.join(dir, 'tokens.txt'),
      numThreads,
      provider,
      debug: 0,
    },
  });
}

/** Try CUDA when requested; always keep CPU as fallback. GPU is unverified on this machine. */
function initRecognizer(): { recognizer: any; provider: string; fallback?: string } {
  const wantCuda = requestedProvider === 'cuda' || requestedProvider === 'auto';
  if (wantCuda) {
    try {
      const r = createRecognizer('cuda');
      // Touch createStream to surface delayed LoadLibrary failures early.
      const s = r.createStream();
      try {
        r.reset(s);
      } catch {
        /* ignore */
      }
      return { recognizer: r, provider: 'cuda' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      parentPort?.postMessage({ type: 'provider_fallback', from: 'cuda', to: 'cpu', message: msg });
    }
  }
  return { recognizer: createRecognizer('cpu'), provider: 'cpu', fallback: wantCuda ? 'cuda_failed' : undefined };
}

const boot = initRecognizer();
const recognizer = boot.recognizer;
const stream = recognizer.createStream();
const requestedLanguage = String(workerData.language ?? 'auto');
stream.setOption('language', requestedLanguage);
let lastText = '';
let acceptedSamples = 0;
let utteranceCaptureStartAt = 0;

parentPort?.postMessage({
  type: 'ready',
  provider: boot.provider,
  requestedProvider,
  fallback: boot.fallback || null,
});

parentPort?.on('message', (message: {
  buffer?: ArrayBuffer;
  capturedAt?: number;
  audioMs?: number;
  control?: string;
  language?: string;
}) => {
  if (message.control === 'reset' || message.control === 'configure') {
    recognizer.reset(stream);
    lastText = '';
    acceptedSamples = 0;
    utteranceCaptureStartAt = 0;
    if (message.control === 'configure') stream.setOption('language', String(message.language ?? 'auto'));
    return;
  }
  if (!message.buffer || typeof message.capturedAt !== 'number') return;
  const started = performance.now();
  const pcm = new Int16Array(message.buffer);
  const audioMs = typeof message.audioMs === 'number' ? message.audioMs : Math.round(pcm.length / 16);
  if (!utteranceCaptureStartAt) utteranceCaptureStartAt = message.capturedAt;
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / (pcm[i] < 0 ? 32768 : 32767);
  stream.acceptWaveform({ sampleRate: 16000, samples });
  acceptedSamples += samples.length;
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  const inferenceMs = performance.now() - started;
  const now = Date.now();
  if (result.text !== lastText) {
    const text = result.text.trim();
    const endpoint = recognizer.isEndpoint(stream);
    if (text && (endpoint || /\s|\p{P}/u.test(result.text))) {
      const newestTokenTime = result.timestamps?.length
        ? result.timestamps[result.timestamps.length - 1] * 1000
        : acceptedSamples / 16;
      parentPort?.postMessage({
        type: 'caption',
        text,
        partial: !endpoint,
        inferenceMs,
        captureAt: utteranceCaptureStartAt + newestTokenTime,
        startAt: utteranceCaptureStartAt,
        endAt: utteranceCaptureStartAt + Math.max(newestTokenTime, acceptedSamples / 16),
        producedAt: now,
        provider: boot.provider,
      });
      lastText = result.text;
    }
  }
  if (recognizer.isEndpoint(stream)) {
    const finalText = result.text.trim();
    if (finalText) {
      parentPort?.postMessage({
        type: 'final',
        text: finalText,
        startAt: utteranceCaptureStartAt,
        endAt: utteranceCaptureStartAt + acceptedSamples / 16,
      });
    }
    recognizer.reset(stream);
    lastText = '';
    acceptedSamples = 0;
    utteranceCaptureStartAt = 0;
  }
  parentPort?.postMessage({
    type: 'processed',
    inferenceMs,
    capturedAt: message.capturedAt,
    producedAt: now,
    audioMs,
    provider: boot.provider,
  });
});
