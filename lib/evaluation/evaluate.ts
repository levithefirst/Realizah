// Task-aware pass/fail. Deterministic checks only; anything Realizah cannot
// verify is reported as "not checked" and does not affect the result.
// A reply passes when every applicable, checkable rule passes.
import ts from "typescript";
import { TARGET_TOLERANCE } from "../task/constraints";
import type { TaskUnderstanding } from "../task/understand";
import { arithmeticAnswer, numbersIn, replyHasValue } from "./arithmetic";
import { RULES, type RuleKey } from "./rules";

export type CheckStatus = "pass" | "fail" | "not_checked";
export type Check = { rule: string; label: string; status: CheckStatus; detail: string };
export type Evaluation = { passed: boolean; checks: Check[]; wordCount: number };

const REFUSAL = [
  /\bas an ai\b/i,
  /\bI(?:'m| am) (?:sorry|unable),? (?:but )?I (?:can(?:no|')t|cannot|am unable to) (?:help|assist|comply|do that|provide)/i,
  /\bI can(?:no|')t (?:help|assist) with (?:that|this)\b/i,
  /\bI(?:'m| am) not able to (?:help|assist|provide)\b/i,
];

// Words as a reader counts them: Markdown markers, code fences and URLs
// do not count as words.
export function countWords(text: string): number {
  const stripped = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*_`|~\-]+/g, " ")
    .trim();
  return stripped ? stripped.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text.trim()];
  const firstBrace = text.search(/[[{]/);
  if (firstBrace >= 0) {
    const open = text[firstBrace];
    const close = open === "{" ? "}" : "]";
    const last = text.lastIndexOf(close);
    if (last > firstBrace) candidates.push(text.slice(firstBrace, last + 1));
  }
  let lastErr = "no JSON found";
  for (const c of candidates) {
    if (!c) continue;
    try {
      return { ok: true, value: JSON.parse(c.trim()) };
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  return { ok: false, error: lastErr };
}

function hasKey(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.length > 0 && v.every((x) => hasKey(x, key));
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object).map((k) => k.toLowerCase());
    if (keys.includes(key.toLowerCase())) return true;
    // One level of wrapping, e.g. {"result": {...}} or {"items": [...]}.
    return Object.values(v as object).some((x) => x && typeof x === "object" && !Array.isArray(x) ? Object.keys(x).map((k) => k.toLowerCase()).includes(key.toLowerCase()) : Array.isArray(x) && hasKey(x, key));
  }
  return false;
}

function codeBlocks(text: string): { lang: string; code: string }[] {
  return [...text.matchAll(/```([\w#+.-]*)\s*\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1].toLowerCase(), code: m[2] }));
}

const LANG_ALIASES: Record<string, string[]> = {
  typescript: ["ts", "typescript", "tsx"],
  javascript: ["js", "javascript", "jsx", "node", "mjs"],
  python: ["py", "python", "python3"],
  go: ["go", "golang"],
  rust: ["rs", "rust"],
  java: ["java"],
  csharp: ["cs", "csharp", "c#"],
  cpp: ["cpp", "c++", "cc", "cxx"],
  php: ["php"],
  ruby: ["rb", "ruby"],
  swift: ["swift"],
  kotlin: ["kt", "kotlin"],
  sql: ["sql", "postgresql", "mysql", "sqlite"],
  bash: ["bash", "sh", "shell", "zsh"],
  html: ["html"],
  css: ["css"],
};

function syntaxErrors(lang: string, code: string): string[] | null {
  if (lang === "json") {
    try {
      JSON.parse(code);
      return [];
    } catch (e) {
      return [(e as Error).message];
    }
  }
  const isTs = LANG_ALIASES.typescript.includes(lang);
  const isJs = LANG_ALIASES.javascript.includes(lang);
  if (!isTs && !isJs) return null;
  const out = ts.transpileModule(code, {
    reportDiagnostics: true,
    fileName: isTs ? (lang === "tsx" ? "a.tsx" : "a.ts") : lang === "jsx" ? "a.jsx" : "a.js",
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, allowJs: true },
  });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

function listItems(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(?:[-*•]|\d{1,2}[.)])\s+\S/.test(l))
    .map((l) => l.replace(/^(?:[-*•]|\d{1,2}[.)])\s+/, ""));
}

