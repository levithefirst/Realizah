// "I use ChatGPT for summarizing tickets" -> { tool: "ChatGPT", task: "summarizing tickets" }
export function parseStatement(s: string): { tool: string; task: string } {
  const m = s.match(/^\s*i\s+use\s+(.+?)\s+(?:for|to)\s+([\s\S]+?)\s*\.?\s*$/i);
  if (m) return { tool: m[1].trim(), task: m[2].trim() };
  return { tool: "", task: s.trim() };
}
