import { spawn, ChildProcess } from 'node:child_process';
import { resolveBinary } from './binary-resolver';
import { AudioSource, Ms } from './types';

export interface VideoInfo {
  id: string;
  url: string;
  durationMs: Ms | null;
  isLive: boolean;
  drm: boolean;
  title?: string;
  httpHeaders?: Record<string, string>;
  protocol?: string;
  startTimeOffsetMs?: Ms;
}

export class PrerollAudioError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'LIVE_STREAM' | 'DRM_PROTECTED' | 'RESOLVE_FAILED' | 'STREAM_FAILED',
    message: string
  ) {
    super(message);
    this.name = 'PrerollAudioError';
  }
}

export class OnlineAudioSource implements AudioSource {
  private resolvedInfo: VideoInfo | null = null;
  private readonly ytDlpPath: string;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;

  constructor(
    private readonly pageUrl: string,
    options: { ytDlpPath?: string; ffmpegPath?: string; ffprobePath?: string } = {}
  ) {
    this.ytDlpPath = options.ytDlpPath || resolveBinary('yt-dlp') || 'yt-dlp';
    this.ffmpegPath = options.ffmpegPath || resolveBinary('ffmpeg') || 'ffmpeg';
    this.ffprobePath = options.ffprobePath || resolveBinary('ffprobe') || 'ffprobe';
  }

  /**
   * Probe video metadata and resolve the direct audio stream URL.
   */
  public async info(): Promise<{ durationMs: Ms | null; isLive: boolean; drm: boolean; id: string; title?: string }> {
    if (!this.resolvedInfo) {
      this.resolvedInfo = await this.resolveMetadata();
    }
    return {
      durationMs: this.resolvedInfo.durationMs,
      isLive: this.resolvedInfo.isLive,
      drm: this.resolvedInfo.drm,
      id: this.resolvedInfo.id,
      title: this.resolvedInfo.title
    };
  }

  /**
   * Open 16 kHz mono s16le PCM stream starting at startMs.
   * Yields blocks of ~1s (16000 samples = 32000 bytes).
   */
  public async *open(startMs: Ms, signal: AbortSignal): AsyncIterable<{ startMs: Ms; pcm: Int16Array }> {
    if (signal.aborted) return;

    if (!this.resolvedInfo) {
      this.resolvedInfo = await this.resolveMetadata();
    }

    if (this.resolvedInfo.isLive) {
      throw new PrerollAudioError('LIVE_STREAM', 'Live streams are not supported in pre-roll mode. Use live capture.');
    }
    if (this.resolvedInfo.drm) {
      throw new PrerollAudioError('DRM_PROTECTED', 'DRM-protected media cannot be pre-rolled. Use live capture.');
    }

    let currentStartMs = startMs;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) return;

