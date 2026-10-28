import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { AsrBackend, AsrSegment, Ms } from './types';

export interface AsrBatchClientOptions {
  modelDir: string;
  language?: string;
  numThreads?: number;
  workerPath?: string;
}

export class AsrBatchClient implements AsrBackend {
  private worker: Worker | null = null;
  private workerReady: Promise<void> | null = null;
  private readonly modelDir: string;
  private readonly language: string;
  private readonly numThreads?: number;
  private readonly workerPath: string;
  private lastRtf = 0;

  constructor(options: AsrBatchClientOptions) {
    this.modelDir = options.modelDir;
    this.language = options.language || 'auto';
    this.numThreads = options.numThreads;
    this.workerPath = options.workerPath || path.join(__dirname, 'asr-batch-worker.js');
  }

  public get rtf(): number {
    return this.lastRtf;
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker && this.workerReady) {
      await this.workerReady;
      return this.worker;
    }

    const worker = new Worker(this.workerPath, {
      workerData: {
        modelDir: this.modelDir,
        language: this.language,
        numThreads: this.numThreads
      }
    });
    this.worker = worker;

    this.workerReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ASR batch worker timed out during initialization'));
      }, 30000);

      const onMessage = (msg: any) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          worker.off('message', onMessage);
          resolve();
        }
      };

      worker.on('message', onMessage);
      worker.once('error', (err) => {
        clearTimeout(timeout);
        this.worker = null;
        this.workerReady = null;
        reject(err);
      });
      worker.once('exit', () => {
        this.worker = null;
        this.workerReady = null;
      });
    });

    await this.workerReady;
    return worker;
  }

  public async *transcribe(
    blocks: AsyncIterable<{ startMs: Ms; pcm: Int16Array }>,
    signal: AbortSignal
  ): AsyncIterable<AsrSegment> {
    if (signal.aborted) return;
    const worker = await this.ensureWorker();

    const segmentQueue: AsrSegment[] = [];
    let notify: (() => void) | null = null;
    let flushed = false;
    let workerError: Error | null = null;

    const onMessage = (msg: any) => {
      if (msg.type === 'segment') {
        segmentQueue.push({
          startMs: msg.startMs,
          endMs: msg.endMs,
          text: msg.text
        });
        if (notify) { notify(); notify = null; }
      } else if (msg.type === 'flushed') {
        flushed = true;
        if (notify) { notify(); notify = null; }
      } else if (msg.type === 'stats') {
        if (typeof msg.rtf === 'number') {
          this.lastRtf = msg.rtf;
        }
      }
    };

    const onError = (err: Error) => {
      workerError = err;
      if (notify) { notify(); notify = null; }
    };

    worker.on('message', onMessage);
    worker.on('error', onError);

    const onAbort = () => {
      try { worker.postMessage({ type: 'reset' }); } catch {}
      if (notify) { notify(); notify = null; }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    // Producer promise: feeds blocks to the worker
    const feedPromise = (async () => {
      try {
        for await (const block of blocks) {
          if (signal.aborted) break;
          const buffer = block.pcm.buffer.slice(
            block.pcm.byteOffset,
            block.pcm.byteOffset + block.pcm.byteLength
          );
          worker.postMessage(
            { type: 'block', buffer, startMs: block.startMs },
            [buffer as unknown as ArrayBuffer]
          );
        }
        if (!signal.aborted) {
          worker.postMessage({ type: 'flush' });
        }
      } catch (e) {
        if (!signal.aborted) {
          workerError = e instanceof Error ? e : new Error(String(e));
        }
      }
    })();

    try {
      while (true) {
        if (signal.aborted) break;

        while (segmentQueue.length > 0) {
          yield segmentQueue.shift()!;
        }

        if (flushed) {
          while (segmentQueue.length > 0) {
            yield segmentQueue.shift()!;
          }
          break;
        }

        if (workerError) throw workerError;

        await new Promise<void>((res) => { notify = res; });
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      worker.off('message', onMessage);
      worker.off('error', onError);
      await feedPromise.catch(() => {});
    }
  }

  public async dispose(): Promise<void> {
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      this.workerReady = null;
      await w.terminate();
    }
  }
}
