// Deterministic extraction of explicit constraints from a task. Only what the
// task states is extracted; nothing is guessed.

export type WordCount = {
  min: number | null;
  max: number | null;
  // "under 10 words each": applies to each list item, not the whole reply.
  perItemMax?: number | null;
  // "a 1,000-word article": a target, checked within TARGET_TOLERANCE.
  target: number | null;
  phrase: string;
};

export const TARGET_TOLERANCE = 0.15;
const MAX_WORDS = 20_000;

const NUM = "(\\d{1,3}(?:,\\d{3})+|\\d{1,5})";
const toInt = (s: string) => Number(s.replace(/,/g, ""));
const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_WORDS;

function all(re: RegExp, s: string): RegExpMatchArray[] {
  return [...s.matchAll(re)];
}

// "each/every/per" + the item and its verb phrase (up to six words, one
// clause: no comma or conjunction can match here) right before a limit.
const PER_ITEM_LEAD = /\b(?:each|every|per)\s+((?:(?!(?:and|or|but|then|so|because|while)\b)[a-z0-9-]+\s+){0,6})$/i;
// Nouns that mean the whole reply rather than one item of it.
const WHOLE_REPLY = /\b(?:response|reply|answer|message|output|whole|entire|total|overall|altogether)\b/i;

export function extractWordCount(task: string): WordCount | null {
  const t = task.replace(/\s+/g, " ");
  let min: number | null = null;
  let max: number | null = null;
  let target: number | null = null;
  let perItemMax: number | null = null;
  let phrase = "";
  const note = (m: RegExpMatchArray) => (phrase = phrase || m[0].trim());
  const perItem = (m: RegExpMatchArray) => {
    const after = t.slice((m.index ?? 0) + m[0].length);
    if (/^\s*(?:each|apiece|per (?:item|line|bullet|point|tagline|headline|title|idea|option|sentence))\b/i.test(after)) return true;
    // "Each tip under 12 words", "Each tip must contain no more than 8 words",
    // "Every item should have fewer than 12 words", "Keep each tip to at most
    // 8 words": the item is named before the limit, in the same clause, and
    // only its verb phrase stands between them.
    const before = t.slice(0, m.index ?? 0).split(/[.!?;:]\s/).pop() ?? "";
    const lead = PER_ITEM_LEAD.exec(before);
    if (!lead) return false;
    // Not when the limit is about the whole reply: "each response must be
    // under 50 words", "...each chapter in no more than 200 words total".
    if (WHOLE_REPLY.test(lead[1]) || /^\s*(?:in\s+)?(?:total|overall|combined|altogether)\b/i.test(after)) return false;
    return true;
  };

  // Ranges: "between 150 and 200 words", "150-200 words", "150 to 200 words".
  for (const m of all(new RegExp(`\\b(?:between\\s+)?${NUM}\\s*(?:-|–|to|and)\\s*${NUM}\\s+words?\\b`, "gi"), t)) {
    const a = toInt(m[1]);
    const b = toInt(m[2]);
    if (ok(a) && ok(b) && a < b) {
      min = a;
      max = b;
      note(m);
    }
  }
  // Upper limits.
  const maxRes = [
    new RegExp(`\\b(?:under|below|less than|fewer than|no more than|not more than|not exceeding|at most|up to|max(?:imum)?(?: of)?|within|limit(?:ed)? (?:of|to)|keep (?:it|this|the \\w+) (?:to|under|below)|cap(?:ped)? at)\\s+${NUM}\\s+words?\\b`, "gi"),
    new RegExp(`\\b${NUM}\\s+words?\\s+(?:or (?:less|fewer)|max(?:imum)?|tops|at most|or under)\\b`, "gi"),
    new RegExp(`\\bword (?:limit|count|cap)(?: of| is|:)?\\s+${NUM}\\b`, "gi"),
    new RegExp(`\\b${NUM}[- ]word (?:limit|max(?:imum)?|cap)\\b`, "gi"),
  ];
  for (const re of maxRes) {
    for (const m of all(re, t)) {
      const n = toInt(m[1]);
      if (!ok(n)) continue;
      if (perItem(m)) {
        perItemMax = perItemMax === null ? n : Math.max(perItemMax, n);
        note(m);
      } else if (max === null || n > max) {
        max = n;
        note(m);
      }
    }
  }
  // Lower limits.
  // "no more than 8 words" / "not over 8 words" are upper limits, not minimums.
  for (const m of all(new RegExp(`\\b(?:at least|minimum(?: of)?|no (?:less|fewer) than|(?<!\\b(?:no|not)\\s)more than|(?<!\\b(?:no|not)\\s)over)\\s+${NUM}\\s+words?\\b`, "gi"), t)) {
    const n = toInt(m[1]);
    if (ok(n)) {
      min = Math.max(min ?? 0, /more than|over/i.test(m[0]) ? n + 1 : n);
      note(m);
    }
  }
  // Targets: "a 1,000-word article", "write 500 words", "in 60 words".
  // Not when the only number is a per-item limit already taken.
  if (min === null && max === null && perItemMax === null) {
    const targetRes = [
      new RegExp(`\\b${NUM}[- ]words?\\b(?!\\s+(?:or|limit|max|cap|tops))`, "gi"),
      new RegExp(`\\b(?:write|draft|produce|give me|in|about|around|roughly|approximately|~)\\s+${NUM}\\s+words?\\b`, "gi"),
    ];
    for (const re of targetRes) {
      for (const m of all(re, t)) {
        if (perItem(m)) continue;
        const before = t.slice(0, m.index);
        if (/\b(?:the|these|those|top)\s+$/i.test(before)) continue; // "the 100 words every child should know"
        const n = toInt(m[1]);
        if (ok(n) && target === null) {
          target = n;
          note(m);
        }
      }
    }
    // "in 60 words" reads as a limit in practice.
    if (target !== null && /^in\s/i.test(phrase)) {
      max = target;
      target = null;
    }
  }
  if (min === null && max === null && target === null && perItemMax === null) return null;
  return { min, max, target, perItemMax, phrase };
}

