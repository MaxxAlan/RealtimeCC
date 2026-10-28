import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ClockSample } from './playback-clock';
import { Ms } from './types';

export interface ActiveMediaInfo {
  tabId: number;
  pageUrl: string;
  title: string;
  durationMs: Ms | null;
  isLive: boolean;
  drm: boolean;
  positionMs: Ms;
  paused: boolean;
  rate: number;
  isAd: boolean;
  lastUpdatedAt: number;
}

export interface ExtensionBridgeOptions {
  port?: number;
  token?: string;
  onActiveMediaChange?: (media: ActiveMediaInfo | null) => void;
  onTick?: (sample: ClockSample & { tabId: number; isAd?: boolean }) => void;
  onEvent?: (event: { tabId: number; name: string; positionMs: number }) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export class ExtensionBridge {
  private port: number;
  private token: string;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private activeMediaMap = new Map<number, ActiveMediaInfo>();
  private activeTabId: number | null = null;
  private authenticatedSockets = new Set<WebSocket>();

  private onActiveMediaChange?: (media: ActiveMediaInfo | null) => void;
  private onTick?: (sample: ClockSample & { tabId: number; isAd?: boolean }) => void;
  private onEvent?: (event: { tabId: number; name: string; positionMs: number }) => void;
  private onConnectionChange?: (connected: boolean) => void;

  constructor(options: ExtensionBridgeOptions = {}) {
    this.port = options.port ?? 9876;
    this.token = options.token || crypto.randomBytes(16).toString('hex');
    this.onActiveMediaChange = options.onActiveMediaChange;
    this.onTick = options.onTick;
    this.onEvent = options.onEvent;
    this.onConnectionChange = options.onConnectionChange;
  }

  public getToken(): string {
    return this.token;
  }

  public getPort(): number {
    return this.port;
  }

  public isConnected(): boolean {
    return this.authenticatedSockets.size > 0;
  }

  public getActiveMedia(): ActiveMediaInfo | null {
    if (this.activeTabId === null) return null;
    return this.activeMediaMap.get(this.activeTabId) || null;
  }

  public async start(): Promise<number> {
    if (this.server) return this.port;

    return new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });

      const wss = new WebSocketServer({
        noServer: true,
        maxPayload: 4096 // 4 KB max message size
      });

      server.on('upgrade', (request, socket, head) => {
        // Enforce 127.0.0.1 and Origin verification
        const origin = request.headers.origin;
        if (origin && !origin.startsWith('chrome-extension://') && !origin.startsWith('moz-extension://')) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      });

      wss.on('connection', (ws) => {
        let msgCountInSecond = 0;
        let rateLimitWindowStart = Date.now();

        ws.on('message', (data, isBinary) => {
          // Drop binary frames
          if (isBinary) return;

          // Rate limit check: max 30 msgs/sec per connection
          const now = Date.now();
          if (now - rateLimitWindowStart > 1000) {
            rateLimitWindowStart = now;
            msgCountInSecond = 0;
          }
          msgCountInSecond++;
          if (msgCountInSecond > 30) {
            ws.close(1008, 'Rate limit exceeded');
            return;
          }

          try {
            const raw = data.toString('utf8');
            const msg = JSON.parse(raw);
            this.handleMessage(ws, msg);
          } catch {
            // Drop invalid JSON
          }
        });

        ws.on('close', () => {
          this.authenticatedSockets.delete(ws);
          this.onConnectionChange?.(this.authenticatedSockets.size > 0);
        });
      });

      server.on('error', (err) => {
        reject(err);
      });

      // Bind strictly to 127.0.0.1
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        this.wss = wss;
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve(this.port);
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.wss) {
      for (const client of this.wss.clients) {
        try { client.close(); } catch {}
      }
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      await new Promise<void>((res) => this.server?.close(() => res()));
      this.server = null;
    }
    this.authenticatedSockets.clear();
    this.activeMediaMap.clear();
    this.activeTabId = null;
  }

  public sendCommand(cmd: { name: 'pause' | 'play'; tabId?: number }): void {
    const payload = JSON.stringify({
      type: 'command',
      name: cmd.name,
      tabId: cmd.tabId ?? this.activeTabId
    });

    for (const ws of this.authenticatedSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload); } catch {}
      }
    }
  }

  private handleMessage(ws: WebSocket, msg: any): void {
    if (!msg || typeof msg !== 'object') return;

    // Authentication
    if (msg.type === 'hello') {
      if (this.verifyToken(msg.token)) {
        this.authenticatedSockets.add(ws);
        ws.send(JSON.stringify({ type: 'hello-ack', status: 'authenticated' }));
        this.onConnectionChange?.(true);
      } else {
        ws.close(1008, 'Invalid pairing token');
      }
      return;
    }

    if (!this.authenticatedSockets.has(ws)) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    const tabId = typeof msg.tabId === 'number' ? msg.tabId : 0;

    if (msg.type === 'media') {
      const media: ActiveMediaInfo = {
        tabId,
        pageUrl: String(msg.pageUrl || ''),
        title: String(msg.title || ''),
        durationMs: typeof msg.durationMs === 'number' ? msg.durationMs : null,
        isLive: Boolean(msg.isLive),
        drm: Boolean(msg.drm),
        positionMs: Number(msg.positionMs || 0),
        paused: Boolean(msg.paused),
        rate: Number(msg.rate || 1.0),
        isAd: Boolean(msg.isAd),
        lastUpdatedAt: Date.now()
      };

      this.activeMediaMap.set(tabId, media);

      // Set as active tab if playing or if first tab
      if (!media.paused || this.activeTabId === null) {
        this.activeTabId = tabId;
        this.onActiveMediaChange?.(media);
      }
    } else if (msg.type === 'tick') {
      const existing = this.activeMediaMap.get(tabId);
      if (existing) {
        existing.positionMs = Number(msg.positionMs || 0);
        existing.paused = Boolean(msg.paused);
        existing.rate = Number(msg.rate || 1.0);
        existing.isAd = Boolean(msg.isAd);
        existing.lastUpdatedAt = Date.now();
      }

      if (tabId === this.activeTabId) {
        this.onTick?.({
          tabId,
          positionMs: Number(msg.positionMs || 0),
          paused: Boolean(msg.paused),
          rate: Number(msg.rate || 1.0),
          isAd: Boolean(msg.isAd),
          receivedAt: performance.now()
        });
      }
    } else if (msg.type === 'event') {
      if (msg.name === 'tab_closed') {
        this.activeMediaMap.delete(tabId);
        if (this.activeTabId === tabId) {
          const nextActive = Array.from(this.activeMediaMap.values())[0] || null;
          this.activeTabId = nextActive ? nextActive.tabId : null;
          this.onActiveMediaChange?.(nextActive);
        }
      } else {
        if (msg.name === 'play') {
          this.activeTabId = tabId;
          const media = this.activeMediaMap.get(tabId);
          if (media) this.onActiveMediaChange?.(media);
        }
        this.onEvent?.({
          tabId,
          name: String(msg.name || ''),
          positionMs: Number(msg.positionMs || 0)
        });
      }
    }
  }

  private verifyToken(provided: unknown): boolean {
    if (typeof provided !== 'string') return false;
    const expectedBuf = Buffer.from(this.token, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    if (expectedBuf.length !== providedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  }
}
