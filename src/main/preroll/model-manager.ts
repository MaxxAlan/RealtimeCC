import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';

export interface DownloadProgress {
  state: 'idle' | 'downloading' | 'verifying' | 'ready' | 'error';
  received: number;
  total: number;
  percent: number | null;
  message?: string;
}

export const TRANSLATOR_MODEL_INFO = {
  id: 'translategemma-4b-it-Q4_K_M',
  filename: 'translategemma-4b-it-Q4_K_M.gguf',
  url: 'https://huggingface.co/42ailab/TranslateGemma-4B-GGUF/resolve/main/translategemma-4b-it-Q4_K_M.gguf',
  sha256: '7f7357c14abd9da4eb200b38b05da502cd6e10d7e1d403fbc9f78c19f3209b72',
  sizeBytes: 2489909312,
  licenseName: 'Gemma Terms of Use',
  licenseUrl: 'https://ai.google.dev/gemma/terms',
};

export function getTranslatorModelPath(modelsDir: string): string {
  return path.join(modelsDir, TRANSLATOR_MODEL_INFO.filename);
}

export function isTranslatorModelInstalled(modelsDir: string): boolean {
  const file = getTranslatorModelPath(modelsDir);
  if (!fs.existsSync(file)) return false;
  try {
    const stats = fs.statSync(file);
    // At minimum, must match expected size or be close to 2.49 GB
    return stats.size > 2_000_000_000;
  } catch {
    return false;
  }
}

export async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

export async function verifyFileSha256(filePath: string, expectedSha256: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false;
  try {
    const actual = await computeFileSha256(filePath);
    return actual === expectedSha256.toLowerCase();
  } catch {
    return false;
  }
}

export interface DownloadOptions {
  expectedSha256?: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

/**
 * Resumable file downloader supporting HTTP 206 Partial Content, redirection,
 * SHA-256 verification, and abort signals.
 */
export function downloadFile(
  url: string,
  destination: string,
  options: DownloadOptions = {},
  redirects = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      return reject(new Error('Download cancelled.'));
    }
    if (redirects > 8) {
      return reject(new Error('Download redirected too many times.'));
    }

    const destDir = path.dirname(destination);
    fs.mkdirSync(destDir, { recursive: true });

    const existingSize = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
    const protocol = url.startsWith('http:') ? http : https;

    const req = protocol.get(
      url,
      {
        headers: {
          'User-Agent': 'RealtimeCC/0.1',
          ...(existingSize > 0 ? { Range: `bytes=${existingSize}-` } : {}),
        },
      },
      (res) => {
        // Handle redirect
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
          res.resume();
          const target = new URL(res.headers.location, url).toString();
          void downloadFile(target, destination, options, redirects + 1).then(resolve, reject);
          return;
        }

        const isResume = existingSize > 0 && res.statusCode === 206;
        if (res.statusCode !== 200 && !isResume) {
          res.resume();
          reject(new Error(`Download failed with HTTP ${res.statusCode ?? 'unknown'}`));
          return;
        }

        const contentLength = Number(res.headers['content-length'] ?? 0);
        const total = contentLength + (isResume ? existingSize : 0);
        let received = isResume ? existingSize : 0;

        const out = fs.createWriteStream(destination, { flags: isResume ? 'a' : 'w' });

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          options.onProgress?.({
            state: 'downloading',
            received,
            total,
            percent: total > 0 ? Math.floor((received * 100) / total) : null,
          });
        });

        res.pipe(out);

        out.on('finish', () => {
          out.close(async () => {
            if (options.expectedSha256) {
              options.onProgress?.({
                state: 'verifying',
                received,
                total,
                percent: 100,
                message: 'Verifying SHA-256 checksum…',
              });

              try {
                const isValid = await verifyFileSha256(destination, options.expectedSha256);
                if (!isValid) {
                  // Mismatch: remove corrupt download
                  fs.unlinkSync(destination);
                  reject(new Error('Downloaded file checksum does not match pinned SHA-256.'));
                  return;
                }
              } catch (err) {
                reject(err);
                return;
              }
            }

            options.onProgress?.({
              state: 'ready',
              received,
              total,
              percent: 100,
            });
            resolve();
          });
        });

        out.on('error', (err) => {
          reject(err);
        });
      },
    );

    req.setTimeout(120000, () => {
      req.destroy(new Error('Download timed out after 120s idle.'));
    });

    req.on('error', reject);

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Download cancelled.'));
      });
    }
  });
}
