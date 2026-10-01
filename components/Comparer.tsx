"use client";

import { useMemo, useState } from "react";
import ToolPicker, { type PickedTool } from "./ToolPicker";
import { matchProduct, type AiProduct } from "@/lib/products";
import { CATEGORY_LABEL, understandTask, type TaskUnderstanding } from "@/lib/task/understand";
import { formatUsd } from "@/lib/pricing";
import { parseWordCap, MAX_WORD_CAP, MIN_WORD_CAP } from "@/lib/wordLimit";
import { parseBudget } from "@/lib/budget";
import type { ComparisonDTO, Plan, ResultDTO } from "@/lib/comparison/service";

function describe(u: TaskUnderstanding): string {
  const c = u.constraints;
  const bits: string[] = [CATEGORY_LABEL[u.primary]];
  const wc = c.wordCount;
  if (wc?.target) bits.push(`${wc.target.toLocaleString()}-word target`);
  if (wc?.max) bits.push(`up to ${wc.max.toLocaleString()} words`);
  if (wc?.min) bits.push(`at least ${wc.min.toLocaleString()} words`);
  if (wc?.perItemMax) bits.push(`${wc.perItemMax} words per item`);
  if (c.listCount) bits.push(`${c.listCount} items`);
  if (c.outputFormat) bits.push(c.outputFormat.replace("_", " "));
  if (c.codeLanguage) bits.push(c.codeLanguage);
  if (c.framework) bits.push(c.framework);
  if (c.requiredFields.length) bits.push(`fields: ${c.requiredFields.join(", ")}`);
  if (c.citationsRequired) bits.push("citations required");
  if (c.language) bits.push(`in ${c.language}`);
  return bits.join(" · ");
}

