// Provider API keys as read from the environment. A key that is present but
// unusable (blank, whitespace, a placeholder, pasted with quotes or a
// "Bearer " prefix) must not make a provider look configured: OpenRouter
// answers such requests with "Missing Authentication header".
// Never log or return the key itself; only the issue.

export type CredentialIssue = "missing" | "blank" | "malformed" | "placeholder";

export type Credential = { key: string; issue: null } | { key: null; issue: CredentialIssue };

const PLACEHOLDER = /^(?:your[\s_-]|<.*>$|\$\{|changeme$|change[_-]me$|placeholder|x{3,}$|todo$|undefined$|null$|none$)/i;

export function readCredential(raw: string | undefined | null): Credential {
  if (raw === undefined || raw === null || raw === "") return { key: null, issue: "missing" };
  let v = raw.trim();
  // Common paste mistakes: surrounding quotes, a copied "Bearer " prefix.
  const quoted = /^(["'`])(.*)\1$/s.exec(v);
  if (quoted) v = quoted[2].trim();
  v = v.replace(/^bearer(?:\s+|$)/i, "").trim();
  if (!v) return { key: null, issue: "blank" };
  // A token never contains whitespace, control characters or non-ASCII.
  if (/[^\x21-\x7e]/.test(v)) return { key: null, issue: "malformed" };
  if (PLACEHOLDER.test(v)) return { key: null, issue: "placeholder" };
  return { key: v, issue: null };
}

export function describeIssue(envVar: string, issue: CredentialIssue): string {
  switch (issue) {
    case "missing":
      return `${envVar} is not set.`;
    case "blank":
      return `${envVar} is set but empty or whitespace.`;
    case "malformed":
      return `${envVar} contains spaces, line breaks or other characters a key can't have.`;
    case "placeholder":
      return `${envVar} looks like a placeholder, not a real key.`;
  }
}

// A non-secret description of a key for diagnostics: its public format
// family and length. Never any character beyond the documented prefix.
const FAMILIES = ["sk-or-v1-", "sk-or-", "sk-proj-", "sk-svcacct-", "sk-ant-", "sk-"];
export function keyShape(key: string): string {
  const family = FAMILIES.find((p) => key.startsWith(p));
  return `${family ? `starts with "${family}"` : "no known key prefix"}, ${key.length} characters`;
}
