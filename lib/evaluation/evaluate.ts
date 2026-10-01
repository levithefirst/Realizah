// Task-aware pass/fail. Deterministic checks only; anything Realizah cannot
// verify is reported as "not checked" and does not affect the result.
// A reply passes when every applicable, checkable rule passes.
import ts from "typescript";
import { TARGET_TOLERANCE } from "../task/constraints";
import type { TaskUnderstanding } from "../task/understand";
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

export function evaluate(
  text: string,
  finishReason: string | null,
  u: TaskUnderstanding,
  overrides: { wordMax?: number | null } = {}
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
  if (c.language && c.language !== "english") {
    add("language", "not_checked", `Requested ${c.language}; not verified automatically.`);
  }

  return { passed: checks.every((ch) => ch.status !== "fail"), checks, wordCount: words };
}