function asOf(iso: string | null): string {
  if (!iso) return "date unknown";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export default function Comparer({ products }: { products: AiProduct[] }) {
  const [tool, setTool] = useState<PickedTool | null>(null);
  const [useCase, setUseCase] = useState("");
  const [task, setTask] = useState("");
  const [budget, setBudget] = useState("");
  const [wordMax, setWordMax] = useState("");
  const [phase, setPhase] = useState<"idle" | "planning" | "running">("idle");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(ComparisonDTO & { remaining?: number }) | null>(null);

  const product = tool?.slug ? products.find((p) => p.slug === tool.slug) ?? null : tool ? matchProduct(tool.name, products) : null;
  const understanding = useMemo(
    () => (task.trim() ? understandTask({ task, useCase, productCapability: product?.capability ?? null }) : null),
    [task, useCase, product?.capability]
  );
  const budgetParsed = parseBudget(budget);
  const wordMaxParsed = wordMax.trim() ? parseWordCap(wordMax) : null;
  const inputError =
    budgetParsed === "invalid"
      ? "Budget must be a dollar amount, like 20 or 2.50."
      : wordMax.trim() && wordMaxParsed === null
        ? `Word limit must be a whole number from ${MIN_WORD_CAP} to ${MAX_WORD_CAP}.`
        : null;
  const ready = Boolean(tool && useCase.trim() && task.trim()) && !inputError && understanding?.executable !== false;

  async function post(path: string) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: tool?.name ?? "",
        useCase,
        task,
        budgetUsd: budget.trim() || null,
        wordMax: wordMax.trim() || null,
      }),
    });
    return { res, data: await res.json().catch(() => null) };
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setError(null);
    setResult(null);
    setPlan(null);
    try {
      setPhase("planning");
      const planned = await post("/api/plan");
      if (!planned.res.ok) return setError(planned.data?.error ?? `Request failed (${planned.res.status}).`);
      const p = planned.data as Plan;
      setPlan(p);
      if (!p.executable) return setError(p.reason ?? "This comparison can't run yet.");
      setPhase("running");
      const ran = await post("/api/run");
      if (!ran.res.ok) return setError(ran.data?.error ?? `Request failed (${ran.res.status}).`);
      setResult(ran.data);
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setPhase("idle");
    }
  }

  const loading = phase !== "idle";

  return (
    <>
      <form onSubmit={run}>
        <div className="panel">
          <label className="field" htmlFor="tool">AI tool you use now</label>
          <ToolPicker products={products} value={tool} onChange={setTool} />

          <label className="field" style={{ marginTop: 14 }} htmlFor="use">What you use it for</label>
          <input
            id="use"
            type="text"
            value={useCase}
            onChange={(e) => setUseCase(e.target.value)}
            placeholder="e.g. long-form writing"
            maxLength={200}
            autoComplete="off"
          />

          <label className="field" style={{ marginTop: 14 }} htmlFor="task">Task to compare</label>
          <textarea
            id="task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="e.g. Write a 1,000-word article about remote work for small teams."
            maxLength={8000}
            style={{ minHeight: 110 }}
          />
          <p className="hint">Sent exactly as written to every model Realizah selects.</p>
          {understanding ? (
            understanding.executable ? (
              <p className="hint">Understood as: {describe(understanding)}.</p>
            ) : (
              <div className="alert error" role="alert">{understanding.notExecutableReason}</div>
            )
          ) : null}
          {understanding?.warnings.map((w) => (
            <p key={w} className="hint" style={{ color: "var(--warn)" }}>{w}</p>
          ))}
        </div>

        <div className="panel">
          <span className="field">Optional</span>
          <div className="chips" style={{ gap: 12 }}>
            <label htmlFor="budget">Budget $</label>
            <input
              id="budget"
              type="text"
              inputMode="decimal"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="20"
              autoComplete="off"
              style={{ width: 90 }}
            />
            <label htmlFor="wordmax">Max words</label>
            <input
              id="wordmax"
              type="text"
              inputMode="numeric"
              value={wordMax}
              onChange={(e) => setWordMax(e.target.value)}
              placeholder={understanding?.constraints.wordCount?.max ? String(understanding.constraints.wordCount.max) : "from task"}
              autoComplete="off"
              style={{ width: 110 }}
            />
          </div>
          <p className="hint">
            Budget is what you&apos;d spend on this task. Realizah estimates how many successful runs it buys; it doesn&apos;t spend it.
            Max words overrides any limit read from your task.
          </p>
          {inputError ? <p className="hint" role="alert" style={{ color: "var(--fail)" }}>{inputError}</p> : null}
        </div>

        <div className="actions">
          <button className="primary" type="submit" disabled={loading || !ready}>
            {loading ? (<><span className="spinner" aria-hidden />{phase === "planning" ? "Selecting models" : "Comparing"}</>) : "Compare"}
          </button>
          <span className="hint" style={{ margin: 0 }}>
            {ready ? "Realizah picks the relevant models for this task." : "Fill in your tool, what you use it for, and the task."}
          </span>
        </div>
      </form>

      {error ? <div className="alert error" role="alert">{error}</div> : null}
      {phase === "running" && plan ? (
        <div className="alert info" aria-live="polite">
          Comparing {plan.candidateCount} relevant models. Each gets your task exactly as written.
        </div>
      ) : null}

      {result ? <Results r={result} /> : null}
    </>
  );
}

