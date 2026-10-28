/**
 * Standalone ESM worker for TranslateGemma 4B via node-llama-cpp.
 *
 * Runs inside an Electron utilityProcess (or Node child_process) to provide:
 * 1. Native crash isolation from Electron main process
 * 2. Proper ESM loading for node-llama-cpp v3
 * 3. GPU (Vulkan/CUDA) or CPU execution
 */

import { getLlama, LlamaCompletion } from 'node-llama-cpp';
import { buildPrompt, cleanOutput } from './translategemma-prompt.js';

let llama = null;
let model = null;
let context = null;
let completion = null;
let backend = 'cpu';
let currentReqId = null;
let abortRequested = false;

const port = process.parentPort;

function send(msg) {
  if (port) {
    port.postMessage(msg);
  } else if (process.send) {
    process.send(msg);
  }
}

async function initModel(modelPath, gpuSetting = 'auto') {
  const gpuOption = gpuSetting === 'off' ? false : 'auto';
  llama = await getLlama({ gpu: gpuOption });

  if (llama.gpu === 'vulkan') backend = 'vulkan';
  else if (llama.gpu === 'cuda') backend = 'cuda';
  else backend = 'cpu';

  model = await llama.loadModel({
    modelPath,
    defaultContextFlashAttention: true,
  });

  context = await model.createContext({
    contextSize: 2048,
    sequences: 1,
  });

  completion = new LlamaCompletion({
    contextSequence: context.getSequence(),
  });

  send({
    type: 'ready',
    backend,
    modelInfo: {
      backend,
      gpu: llama.gpu,
      contextSize: 2048,
    },
  });
}

async function handleTranslate(reqId, units) {
  currentReqId = reqId;
  abortRequested = false;

  const results = [];
  let totalTokens = 0;
  let totalDecodeMs = 0;
  const startedTotal = performance.now();

  for (const unit of units) {
    if (abortRequested) {
      results.push({
        id: unit.id,
        text: unit.text,
        ok: false,
        reason: 'aborted',
      });
      continue;
    }

    try {
      const prompt = buildPrompt({
        src: unit.src,
        tgt: unit.tgt,
        text: unit.text,
      });

      // Clamp max output tokens: max(32, min(256, ceil(srcTokens * 3) + 16))
      const approxSrcTokens = Math.ceil(unit.text.length / 3);
      const maxTokens = Math.max(32, Math.min(256, approxSrcTokens * 3 + 16));

      const startedUnit = performance.now();
      const raw = await completion.generateCompletion(prompt, {
        maxTokens,
        temperature: 0,
        customStopTriggers: ['<end_of_turn>', '<eos>'],
      });
      const decodeMs = performance.now() - startedUnit;
      totalDecodeMs += decodeMs;

      // Approx token count for rate metrics
      const approxTokens = Math.ceil(raw.length / 3);
      totalTokens += approxTokens;

      const cleaned = cleanOutput(raw, unit.text);
      results.push({
        id: unit.id,
        text: cleaned.text,
        ok: cleaned.ok,
        reason: cleaned.reason,
      });
    } catch (err) {
      results.push({
        id: unit.id,
        text: unit.text,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const elapsedSec = (performance.now() - startedTotal) / 1000;
  const tokensPerSecond = elapsedSec > 0 ? Math.round((totalTokens / elapsedSec) * 10) / 10 : 0;

  send({
    type: 'translate_result',
    reqId,
    results,
    stats: {
      tokensPerSecond,
      decodeMs: Math.round(totalDecodeMs),
      backend,
    },
  });

  currentReqId = null;
  abortRequested = false;
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'init':
      initModel(msg.modelPath, msg.gpu).catch((err) => {
        send({
          type: 'error',
          message: `Failed to initialize TranslateGemma model: ${err.message}`,
        });
      });
      break;

    case 'translate':
      handleTranslate(msg.reqId, msg.units).catch((err) => {
        send({
          type: 'error',
          reqId: msg.reqId,
          message: `Translation execution failed: ${err.message}`,
        });
      });
      break;

    case 'abort':
      if (currentReqId === msg.reqId) {
        abortRequested = true;
      }
      break;

    case 'dispose':
      if (context) void context.dispose();
      if (model) void model.dispose();
      process.exit(0);
      break;
  }
}

if (port) {
  port.on('message', (e) => handleMessage(e.data));
} else {
  process.on('message', (msg) => handleMessage(msg));
}

send({ type: 'worker_started' });
