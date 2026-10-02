// Progressive comparison under a hard spend cap.
//
// Waves:
//   0  screening   free-tier runs (cost $0, never labeled) + the cheapest paid
//                  core model. Screening alone never ends a comparison.
//   1  core        the rest of the diverse core (one per price tier, distinct
//                  creators), MIN_CANDIDATES_PER_RUN in total.
//   2+ expansion   two at a time, filling uncovered price tiers first, then
//                  uncovered creators, then queue order.
// After each wave from 1 on, the comparison stops once it is meaningful:
// at least MIN_CANDIDATES_PER_RUN paid models attempted, at least two passed,
// every available price tier tried, and at least min(3, available) creators.
// Stopping never looks at which model is cheapest, so it can't favor one.
//
// Systemic failures: a provider is treated as down, and nothing more is
// launched on it, when it has no success and either answered with HTTP 401
// (its credentials were rejected: account-wide, not per model), or failed
// at least twice with the same auth/network error. Ordinary per-model
// failures (a 403 on one gated model, a bad request, a timeout) never do.
//
// Spend: before launching a paid call, actual spend + in-flight worst-case
// reservations + this call's worst case must fit MAX_EXECUTION_COST_USD, so
// no call is ever launched whose reservation exceeds what is left of the cap.
// Worst case = byte-level input bound + the call's max output tokens, raised
// for routes that recently billed above it (comparison/billing.ts). A
// timed-out call is charged at least its worst case.
//
// Billing safety, after every call, in this order: (1) the call returns,
// (2) its billed cost is taken (provider-reported, never below the token
// cost), (3) it is compared with the reservation, (4) an overrun is recorded
// and the route marked unsafe for the rest of the comparison, (5) cost
// control decides whether anything more may launch, and only then (6) is the
// comparison checked for being meaningful. Other routes keep running: one
// route's overrun is not a reason to stop the others. Any overrun is named in
// the stop reason.
import type { ExecutionLimits } from "../config";
import type { ChatMessage, ProviderAdapter, RunModelResult } from "../providers/types";
import { isFreeAccess, type Candidate, type PriceTier, type SelectionResult } from "../selection/select";
import type { TaskUnderstanding } from "../task/understand";
import { billedCostUsd, isOverReservation } from "./billing";
import { runCandidate, type CandidateOutcome } from "./execute";

export const EXPANSION_WAVE_SIZE = 2;
const EPS = 1e-12;

export type SkipKind = "budget" | "meaningful" | "candidate_limit" | "unsafe_route" | "provider_failure";
export type StagedOutcome = CandidateOutcome & { stage: number };
export type Skipped = { candidate: Candidate; kind: SkipKind; reason: string };

export type Ledger = {
  capUsd: number;
  // Billed cost of completed calls.
  actualUsd: number;
  // Billed cost, and at least the worst case for timed-out calls: what the cap is held to.
  chargedUsd: number;
  // Highest charged + in-flight reservation reached when launching (<= cap).
  peakCommittedUsd: number;
  // Calls that billed above their reservation.
  overruns: BillingOverrun[];
};

export type BillingOverrun = {
  slug: string;
  accessId: string;
  providerId: string;
  externalModelId: string;
  reservedUsd: number;
  billedUsd: number;
  // billed / reserved; Infinity when the route reserved $0 (a free route).
  ratio: number;
  inputTokens: number | null;
  outputTokens: number | null;
  maxOutputTokens: number;
};

export function describeOverrun(o: BillingOverrun): string {
  const ratio = Number.isFinite(o.ratio) ? ` (${Math.round(o.ratio * 10) / 10}x)` : "";
  return `${o.slug} via ${o.providerId} billed $${o.billedUsd.toPrecision(3)} against $${o.reservedUsd.toPrecision(3)} reserved${ratio}`;
}

export type ProgressiveResult = {
  outcomes: StagedOutcome[];
  skipped: Skipped[];
  ledger: Ledger;
  stopReason: string;
  meaningful: boolean;
  paidAttempted: number;
  // Providers declared down during this run (same systemic error on every call).
  providerFailures: ProviderFailure[];
};

export type ProviderFailure = { providerId: string; errorKind: NonNullable<RunModelResult["errorKind"]>; message: string; calls: number };

// Errors that are about the provider or the account, not the model or task.
const PROVIDER_LEVEL: ReadonlySet<string> = new Set(["auth", "network"]);
const MIN_FAILURES_FOR_SYSTEMIC = 2;

