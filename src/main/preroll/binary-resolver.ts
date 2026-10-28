import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface BinaryLocations {
  ytDlp: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
}

function isExecutable(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function findInPath(binName: string): string | null {
  const isWin = process.platform === 'win32';
  const nameWithExt = isWin && !binName.endsWith('.exe') ? `${binName}.exe` : binName;

  const pathVar = process.env.PATH || '';
  const dirs = pathVar.split(path.delimiter);

  for (const dir of dirs) {
    if (!dir) continue;
    const fullPath = path.join(dir, nameWithExt);
    if (isExecutable(fullPath)) {
      return fullPath;
    }
  }

  // Also check standard Windows WinGet or LocalAppData locations
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || '';
    if (localAppData) {
      const wingetLink = path.join(localAppData, 'Microsoft', 'WinGet', 'Links', nameWithExt);
      if (isExecutable(wingetLink)) return wingetLink;

      const wingetPkg = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
      if (fs.existsSync(wingetPkg)) {
        try {
          const entries = fs.readdirSync(wingetPkg);
          for (const entry of entries) {
            if (entry.toLowerCase().includes(binName.toLowerCase())) {
              const candidate = path.join(wingetPkg, entry, nameWithExt);
              if (isExecutable(candidate)) return candidate;
            }
          }
        } catch {}
      }
    }
  }

  return null;
}

export function resolveBinary(name: 'yt-dlp' | 'ffmpeg' | 'ffprobe', customPath?: string): string | null {
  if (customPath && isExecutable(customPath)) {
    return customPath;
  }

  const isWin = process.platform === 'win32';
  const exeName = isWin ? `${name}.exe` : name;

  // 1. Env variable
  const envVarMap: Record<string, string | undefined> = {
    'yt-dlp': process.env.YT_DLP_PATH,
    'ffmpeg': process.env.FFMPEG_PATH,
    'ffprobe': process.env.FFPROBE_PATH
  };
  const envPath = envVarMap[name];
  if (envPath && isExecutable(envPath)) return envPath;

  // 2. Bundled in resources/bin (production or dev)
  const resourceDirs = [
    // Electron packaged resources
    process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null,
    // Dev root resources
    path.resolve(process.cwd(), 'resources', 'bin'),
    path.resolve(__dirname, '..', '..', '..', 'resources', 'bin'),
    path.resolve(__dirname, '..', '..', 'resources', 'bin')
  ];

  for (const dir of resourceDirs) {
    if (dir) {
      const p = path.join(dir, exeName);
      if (isExecutable(p)) return p;
    }
  }

  // 3. User data bin
  const appData = process.env.APPDATA;
  if (appData) {
    const p = path.join(appData, 'realtimecc', 'bin', exeName);
    if (isExecutable(p)) return p;
  }

  // 4. System PATH
  const foundInPath = findInPath(name);
  if (foundInPath) return foundInPath;

  return null;
}

export function resolveAllBinaries(): BinaryLocations {
  return {
    ytDlp: resolveBinary('yt-dlp'),
    ffmpeg: resolveBinary('ffmpeg'),
    ffprobe: resolveBinary('ffprobe')
  };
}

export async function checkYtDlpVersion(ytDlpPath?: string): Promise<{ version: string | null; error?: string }> {
  const binary = ytDlpPath || resolveBinary('yt-dlp');
  if (!binary) return { version: null, error: 'yt-dlp executable not found' };

  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 10000 });
    return { version: stdout.trim() };
  } catch (e) {
    return { version: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function updateYtDlp(ytDlpPath?: string): Promise<{ success: boolean; message: string }> {
  const binary = ytDlpPath || resolveBinary('yt-dlp');
  if (!binary) return { success: false, message: 'yt-dlp executable not found' };

  try {
    const { stdout, stderr } = await execFileAsync(binary, ['-U'], { timeout: 60000 });
    return { success: true, message: (stdout + '\n' + stderr).trim() };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }
}
