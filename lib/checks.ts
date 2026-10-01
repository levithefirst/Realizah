export type Criteria = {
  wordCap: number;
  bannedPhrases: string[];
};

export const DEFAULT_CRITERIA: Criteria = {
  wordCap: 80,
  bannedPhrases: ["as an AI"],
};

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export type CheckResult = {
  passed: boolean;
  wordCount: number;
  reasons: string[];
};

export function runChecks(output: string, c: Criteria): CheckResult {
  const reasons: string[] = [];
  const wordCount = countWords(output);
  if (wordCount === 0) reasons.push("empty output");
  if (wordCount > c.wordCap) reasons.push(`${wordCount} words, over the ${c.wordCap}-word cap`);
  const lower = output.toLowerCase();
  for (const p of c.bannedPhrases) {
    if (p && lower.includes(p.toLowerCase())) reasons.push(`contains "${p}"`);
  }
  return { passed: reasons.length === 0, wordCount, reasons };
}

export function normalizeCriteria(input: unknown): Criteria {
  const o = (input ?? {}) as Record<string, unknown>;
  let wordCap = Math.round(Number(o.wordCap));
  if (!Number.isFinite(wordCap)) wordCap = DEFAULT_CRITERIA.wordCap;
  wordCap = Math.min(300, Math.max(10, wordCap));
  let banned = DEFAULT_CRITERIA.bannedPhrases;
  if (Array.isArray(o.bannedPhrases)) {
    banned = o.bannedPhrases
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 5);
  }
  // "as an AI" is a fixed check and cannot be removed.
  if (!banned.some((b) => b.toLowerCase() === "as an ai")) banned = ["as an AI", ...banned];
  return { wordCap, bannedPhrases: banned };
}