function Results({ r }: { r: ComparisonDTO & { remaining?: number } }) {
  const anyBetter = r.results.some((x) => x.betterCost);
  return (
    <section aria-live="polite">
      <div className={`verdict ${anyBetter ? "" : "none"}`}>
        <strong>Compared across {r.attempted} {r.attempted === 1 ? "model" : "models"}</strong>
        {r.succeeded} passed, {r.failed} failed or errored. {r.summary}
        <div className="hint">
          Cheaper cost is the lowest estimated dollars for this run, pass or fail. Better cost is the lowest dollars per successful
          outcome; a failed result never gets it. Neither label judges which answer reads best.
        </div>
      </div>

      <div className="baseline">
        <strong>{r.baseline.taskCostKnown ? `${r.baseline.product}: ${formatUsd(r.baseline.costUsd)} (${r.baseline.status})` : "Current tool cost unavailable"}</strong>
        <div className="hint" style={{ marginTop: 4 }}>{r.baseline.message}</div>
      </div>

      {r.warnings.map((w) => (
        <p key={w} className="hint" style={{ color: "var(--warn)" }}>{w}</p>
      ))}

      {r.budgetUsd !== null ? (
        <p className="hint">
          Budget ${r.budgetUsd}: run counts below are estimates from one run per model at today&apos;s prices, not a guarantee.
        </p>
      ) : null}

      <div className="cards">
        {r.results.map((x) => (
          <Card key={x.key} x={x} budgetUsd={r.budgetUsd} />
        ))}
      </div>

      <h2 className="section">Audit trail</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Model</th><th>Provider</th><th>Tokens in</th><th>Tokens out</th><th>Est. cost</th><th>Price</th><th>Passed</th></tr>
          </thead>
          <tbody>
            {r.results.map((x) => (
              <tr key={x.key}>
                <td>{x.slug}</td>
                <td>{x.provider}</td>
                <td className="num">{x.inputTokens ?? "-"}</td>
                <td className="num">{x.outputTokens ?? "-"}</td>
                <td className="num">{formatUsd(x.estimatedCostUsd)}</td>
                <td className="num">${x.inputUsdPer1m}/${x.outputUsdPer1m} per 1M ({x.priceStatus})</td>
                <td>{x.executed ? (x.passed ? "yes" : "no") : "error"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Run {r.runId.slice(0, 8)}. Realizah spent about {formatUsd(r.actualExecutionCostUsd)} running this comparison (limit{" "}
        {formatUsd(r.executionBudgetUsd)}). {typeof r.remaining === "number" ? `${r.remaining} free comparisons left today.` : null}
      </p>
    </section>
  );
}

function Card({ x, budgetUsd }: { x: ResultDTO; budgetUsd: number | null }) {
  const status = !x.executed ? "ERROR" : x.passed ? "PASS" : "FAIL";
  return (
    <article className="card">
      <div className="chips">
        {x.cheaperCost ? <span className="chip rec">Cheaper cost</span> : null}
        {x.betterCost ? <span className="chip rec">Better cost</span> : null}
        <span className={`chip ${status === "PASS" ? "ok" : "bad"}`}>{status}</span>
      </div>
      <div>
        <h3>{x.model}</h3>
        <div className="model">{x.slug} · via {x.provider}</div>
      </div>
      <dl className="stats">
        <div><dt>Estimated cost</dt><dd>{formatUsd(x.estimatedCostUsd)}</dd></div>
        <div><dt>$ per success</dt><dd>{x.passed ? formatUsd(x.costPerSuccessUsd) : "unavailable"}</dd></div>
        <div><dt>Latency</dt><dd>{x.latencyMs !== null ? `${(x.latencyMs / 1000).toFixed(1)}s` : "-"}</dd></div>
        <div><dt>Tokens in/out</dt><dd>{x.inputTokens ?? "-"} / {x.outputTokens ?? "-"}</dd></div>
        {x.wordCount !== null ? <div><dt>Words</dt><dd>{x.wordCount}</dd></div> : null}
        {budgetUsd !== null && x.budget ? (
          <div>
            <dt>Within ${budgetUsd}</dt>
            <dd>{x.budget.successfulRunsWithinBudget !== null ? `≈${x.budget.successfulRunsWithinBudget.toLocaleString()} runs` : x.budget.exceedsBudget ? "over budget" : "n/a"}</dd>
          </div>
        ) : null}
      </dl>
      {x.failureReason ? <p className="why" style={{ color: "var(--fail)" }}>{x.failureReason}</p> : null}
      <p className="hint" style={{ margin: 0 }}>
        ${x.inputUsdPer1m} in / ${x.outputUsdPer1m} out per 1M tokens, {x.priceStatus}, as of {asOf(x.priceObservedAt)}
      </p>
      {x.checks.length ? (
        <details>
          <summary>Checks</summary>
          <ul className="checks">
            {x.checks.map((c) => (
              <li key={c.rule}>
                <span className={`st ${c.status}`}>{c.status === "not_checked" ? "not checked" : c.status}</span>
                <span>{c.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {x.output ? (
        <details>
          <summary>Output</summary>
          <pre>{x.output}</pre>
        </details>
      ) : null}
    </article>
  );
}
