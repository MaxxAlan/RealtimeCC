export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new RangeError('Percentile must be between 0 and 1.');
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]);
}
