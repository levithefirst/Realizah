"use client";

import { useMemo, useState } from "react";
import type { Tool } from "@/lib/tools";
import type { CompareResult, ResultCard } from "@/lib/compare";
import { checkSupport, type AiTool } from "@/lib/support";
import { formatUsd } from "@/lib/cost";

function rate(t: Tool): string {
  if (t.isUnknown) return "price UNKNOWN";
  return `$${t.inputUsdPer1m} in / $${t.outputUsdPer1m} out per 1M`;
}

function asOf(iso: string | null): string {
  if (!iso) return "date unknown";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export default function Comparer({
  tools,
  aiTools,
  defaultTask,
}: {
  tools: Tool[];
  aiTools: AiTool[];
  defaultTask: string;
}) {
  const [toolName, setToolName] = useState("");
  const [useCase, setUseCase] = useState("");
  // Empty by default: an empty task runs the demo, anything typed is sent as is.
  const [task, setTask] = useState("");
  const [models, setModels] = useState<string[]>(() => tools.slice(0, 3).map((t) => t.slug));
  const [wordCap, setWordCap] = useState(80);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(CompareResult & { remaining?: number }) | null>(null);

  const ready = toolName.trim() !== "" && useCase.trim() !== "";
  const support = useMemo(
    () => (ready ? checkSupport({ tool: toolName, useCase, task }, aiTools) : null),
    [ready, toolName, useCase, task, aiTools]
  );
  const callCount = models.length;
  const lastChecked = tools.map((t) => t.lastChecked).filter(Boolean).sort().at(-1) ?? null;

  function toggleModel(slug: string) {
    setModels((prev) => {
      if (prev.includes(slug)) return prev.length > 2 ? prev.filter((m) => m !== slug) : prev;
      if (prev.length >= 3) return prev;
      return [...prev, slug];
    });
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!support?.supported) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: toolName.trim(),
          useCase: useCase.trim(),
          task,
          models,
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
          <label className="field" htmlFor="tool">AI tool you use now</label>
          <input
            id="tool"
            type="text"
            list="known-tools"
            value={toolName}
            onChange={(e) => setToolName(e.target.value)}
            placeholder="e.g. ChatGPT, Claude, Jasper"
            maxLength={80}
            autoComplete="off"
          />
          <datalist id="known-tools">
            {aiTools.map((t) => (
              <option key={t.slug} value={t.name} />
            ))}
          </datalist>

          <label className="field" style={{ marginTop: 14 }} htmlFor="use">What you use it for</label>
          <input
            id="use"
            type="text"
            value={useCase}
            onChange={(e) => setUseCase(e.target.value)}
            placeholder="e.g. summarizing customer support tickets"
            maxLength={200}
          />

          <label className="field" style={{ marginTop: 14 }} htmlFor="task">Task to compare</label>
          <textarea
            id="task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="e.g. Write a cold email to a SaaS founder offering an AI video service. Keep it under 100 words."
            maxLength={600}
          />
          <p className="hint">
            {task.trim()
              ? "Sent exactly as written to every selected model."
              : `Leave empty to run the demo: "${defaultTask}" on a short fictional support ticket.`}
          </p>
          {support ? (
            support.supported ? (
              <p className="hint">{support.message}</p>
            ) : (
              <div className="alert error" role="alert">{support.message}</div>
            )
          ) : null}
        </div>

        <div className="grid2">
          <div className="panel">
            <span className="field">Models to run this task on (pick 2 or 3)</span>
            <div className="opts">
              {tools.map((t) => {
                const checked = models.includes(t.slug);
                const disabled = (!checked && models.length >= 3) || (checked && models.length <= 2);
                return (
                  <label key={t.slug} className="opt" aria-disabled={disabled}>
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleModel(t.slug)} />
                    <span>{t.name}</span>
                    <span className="price">{rate(t)}</span>
                  </label>
                );
              })}
              {tools.length === 0 ? <p className="hint">No models seeded yet.</p> : null}
            </div>
            <p className="hint">
              OpenAI API models used to price this task. None of them is assumed to be the model behind your tool.
              Prices from <a href="https://openai.com/api/pricing/" target="_blank" rel="noreferrer">OpenAI pricing</a>, as of {asOf(lastChecked)}. Missing prices show UNKNOWN.
            </p>
          </div>

          <div className="panel">
            <label className="field" htmlFor="cap">Success checks</label>
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
            <p className="hint">Checked on every reply. Not added to your task, so set the cap your task asks for.</p>
          </div>
        </div>

        <div className="actions">
          <button
            className="primary"
            type="submit"
            disabled={loading || !tools.length || callCount < 2 || !ready || !support?.supported}
          >
            {loading ? (<><span className="spinner" aria-hidden />Running {callCount} calls</>) : `Run ${callCount} real calls`}
          </button>
          <span className="hint" style={{ margin: 0 }}>
            {ready ? "Max 400 output tokens and 25s per model. Usually under 10 seconds." : "Fill in your tool and what you use it for."}
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

          <p className="hint">
            {result.mode === "demo"
              ? `Demo run: no task was entered, so every model got "${result.task}" on the sample support ticket. `
              : "Every model got your task exactly as written. "}
            {result.results.find((r) => r.isCurrent)
              ? `Verified mapping: ${result.currentTool} runs on ${result.results.find((r) => r.isCurrent)!.label}.`
              : `${result.currentTool} itself was not run. Realizah has no verified model or price for it, so these cards show what this task costs on each OpenAI model.`}
          </p>

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
