/**
 * Supported language mapping and validation for Google TranslateGemma 4B.
 *
 * Official model cards & benchmarks evaluate 55 core languages for high-fidelity translation
 * (WMT24++ benchmark and Gemma 3 translation fine-tune).
 */

export type TranslateGemmaLanguage = {
  code: string;       // e.g. 'en', 'vi', 'zh-Hans', 'pt-BR'
  name: string;       // English language name used in prompt, e.g. 'English', 'Vietnamese'
  label: string;      // Human-readable label for UI display
};

export const TRANSLATEGEMMA_LANGUAGES: TranslateGemmaLanguage[] = [
  { code: 'ar', name: 'Arabic', label: 'Arabic' },
  { code: 'bg', name: 'Bulgarian', label: 'Bulgarian' },
  { code: 'bn', name: 'Bengali', label: 'Bengali' },
  { code: 'ca', name: 'Catalan', label: 'Catalan' },
  { code: 'cs', name: 'Czech', label: 'Czech' },
  { code: 'da', name: 'Danish', label: 'Danish' },
  { code: 'de', name: 'German', label: 'German' },
  { code: 'el', name: 'Greek', label: 'Greek' },
  { code: 'en', name: 'English', label: 'English' },
  { code: 'es', name: 'Spanish', label: 'Spanish' },
  { code: 'et', name: 'Estonian', label: 'Estonian' },
  { code: 'fa', name: 'Persian', label: 'Persian' },
  { code: 'fi', name: 'Finnish', label: 'Finnish' },
  { code: 'fil', name: 'Filipino', label: 'Filipino' },
  { code: 'fr', name: 'French', label: 'French' },
  { code: 'gu', name: 'Gujarati', label: 'Gujarati' },
  { code: 'he', name: 'Hebrew', label: 'Hebrew' },
  { code: 'hi', name: 'Hindi', label: 'Hindi' },
  { code: 'hr', name: 'Croatian', label: 'Croatian' },
  { code: 'hu', name: 'Hungarian', label: 'Hungarian' },
  { code: 'id', name: 'Indonesian', label: 'Indonesian' },
  { code: 'is', name: 'Icelandic', label: 'Icelandic' },
  { code: 'it', name: 'Italian', label: 'Italian' },
  { code: 'ja', name: 'Japanese', label: 'Japanese' },
  { code: 'kn', name: 'Kannada', label: 'Kannada' },
  { code: 'ko', name: 'Korean', label: 'Korean' },
  { code: 'lt', name: 'Lithuanian', label: 'Lithuanian' },
  { code: 'lv', name: 'Latvian', label: 'Latvian' },
  { code: 'ml', name: 'Malayalam', label: 'Malayalam' },
  { code: 'mr', name: 'Marathi', label: 'Marathi' },
  { code: 'nl', name: 'Dutch', label: 'Dutch' },
  { code: 'no', name: 'Norwegian', label: 'Norwegian' },
  { code: 'pa', name: 'Punjabi', label: 'Punjabi' },
  { code: 'pl', name: 'Polish', label: 'Polish' },
  { code: 'pt-BR', name: 'Portuguese', label: 'Portuguese (Brazil)' },
  { code: 'pt-PT', name: 'Portuguese', label: 'Portuguese (Portugal)' },
  { code: 'ro', name: 'Romanian', label: 'Romanian' },
  { code: 'ru', name: 'Russian', label: 'Russian' },
  { code: 'sk', name: 'Slovak', label: 'Slovak' },
  { code: 'sl', name: 'Slovenian', label: 'Slovenian' },
  { code: 'sr', name: 'Serbian', label: 'Serbian' },
  { code: 'sv', name: 'Swedish', label: 'Swedish' },
  { code: 'sw', name: 'Swahili', label: 'Swahili' },
  { code: 'ta', name: 'Tamil', label: 'Tamil' },
  { code: 'te', name: 'Telugu', label: 'Telugu' },
  { code: 'th', name: 'Thai', label: 'Thai' },
  { code: 'tr', name: 'Turkish', label: 'Turkish' },
  { code: 'uk', name: 'Ukrainian', label: 'Ukrainian' },
  { code: 'ur', name: 'Urdu', label: 'Urdu' },
  { code: 'vi', name: 'Vietnamese', label: 'Vietnamese' },
  { code: 'zh-Hans', name: 'Chinese', label: 'Chinese (Simplified)' },
  { code: 'zh-Hant', name: 'Chinese', label: 'Chinese (Traditional)' },
  { code: 'zu', name: 'Zulu', label: 'Zulu' },
];

const CODE_TO_LANG = new Map<string, TranslateGemmaLanguage>(
  TRANSLATEGEMMA_LANGUAGES.map((l) => [l.code.toLowerCase(), l]),
);

/**
 * Mapping table from BCP-47 / Google Live / Nemotron codes to TranslateGemma codes.
 */
