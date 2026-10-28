import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../src/main/preroll/extension-bridge';
import { PrerollSession } from '../src/main/preroll/preroll-session';
import { AsrBackend, Translator } from '../src/main/preroll/types';

describe('ExtensionBridge', () => {
  let bridge: ExtensionBridge | null = null;

  afterEach(async () => {
    if (bridge) {
      await bridge.stop();
      bridge = null;
    }
  });

  it('binds to 127.0.0.1 and authenticates with token', async () => {
    bridge = new ExtensionBridge({ port: 0 });
    const port = await bridge.start();
    const token = bridge.getToken();

    // Connect with valid token
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messagePromise = new Promise<any>((resolve) => {
      ws.on('message', (d) => resolve(JSON.parse(d.toString())));
    });

    await new Promise<void>((res) => { ws.on('open', res); });
    ws.send(JSON.stringify({ type: 'hello', v: 1, token, browser: 'chrome' }));

    const ack = await messagePromise;
    expect(ack.type).toBe('hello-ack');
    expect(ack.status).toBe('authenticated');
    expect(bridge.isConnected()).toBe(true);

    ws.close();
  });

  it('rejects connection with invalid pairing token', async () => {
    bridge = new ExtensionBridge({ port: 0 });
    const port = await bridge.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    await new Promise<void>((res) => { ws.on('open', res); });
    ws.send(JSON.stringify({ type: 'hello', v: 1, token: 'wrong-token', browser: 'chrome' }));

    const closeInfo = await closePromise;
    expect(closeInfo.code).toBe(1008);
  });

  it('receives media and tick updates and updates active media', async () => {
    let tickReceived: any = null;
    let activeMediaReceived: any = null;

    bridge = new ExtensionBridge({
      port: 0,
      onTick: (s) => { tickReceived = s; },
      onActiveMediaChange: (m) => { activeMediaReceived = m; }
    });

    const port = await bridge.start();
    const token = bridge.getToken();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res) => { ws.on('open', res); });
    ws.send(JSON.stringify({ type: 'hello', v: 1, token, browser: 'chrome' }));

    await new Promise((r) => setTimeout(r, 50));

    // Send media state
    ws.send(JSON.stringify({
      type: 'media',
      tabId: 101,
      pageUrl: 'https://youtube.com/watch?v=123',
      title: 'Test Video',
      durationMs: 300000,
      isLive: false,
      drm: false,
      positionMs: 15000,
      paused: false,
      rate: 1.0,
      isAd: false
    }));

    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.getActiveMedia()?.title).toBe('Test Video');
    expect(activeMediaReceived?.tabId).toBe(101);

    // Send tick
    ws.send(JSON.stringify({
      type: 'tick',
      tabId: 101,
      positionMs: 15500,
      paused: false,
      rate: 1.0,
      isAd: false
    }));

    await new Promise((r) => setTimeout(r, 50));
    expect(tickReceived?.positionMs).toBe(15500);

    ws.close();
  });
});

describe('PrerollSession Fallback', () => {
  const fakeAsr: AsrBackend = {
    async *transcribe() {}
  };
  const fakeTranslator: Translator = {
    async ready() {},
    async translate() { return []; },
    stats() { return { backend: 'cpu', queued: 0 }; },
    async dispose() {}
  };

  it('falls back when no browser media or manual URL is active', async () => {
    const session = new PrerollSession({
      asrBackend: fakeAsr,
      translator: fakeTranslator,
      port: 0,
      onCaption: () => {}
    });

    const result = await session.start();
    expect(result.shouldFallback).toBe(true);
    expect(result.reason).toContain('No active online video found');

    await session.dispose();
  });
});
