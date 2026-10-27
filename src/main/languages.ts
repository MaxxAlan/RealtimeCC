export type CaptionLanguage = { code: string; label: string };
export const translationLanguages: CaptionLanguage[] = [
  { code: 'af', label: 'Afrikaans' }, { code: 'ak', label: 'Akan' }, { code: 'sq', label: 'Albanian' }, { code: 'am', label: 'Amharic' },
  { code: 'ar', label: 'Arabic' }, { code: 'hy', label: 'Armenian' }, { code: 'az', label: 'Azerbaijani' }, { code: 'eu', label: 'Basque' },
  { code: 'be', label: 'Belarusian' }, { code: 'bn', label: 'Bengali' }, { code: 'bg', label: 'Bulgarian' }, { code: 'my', label: 'Burmese' },
  { code: 'ca', label: 'Catalan' }, { code: 'ceb', label: 'Cebuano' }, { code: 'zh-Hans', label: 'Chinese (Simplified)' }, { code: 'zh-Hant', label: 'Chinese (Traditional)' },
  { code: 'km', label: 'Khmer' }, { code: 'rw', label: 'Kinyarwanda' }, { code: 'hr', label: 'Croatian' }, { code: 'cs', label: 'Czech' }, { code: 'da', label: 'Danish' },
  { code: 'nl', label: 'Dutch' }, { code: 'en', label: 'English' }, { code: 'et', label: 'Estonian' }, { code: 'fa', label: 'Persian' },
  { code: 'fil', label: 'Filipino' }, { code: 'fi', label: 'Finnish' }, { code: 'fr', label: 'French' }, { code: 'gl', label: 'Galician' },
  { code: 'ka', label: 'Georgian' }, { code: 'de', label: 'German' }, { code: 'el', label: 'Greek' }, { code: 'gu', label: 'Gujarati' },
  { code: 'ha', label: 'Hausa' }, { code: 'he', label: 'Hebrew' }, { code: 'hi', label: 'Hindi' }, { code: 'hu', label: 'Hungarian' },
  { code: 'is', label: 'Icelandic' }, { code: 'id', label: 'Indonesian' }, { code: 'it', label: 'Italian' }, { code: 'ja', label: 'Japanese' },
  { code: 'jv', label: 'Javanese' }, { code: 'kn', label: 'Kannada' }, { code: 'kk', label: 'Kazakh' }, { code: 'ko', label: 'Korean' },
  { code: 'lo', label: 'Lao' }, { code: 'lv', label: 'Latvian' }, { code: 'lt', label: 'Lithuanian' }, { code: 'mk', label: 'Macedonian' },
  { code: 'ms', label: 'Malay' }, { code: 'ml', label: 'Malayalam' }, { code: 'mt', label: 'Maltese' }, { code: 'mi', label: 'Maori' }, { code: 'mr', label: 'Marathi' }, { code: 'mn', label: 'Mongolian' },
  { code: 'ne', label: 'Nepali' }, { code: 'no', label: 'Norwegian' }, { code: 'or', label: 'Odia' }, { code: 'om', label: 'Oromo' }, { code: 'ps', label: 'Pashto' }, { code: 'pa', label: 'Punjabi' },
  { code: 'pl', label: 'Polish' }, { code: 'pt-BR', label: 'Portuguese (Brazil)' }, { code: 'pt-PT', label: 'Portuguese (Portugal)' }, { code: 'ro', label: 'Romanian' },
  { code: 'ru', label: 'Russian' }, { code: 'sr', label: 'Serbian' }, { code: 'sd', label: 'Sindhi' }, { code: 'si', label: 'Sinhala' },
  { code: 'sk', label: 'Slovak' }, { code: 'sl', label: 'Slovenian' }, { code: 'es', label: 'Spanish' }, { code: 'su', label: 'Sundanese' }, { code: 'sw', label: 'Swahili' },
  { code: 'sv', label: 'Swedish' }, { code: 'ta', label: 'Tamil' }, { code: 'te', label: 'Telugu' }, { code: 'th', label: 'Thai' },
  { code: 'tr', label: 'Turkish' }, { code: 'uk', label: 'Ukrainian' }, { code: 'ur', label: 'Urdu' }, { code: 'uz', label: 'Uzbek' },
  { code: 'vi', label: 'Vietnamese' }, { code: 'zu', label: 'Zulu' },
];