const ALIAS_MAP: Record<string, string> = {
  // English
  'en-us': 'en',
  'en-gb': 'en',
  'en-in': 'en',
  'en': 'en',

  // Vietnamese
  'vi-vn': 'vi',
  'vi': 'vi',

  // Norwegian
  'nb-no': 'no',
  'nn-no': 'no',
  'no': 'no',

  // Chinese
  'cmn-hans-cn': 'zh-Hans',
  'zh-hans': 'zh-Hans',
  'zh-cn': 'zh-Hans',
  'zh': 'zh-Hans',
  'cmn-hant-tw': 'zh-Hant',
  'yue-hant-hk': 'zh-Hant',
  'zh-hant': 'zh-Hant',
  'zh-tw': 'zh-Hant',

  // Portuguese
  'pt-br': 'pt-BR',
  'pt-pt': 'pt-PT',
  'pt': 'pt-BR', // Default generic Portuguese to pt-BR

  // Spanish
  'es-us': 'es',
  'es-419': 'es',
  'es-es': 'es',
  'es': 'es',

  // French
  'fr-fr': 'fr',
  'fr-ca': 'fr',
  'fr': 'fr',

  // German
  'de-de': 'de',
  'de': 'de',

  // Japanese
  'ja-jp': 'ja',
  'ja': 'ja',

  // Korean
  'ko-kr': 'ko',
  'ko': 'ko',

  // Russian
  'ru-ru': 'ru',
  'ru': 'ru',

  // Italian
  'it-it': 'it',
  'it': 'it',

  // Filipino
  'fil-ph': 'fil',
  'fil': 'fil',

  // Ukrainian
  'uk-ua': 'uk',
  'uk': 'uk',

  // Turkish
  'tr-tr': 'tr',
  'tr': 'tr',

  // Hindi
  'hi-in': 'hi',
  'hi': 'hi',

  // Arabic
  'ar-eg': 'ar',
  'ar-ar': 'ar',
  'ar': 'ar',

  // Bulgarian
  'bg-bg': 'bg',
  'bg': 'bg',

  // Bengali
  'bn-bd': 'bn',
  'bn-in': 'bn',
  'bn': 'bn',

  // Catalan
  'ca-es': 'ca',
  'ca': 'ca',

  // Czech
  'cs-cz': 'cs',
  'cs': 'cs',

  // Danish
  'da-dk': 'da',
  'da': 'da',

  // Greek
  'el-gr': 'el',
  'el': 'el',

  // Estonian
  'et-ee': 'et',
  'et': 'et',

  // Persian
  'fa-ir': 'fa',
  'fa': 'fa',

  // Finnish
  'fi-fi': 'fi',
  'fi': 'fi',

  // Gujarati
  'gu-in': 'gu',
  'gu': 'gu',

  // Hebrew
  'he-il': 'he',
  'he': 'he',

  // Croatian
  'hr-hr': 'hr',
  'hr': 'hr',

  // Hungarian
  'hu-hu': 'hu',
  'hu': 'hu',

  // Indonesian
  'id-id': 'id',
  'id': 'id',

  // Icelandic
  'is-is': 'is',
  'is': 'is',

  // Kannada
  'kn-in': 'kn',
  'kn': 'kn',

  // Lithuanian
  'lt-lt': 'lt',
  'lt': 'lt',

  // Latvian
  'lv-lv': 'lv',
  'lv': 'lv',

  // Malayalam
  'ml-in': 'ml',
  'ml': 'ml',

  // Marathi
  'mr-in': 'mr',
  'mr': 'mr',

  // Dutch
  'nl-nl': 'nl',
  'nl': 'nl',

  // Punjabi
  'pa-in': 'pa',
  'pa-guru-in': 'pa',
  'pa': 'pa',

  // Polish
  'pl-pl': 'pl',
  'pl': 'pl',

  // Romanian
  'ro-ro': 'ro',
  'ro': 'ro',

  // Slovak
  'sk-sk': 'sk',
  'sk': 'sk',

  // Slovenian
  'sl-si': 'sl',
  'sl': 'sl',

  // Serbian
  'sr-rs': 'sr',
  'sr': 'sr',

  // Swedish
  'sv-se': 'sv',
  'sv': 'sv',

  // Swahili
  'sw-ke': 'sw',
  'sw': 'sw',

  // Tamil
  'ta-in': 'ta',
  'ta': 'ta',

  // Telugu
  'te-in': 'te',
  'te': 'te',

  // Thai
  'th-th': 'th',
  'th': 'th',

  // Urdu
  'ur': 'ur',

  // Zulu
  'zu': 'zu',
};

/**
 * Normalizes any app or BCP-47 language code to the canonical TranslateGemma code,
 * or returns null if not supported.
 */
export function toTranslateGemmaCode(realtimeCcCode: string | null | undefined): string | null {
  if (!realtimeCcCode || typeof realtimeCcCode !== 'string') return null;
  const normalized = realtimeCcCode.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'same') return null;

  const direct = ALIAS_MAP[normalized];
  if (direct) return direct;

  const exact = CODE_TO_LANG.get(normalized);
  if (exact) return exact.code;

  return null;
}

/**
 * Returns the TranslateGemmaLanguage metadata for a code, or null if unsupported.
 */
export function getTranslateGemmaLanguage(code: string | null | undefined): TranslateGemmaLanguage | null {
  const canonical = toTranslateGemmaCode(code);
  if (!canonical) return null;
  return CODE_TO_LANG.get(canonical.toLowerCase()) ?? null;
}

/**
 * Checks whether the given source and target languages form a valid translation pair.
 */
export function isSupportedPair(src: string | null | undefined, tgt: string | null | undefined): boolean {
  const srcCode = toTranslateGemmaCode(src);
  const tgtCode = toTranslateGemmaCode(tgt);
  if (!srcCode || !tgtCode) return false;
  return srcCode !== tgtCode;
}