// Extracted values must come from the source. Numbers, phone numbers, emails
// and links are compared exactly (digits only for numbers); invented ones
// fail. Text values are compared verbatim; a rephrased value is legitimate,
// so it is reported as not checked rather than failed.
const DIGITS = /\+?\d[\d\s().-]{1,}\d|\d{3,}/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL = /https?:\/\/[^\s)"'<>]+/g;

function extractedValues(reply: string): string[] {
  const parsed = extractJson(reply);
  const values: string[] = [];
  if (parsed.ok && parsed.value && typeof parsed.value === "object") {
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
      else if (typeof v === "string" || typeof v === "number") values.push(String(v));
    };
    walk(parsed.value);
    return values;
  }
  for (const line of reply.replace(/```[\w-]*\n?|```/g, "").split("\n")) {
    const l = line.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, "").trim();
    if (!l) continue;
    const kv = /^\**[^:|]{1,40}?\**\s*:\s*(.+)$/.exec(l);
    if (kv) values.push(kv[1]);
    else if (l.includes(",")) values.push(...l.split(",")); // CSV rows
    else values.push(l);
  }
  return values.map((v) => v.replace(/^\*+|\*+$/g, "").trim()).filter(Boolean);
}

function extractionChecks(reply: string, source: string): { rule: RuleKey; status: CheckStatus; detail: string }[] {
  const srcLower = source.toLowerCase().replace(/\s+/g, " ");
  const srcDigits = [...source.matchAll(DIGITS)].map((m) => m[0].replace(/\D/g, ""));
  const srcNumbers = numbersIn(source);
  // A number is known if its digits appear in a source number (phones keep
  // their digits whatever the spacing) or it equals one numerically (2.5 / 2.50).
  const numberKnown = (raw: string) => {
    const d = raw.replace(/\D/g, "");
    const n = Number(raw.replace(/[^\d.-]/g, ""));
    if (srcDigits.some((s) => s.includes(d)) || (Number.isFinite(n) && srcNumbers.includes(n))) return true;
    // Phone numbers reformatted with a country code or trunk prefix
    // ("0803 123 4567" -> "+234 803 123 4567"): same trailing digits.
    return d.length >= 8 && srcDigits.some((s) => {
      const k = Math.min(d.length, s.length, 10);
      return k >= 8 && d.slice(-k) === s.slice(-k);
    });
  };
  const hard = new Map<string, boolean>();
  for (const re of [EMAIL, URL]) for (const m of reply.matchAll(re)) hard.set(m[0].toLowerCase(), srcLower.includes(m[0].toLowerCase()));
  for (const m of reply.matchAll(DIGITS)) {
    const raw = m[0].trim();
    // Dates are often reformatted ("Oct 1, 2024" -> "2024-10-01"): not a hard check.
    if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(raw)) continue;
    hard.set(raw, numberKnown(raw));
  }
  const invented = [...hard].filter(([, known]) => !known).map(([v]) => v);
  const checks: { rule: RuleKey; status: CheckStatus; detail: string }[] = [];
  checks.push(
    hard.size === 0
      ? { rule: "extraction_values", status: "not_checked", detail: "No numbers, emails or links in the reply to verify." }
      : invented.length
        ? { rule: "extraction_values", status: "fail", detail: `Not in the source: ${invented.slice(0, 3).join(", ")}.` }
        : { rule: "extraction_values", status: "pass", detail: `${hard.size} value(s) found in the source.` }
  );
  const text = extractedValues(reply).filter((v) => /[A-Za-z]/.test(v) && !/https?:|@/.test(v));
  const unseen = text.filter((v) => !srcLower.includes(v.toLowerCase().replace(/\s+/g, " ").replace(/[.;]$/, "")));
  checks.push(
    text.length === 0
      ? { rule: "extraction_text", status: "not_checked", detail: "No text values to compare." }
      : unseen.length
        ? { rule: "extraction_text", status: "not_checked", detail: `${unseen.length} of ${text.length} text value(s) not found verbatim (may be rephrased).` }
        : { rule: "extraction_text", status: "pass", detail: `All ${text.length} text value(s) found in the source.` }
  );
  return checks;
}

// Rules whose details can quote the task or the model's reply (field names,
// phrases, invented values, parser messages with code or JSON snippets).
// Permanent records keep only a content-free version; the full wording is
// stored with the reply and deleted with it (see applyRetention).
const CONTENT_DETAIL_RULES = new Set<string>([
  RULES.json_fields.id,
  RULES.format_json.id,
  RULES.sections.id,
  RULES.must_include.id,
  RULES.code_syntax.id,
  RULES.math_answer.id,
  RULES.extraction_values.id,
  RULES.extraction_text.id,
]);

