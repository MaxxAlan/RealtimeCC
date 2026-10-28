import { describe, expect, it, vi } from 'vitest';
import { TranslatorClient, WorkerChannel } from '../src/main/preroll/translator-client';
import { TranslationUnit } from '../src/main/preroll/types';

class MockWorkerChannel implements WorkerChannel {
  public listeners: Record<string, ((...args: any[]) => void)[]> = {};
  public sentMessages: any[] = [];
  public killed = false;

  postMessage(message: any): void {
    this.sentMessages.push(message);

    // Auto-respond to 'init' with 'ready'
    if (message.type === 'init') {
      setTimeout(() => {
        this.emit('message', { type: 'ready', backend: 'vulkan' });
      }, 5);
    }

    // Auto-respond to 'translate'
    if (message.type === 'translate') {
      setTimeout(() => {
        const results = message.units.map((u: TranslationUnit) => ({
          id: u.id,
          text: `[DỊCH: ${u.text}]`,
          ok: true,
        }));
        this.emit('message', {
          type: 'translate_result',
          reqId: message.reqId,
          results,
          stats: { tokensPerSecond: 45.2, backend: 'vulkan' },
        });
      }, 10);
    }
  }

  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(listener);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    const list = this.listeners[event] ?? [];
    for (const fn of list) fn(...args);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe('TranslatorClient', () => {
  it('initializes and completes translation requests in order', async () => {
    let mockWorker!: MockWorkerChannel;
    const client = new TranslatorClient({
      modelPath: 'mock-model.gguf',
      workerFactory: () => {
        mockWorker = new MockWorkerChannel();
        return mockWorker;
      },
    });

    await client.ready();
    expect(client.stats().backend).toBe('vulkan');

    const units: TranslationUnit[] = [
      { id: '1', startMs: 0, endMs: 2000, text: 'Hello', src: 'en', tgt: 'vi' },
      { id: '2', startMs: 2000, endMs: 4000, text: 'World', src: 'en', tgt: 'vi' },
    ];

    const results = await client.translate(units);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ id: '1', text: '[DỊCH: Hello]', ok: true });
    expect(results[1]).toEqual({ id: '2', text: '[DỊCH: World]', ok: true });
    expect(client.stats().tokensPerSecond).toBe(45.2);

    await client.dispose();
    expect(mockWorker.killed).toBe(true);
  });

  it('handles per-request abort gracefully', async () => {
    let mockWorker!: MockWorkerChannel;
    const client = new TranslatorClient({
      modelPath: 'mock-model.gguf',
      workerFactory: () => {
        mockWorker = new MockWorkerChannel();
        return mockWorker;
      },
    });

    await client.ready();

    const controller = new AbortController();
    const translatePromise = client.translate(
      [{ id: '1', startMs: 0, endMs: 1000, text: 'Wait', src: 'en', tgt: 'vi' }],
      { signal: controller.signal },
    );

    controller.abort();
    const results = await translatePromise;
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toBe('aborted');

    await client.dispose();
  });

  it('handles worker crash and retries in-flight units upon restart', async () => {
    let worker1 = new MockWorkerChannel();
    let worker2 = new MockWorkerChannel();
    let workerCount = 0;

    const client = new TranslatorClient({
      modelPath: 'mock-model.gguf',
      workerFactory: () => {
        workerCount++;
        return workerCount === 1 ? worker1 : worker2;
      },
    });

    await client.ready();

    // Override worker1's translate response to simulate a crash before answering
    worker1.postMessage = (msg: any) => {
      worker1.sentMessages.push(msg);
      if (msg.type === 'translate') {
        // Worker crashes!
        setTimeout(() => {
          worker1.emit('exit', 1);
        }, 10);
      }
    };

    const translatePromise = client.translate([
      { id: 'crash-1', startMs: 0, endMs: 1000, text: 'Test crash', src: 'en', tgt: 'vi' },
    ]);

    const results = await translatePromise;
    expect(results[0].id).toBe('crash-1');
    expect(results[0].text).toBe('[DỊCH: Test crash]');
    expect(results[0].ok).toBe(true);

    await client.dispose();
  });
});
