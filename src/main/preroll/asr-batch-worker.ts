import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import os from 'node:os';

const dir = String(workerData?.modelDir || '');
const requestedLanguage = String(workerData?.language || 'auto');
const numThreads = Number(workerData?.numThreads || Math.max(1, os.cpus().length - 2));

const sherpa = require('sherpa-onnx-node');

const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 128 },
  modelConfig: {
    transducer: {
      encoder: path.join(dir, 'encoder.int8.onnx'),
      decoder: path.join(dir, 'decoder.int8.onnx'),
      joiner: path.join(dir, 'joiner.int8.onnx')
    },
    tokens: path.join(dir, 'tokens.txt'),
    numThreads,
    provider: 'cpu',
    debug: 0
  },
  endpointConfig: {
    rule1: { mustContainANonSilenceFrame: true, minTrailingSilence: 0.8, minUtteranceLength: 0 },
    rule2: { mustContainANonSilenceFrame: true, minTrailingSilence: 0.6, minUtteranceLength: 2.0 },
    rule3: { mustContainANonSilenceFrame: false, minTrailingSilence: 0.0, minUtteranceLength: 8.0 }
  },
  enableEndpoint: true
});

let stream = recognizer.createStream();
if (requestedLanguage && requestedLanguage !== 'auto') {
  stream.setOption('language', requestedLanguage);
}

let utteranceStartMs = 0;
let acceptedSamples = 0;
let totalAudioMs = 0;
let totalDecodeMs = 0;

parentPort?.postMessage({ type: 'ready' });

parentPort?.on('message', (msg: {
  type: 'block' | 'flush' | 'reset' | 'configure';
  buffer?: ArrayBuffer;
  startMs?: number;
  language?: string;
}) => {
  if (msg.type === 'configure') {
    if (msg.language && msg.language !== 'auto') {
      stream.setOption('language', msg.language);
    }
    return;
  }

  if (msg.type === 'reset') {
    recognizer.reset(stream);
    utteranceStartMs = 0;
    acceptedSamples = 0;
    return;
  }

  if (msg.type === 'flush') {
    try {
      stream.inputFinished();
      while (recognizer.isReady(stream)) {
        recognizer.decode(stream);
      }
      const res = recognizer.getResult(stream);
      const finalText = res.text?.trim();
      if (finalText && utteranceStartMs > 0) {
        const endMs = utteranceStartMs + Math.round(acceptedSamples / 16);
        parentPort?.postMessage({
          type: 'segment',
          startMs: utteranceStartMs,
          endMs,
          text: finalText
        });
      }
    } catch {}

    recognizer.reset(stream);
    utteranceStartMs = 0;
    acceptedSamples = 0;
    parentPort?.postMessage({ type: 'flushed' });
    return;
  }

  if (msg.type === 'block' && msg.buffer) {
    const started = performance.now();
    const pcm = new Int16Array(msg.buffer);
    const blockStartMs = typeof msg.startMs === 'number' ? msg.startMs : 0;

    if (!utteranceStartMs) {
      utteranceStartMs = blockStartMs;
    }

    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      samples[i] = pcm[i] / (pcm[i] < 0 ? 32768 : 32767);
    }

    stream.acceptWaveform({ sampleRate: 16000, samples });
    acceptedSamples += samples.length;

    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
    }

    const decodeDuration = performance.now() - started;
    const audioDuration = Math.round(samples.length / 16);
    totalAudioMs += audioDuration;
    totalDecodeMs += decodeDuration;

    if (recognizer.isEndpoint(stream)) {
      const result = recognizer.getResult(stream);
      const finalText = result.text?.trim();
      if (finalText) {
        const endMs = utteranceStartMs + Math.round(acceptedSamples / 16);
        parentPort?.postMessage({
          type: 'segment',
          startMs: utteranceStartMs,
          endMs,
          text: finalText
        });
      }
      recognizer.reset(stream);
      utteranceStartMs = 0;
      acceptedSamples = 0;
    }

    const rtf = totalAudioMs > 0 ? totalDecodeMs / totalAudioMs : 0;
    parentPort?.postMessage({
      type: 'stats',
      rtf,
      totalAudioMs,
      totalDecodeMs
    });
  }
});
