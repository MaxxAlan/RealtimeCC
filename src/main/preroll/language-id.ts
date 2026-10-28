/**
 * Lightweight, 100% offline text-based language identification with hysteresis.
 * 
 * Accurately detects primary languages (English, Vietnamese, Japanese, Chinese,
 * French, Spanish, German, Russian, etc.) from transcript text without network calls.
 */

export interface LanguageVote {
  lang: string;
  confidence: number;
}

// Common distinctive function words / characters for top languages
const LANGUAGE_PATTERNS: Array<{ lang: string; test: (text: string) => number }> = [
  // Vietnamese: distinctive diacritics
  {
    lang: 'vi',
    test: (text: string) => {
      const match = text.match(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/gi);
      return match ? Math.min(1.0, match.length / 5) : 0;
    },
  },
  // Japanese: Hiragana / Katakana
  {
    lang: 'ja',
    test: (text: string) => {
      const match = text.match(/[\u3040-\u309F\u30A0-\u30FF]/g);
      return match ? Math.min(1.0, match.length / 3) : 0;
    },
  },
  // Korean: Hangul
  {
    lang: 'ko',
    test: (text: string) => {
      const match = text.match(/[\uAC00-\uD7AF\u1100-\u11FF]/g);
      return match ? Math.min(1.0, match.length / 3) : 0;
    },
  },
  // Chinese: Hanzi without Japanese kana
  {
    lang: 'zh-Hans',
    test: (text: string) => {
      const hasKana = /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
      if (hasKana) return 0;
      const match = text.match(/[\u4E00-\u9FFF]/g);
      return match ? Math.min(1.0, match.length / 4) : 0;
    },
  },
  // Russian / Cyrillic
  {
    lang: 'ru',
    test: (text: string) => {
      const match = text.match(/[\u0400-\u04FF]/g);
      return match ? Math.min(1.0, match.length / 5) : 0;
    },
  },
  // French: distinctive words
  {
    lang: 'fr',
    test: (text: string) => {
      const words = new Set(['le', 'la', 'les', 'des', 'un', 'une', 'du', 'et', 'est', 'pour', 'dans', 'avec', 'que', 'qui', 'pas', 'sur', 'ce', 'cette']);
      const tokens = text.toLowerCase().split(/\s+/);
      const matches = tokens.filter((t) => words.has(t)).length;
      return matches > 0 ? Math.min(1.0, matches / 2) : 0;
    },
  },
  // Spanish: distinctive words
  {
    lang: 'es',
    test: (text: string) => {
      const words = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'en', 'es', 'por', 'para', 'con', 'que', 'del', 'al', 'como', 'más', 'pero', 'sus']);
      const tokens = text.toLowerCase().split(/\s+/);
      const matches = tokens.filter((t) => words.has(t)).length;
      return matches > 0 ? Math.min(1.0, matches / 2) : 0;
    },
  },
  // German: distinctive words
  {
    lang: 'de',
    test: (text: string) => {
      const words = new Set(['der', 'die', 'das', 'und', 'ist', 'in', 'den', 'von', 'zu', 'mit', 'auf', 'für', 'nicht', 'ein', 'eine', 'dem', 'sich']);
      const tokens = text.toLowerCase().split(/\s+/);
      const matches = tokens.filter((t) => words.has(t)).length;
      return matches > 0 ? Math.min(1.0, matches / 2) : 0;
    },
  },
  // English: distinctive words
  {
    lang: 'en',
    test: (text: string) => {
      const words = new Set(['the', 'and', 'is', 'are', 'was', 'were', 'to', 'in', 'that', 'it', 'with', 'as', 'for', 'on', 'at', 'by', 'this', 'have', 'from', 'you']);
      const tokens = text.toLowerCase().split(/\s+/);
      const matches = tokens.filter((t) => words.has(t)).length;
      return matches > 0 ? Math.min(1.0, matches / 2) : 0;
    },
  },
];

export class LanguageIdentifier {
  private history: string[] = [];
  private maxHistory: number;

  constructor(maxHistory = 5) {
    this.maxHistory = maxHistory;
  }

  public identifyText(text: string): LanguageVote {
    let bestLang = 'en';
    let maxScore = 0;

    for (const pattern of LANGUAGE_PATTERNS) {
      const score = pattern.test(text);
      if (score > maxScore) {
        maxScore = score;
        bestLang = pattern.lang;
      }
    }

    return {
      lang: bestLang,
      confidence: maxScore,
    };
  }

  /**
   * Identifies language with hysteresis (majority voting across last N segments).
   */
  public vote(text: string): string {
    const single = this.identifyText(text);
    if (single.confidence > 0.3) {
      this.history.push(single.lang);
      if (this.history.length > this.maxHistory) {
        this.history.shift();
      }
    }

    if (this.history.length === 0) return 'en';

    // Count votes
    const counts = new Map<string, number>();
    for (const lang of this.history) {
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }

    let topLang = 'en';
    let topCount = 0;
    for (const [lang, count] of counts.entries()) {
      if (count > topCount) {
        topCount = count;
        topLang = lang;
      }
    }

    return topLang;
  }

  public reset() {
    this.history = [];
  }
}