export type OutputFormat = "json" | "markdown_table" | "bullet_list" | "numbered_list" | "code" | "csv" | null;

export function extractOutputFormat(text: string): OutputFormat {
  const t = text.toLowerCase();
  if (/\bjson\b/.test(t)) return "json";
  if (/\bcsv\b/.test(t)) return "csv";
  if (/\b(markdown )?table\b/.test(t)) return "markdown_table";
  if (/\bnumbered (list|steps)\b/.test(t)) return "numbered_list";
  if (/\b(bullet(ed)?( point)?s?|bullet list)\b/.test(t)) return "bullet_list";
  return null;
}

const CODE_LANGUAGES: [string, RegExp][] = [
  ["typescript", /\b(typescript|\.tsx?\b|ts function)\b/i],
  ["javascript", /\b(javascript|node\.?js|\.jsx?\b)\b/i],
  ["python", /\bpython\b|\.py\b/i],
  ["go", /\b(golang|go function|in go)\b/i],
  ["rust", /\brust\b/i],
  ["java", /\bjava\b(?!script)/i],
  ["csharp", /\b(c#|csharp|\.net)\b/i],
  ["cpp", /\b(c\+\+|cpp)\b/i],
  ["php", /\bphp\b/i],
  ["ruby", /\bruby\b/i],
  ["swift", /\bswift\b/i],
  ["kotlin", /\bkotlin\b/i],
  ["sql", /\b(sql|postgres|mysql|sqlite)\b/i],
  ["bash", /\b(bash|shell script)\b/i],
  ["html", /\bhtml\b/i],
  ["css", /\bcss\b/i],
];

const FRAMEWORKS: [string, RegExp][] = [
  ["react", /\breact\b/i],
  ["next.js", /\bnext\.?js\b/i],
  ["vue", /\bvue\b/i],
  ["svelte", /\bsvelte\b/i],
  ["angular", /\bangular\b/i],
  ["express", /\bexpress(\.js)?\b/i],
  ["django", /\bdjango\b/i],
  ["flask", /\bflask\b/i],
  ["fastapi", /\bfastapi\b/i],
  ["rails", /\brails\b/i],
  ["spring", /\bspring( boot)?\b/i],
  ["tailwind", /\btailwind\b/i],
];

export function extractCodeLanguage(text: string): string | null {
  for (const [lang, re] of CODE_LANGUAGES) if (re.test(text)) return lang;
  return null;
}

export function extractFramework(text: string): string | null {
  for (const [fw, re] of FRAMEWORKS) if (re.test(text)) return fw;
  return null;
}

const LANGUAGES = [
  "english", "spanish", "french", "german", "portuguese", "italian", "dutch", "polish", "russian", "turkish",
  "arabic", "hindi", "bengali", "urdu", "japanese", "chinese", "mandarin", "korean", "vietnamese", "indonesian",
  "swahili", "yoruba", "igbo", "hausa", "amharic", "greek", "hebrew", "thai", "ukrainian", "swedish",
];
export function extractLanguage(text: string): string | null {
  const m = text.toLowerCase().match(new RegExp(`\\b(?:in|into|to)\\s+(${LANGUAGES.join("|")})\\b`));
  return m ? m[1] : null;
}

export function extractCitationsRequired(text: string): boolean {
  return /\b(cite|citations?|with sources|include sources|list (?:your |the )?sources|references|bibliography|with links)\b/i.test(text);
}

function splitList(s: string): string[] {
  return s
    .split(/,|;|\band\b|\//)
    .map((x) => x.replace(/["“”'`*]/g, "").trim())
    .filter((x) => x.length > 0 && x.length <= 60);
}

export function extractRequiredSections(text: string): string[] {
  const m = text.match(/\b(?:sections?|headings?|headers?)\s*(?:called|named|for|titled|:)\s*([^.\n]+)/i)
    ?? text.match(/\bwith (?:the )?(?:sections?|headings?)\s+([^.\n]+)/i);
  return m ? splitList(m[1]).slice(0, 12) : [];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const COUNT = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})`;
const LIST_NOUNS =
  "bullet points|bullets|items|tips|ideas|steps|reasons|examples|questions|options|names|titles|headlines|taglines|points|variations|versions|facts|ways|suggestions|benefits|mistakes|rules|lessons|strategies";

export function extractListCount(text: string): number | null {
  // "5 tips", "exactly five short tips", "a list of 7", "list 3 benefits".
  const m =
    text.match(new RegExp(`\\b${COUNT}\\s+(?:[a-z-]+\\s+){0,2}?(?:${LIST_NOUNS})\\b`, "i")) ??
    text.match(new RegExp(`\\blist of ${COUNT}\\b`, "i"));
  if (!m) return null;
  let n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
  // "5-10 bullet points" / "3 to 5 ideas": the reply needs at least the lower bound.
  const range = /\b(\d{1,2})\s*(?:-|–|to)\s*$/.exec(text.slice(0, m.index));
  if (range && Number(range[1]) < n) n = Number(range[1]);
  return n >= 1 && n <= 50 ? n : null;
}

export function extractMustInclude(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:mention|include|use|contain)\s+(?:the\s+)?(?:(?:word|phrase|keyword|term)s?\s+)?["“']([^"”']{1,60})["”']/gi)) {
    out.push(m[1].trim());
  }
  return [...new Set(out)].slice(0, 10);
}

// Words after which a field list has ended and the sentence goes on:
// "fields name, age, and city for a person who is 29 and lives in Lagos".
const LIST_ENDS = /\s+(?:for|from|about|that|which|who|whose|where|when|based|using|describing|representing|given|named|called|so|because|if)\b/i;
// Words that end one field name without ending the list ("price in USD").
const ITEM_ENDS = /\s+(?:in|with|to|on|as)\b/i;

export function extractRequiredFields(text: string): string[] {
  const m = text.match(/\b(?:fields?|keys?|properties|columns)\s*(?::|named|called|for|like|such as|including)?\s*([^.\n:]+)/i);
  if (!m) return [];
  const fields: string[] = [];
  for (const raw of splitList(m[1])) {
    const end = LIST_ENDS.exec(raw);
    const item = (end ? raw.slice(0, end.index) : raw).split(ITEM_ENDS)[0].trim();
    if (item) fields.push(item.replace(/\s+/g, "_"));
    if (end) break; // the rest of the sentence is not field names
  }
  return fields.filter((f) => /^[A-Za-z_][\w.-]{0,40}$/.test(f)).slice(0, 20);
}

export function extractWantsTests(text: string): boolean {
  return /\b(?:unit tests?|tests? cases?|with tests|and tests|write tests|jest|vitest|pytest|mocha|test suite)\b/i.test(text);
}

export function estimateTokens(text: string): number {
  // Conservative: ~3.5 characters per token for English; never below 1.
  return Math.max(1, Math.ceil(text.length / 3.5));
}