export function isLabelEligible(o: { candidate: Candidate }): boolean {
  // A $0 route never carries a cost label, whatever role it ended up with.
  const a = o.candidate.access;
  return o.candidate.role !== "free_screening" && !(a && isFreeAccess(a));
}

export function meaningfulness(outcomes: StagedOutcome[], selection: Pick<SelectionResult, "tiersAvailable" | "creatorsAvailable">, minCandidates: number) {
  const paid = outcomes.filter(isLabelEligible);
  const passes = paid.filter((o) => o.passed).length;
  const tiers = new Set<PriceTier>(paid.map((o) => o.candidate.priceTier));
  const creators = new Set(paid.map((o) => o.candidate.model.creator));
  const missingTiers = selection.tiersAvailable.filter((t) => !tiers.has(t));
  const creatorsNeeded = Math.min(3, selection.creatorsAvailable);
  return {
    meaningful: paid.length >= minCandidates && passes >= 2 && missingTiers.length === 0 && creators.size >= creatorsNeeded,
    paid: paid.length,
    passes,
    missingTiers,
    creators: creators.size,
    creatorsNeeded,
  };
}

export async function runProgressive(opts: {
  selection: SelectionResult;
  messages: ChatMessage[];
  adapters: Map<string, ProviderAdapter>;
  understanding: TaskUnderstanding;
  limits: ExecutionLimits;
  wordMaxOverride?: number | null;
}): Promise<ProgressiveResult> {
  const { selection, limits } = opts;
  const cap = limits.maxExecutionCostUsd;
  const ledger: Ledger = { capUsd: cap, actualUsd: 0, chargedUsd: 0, peakCommittedUsd: 0, overruns: [] };
  // Routes that billed above their reservation in this comparison.
  const unsafeRoutes = new Set<string>();
  const outcomes: StagedOutcome[] = [];
  const skipped: Skipped[] = [];
  let reserved = 0;
  let paidLaunched = 0;

  // Per-provider call history, to spot a provider that fails every call.
  const history = new Map<string, { ok: number; failures: { kind: string; message: string; status: number | null }[] }>();
  const record = (providerId: string, run: RunModelResult) => {
    const h = history.get(providerId) ?? { ok: 0, failures: [] };
    if (run.ok) h.ok++;
    else h.failures.push({ kind: run.errorKind ?? "provider_error", message: run.error ?? "", status: run.httpStatus ?? null });
    history.set(providerId, h);
  };
  const providerDown = (providerId: string): ProviderFailure | null => {
    const h = history.get(providerId);
    if (!h || h.ok > 0 || !h.failures.length) return null;
    const [first] = h.failures;
    if (!PROVIDER_LEVEL.has(first.kind)) return null;
    const credentialsRejected = h.failures.every((f) => f.status === 401);
    if (!credentialsRejected && h.failures.length < MIN_FAILURES_FOR_SYSTEMIC) return null;
    if (!h.failures.every((f) => f.kind === first.kind && f.message === first.message)) return null;
    return { providerId, errorKind: first.kind as ProviderFailure["errorKind"], message: first.message, calls: h.failures.length };
  };
  const downReason = (f: ProviderFailure) => `Not run: all ${f.calls} calls to ${f.providerId} failed with the same ${f.errorKind} error (${f.message || "no message"}).`;

  const remaining = [...selection.candidates];
  const remove = (c: Candidate) => remaining.splice(remaining.indexOf(c), 1);
  const skip = (c: Candidate, kind: SkipKind, reason: string) => skipped.push({ candidate: c, kind, reason });

  async function wave(items: Candidate[], stage: number) {
    const pending = [...items];
    const running = new Set<Promise<void>>();
    const launch = (c: Candidate) => {
      const paid = c.role !== "free_screening";
      const hold = paid ? c.worstCaseCostUsd : 0;
      reserved += hold;
      if (paid) paidLaunched++;
      ledger.peakCommittedUsd = Math.max(ledger.peakCommittedUsd, ledger.chargedUsd + reserved);
      const p: Promise<void> = runCandidate({
        candidate: c,
        messages: opts.messages,
        adapters: opts.adapters,
        understanding: opts.understanding,
        timeoutMs: limits.timeoutMs,
        wordMaxOverride: opts.wordMaxOverride,
      }).then((o) => {
        reserved -= hold;
        record(c.access.providerId, o.run);
        // (2) what was billed, (3) against the reservation, (4) recorded.
        const billed = billedCostUsd(o);
        ledger.actualUsd += billed;
        ledger.chargedUsd += o.run.errorKind === "timeout" ? Math.max(hold, billed) : billed;
        if (isOverReservation(billed, hold)) {
          unsafeRoutes.add(c.access.accessId);
          ledger.overruns.push({
            slug: c.model.slug,
            accessId: c.access.accessId,
            providerId: c.access.providerId,
            externalModelId: c.access.externalModelId,
            reservedUsd: hold,
            billedUsd: billed,
            ratio: hold > 0 ? billed / hold : Infinity,
            inputTokens: o.run.inputTokens,
            outputTokens: o.run.outputTokens,
            maxOutputTokens: c.maxOutputTokens,
          });
        }
        outcomes.push({ ...o, stage });
        running.delete(p);
      });
      running.add(p);
    };

    while (pending.length || running.size) {
      for (let i = 0; i < pending.length && running.size < limits.maxConcurrent; ) {
        const c = pending[i];
        const paid = c.role !== "free_screening";
        if (unsafeRoutes.has(c.access.accessId)) {
          skip(c, "unsafe_route", "Not run: this route billed above its reservation earlier in this comparison.");
          pending.splice(i, 1);
          continue;
        }
        const down = providerDown(c.access.providerId);
        if (down) {
          skip(c, "provider_failure", downReason(down));
          pending.splice(i, 1);
          continue;
        }
        if (paid && paidLaunched >= limits.maxCandidates) {
          skip(c, "candidate_limit", `Candidate limit of ${limits.maxCandidates} paid models reached.`);
          pending.splice(i, 1);
          continue;
        }
        const need = paid ? c.worstCaseCostUsd : 0;
        if (ledger.chargedUsd + reserved + need <= cap + EPS) {
          pending.splice(i, 1);
          launch(c);
        } else if (running.size === 0) {
          const left = Math.max(0, cap - ledger.chargedUsd);
          skip(c, "budget", `Needs up to $${need.toPrecision(2)} worst case; $${left.toPrecision(2)} of the $${cap} cap left.`);
          pending.splice(i, 1);
        } else {
          i++; // may fit once an in-flight call releases its unused reservation
        }
      }
      if (running.size) await Promise.race(running);
    }
  }

  // Wave 0: screening.
  const firstPaid = remaining.find((c) => c.role === "core");
  if (firstPaid) remove(firstPaid);
  await wave([...selection.screening, ...(firstPaid ? [firstPaid] : [])], 0);

  // Wave 1: the rest of the core.
  const core = remaining.filter((c) => c.role === "core");
  core.forEach(remove);
  await wave(core, 1);

  // Waves 2+: expansion until meaningful, the limit, or the cap.
  let stage = 2;
  let stopReason = "";
  // (5) Cost control decides before anything else whether more may launch.
  const costControlStop = (): string | null => {
    const overrun = ledger.overruns.map(describeOverrun).join("; ");
    if (ledger.chargedUsd > cap + EPS) {
      return `Stopped by cost control: billing reached $${ledger.chargedUsd.toPrecision(3)}, above the $${cap} cap${overrun ? `, because ${overrun}` : ""}.`;
    }
    if (ledger.overruns.length && remaining.length) {
      const left = cap - ledger.chargedUsd;
      const fits = remaining.some((c) => !unsafeRoutes.has(c.access.accessId) && c.worstCaseCostUsd <= left + EPS);
      if (!fits) return `Stopped by cost control: ${overrun}, and the $${Math.max(0, left).toPrecision(2)} left of the $${cap} cap can't cover any remaining model's reservation.`;
    }
    return null;
  };
  for (;;) {
    const costStop = costControlStop();
    if (costStop) {
      stopReason = costStop;
      for (const c of remaining) skip(c, "budget", "Not run: cost control stopped the comparison.");
      remaining.length = 0;
      break;
    }
    // (6) Only then: is the comparison already meaningful?
    const m = meaningfulness(outcomes, selection, limits.minCandidates);
    if (m.meaningful) {
      stopReason = `Meaningful comparison reached: ${m.paid} paid models, ${m.passes} passed, all price tiers, ${m.creators} creators.`;
      for (const c of remaining) skip(c, "meaningful", "Not needed: the comparison was already meaningful.");
      break;
    }
    // Drop everything queued on a provider that is down.
    for (const c of remaining.filter((x) => providerDown(x.access.providerId))) {
      remove(c);
      skip(c, "provider_failure", downReason(providerDown(c.access.providerId)!));
    }
    const failures = [...history.keys()].map(providerDown).filter((f): f is ProviderFailure => f !== null);
    if (!remaining.length && failures.length && !outcomes.some((o) => o.run.ok)) {
      const f = failures[0];
      stopReason = `Stopped early: every call to ${f.providerId} failed with the same ${f.errorKind} error (${f.message || "no message"}). No more models were launched.`;
      break;
    }
    if (!remaining.length) {
      stopReason = m.paid ? `All ${m.paid} queued models that fit the cap were tried.` : "No paid model could run within the cap.";
      break;
    }
    if (paidLaunched >= limits.maxCandidates) {
      stopReason = `Candidate limit of ${limits.maxCandidates} paid models reached.`;
      for (const c of remaining) skip(c, "candidate_limit", stopReason);
      break;
    }
    // Next wave: uncovered tiers first, then uncovered creators, then order.
    const triedTiers = new Set(outcomes.filter(isLabelEligible).map((o) => o.candidate.priceTier));
    const triedCreators = new Set(outcomes.filter(isLabelEligible).map((o) => o.candidate.model.creator));
    const ranked = [...remaining].sort((a, b) => {
      const ta = triedTiers.has(a.priceTier) ? 1 : 0;
      const tb = triedTiers.has(b.priceTier) ? 1 : 0;
      if (ta !== tb) return ta - tb;
      const ca = triedCreators.has(a.model.creator) ? 1 : 0;
      const cb = triedCreators.has(b.model.creator) ? 1 : 0;
      if (ca !== cb) return ca - cb;
      return a.rank - b.rank;
    });
    const next = ranked.slice(0, EXPANSION_WAVE_SIZE);
    next.forEach(remove);
    const before = outcomes.length + skipped.length;
    await wave(next, stage++);
    if (outcomes.length + skipped.length === before) break; // nothing progressed
  }

  const final = meaningfulness(outcomes, selection, limits.minCandidates);
  if (!stopReason) stopReason = final.meaningful ? "Meaningful comparison reached." : "Stopped.";
  // A billing overrun is always named, whatever ended the comparison.
  if (ledger.overruns.length && !stopReason.startsWith("Stopped by cost control")) {
    stopReason += ` Cost control: ${ledger.overruns.map(describeOverrun).join("; ")}; route marked unsafe for this comparison.`;
  }
  const providerFailures = [...history.keys()].map(providerDown).filter((f): f is ProviderFailure => f !== null);
  return { outcomes, skipped, ledger, stopReason, meaningful: final.meaningful, paidAttempted: final.paid, providerFailures };
}

