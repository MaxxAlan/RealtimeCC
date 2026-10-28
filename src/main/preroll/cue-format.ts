import { Ms } from './types';

export interface FormattedCueUnit {
  startMs: Ms;
  endMs: Ms;
  text: string;
}

/** Check if text or language code is primarily CJK */
export function isCjk(text: string, lang?: string): boolean {
  if (lang) {
    const l = lang.toLowerCase();
    if (l.startsWith('zh') || l.startsWith('ja') || l.startsWith('ko') || l.startsWith('cmn') || l.startsWith('yue')) {
      return true;
    }
  }
  // Check proportion of CJK characters in text
  const cjkMatches = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
  return Boolean(cjkMatches && cjkMatches.length >= Math.max(2, Math.floor(text.length * 0.2)));
}

/**
 * Balance and split text into at most 2 lines.
 * Max ~42 chars for Latin, ~20 for CJK per line.
 */
export function formatSubtitleLines(text: string, isCjkText: boolean): string {
  const clean = text.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
  const maxPerLine = isCjkText ? 20 : 42;

  if (clean.length <= maxPerLine) {
    return clean;
  }

  // Find optimal split point near the midpoint
  const targetSplit = Math.floor(clean.length / 2);
  let bestIdx = -1;
  let bestScore = Infinity;

  if (isCjkText) {
    // For CJK, can split after punctuation or any character
    for (let i = 5; i < clean.length - 5; i++) {
      const char = clean[i];
      let penalty = Math.abs(i - targetSplit);
      if (/[，。！？；、,.!?;\s]/.test(char)) {
        penalty -= 8;
        const candidate = i + 1;
        if (penalty < bestScore) {
          bestScore = penalty;
          bestIdx = candidate;
        }
      } else {
        if (penalty < bestScore) {
          bestScore = penalty;
          bestIdx = i;
        }
      }
    }
  } else {
    // For Latin scripts, split at whitespace or punctuation
    const words = clean.split(' ');
    if (words.length <= 1) {
      return clean;
    }

    let runningLen = 0;
    for (let i = 0; i < words.length - 1; i++) {
      runningLen += words[i].length + (i > 0 ? 1 : 0);
      const diff = Math.abs(runningLen - targetSplit);
      let penalty = diff;
      const lastChar = words[i][words[i].length - 1];
      if (/[,;:.!?]/.test(lastChar)) {
        penalty -= 5;
      }
      if (penalty < bestScore) {
        bestScore = penalty;
        bestIdx = runningLen;
      }
    }
  }

  if (bestIdx > 0 && bestIdx < clean.length) {
    const line1 = clean.slice(0, bestIdx).trim();
    const line2 = clean.slice(bestIdx).trim();
    if (line1 && line2) {
      return `${line1}\n${line2}`;
    }
  }

  return clean;
}

/**
 * Formats a raw translation unit into one or more subtitle cues:
 * - Max 7000ms duration per cue (splits longer units proportionally)
 * - Max 2 lines per cue
 * - Minimum display duration 1000ms, reading speed ~17 chars/sec
 * - Extended up to nextStartMs - 40ms without overlap
 */
export function formatCue(
  unit: { text: string; startMs: Ms; endMs: Ms },
  nextStartMs?: Ms,
  lang?: string
): FormattedCueUnit[] {
  const text = unit.text.trim();
  if (!text) return [];

  const cjk = isCjk(text, lang);
  const maxCharsPerCue = (cjk ? 20 : 42) * 2; // 2 lines max
  const duration = Math.max(250, unit.endMs - unit.startMs);

  // If text is too long for 2 lines or duration > 7000ms, split into pieces
  if (text.length > maxCharsPerCue || duration > 7000) {
    const minPieces = Math.max(1, Math.ceil(duration / 7000));
    const effectiveMaxChars = minPieces > 1
      ? Math.min(maxCharsPerCue, Math.ceil(text.length / minPieces) + 2)
      : maxCharsPerCue;
    const parts = splitLongUnit(text, cjk, effectiveMaxChars);
    if (parts.length > 1) {
      const results: FormattedCueUnit[] = [];
      const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
      let currentStart = unit.startMs;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const partRatio = totalChars > 0 ? part.length / totalChars : 1 / parts.length;
        const partDuration = Math.round(duration * partRatio);
        const partEnd = i === parts.length - 1 ? unit.endMs : currentStart + partDuration;
        const followingStart = i === parts.length - 1 ? nextStartMs : partEnd;

        const formattedParts = formatSingleCue(
          { text: part, startMs: currentStart, endMs: partEnd },
          followingStart,
          cjk
        );
        results.push(...formattedParts);
        currentStart = partEnd;
      }
      return results;
    }
  }

  return formatSingleCue(unit, nextStartMs, cjk);
}

function splitLongUnit(text: string, isCjkText: boolean, maxChars: number): string[] {
  // Try splitting by sentence ends first
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g);
  if (sentences && sentences.length > 1) {
    const chunks: string[] = [];
    let current = '';
    for (const s of sentences) {
      if ((current + s).length <= maxChars) {
        current += s;
      } else {
        if (current) chunks.push(current.trim());
        current = s;
      }
    }
    if (current) chunks.push(current.trim());
    if (chunks.length > 1) return chunks;
  }

  // Otherwise split by word or character boundary
  const words = isCjkText ? text.split('') : text.split(' ');
  const chunks: string[] = [];
  let current = '';

  for (const w of words) {
    const candidate = current ? (isCjkText ? current + w : `${current} ${w}`) : w;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current.trim());
      current = w;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

function formatSingleCue(
  unit: { text: string; startMs: Ms; endMs: Ms },
  nextStartMs: Ms | undefined,
  isCjkText: boolean
): FormattedCueUnit[] {
  const text = formatSubtitleLines(unit.text, isCjkText);
  const cleanCharCount = unit.text.replace(/\s+/g, '').length;

  // Minimum duration 1000ms, reading speed ~17 chars/sec
  const readingDurationMs = Math.ceil((cleanCharCount / 17) * 1000);
  let targetDuration = Math.max(1000, readingDurationMs, unit.endMs - unit.startMs);
  targetDuration = Math.min(targetDuration, 7000);

  let endMs = unit.startMs + targetDuration;

  if (typeof nextStartMs === 'number' && nextStartMs > unit.startMs) {
    const maxAllowedEnd = nextStartMs - 40;
    if (endMs > maxAllowedEnd) {
      endMs = Math.max(unit.startMs + 500, maxAllowedEnd);
    }
  }

  return [{
    startMs: unit.startMs,
    endMs,
    text
  }];
}
