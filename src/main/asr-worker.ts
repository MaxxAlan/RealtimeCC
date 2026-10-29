import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';

const dir = workerData.modelDir as string;
const sherpa = require('sherpa-onnx-node');
const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 128 },
  modelConfig: {
    transducer: {
      encoder: path.join(dir, 'encoder.int8.onnx'),
      decoder: path.join(dir, 'decoder.int8.onnx'),
      joiner: path.join(dir, 'joiner.int8.onnx'),
    },
    tokens: path.join(dir, 'tokens.txt'),
    numThreads: Number(workerData.numThreads ?? 4),
    provider: 'cpu',
    debug: 0,
  },
});
const stream = recognizer.createStream();
const requestedLanguage = String(workerData.language ?? 'auto');
stream.setOption('language', requestedLanguage);
let lastText = '';
let acceptedSamples = 0;
let utteranceCaptureStartAt = 0;

parentPort?.postMessage({ type: 'ready' });
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
    // Avoid flashing an unreadable one-character prefix on every decoder
    // update. A complete word appears at its next boundary, and one-word
    // utterances still appear when the recognizer detects their endpoint.
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
  });
});
