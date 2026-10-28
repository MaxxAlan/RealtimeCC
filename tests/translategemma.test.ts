import { describe, expect, it } from 'vitest';
import {
  toTranslateGemmaCode,
  getTranslateGemmaLanguage,
  isSupportedPair,
  TRANSLATEGEMMA_LANGUAGES,
} from '../src/main/preroll/translategemma-languages';
import {
  buildPrompt,
  cleanOutput,
} from '../src/main/preroll/translategemma-prompt';

describe('TranslateGemma Language Mapping', () => {
  it('maps standard RealtimeCC codes to canonical TranslateGemma codes', () => {
    expect(toTranslateGemmaCode('en-US')).toBe('en');
    expect(toTranslateGemmaCode('vi-VN')).toBe('vi');
    expect(toTranslateGemmaCode('nb-NO')).toBe('no');
    expect(toTranslateGemmaCode('cmn-Hans-CN')).toBe('zh-Hans');
    expect(toTranslateGemmaCode('pt-BR')).toBe('pt-BR');
  });

  it('returns null for unsupported or auto codes', () => {
    expect(toTranslateGemmaCode('auto')).toBeNull();
    expect(toTranslateGemmaCode('same')).toBeNull();
    expect(toTranslateGemmaCode('klingon')).toBeNull();
    expect(toTranslateGemmaCode(null as any)).toBeNull();
    expect(toTranslateGemmaCode('')).toBeNull();
  });

  it('resolves metadata for required core languages vi, ja, fr, en', () => {
    for (const code of ['vi', 'ja', 'fr', 'en']) {
      const meta = getTranslateGemmaLanguage(code);
      expect(meta).not.toBeNull();
      expect(meta?.code).toBe(code);
    }
  });

  it('validates supported translation pairs', () => {
    expect(isSupportedPair('en-US', 'vi-VN')).toBe(true);
    expect(isSupportedPair('en', 'ja')).toBe(true);
    expect(isSupportedPair('en-US', 'en-GB')).toBe(false); // same underlying code 'en'
    expect(isSupportedPair('en', 'unknown')).toBe(false);
  });
});

describe('TranslateGemma Prompt Construction', () => {
  it('matches golden prompt byte-for-byte with exact turn markers and two blank lines', () => {
    const prompt = buildPrompt({
      src: 'en',
      tgt: 'vi',
      text: 'Good morning, how are you today?',
    });

    const expected =
      '<bos><start_of_turn>user\n' +
      'You are a professional English (en) to Vietnamese (vi) translator. Your goal is to accurately convey the meaning and nuances of the original English text while adhering to Vietnamese grammar, vocabulary, and cultural sensitivities.\n' +
      'Produce only the Vietnamese translation, without any additional explanations or commentary. Please translate the following English text into Vietnamese:\n' +
      '\n' +
      '\n' +
      'Good morning, how are you today?<end_of_turn>\n' +
      '<start_of_turn>model\n';

    expect(prompt).toBe(expected);
  });

  it('throws on unsupported source or target languages', () => {
    expect(() =>
      buildPrompt({ src: 'xyz', tgt: 'vi', text: 'Hello' }),
    ).toThrow(/Unsupported source language/);
    expect(() =>
      buildPrompt({ src: 'en', tgt: 'xyz', text: 'Hello' }),
    ).toThrow(/Unsupported target language/);
  });
});

describe('cleanOutput Sanitization', () => {
  const src = 'Hello world';

  it('cleans normal translation cleanly', () => {
    const res = cleanOutput(' Xin chào thế giới ', src);
    expect(res).toEqual({ ok: true, text: 'Xin chào thế giới' });
  });

  it('strips turn markers and model tokens', () => {
    const raw = '<bos><start_of_turn>model\nXin chào thế giới<end_of_turn><eos>';
    const res = cleanOutput(raw, src);
    expect(res).toEqual({ ok: true, text: 'Xin chào thế giới' });
  });

  it('strips markdown code blocks', () => {
    const raw = '```markdown\nXin chào thế giới\n```';
    const res = cleanOutput(raw, src);
    expect(res).toEqual({ ok: true, text: 'Xin chào thế giới' });
  });

  it('strips wrapping quotes when source was unquoted', () => {
    const raw = '"Xin chào thế giới"';
    const res = cleanOutput(raw, src);
    expect(res).toEqual({ ok: true, text: 'Xin chào thế giới' });
  });

  it('strips chatter and preambles', () => {
    const raw = 'Here is the translation: Xin chào thế giới';
    const res = cleanOutput(raw, src);
    expect(res).toEqual({ ok: true, text: 'Xin chào thế giới' });
  });

  it('detects empty output and returns fallback', () => {
    const res = cleanOutput('', src);
    expect(res.ok).toBe(false);
    expect(res.text).toBe(src);
    expect(res.reason).toBe('empty_output');
  });

  it('detects runaway repetition and returns fallback', () => {
    const raw = 'thế giới thế giới thế giới thế giới thế giới thế giới';
    const res = cleanOutput(raw, src);
    expect(res.ok).toBe(false);
    expect(res.text).toBe(src);
    expect(res.reason).toBe('runaway_repetition');
  });

  it('detects absurd length ratio and returns fallback', () => {
    const raw = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' '); // excessively long compared to "Hello world"
    const res = cleanOutput(raw, src);
    expect(res.ok).toBe(false);
    expect(res.text).toBe(src);
    expect(res.reason).toBe('length_ratio_too_large');
  });
});
