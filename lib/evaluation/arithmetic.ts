// Expected answers for tasks that state plain arithmetic, so a mathematics
// reply can be checked for the right number instead of only being non-empty.
// Deterministic: a small recursive-descent parser, no eval. Anything that is
// not unambiguous arithmetic returns null and stays "not checked".

export type ArithmeticAnswer = { expression: string; value: number };

const NUMBER = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
const OP = String.raw`[-+*/×÷^x]`;
// Numbers joined by operators, optionally parenthesised: "17*19", "(3 + 4) × 2".
const EXPRESSION = new RegExp(String.raw`[(\s]*-?${NUMBER}[)\s]*(?:${OP}[(\s]*-?${NUMBER}[)\s]*)+`, "g");

function evaluateExpression(src: string): number | null {
  const tokens = src
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(/×|x/g, "*")
    .replace(/÷/g, "/")
    .match(/\d+(?:\.\d+)?|[-+*/^()]/g);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  // expr := term (("+" | "-") term)* ; term := power (("*" | "/") power)*
  // power := unary ("^" power)? ; unary := "-" unary | atom ; atom := num | "(" expr ")"
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") v = next() === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = power();
    while (peek() === "*" || peek() === "/") v = next() === "*" ? v * power() : v / power();
    return v;
  };
  const power = (): number => {
    const b = unary();
    return peek() === "^" ? (next(), Math.pow(b, power())) : b;
  };
  const unary = (): number => (peek() === "-" ? (next(), -unary()) : atom());
  const atom = (): number => {
    const t = next();
    if (t === "(") {
      const v = expr();
      if (next() !== ")") throw new Error("unbalanced");
      return v;
    }
    if (t === undefined || !/^\d/.test(t)) throw new Error("number expected");
    return Number(t);
  };
  try {
    const v = expr();
    return i === tokens.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function arithmeticAnswer(task: string): ArithmeticAnswer | null {
  const pct = [...task.matchAll(new RegExp(String.raw`\b(${NUMBER})\s*(?:%|percent)\s+of\s+(${NUMBER})\b`, "gi"))];
  const roots = [...task.matchAll(new RegExp(String.raw`\b(square|cube) root of\s+(${NUMBER})\b`, "gi"))];
  const exprs = [...task.matchAll(EXPRESSION)]
    .map((m) => m[0].trim())
    // A bare negative number or a date/range like "2024-10-01" is not arithmetic to check.
    .filter((e) => /\d\s*[*/×÷^x+]\s*\(?-?\d|\d\s+-\s+\d/.test(e) && !/^\d{4}-\d{2}-\d{2}$/.test(e));
  // Exactly one unambiguous computation, or nothing is checked.
  if (pct.length + roots.length + exprs.length !== 1) return null;
  const n = (s: string) => Number(s.replace(/,/g, ""));
  if (pct.length) return { expression: pct[0][0], value: (n(pct[0][1]) / 100) * n(pct[0][2]) };
  if (roots.length) {
    const v = roots[0][1].toLowerCase() === "square" ? Math.sqrt(n(roots[0][2])) : Math.cbrt(n(roots[0][2]));
    return { expression: roots[0][0], value: v };
  }
  const value = evaluateExpression(exprs[0]);
  return value === null ? null : { expression: exprs[0], value };
}

// Numbers as a reader writes them: "323", "-4", "1,234.5", "36.0".
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:,\d{3})*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, "")));
}

// A reply matches when it states the value, allowing for the rounding a
// reply's own decimals imply ("0.33" for 1/3).
export function replyHasValue(text: string, value: number): boolean {
  return [...text.matchAll(/-?\d+(?:,\d{3})*(?:\.(\d+))?/g)].some((m) => {
    const n = Number(m[0].replace(/,/g, ""));
    const decimals = m[1]?.length ?? 0;
    const tolerance = Math.max(1e-9 * Math.max(1, Math.abs(value)), decimals ? 0.5 * 10 ** -decimals : 1e-9);
    return Math.abs(n - value) <= tolerance;
  });
}
