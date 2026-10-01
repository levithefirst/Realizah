"use client";

import { useMemo, useState } from "react";
import type { Tool } from "@/lib/tools";
import type { CompareResult, ResultCard } from "@/lib/compare";
import { parseStatement } from "@/lib/parse";
import { formatUsd } from "@/lib/cost";

const PLACEHOLDER =
  "I use ChatGPT for summarizing a short brief in 80 words or fewer with no invented facts";

function rate(t: Tool): string {
  if (t.isUnknown) return "price UNKNOWN";
  return `$${t.inputUsdPer1m} in / $${t.outputUsdPer1m} out per 1M`;
}

function asOf(iso: string | null): string {
  if (!iso) return "date unknown";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export default function Comparer({ tools, defaultTask }: { tools: Tool[]; defaultTask: string }) {
  const [statement, setStatement] = useState("");
  const initial = (tools.find((t) => t.slug === "gpt-4o-mini") ?? tools[0])?.slug ?? "";
  const [current, setCurrent] = useState(initial);
  const [alts, setAlts] = useState<string[]>(() => tools.filter((t) => t.slug !== initial).slice(0, 2).map((t) => t.slug));
  const [wordCap, setWordCap] = useState(80);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(CompareResult & { remaining?: number }) | null>(null);

  const parsed = useMemo(() => parseStatement(statement || PLACEHOLDER), [statement]);
  const altChoices = tools.filter((t) => t.slug !== current);
  const callCount = 1 + alts.filter((a) => a !== current).length;
  const lastChecked = tools.map((t) => t.lastChecked).filter(Boolean).sort().at(-1) ?? null;

  function onCurrent(slug: string) {
    setCurrent(slug);
    setAlts((prev) => {
      const kept = prev.filter((a) => a !== slug);
      if (kept.length === 0) {
        const first = tools.find((t) => t.slug !== slug);
        return first ? [first.slug] : [];
      }
      return kept;
    });
  }

  function toggleAlt(slug: string) {
    setAlts((prev) => {
      if (prev.includes(slug)) return prev.length > 1 ? prev.filter((a) => a !== slug) : prev;
      if (prev.length >= 2) return prev;
      return [...prev, slug];
    });
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          statement: statement.trim() || PLACEHOLDER,
          current,
          alternatives: alts.filter((a) => a !== current),
          criteria: { wordCap, bannedPhrases: ["as an AI"] },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Request failed (${res.status}).`);
      } else {
        setResult(data);
      }
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <form onSubmit={run}>
        <div className="panel">
          <label className="field" htmlFor="statement">I use [tool] for [task]</label>
          <textarea
            id="statement"
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            placeholder={PLACEHOLDER}
            maxLength={600}
          />
          <p className="hint">
            Read as: tool <strong>{parsed.tool || "(not stated)"}</strong>, task{" "}
            <strong>{parsed.task || defaultTask}</strong>. It runs on a short fictional support ticket, never
            your files.
          </p>
        </div>

        <div className="grid2">
          <div className="panel">
            <label className="field" htmlFor="current">Model behind your current tool</label>
            <select id="current" value={current} onChange={(e) => onCurrent(e.target.value)} disabled={!tools.length}>
              {tools.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name} ({rate(t)})
                </option>
              ))}
            </select>
            <p className="hint">
              Prices from <a href="https://openai.com/api/pricing/" target="_blank" rel="noreferrer">OpenAI pricing</a>, as of {asOf(lastChecked)}. Missing prices show UNKNOWN.
            </p>

            <label className="field" style={{ marginTop: 14 }} htmlFor="cap">Success checks</label>
            <div className="chips">
              <span>Word cap</span>
              <input
                id="cap"
                type="number"
                min={10}
                max={300}
                value={wordCap}
                onChange={(e) => setWordCap(Number(e.target.value) || 80)}
                style={{ width: 90 }}
              />
              <span className="chip">must not say &ldquo;as an AI&rdquo;</span>
            </div>
          </div>

          <div className="panel">
            <span className="field">Alternatives to try (pick up to 2)</span>
            <div className="opts">
              {altChoices.map((t) => {
                const checked = alts.includes(t.slug);
                const disabled = !checked && alts.filter((a) => a !== current).length >= 2;
                return (
                  <label key={t.slug} className="opt" aria-disabled={disabled}>
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleAlt(t.slug)} />
                    <span>{t.name}</span>
                    <span className="price">{rate(t)}</span>
                  </label>
                );
              })}
              {altChoices.length === 0 ? <p className="hint">No alternatives seeded yet.</p> : null}
            </div>
          </div>
        </div>

        <div className="actions">
          <button className="primary" type="submit" disabled={loading || !tools.length || callCount < 2}>
            {loading ? (<><span className="spinner" aria-hidden />Running {callCount} calls</>) : `Run ${callCount} real calls`}
          </button>
          <span className="hint" style={{ margin: 0 }}>
            Max 400 output tokens and 25s per model. Usually under 10 seconds.
          </span>
        </div>
      </form>

      {error ? <div className="alert error" role="alert">{error}</div> : null}
      {loading ? <div className="alert info" aria-live="polite">Calling each model with the same fixture and checking the answers.</div> : null}

      {result ? (
        <section aria-live="polite">
          <div className={`verdict ${result.betterCostSlugs.length ? "" : "none"}`}>
            <strong>Cost labels for this run</strong>
            {result.summary}
            <div className="hint">
              Cheaper cost is the lowest sticker cost, pass or fail. Better cost is the lowest dollars per successful
              outcome, and a fail never gets it. Neither label judges which answer reads best.
            </div>
          </div>

          <div className="cards">
            {result.results.map((r) => (
              <Card key={r.slug} r={r} />
            ))}
          </div>

          <h2 className="section">Audit trail</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Model</th><th>Tokens in</th><th>Tokens out</th><th>Est. cost</th><th>Passed</th><th>Time (UTC)</th></tr>
              </thead>
              <tbody>
                {result.audit.map((a, i) => (
                  <tr key={i}>
                    <td>{a.model}</td>
                    <td className="num">{a.tokensIn ?? "-"}</td>
                    <td className="num">{a.tokensOut ?? "-"}</td>
                    <td className="num">{formatUsd(a.estimatedCostUsd)}</td>
                    <td>{a.success ? "yes" : "no"}</td>
                    <td className="num">{new Date(a.createdAt).toISOString().replace("T", " ").slice(0, 19)}</td>
                  </tr>
                ))}
                {result.audit.length === 0 ? (<tr><td colSpan={6}>No completed calls to log.</td></tr>) : null}
              </tbody>
            </table>
          </div>
          <p className="hint">
            Run {result.runId.slice(0, 8)}. {typeof result.remaining === "number" ? `${result.remaining} free comparisons left today.` : null}
          </p>
        </section>
      ) : null}
    </>
  );
}

function Card({ r }: { r: ResultCard }) {
  return (
    <article className="card">
      <div className="chips">
        {r.cheaperCost ? <span className="chip rec">Cheaper cost</span> : null}
        {r.betterCost ? <span className="chip rec">Better cost</span> : null}
        {r.isCurrent ? <span className="chip cur">Current</span> : null}
        {r.qualityBand === "good" ? <span className="chip ok">PASS</span> : <span className="chip bad">{r.qualityBand === "error" ? "ERROR" : "FAIL"}</span>}
      </div>
      <div>
        <h3>{r.label}</h3>
        <div className="model">{r.modelId}</div>
      </div>
      <dl className="stats">
        <div><dt>Sticker cost</dt><dd>{formatUsd(r.estimatedCostUsd)}</dd></div>
        <div><dt>$ per success</dt><dd>{r.passed ? formatUsd(r.costPerSuccessUsd) : "none (failed)"}</dd></div>
        <div><dt>Latency</dt><dd>{r.latencyMs !== null ? `${(r.latencyMs / 1000).toFixed(1)}s` : "-"}</dd></div>
        <div><dt>Tokens in/out</dt><dd>{r.tokensIn ?? "-"} / {r.tokensOut ?? "-"}</dd></div>
        <div><dt>Words</dt><dd>{r.wordCount ?? "-"}</dd></div>
      </dl>
      <p className="why">{r.why}</p>
      {r.priceAsOf ? <p className="hint" style={{ margin: 0 }}>Price as of {asOf(r.priceAsOf)}</p> : null}
      <details open>
        <summary>Reply</summary>
        <pre>{r.output ?? "No reply."}</pre>
      </details>
    </article>
  );
}