// Failures that say nothing about the user's task: the provider, the account,
// the network or Realizah's registry. A run where nothing succeeded and every
// failure is one of these did not give the user a comparison, so it must not
// use their free allowance. A provider_error (e.g. a 400 the task itself may
// have caused) is not on the list.
const NOT_THE_USERS_FAULT: ReadonlySet<string> = new Set(["auth", "network", "rate_limited", "timeout", "not_found", "unsupported_endpoint"]);

export function systemicFailure(res: Pick<ProgressiveResult, "outcomes" | "providerFailures">): string | null {
  if (res.outcomes.some((o) => o.run.ok)) return null;
  if (res.outcomes.length === 0) return "No model could be run.";
  if (!res.outcomes.every((o) => NOT_THE_USERS_FAULT.has(o.run.errorKind ?? ""))) return null;
  const f = res.providerFailures[0];
  if (f) return `every call to ${f.providerId} failed (${f.errorKind}: ${f.message || "no message"})`;
  const kinds = [...new Set(res.outcomes.map((o) => o.run.errorKind))].join(", ");
  return `no model returned a reply (${kinds})`;
}

// Labels over the measured results that are eligible: paid candidates only
// (free-tier screening never gets a cost label), and only once at least two
// paid models ran, so a label is always a comparison.
export function labelOutcomes(outcomes: CandidateOutcome[], assign: (xs: { key: string; label: string; passed: boolean; estimatedCostUsd: number | null; costPerSuccessUsd: number | null }[]) => { cheaper: string[]; better: string[] }): { cheaper: string[]; better: string[]; withheld: string | null } {
  const eligible = outcomes.filter(isLabelEligible);
  if (eligible.length < 2) {
    return { cheaper: [], better: [], withheld: "Fewer than two paid models ran, so there is nothing to compare." };
  }
  const l = assign(
    eligible.map((o) => ({
      key: o.candidate.model.id,
      label: o.candidate.model.name,
      passed: o.passed,
      estimatedCostUsd: o.estimatedCostUsd,
      costPerSuccessUsd: o.costPerSuccessUsd,
    }))
  );
  return { ...l, withheld: null };
}
