import { getTranslateGemmaLanguage, toTranslateGemmaCode } from './translategemma-languages';

export interface BuildPromptArgs {
  src: string;
  tgt: string;
  text: string;
}

export interface CleanOutputResult {
  ok: boolean;
  text: string;
  reason?: string;
}

/**
 * Builds the official TranslateGemma chat template prompt.
 *
 * Structure:
 * <bos><start_of_turn>user
 * You are a professional {SRC_NAME} ({src_code}) to {TGT_NAME} ({tgt_code}) translator. Your goal is to accurately convey the meaning and nuances of the original {SRC_NAME} text while adhering to {TGT_NAME} grammar, vocabulary, and cultural sensitivities.
 * Produce only the {TGT_NAME} translation, without any additional explanations or commentary. Please translate the following {SRC_NAME} text into {TGT_NAME}:
 * 
 * 
 * {TEXT}<end_of_turn>
 * <start_of_turn>model
 */
export function buildPrompt({ src, tgt, text }: BuildPromptArgs): string {
  const srcLang = getTranslateGemmaLanguage(src);
  const tgtLang = getTranslateGemmaLanguage(tgt);

  if (!srcLang) {
    throw new Error(`Unsupported source language for TranslateGemma: ${src}`);
  }
  if (!tgtLang) {
    throw new Error(`Unsupported target language for TranslateGemma: ${tgt}`);
  }

  const trimmedText = text.trim();

  return (
    `<bos><start_of_turn>user\n` +
    `You are a professional ${srcLang.name} (${srcLang.code}) to ${tgtLang.name} (${tgtLang.code}) translator. Your goal is to accurately convey the meaning and nuances of the original ${srcLang.name} text while adhering to ${tgtLang.name} grammar, vocabulary, and cultural sensitivities.\n` +
    `Produce only the ${tgtLang.name} translation, without any additional explanations or commentary. Please translate the following ${srcLang.name} text into ${tgtLang.name}:\n\n\n` +
    `${trimmedText}<end_of_turn>\n` +
    `<start_of_turn>model\n`
  );
}

/**
 * Detects runaway repetition patterns (e.g. "word word word word" or "abcabcabcabc").
 */
function hasRunawayRepetition(text: string): boolean {
  if (text.length > 1000) return true;
  // Character repetition: same character 10+ times in a row
  if (/(.)\1{9,}/u.test(text)) return true;

  // Word token repetition
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 4) {
    let repeatCount = 1;
    for (let i = 1; i < words.length; i++) {
      if (words[i].toLowerCase() === words[i - 1].toLowerCase()) {
        repeatCount++;
        if (repeatCount >= 4) return true;
      } else {
        repeatCount = 1;
      }
    }
  }

  // Multi-word phrase repetition (phrase of 2 to 5 words repeated 3+ times)
  if (words.length >= 6) {
    for (let len = 2; len <= 5; len++) {
      for (let start = 0; start <= words.length - len * 3; start++) {
        const p1 = words.slice(start, start + len).join(' ').toLowerCase();
        const p2 = words.slice(start + len, start + len * 2).join(' ').toLowerCase();
        const p3 = words.slice(start + len * 2, start + len * 3).join(' ').toLowerCase();
        if (p1 === p2 && p2 === p3) return true;
      }
    }
  }

  return false;
}

/**
 * Cleans raw output from TranslateGemma:
 * - Strips system tokens and markdown code fences
 * - Strips wrapping quotes
 * - Rejects chatty preambles
 * - Detects runaway repetition and absurd length ratios
 */
export function cleanOutput(raw: string, srcText: string): CleanOutputResult {
  const fallback = srcText.trim();
  if (!raw || typeof raw !== 'string') {
    return { ok: false, text: fallback, reason: 'empty_output' };
  }

  // 1. Remove special tokens
  let cleaned = raw
    .replace(/<end_of_turn>/g, '')
    .replace(/<start_of_turn>model/g, '')
    .replace(/<bos>/g, '')
    .replace(/<eos>/g, '')
    .trim();

  // 2. Strip wrapping markdown code blocks (e.g. ```text ... ``` or ``` ...)
  cleaned = cleaned.replace(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/g, '$1').trim();

  // 3. Strip conversational prefixes/preambles (e.g. "Here is the translation:")
  cleaned = cleaned.replace(/^(?:here(?:'s| is) (?:the )?(?:translation|translated text)[:：]?\s*)/i, '');
  cleaned = cleaned.replace(/^(?:translation[:：]\s*)/i, '');

  // 4. Strip wrapping quotes if the source wasn't quote-wrapped
  const srcTrimmed = srcText.trim();
  const srcHasQuotes =
    (srcTrimmed.startsWith('"') && srcTrimmed.endsWith('"')) ||
    (srcTrimmed.startsWith('“') && srcTrimmed.endsWith('”')) ||
    (srcTrimmed.startsWith("'") && srcTrimmed.endsWith("'"));

  if (!srcHasQuotes) {
    if (
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith('“') && cleaned.endsWith('”')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))
    ) {
      cleaned = cleaned.slice(1, -1).trim();
    }
  }

  // 5. Check if output is empty
  if (!cleaned) {
    return { ok: false, text: fallback, reason: 'empty_output' };
  }

  // 6. Runaway repetition check
  if (hasRunawayRepetition(cleaned)) {
    return { ok: false, text: fallback, reason: 'runaway_repetition' };
  }

  // 7. Absurd length ratio check
  if (srcTrimmed.length > 5 && cleaned.length > srcTrimmed.length * 10) {
    return { ok: false, text: fallback, reason: 'length_ratio_too_large' };
  }
  if (srcTrimmed.length > 30 && cleaned.length < srcTrimmed.length * 0.08) {
    return { ok: false, text: fallback, reason: 'length_ratio_too_small' };
  }

  return { ok: true, text: cleaned };
}
