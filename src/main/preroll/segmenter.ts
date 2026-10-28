import { AsrSegment, Ms, TranslationUnit } from './types';

export interface SegmenterOptions {
  maxChars?: number;
  maxDurationMs?: number;
  gapThresholdMs?: number;
  srcLang?: string;
  tgtLang?: string;
}

const DEFAULT_MAX_CHARS = 180;
const DEFAULT_MAX_DURATION_MS = 8000;
const DEFAULT_GAP_THRESHOLD_MS = 700;

const SENTENCE_END_PUNCTUATION = /[.!?。！？…]$/;

export class Segmenter {
  private currentSegments: AsrSegment[] = [];
  private unitCounter = 0;
  private readonly maxChars: number;
  private readonly maxDurationMs: number;
  private readonly gapThresholdMs: number;
  private readonly srcLang: string;
  private readonly tgtLang: string;

  constructor(options: SegmenterOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.gapThresholdMs = options.gapThresholdMs ?? DEFAULT_GAP_THRESHOLD_MS;
    this.srcLang = options.srcLang ?? 'en';
    this.tgtLang = options.tgtLang ?? 'vi';
  }

  /**
   * Process a single incoming ASR segment. Returns any completed TranslationUnits.
   */
  public push(segment: AsrSegment): TranslationUnit[] {
    const text = segment.text.trim();
    if (!text) return [];

    const units: TranslationUnit[] = [];

    if (this.currentSegments.length > 0) {
      const prev = this.currentSegments[this.currentSegments.length - 1];
      const gap = segment.startMs - prev.endMs;

      // Flush if silence gap exceeds threshold
      if (gap > this.gapThresholdMs) {
        const flushed = this.flush();
        if (flushed) units.push(...flushed);
      }
    }

    this.currentSegments.push({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text
    });

    const currentText = this.buildCombinedText();
    const currentDuration = this.currentSegments[this.currentSegments.length - 1].endMs - this.currentSegments[0].startMs;

    // Check if sentence ended with punctuation
    const hasSentenceEnd = SENTENCE_END_PUNCTUATION.test(text);

    // Check if exceeded max chars or max duration
    const isTooLong = currentText.length >= this.maxChars || currentDuration >= this.maxDurationMs;

    if (hasSentenceEnd || isTooLong) {
      const flushed = this.flush();
      if (flushed) units.push(...flushed);
    }

    return units;
  }

  /**
   * Flush any remaining accumulated segments into a completed TranslationUnit.
   */
  public flush(): TranslationUnit[] {
    if (this.currentSegments.length === 0) return [];

    const startMs = this.currentSegments[0].startMs;
    const endMs = this.currentSegments[this.currentSegments.length - 1].endMs;
    const text = this.buildCombinedText();

    this.currentSegments = [];

    if (!text.trim()) return [];

    this.unitCounter++;
    const unit: TranslationUnit = {
      id: `tu-${this.unitCounter}-${startMs}`,
      startMs,
      endMs,
      text: text.trim(),
      src: this.srcLang,
      tgt: this.tgtLang
    };

    return [unit];
  }

  public reset(): void {
    this.currentSegments = [];
    this.unitCounter = 0;
  }

  private buildCombinedText(): string {
    return this.currentSegments.map((s) => s.text.trim()).join(' ');
  }
}

/**
 * Async generator wrapping a stream of ASR segments into TranslationUnits.
 */
export async function* segmentStream(
  segments: AsyncIterable<AsrSegment>,
  options: SegmenterOptions = {}
): AsyncIterable<TranslationUnit> {
  const segmenter = new Segmenter(options);
  for await (const seg of segments) {
    const units = segmenter.push(seg);
    for (const u of units) {
      yield u;
    }
  }
  const remaining = segmenter.flush();
  for (const u of remaining) {
    yield u;
  }
}
