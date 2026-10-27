import { describe, expect, it } from 'vitest';
import { percentile } from '../src/main/metrics';
import { translationLanguages } from '../src/main/languages';

describe('latency percentile reporting', () => {
  it('uses nearest-rank percentiles without mutating samples', () => {
    const samples = [500, 100, 300, 200, 400];
    expect(percentile(samples, 0.5)).toBe(300);
    expect(percentile(samples, 0.95)).toBe(500);
    expect(percentile(samples, 0.99)).toBe(500);
    expect(samples).toEqual([500, 100, 300, 200, 400]);
  });
  it('returns null when no visible-caption samples were recorded', () => {
    expect(percentile([], 0.95)).toBeNull();
  });
  it('rejects invalid percentile requests', () => {
    expect(() => percentile([1], 1.1)).toThrow(RangeError);
  });
});

describe('caption translation languages', () => {
  it('offers distinct selectable French, Japanese, and Vietnamese output languages', () => {
    expect(translationLanguages.some((language) => language.code === 'fr' && language.label === 'French')).toBe(true);
    expect(translationLanguages.some((language) => language.code === 'ja' && language.label === 'Japanese')).toBe(true);
    expect(translationLanguages.some((language) => language.code === 'vi' && language.label === 'Vietnamese')).toBe(true);
    expect(new Set(translationLanguages.map((language) => language.code)).size).toBe(translationLanguages.length);
  });
});