// Gemini 3.5 Transcribe Live's published language list. Empty hint means
// automatic detection, including multilingual and code-switched speech.
export const liveLanguages: CaptionLanguage[] = [
  { code: 'af-ZA', label: 'Afrikaans' }, { code: 'am-ET', label: 'Amharic' },
  { code: 'ar-EG', label: 'Arabic (Egypt)' }, { code: 'hy-AM', label: 'Armenian' },
  { code: 'as-IN', label: 'Assamese' }, { code: 'az-AZ', label: 'Azerbaijani' },
  { code: 'be-BY', label: 'Belarusian' }, { code: 'bn-BD', label: 'Bengali (Bangladesh)' },
  { code: 'bn-IN', label: 'Bengali (India)' }, { code: 'bs-BA', label: 'Bosnian' },
  { code: 'bg-BG', label: 'Bulgarian' }, { code: 'rup-BG', label: 'Aromanian' },
  { code: 'my-MM', label: 'Burmese' }, { code: 'yue-Hant-HK', label: 'Cantonese (Traditional)' },
  { code: 'ca-ES', label: 'Catalan' }, { code: 'ceb', label: 'Cebuano' },
  { code: 'km-KH', label: 'Central Khmer' }, { code: 'hr-HR', label: 'Croatian' },
  { code: 'cs-CZ', label: 'Czech' }, { code: 'da-DK', label: 'Danish' },
  { code: 'nl-NL', label: 'Dutch' }, { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-IN', label: 'English (India)' }, { code: 'en-US', label: 'English (US)' },
  { code: 'et-EE', label: 'Estonian' }, { code: 'fa-IR', label: 'Persian' },
  { code: 'fil-PH', label: 'Filipino' }, { code: 'fi-FI', label: 'Finnish' },
  { code: 'fr-FR', label: 'French' }, { code: 'gl-ES', label: 'Galician' },
  { code: 'ka-GE', label: 'Georgian' }, { code: 'de-DE', label: 'German' },
  { code: 'el-GR', label: 'Greek' }, { code: 'gu-IN', label: 'Gujarati' },
  { code: 'ha-NG', label: 'Hausa' }, { code: 'he-IL', label: 'Hebrew' },
  { code: 'hi-IN', label: 'Hindi' }, { code: 'hu-HU', label: 'Hungarian' },
  { code: 'is-IS', label: 'Icelandic' }, { code: 'id-ID', label: 'Indonesian' },
  { code: 'it-IT', label: 'Italian' }, { code: 'ja-JP', label: 'Japanese' },
  { code: 'jv-ID', label: 'Javanese' }, { code: 'kea-CV', label: 'Kabuverdianu' },
  { code: 'kn-IN', label: 'Kannada' }, { code: 'kk-KZ', label: 'Kazakh' },
  { code: 'ko-KR', label: 'Korean' }, { code: 'ky-KG', label: 'Kyrgyz' },
  { code: 'lv-LV', label: 'Latvian' }, { code: 'ln-CD', label: 'Lingala' },
  { code: 'lt-LT', label: 'Lithuanian' }, { code: 'mk-MK', label: 'Macedonian' },
  { code: 'ms-MY', label: 'Malay' }, { code: 'ml-IN', label: 'Malayalam' },
  { code: 'mt-MT', label: 'Maltese' }, { code: 'cmn-Hans-CN', label: 'Mandarin Chinese' },
  { code: 'mr-IN', label: 'Marathi' }, { code: 'mn-MN', label: 'Mongolian' },
  { code: 'ne-NP', label: 'Nepali' }, { code: 'nb-NO', label: 'Norwegian' },
  { code: 'or-IN', label: 'Odia' }, { code: 'pl-PL', label: 'Polish' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)' }, { code: 'pt-PT', label: 'Portuguese (Portugal)' },
  { code: 'pa-IN', label: 'Punjabi' }, { code: 'pa-Guru-IN', label: 'Punjabi (Gurmukhi)' },
  { code: 'ro-RO', label: 'Romanian' }, { code: 'ru-RU', label: 'Russian' },
  { code: 'sr-RS', label: 'Serbian' }, { code: 'sd-Arab-IN', label: 'Sindhi (Arabic)' },
  { code: 'sk-SK', label: 'Slovak' }, { code: 'sl-SI', label: 'Slovenian' },
  { code: 'es-419', label: 'Spanish (Latin America)' }, { code: 'es-US', label: 'Spanish (US)' },
  { code: 'sw-KE', label: 'Swahili (Kenya)' }, { code: 'sv-SE', label: 'Swedish' },
  { code: 'tg-TJ', label: 'Tajik' }, { code: 'te-IN', label: 'Telugu' },
  { code: 'th-TH', label: 'Thai' }, { code: 'tr-TR', label: 'Turkish' },
  { code: 'uk-UA', label: 'Ukrainian' }, { code: 'uz-UZ', label: 'Uzbek' },
  { code: 'vi-VN', label: 'Vietnamese' },
];

// Ready and broad-coverage Nemotron locales. The other eight recognized
// locales require model adaptation and are intentionally excluded here.
export const localReadyLanguages = new Set([
  'en-US', 'en-GB', 'es-US', 'fr-FR', 'it-IT',
  'pt-BR', 'pt-PT', 'nl-NL', 'de-DE', 'tr-TR', 'ru-RU',
  'hi-IN', 'ja-JP', 'ko-KR', 'vi-VN', 'uk-UA', 'pl-PL', 'sv-SE',
  'cs-CZ', 'nb-NO', 'da-DK', 'bg-BG', 'fi-FI', 'hr-HR', 'sk-SK',
  'hu-HU', 'ro-RO', 'et-EE',
]);

export function isLiveLanguage(code: string): boolean {
  return code === 'auto' || liveLanguages.some((language) => language.code === code);
}

export function nemotronLanguage(code: string): string {
  const map: Record<string, string> = {
    'en-US': 'en', 'en-GB': 'en', 'es-US': 'es', 'es-ES': 'es', 'fr-FR': 'fr',
    'fr-CA': 'fr', 'it-IT': 'it', 'pt-BR': 'pt', 'pt-PT': 'pt', 'nl-NL': 'nl',
    'de-DE': 'de', 'tr-TR': 'tr', 'ru-RU': 'ru', 'ar-AR': 'ar', 'hi-IN': 'hi',
    'ja-JP': 'ja', 'ko-KR': 'ko', 'vi-VN': 'vi', 'uk-UA': 'uk', 'pl-PL': 'pl',
    'sv-SE': 'sv', 'cs-CZ': 'cs', 'nb-NO': 'no', 'da-DK': 'da', 'bg-BG': 'bg',
    'fi-FI': 'fi', 'hr-HR': 'hr', 'sk-SK': 'sk', 'zh-CN': 'zh', 'hu-HU': 'hu',
    'ro-RO': 'ro', 'et-EE': 'et',
  };
  return code === 'auto' ? 'auto' : map[code] ?? 'auto';
}
