import path from 'node:path';
import fs from 'node:fs';
import { fork as nodeFork, ChildProcess } from 'node:child_process';
import { Translator, TranslationUnit } from './types';

export interface WorkerChannel {
  postMessage(message: any): void;
  on(event: 'message', listener: (message: any) => void): this;
  on(event: 'exit', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  kill(): boolean | void;
}

export interface TranslatorClientOptions {
  modelPath: string;
  gpu?: 'auto' | 'off';
  workerPath?: string;
  workerFactory?: () => WorkerChannel;
}

export class TranslatorClient implements Translator {
  private modelPath: string;
  private gpu: 'auto' | 'off';
  private workerPath: string;
  private workerFactory?: () => WorkerChannel;

  private worker: WorkerChannel | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  private pendingRequests = new Map<
    string,
    {
      resolve: (results: Array<{ id: string; text: string; ok: boolean; reason?: string }>) => void;
      reject: (err: Error) => void;
      units: TranslationUnit[];
      signal?: AbortSignal;
      retried?: boolean;
    }
  >();

  private nextReqId = 1;
  private isDisposed = false;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  private lastTokensPerSecond = 0;
  private detectedBackend: 'cuda' | 'vulkan' | 'cpu' = 'cpu';

  constructor(options: TranslatorClientOptions) {
    this.modelPath = options.modelPath;
    this.gpu = options.gpu ?? 'auto';
    this.workerPath = options.workerPath ?? this.resolveWorkerPath();
    this.workerFactory = options.workerFactory;
  }

  private resolveWorkerPath(): string {
    // Check dist folder first (production / built layout)
    const distPath = path.join(__dirname, 'translator-worker.mjs');
    if (fs.existsSync(distPath)) return distPath;

    // Check src folder (dev / test layout)
    const srcPath = path.resolve(__dirname, '../../../src/main/preroll/translator-worker.mjs');
    if (fs.existsSync(srcPath)) return srcPath;

    return distPath;
  }

  private spawnWorker(): WorkerChannel {
    if (this.workerFactory) {
      return this.workerFactory();
    }

    // Try Electron utilityProcess if running within Electron
    try {
      const electron = require('electron');
      if (electron.utilityProcess?.fork) {
        const proc = electron.utilityProcess.fork(this.workerPath, [], {
          serviceName: 'RealtimeCC-TranslatorWorker',
        });
        return {
          postMessage: (msg: any) => proc.postMessage(msg),
          on: (event: any, listener: any) => {
            proc.on(event, listener);
            return this as any;
          },
          kill: () => proc.kill(),
        };
      }
    } catch {
      // Not in Electron main process, fall through to ChildProcess
    }

    // Fallback to Node.js child_process.fork (for headless CLI or unit tests)
    const child: ChildProcess = nodeFork(this.workerPath, [], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });

    return {
      postMessage: (msg: any) => child.send(msg),
      on: (event: any, listener: any) => {
        child.on(event, listener);
        return this as any;
      },
      kill: () => child.kill(),
    };
  }

