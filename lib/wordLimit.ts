// Optional user override for the reply's maximum word count. Detection of
// limits stated in the task lives in task/constraints.ts.
export const MIN_WORD_CAP = 1;
export const MAX_WORD_CAP = 20_000;

// Any whole number in range is kept exactly: 8, 50, 100, 137, 500.
export function parseWordCap(input: string | number): number | null {
  const s = String(input).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN_WORD_CAP && n <= MAX_WORD_CAP ? n : null;
}