      try {
        const stream = this.spawnFfmpegStream(this.resolvedInfo, currentStartMs, signal);
        let deliveredSamples = 0;

        for await (const pcm of stream) {
          if (signal.aborted) return;
          const blockStartMs = currentStartMs + Math.round((deliveredSamples / 16000) * 1000);
          deliveredSamples += pcm.length;
          yield { startMs: blockStartMs, pcm };
        }

        // Successfully finished stream
        return;
      } catch (err) {
        if (signal.aborted) return;

        // Check if URL might have expired (HTTP 403 / 410)
        const errMsg = String(err);
        const isExpired = errMsg.includes('403') || errMsg.includes('410') || errMsg.includes('Forbidden');

        if (isExpired && attempt < maxRetries) {
          // Re-resolve URL and resume from current position
          this.resolvedInfo = await this.resolveMetadata();
          continue;
        }

        // If direct ffmpeg fails on fragment-based protocol, try piped yt-dlp -> ffmpeg
        if (attempt === 0 && (this.resolvedInfo.protocol?.includes('dash') || this.resolvedInfo.protocol?.includes('m3u8'))) {
          try {
            const fallbackStream = this.spawnYtDlpPipedStream(this.pageUrl, currentStartMs, signal);
            let deliveredSamples = 0;
            for await (const pcm of fallbackStream) {
              if (signal.aborted) return;
              const blockStartMs = currentStartMs + Math.round((deliveredSamples / 16000) * 1000);
              deliveredSamples += pcm.length;
              yield { startMs: blockStartMs, pcm };
            }
            return;
          } catch (fallbackErr) {
            if (signal.aborted) return;
            throw new PrerollAudioError('STREAM_FAILED', `Audio stream failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
          }
        }

        throw new PrerollAudioError('STREAM_FAILED', `Audio stream failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async resolveMetadata(): Promise<VideoInfo> {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-cache-dir',
      '-f', 'wa/w',
      '-J',
      this.pageUrl
    ];

    const json = await new Promise<string>((resolve, reject) => {
      const proc = spawn(this.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new PrerollAudioError('RESOLVE_FAILED', `yt-dlp failed with exit code ${code}: ${stderr.slice(0, 300)}`));
      });
      proc.on('error', (e) => reject(new PrerollAudioError('RESOLVE_FAILED', `Could not spawn yt-dlp: ${e.message}`)));
    });

    let data: any;
    try {
      data = JSON.parse(json);
    } catch {
      throw new PrerollAudioError('RESOLVE_FAILED', 'Failed to parse yt-dlp JSON output.');
    }

    const isLive = Boolean(data.is_live || data.live_status === 'is_live' || data.live_status === 'post_live');
    const hasDrm = Boolean(
      data.has_drm ||
      (Array.isArray(data.formats) && data.formats.some((f: any) => f.has_drm || (typeof f.format_note === 'string' && f.format_note.toLowerCase().includes('drm'))))
    );

    const streamUrl = data.url || (Array.isArray(data.formats) && data.formats[0]?.url);
    if (!streamUrl) {
      throw new PrerollAudioError('RESOLVE_FAILED', 'No playable audio stream URL found.');
    }

    const durationSec = typeof data.duration === 'number' ? data.duration : null;
    const durationMs = durationSec ? Math.round(durationSec * 1000) : null;

    // Probe start_time offset if HLS/TS
    let startTimeOffsetMs = 0;
    if (data.protocol && (data.protocol.includes('m3u8') || data.protocol.includes('hls'))) {
      startTimeOffsetMs = await this.probeStartTimeOffset(streamUrl, data.http_headers);
    }

    return {
      id: String(data.id || this.pageUrl),
      url: streamUrl,
      durationMs,
      isLive,
      drm: hasDrm,
      title: data.title ? String(data.title) : undefined,
      httpHeaders: data.http_headers,
      protocol: data.protocol,
      startTimeOffsetMs
    };
  }

  private async probeStartTimeOffset(url: string, headers?: Record<string, string>): Promise<number> {
    try {
      const headerArgs = headers ? ['-headers', Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n'] : [];
      const args = [
        '-v', 'error',
        ...headerArgs,
        '-show_entries', 'format=start_time',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        url
      ];

      const out = await new Promise<string>((resolve, reject) => {
        const proc = spawn(this.ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.on('close', (code) => { if (code === 0) resolve(stdout.trim()); else reject(); });
        proc.on('error', reject);
      });

      const offsetSec = parseFloat(out);
      return Number.isFinite(offsetSec) && offsetSec > 0 ? Math.round(offsetSec * 1000) : 0;
    } catch {
      return 0;
    }
  }

  private async *spawnFfmpegStream(
    info: VideoInfo,
    startMs: Ms,
    signal: AbortSignal
  ): AsyncIterable<Int16Array> {
    const adjustedStartSec = Math.max(0, (startMs + (info.startTimeOffsetMs ?? 0)) / 1000);
    const headersStr = info.httpHeaders
      ? Object.entries(info.httpHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n'
      : '';

    const args: string[] = [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin'
    ];

    if (headersStr) {
      args.push('-headers', headersStr);
    }

    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-ss', adjustedStartSec.toFixed(3),
      '-i', info.url,
      '-vn', '-sn', '-dn',
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1'
    );

    const proc = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    yield* this.readPcmBlocks(proc, signal);
  }

  private async *spawnYtDlpPipedStream(
    pageUrl: string,
    startMs: Ms,
    signal: AbortSignal
  ): AsyncIterable<Int16Array> {
    const startSec = Math.max(0, startMs / 1000);
    const ytdlpArgs = [
      '--download-sections', `*${startSec.toFixed(1)}-`,
      '-f', 'wa/w',
      '-o', '-',
      pageUrl
    ];

    const ytdlpProc = spawn(this.ytDlpPath, ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-i', 'pipe:0',
      '-vn', '-sn', '-dn',
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1'
    ];

    const ffmpegProc = spawn(this.ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    ytdlpProc.stdout.pipe(ffmpegProc.stdin);

    const cleanup = () => {
      try { ytdlpProc.kill('SIGKILL'); } catch {}
      try { ffmpegProc.kill('SIGKILL'); } catch {}
    };

    signal.addEventListener('abort', cleanup, { once: true });

    try {
      yield* this.readPcmBlocks(ffmpegProc, signal);
    } finally {
      cleanup();
      signal.removeEventListener('abort', cleanup);
    }
  }

  private async *readPcmBlocks(proc: ChildProcess, signal: AbortSignal): AsyncIterable<Int16Array> {
    const killProc = () => {
      try { proc.kill('SIGKILL'); } catch {}
    };

    signal.addEventListener('abort', killProc, { once: true });

    const BLOCK_SAMPLES = 16000; // ~1 second of 16kHz mono audio
    const BLOCK_BYTES = BLOCK_SAMPLES * 2;
    let remainder = Buffer.alloc(0);

    const queue: Buffer[] = [];
    let error: Error | null = null;
    let ended = false;
    let notify: (() => void) | null = null;

    proc.stdout?.on('data', (chunk: Buffer) => {
      queue.push(chunk);
      if (notify) {
        notify();
        notify = null;
      }
    });

    let stderrOutput = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderrOutput += d.toString();
    });

    proc.on('error', (e) => {
      error = e;
      if (notify) { notify(); notify = null; }
    });

    proc.on('close', (code) => {
      if (code !== 0 && code !== null && !signal.aborted) {
        error = new Error(`FFmpeg exited with code ${code}: ${stderrOutput.slice(0, 300)}`);
      }
      ended = true;
      if (notify) { notify(); notify = null; }
    });

    try {
      while (true) {
        if (signal.aborted) break;

        while (queue.length > 0) {
          const chunk = queue.shift()!;
          const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;

          let offset = 0;
          while (offset + BLOCK_BYTES <= combined.length) {
            const blockBuf = combined.subarray(offset, offset + BLOCK_BYTES);
            const pcm = new Int16Array(
              blockBuf.buffer,
              blockBuf.byteOffset,
              blockBuf.byteLength / 2
            );
            yield new Int16Array(pcm); // clone to avoid buffer detachment
            offset += BLOCK_BYTES;
          }

          remainder = Buffer.from(combined.subarray(offset));
        }

        if (ended) {
          if (remainder.length >= 2) {
            const pcm = new Int16Array(
              remainder.buffer,
              remainder.byteOffset,
              Math.floor(remainder.byteLength / 2)
            );
            yield new Int16Array(pcm);
          }
          break;
        }

        if (error) throw error;

        await new Promise<void>((res) => { notify = res; });
      }
    } finally {
      killProc();
      signal.removeEventListener('abort', killProc);
    }
  }
}