  public ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.initWorker();
    });

    return this.readyPromise;
  }

  private initWorker() {
    if (this.isDisposed) return;

    try {
      const worker = this.spawnWorker();
      this.worker = worker;

      worker.on('message', (msg: any) => this.handleWorkerMessage(msg));
      worker.on('error', (err: Error) => this.handleWorkerError(err));
      worker.on('exit', (code: number | null) => this.handleWorkerExit(code));

      worker.postMessage({
        type: 'init',
        modelPath: this.modelPath,
        gpu: this.gpu,
      });
    } catch (err) {
      this.readyReject?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleWorkerMessage(msg: any) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ready') {
      this.restartCount = 0;
      this.detectedBackend = msg.backend ?? 'cpu';
      this.readyResolve?.();
      return;
    }

    if (msg.type === 'error' && !msg.reqId) {
      const err = new Error(msg.message ?? 'Unknown worker error');
      this.readyReject?.(err);
      return;
    }

    if (msg.type === 'translate_result' && msg.reqId) {
      const pending = this.pendingRequests.get(msg.reqId);
      if (pending) {
        this.pendingRequests.delete(msg.reqId);
        if (msg.stats?.tokensPerSecond) {
          this.lastTokensPerSecond = msg.stats.tokensPerSecond;
        }
        if (msg.stats?.backend) {
          this.detectedBackend = msg.stats.backend;
        }
        pending.resolve(msg.results);
      }
      return;
    }

    if (msg.type === 'error' && msg.reqId) {
      const pending = this.pendingRequests.get(msg.reqId);
      if (pending) {
        this.pendingRequests.delete(msg.reqId);
        // Fall back to returning source text marked not ok
        pending.resolve(
          pending.units.map((u) => ({
            id: u.id,
            text: u.text,
            ok: false,
            reason: msg.message,
          })),
        );
      }
    }
  }

  private handleWorkerError(err: Error) {
    if (this.isDisposed) return;
    this.readyReject?.(err);
  }

  private handleWorkerExit(code: number | null) {
    if (this.isDisposed) return;
    this.worker = null;

    // Retry or reject in-flight requests
    const inFlight = Array.from(this.pendingRequests.entries());
    this.pendingRequests.clear();

    for (const [, req] of inFlight) {
      if (!req.retried) {
        // Queue for automatic retry upon worker restart
        req.retried = true;
        const newReqId = `retry-${this.nextReqId++}`;
        this.pendingRequests.set(newReqId, req);
      } else {
        // Already retried: fall back to source text
        req.resolve(
          req.units.map((u) => ({
            id: u.id,
            text: u.text,
            ok: false,
            reason: `Worker exited with code ${code}`,
          })),
        );
      }
    }

    // Schedule auto-restart with exponential back-off
    if (this.restartCount < 5) {
      const delay = Math.min(500 * Math.pow(2, this.restartCount), 8000);
      this.restartCount++;
      this.restartTimer = setTimeout(() => {
        this.readyPromise = new Promise<void>((resolve, reject) => {
          this.readyResolve = resolve;
          this.readyReject = reject;
          this.initWorker();
        });
        void this.readyPromise.then(() => {
          // Re-send retried requests
          for (const [reqId, req] of this.pendingRequests.entries()) {
            this.worker?.postMessage({
              type: 'translate',
              reqId,
              units: req.units,
            });
          }
        });
      }, delay);
    }
  }

  public async translate(
    units: TranslationUnit[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<Array<{ id: string; text: string; ok: boolean; reason?: string }>> {
    if (units.length === 0) return [];
    if (opts.signal?.aborted) {
      return units.map((u) => ({ id: u.id, text: u.text, ok: false, reason: 'aborted' }));
    }

    await this.ready();
    if (opts.signal?.aborted) {
      return units.map((u) => ({ id: u.id, text: u.text, ok: false, reason: 'aborted' }));
    }

    const reqId = `req-${this.nextReqId++}`;

    return new Promise((resolve, reject) => {
      const abortListener = () => {
        this.worker?.postMessage({ type: 'abort', reqId });
        this.pendingRequests.delete(reqId);
        resolve(units.map((u) => ({ id: u.id, text: u.text, ok: false, reason: 'aborted' })));
      };

      if (opts.signal) {
        opts.signal.addEventListener('abort', abortListener, { once: true });
      }

      this.pendingRequests.set(reqId, {
        resolve: (results) => {
          if (opts.signal) opts.signal.removeEventListener('abort', abortListener);
          resolve(results);
        },
        reject: (err) => {
          if (opts.signal) opts.signal.removeEventListener('abort', abortListener);
          reject(err);
        },
        units,
        signal: opts.signal,
      });

      this.worker?.postMessage({
        type: 'translate',
        reqId,
        units,
      });
    });
  }

  public stats(): { tokensPerSecond?: number; backend?: 'cuda' | 'vulkan' | 'cpu'; queued: number } {
    return {
      tokensPerSecond: this.lastTokensPerSecond || undefined,
      backend: this.detectedBackend,
      queued: this.pendingRequests.size,
    };
  }

  public async dispose(): Promise<void> {
    this.isDisposed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.worker) {
      this.worker.postMessage({ type: 'dispose' });
      this.worker.kill();
      this.worker = null;
    }
    this.pendingRequests.clear();
  }
}
