// Word-limit handling for the success check. Pure, shared by the form and
// the API so both read a task the same way.

export const DEFAULT_WORD_CAP = 80;
export const MIN_WORD_CAP = 1;
export const MAX_WORD_CAP = 10_000;

const NUM = "(\\d{1,5}(?:,\\d{3})?)";
const WORDS = "words?";

// Phrases that set an upper limit. "at least 100 words" is a minimum and is
// deliberately not matched.
const LIMIT_PATTERNS: RegExp[] = [
  // under / below / less than / fewer than / no more than / not more than /
  // at most / up to / max / maximum (of) / within / keep it to / limit (of) N words
  new RegExp(
    `\\b(?:under|below|less than|fewer than|no more than|not more than|not exceeding|at most|up to|max(?:imum)?(?: of)?|within|limit(?:ed)? (?:of|to)|keep (?:it|this|the \\w+) (?:to|under|below)|cap(?:ped)? at)\\s+${NUM}\\s+${WORDS}\\b`,
    "gi"
  ),
  // N words or less / or fewer / max / maximum / tops / at most
  new RegExp(`\\b${NUM}\\s+${WORDS}\\s+(?:or (?:less|fewer)|max(?:imum)?|tops|at most|or under)\\b`, "gi"),
  // in N words (or less) / in under N words
  new RegExp(`\\bin\\s+${NUM}\\s+${WORDS}\\b`, "gi"),
  // a 100-word email / 100 word limit / word limit: 100
  new RegExp(`\\b${NUM}[- ]word\\b(?!s)`, "gi"),
  new RegExp(`\\bword (?:limit|count|cap)(?: of| is|:)?\\s+${NUM}\\b`, "gi"),
  // 150-200 words / 150 to 200 words / between 150 and 200 words: the upper bound
  new RegExp(`\\b\\d{1,5}\\s*(?:-|to|and)\\s*${NUM}\\s+${WORDS}\\b`, "gi"),
];

const MINIMUM_BEFORE = /\b(?:at least|minimum(?: of)?|min|more than|over|no less than|no fewer than)\s+$/i;

function toInt(s: string): number {
  return Number(s.replace(/,/g, ""));
}

// The explicit word limit a task asks for, or null when it states none.
// Several limits (e.g. a subject line and a body): the largest wins, because
// the check runs on the whole reply.
export function detectWordLimit(task: string): number | null {
  const found: number[] = [];
  for (const re of LIMIT_PATTERNS) {
    re.lastIndex = 0;
    for (const m of task.matchAll(re)) {
      const before = task.slice(0, m.index);
      if (MINIMUM_BEFORE.test(before)) continue;
      const n = toInt(m[1]);
      if (Number.isInteger(n) && n >= MIN_WORD_CAP && n <= MAX_WORD_CAP) found.push(n);
    }
  }
  return found.length ? Math.max(...found) : null;
}

// Strict parse of what the user typed. Any whole number in range is kept as
// is: 8, 50, 80, 100, 137, 500 all stay themselves.
export function parseWordCap(input: string | number): number | null {
  const s = String(input).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN_WORD_CAP && n <= MAX_WORD_CAP ? n : null;
}

export type WordCapState = {
  cap: number | null;
  source: "user" | "task" | "default";
  detected: number | null;
  error: string | null;
};

// touched: the user has edited the field, so their value wins over the task.
export function resolveWordCap(opts: { input: string; touched: boolean; task: string }): WordCapState {
  const detected = detectWordLimit(opts.task);
  if (opts.touched) {
    const cap = parseWordCap(opts.input);
    return {
      cap,
      source: "user",
      detected,
      error: cap === null ? `Enter a whole number of words from ${MIN_WORD_CAP} to ${MAX_WORD_CAP}.` : null,
    };
  }
  if (detected !== null) return { cap: detected, source: "task", detected, error: null };
  return { cap: DEFAULT_WORD_CAP, source: "default", detected: null, error: null };
}