export function contentFreeChecks(checks: Check[]): Check[] {
  return checks.map((c) =>
    CONTENT_DETAIL_RULES.has(c.rule)
      ? { ...c, detail: c.status === "pass" ? "Passed." : c.status === "fail" ? "Failed." : "Not checked." }
      : c
  );
}

export function evaluate(
  text: string,
  finishReason: string | null,
  u: TaskUnderstanding,
  // wordMax: the user's explicit limit. source: the prompt the model was
  // given (the task), for correctness checks that compare against it.
  overrides: { wordMax?: number | null; source?: string } = {}
): Evaluation {
  const checks: Check[] = [];
  const add = (key: RuleKey, status: CheckStatus, detail: string) =>
    checks.push({ rule: RULES[key].id, label: RULES[key].description, status, detail });
  const c = u.constraints;
  const words = countWords(text);

  add("nonempty", text.trim() ? "pass" : "fail", text.trim() ? "Reply received." : "Empty reply.");
  add(
    "not_truncated",
    finishReason === "length" ? "fail" : "pass",
    finishReason === "length" ? "Cut off at the output token limit." : `Finished (${finishReason ?? "stop"}).`
  );
  const refusal = REFUSAL.find((re) => re.test(text));
  add("no_refusal", refusal ? "fail" : "pass", refusal ? "Refused or said it is an AI." : "No refusal.");

  const wc = c.wordCount;
  const max = overrides.wordMax ?? wc?.max ?? null;
  if (max !== null || wc?.min != null || wc?.target != null) {
    const problems: string[] = [];
    if (max !== null && words > max) problems.push(`${words} words, over the ${max}-word limit`);
    if (wc?.min != null && words < wc.min) problems.push(`${words} words, under the ${wc.min}-word minimum`);
    if (wc?.target != null && overrides.wordMax == null) {
      const lo = Math.floor(wc.target * (1 - TARGET_TOLERANCE));
      const hi = Math.ceil(wc.target * (1 + TARGET_TOLERANCE));
      if (words < lo || words > hi) problems.push(`${words} words, outside ${lo} to ${hi} for a ${wc.target}-word target`);
    }
    add("word_count", problems.length ? "fail" : "pass", problems.join("; ") || `${words} words.`);
  }

  const items = listItems(text);
  if (wc?.perItemMax) {
    const over = items.filter((i) => countWords(i) > wc.perItemMax!);
    add(
      "per_item_words",
      items.length === 0 ? "fail" : over.length ? "fail" : "pass",
      items.length === 0 ? "No list items found to check." : over.length ? `${over.length} item(s) over ${wc.perItemMax} words.` : `All ${items.length} items within ${wc.perItemMax} words.`
    );
  }
  if (c.listCount) {
    add("list_count", items.length >= c.listCount ? "pass" : "fail", `${items.length} of ${c.listCount} items.`);
  }

  if (c.outputFormat === "json") {
    const parsed = extractJson(text);
    add("format_json", parsed.ok ? "pass" : "fail", parsed.ok ? "Valid JSON." : `Invalid JSON: ${parsed.error}`);
    if (c.requiredFields.length) {
      const missing = parsed.ok ? c.requiredFields.filter((f) => !hasKey(parsed.value, f)) : c.requiredFields;
      add("json_fields", missing.length ? "fail" : "pass", missing.length ? `Missing: ${missing.join(", ")}.` : `All ${c.requiredFields.length} fields present.`);
    }
  } else if (c.outputFormat === "bullet_list" || c.outputFormat === "numbered_list") {
    const want = c.outputFormat === "numbered_list" ? /^\s*\d{1,2}[.)]\s+/m : /^\s*[-*•]\s+/m;
    add("format_list", want.test(text) ? "pass" : "fail", want.test(text) ? "List format used." : `No ${c.outputFormat.replace("_", " ")} found.`);
  } else if (c.outputFormat === "markdown_table") {
    const ok = /^\s*\|.+\|\s*$/m.test(text) && /^\s*\|?\s*:?-{3,}/m.test(text);
    add("format_table", ok ? "pass" : "fail", ok ? "Markdown table found." : "No Markdown table found.");
  } else if (c.outputFormat === "csv") {
    const rows = (codeBlocks(text)[0]?.code ?? text).split("\n").map((l) => l.trim()).filter((l) => l.includes(","));
    const cols = new Set(rows.map((r) => r.split(",").length));
    const ok = rows.length >= 2 && cols.size === 1;
    add("format_csv", ok ? "pass" : "fail", ok ? `${rows.length} rows.` : "No consistent comma-separated rows.");
  }

  if (u.primary === "coding") {
    const blocks = codeBlocks(text);
    const codeLike = blocks.length > 0 || /[{};]\s*$|^\s*(def|function|class|const|let|import|return)\b/m.test(text);
    add("code_present", codeLike ? "pass" : "fail", blocks.length ? `${blocks.length} code block(s).` : codeLike ? "Inline code." : "No code found.");
    if (c.codeLanguage && blocks.length) {
      const aliases = LANG_ALIASES[c.codeLanguage] ?? [c.codeLanguage];
      const tagged = blocks.filter((b) => b.lang);
      if (!tagged.length) add("code_language", "not_checked", "Code blocks are not tagged with a language.");
      else {
        const ok = tagged.some((b) => aliases.includes(b.lang));
        add("code_language", ok ? "pass" : "fail", ok ? `Tagged ${c.codeLanguage}.` : `Tagged ${tagged.map((b) => b.lang).join(", ")}, expected ${c.codeLanguage}.`);
      }
    }
    const checkable = blocks
      .map((b) => ({ b, errs: syntaxErrors(b.lang || (c.codeLanguage === "typescript" ? "ts" : c.codeLanguage === "javascript" ? "js" : ""), b.code) }))
      .filter((x) => x.errs !== null);
    if (checkable.length) {
      const bad = checkable.filter((x) => x.errs!.length);
      add("code_syntax", bad.length ? "fail" : "pass", bad.length ? `Syntax error: ${bad[0].errs![0]}` : `${checkable.length} block(s) parse.`);
    } else {
      add("code_syntax", "not_checked", "Syntax checks cover JavaScript, TypeScript and JSON only.");
    }
    add("code_tests", "not_checked", "Realizah does not execute code yet.");
  } else if (c.outputFormat === "json") {
    // handled above
  }

  if (c.citationsRequired) {
    const ok = /https?:\/\/\S+/.test(text) || /^\s*(?:sources|references|bibliography|citations)\s*:?\s*$/im.test(text) || /\[\d+\]/.test(text);
    add("citations", ok ? "pass" : "fail", ok ? "Sources cited." : "No links or references found.");
  }
  if (c.requiredSections.length) {
    const lower = text.toLowerCase();
    const missing = c.requiredSections.filter((s) => !lower.includes(s.toLowerCase()));
    add("sections", missing.length ? "fail" : "pass", missing.length ? `Missing: ${missing.join(", ")}.` : "All sections present.");
  }
  if (c.mustInclude.length) {
    const lower = text.toLowerCase();
    const missing = c.mustInclude.filter((s) => !lower.includes(s.toLowerCase()));
    add("must_include", missing.length ? "fail" : "pass", missing.length ? `Missing: ${missing.map((m) => `"${m}"`).join(", ")}.` : "All phrases present.");
  }
  // Correctness, where it can be verified deterministically.
  if (u.primary === "mathematics" || u.primary === "reasoning") {
    const expected = overrides.source ? arithmeticAnswer(overrides.source) : null;
    if (expected) {
      const ok = replyHasValue(text, expected.value);
      const shown = Number.isInteger(expected.value) ? String(expected.value) : String(Math.round(expected.value * 1e6) / 1e6);
      add("math_answer", ok ? "pass" : "fail", ok ? `States ${shown} (${expected.expression}).` : `Expected ${shown} for ${expected.expression}; not found in the reply.`);
    } else {
      add("math_answer", "not_checked", "The answer's correctness is not verified automatically for this task.");
    }
  }
  if (u.primary === "extraction" && overrides.source) {
    for (const ch of extractionChecks(text, overrides.source)) add(ch.rule, ch.status, ch.detail);
  }

  if (c.language && c.language !== "english") {
    add("language", "not_checked", `Requested ${c.language}; not verified automatically.`);
  }

  return { passed: checks.every((ch) => ch.status !== "fail"), checks, wordCount: words };
}
