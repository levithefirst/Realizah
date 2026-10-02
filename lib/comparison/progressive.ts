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
// Spend: before launching a paid call, actual spend + in-flight worst-case
// reservations + this call's worst case must fit MAX_EXECUTION_COST_USD.
// Worst case = byte-level input bound + the call's max output tokens. A
// timed-out call is charged its worst case (the provider may still bill it).
import type { ExecutionLimits } from "../config";
import type { ChatMessage, ProviderAdapter } from "../providers/types";
import { isFreeAccess, type Candidate, type PriceTier, type SelectionResult } from "../selection/select";
import type { TaskUnderstanding } from "../task/understand";
import { runCandidate, type CandidateOutcome } from "./execute";

export const EXPANSION_WAVE_SIZE = 2;
const EPS = 1e-12;

export type SkipKind = "budget" | "meaningful" | "candidate_limit" | "spend_anomaly";
export type StagedOutcome = CandidateOutcome & { stage: number };
export type Skipped = { candidate: Candidate; kind: SkipKind; reason: string };

export type Ledger = {
  capUsd: number;
  // Known cost of completed calls.
  actualUsd: number;
  // Known cost plus worst case for timed-out calls: what the cap is held to.
  chargedUsd: number;
  // Highest actual + in-flight reservation ever reached (always <= cap).
  peakCommittedUsd: number;
  anomaly: string | null;
};

export type ProgressiveResult = {
  outcomes: StagedOutcome[];
  skipped: Skipped[];
  ledger: Ledger;
  stopReason: string;
  meaningful: boolean;
  paidAttempted: number;
};

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
  const ledger: Ledger = { capUsd: cap, actualUsd: 0, chargedUsd: 0, peakCommittedUsd: 0, anomaly: null };
  const outcomes: StagedOutcome[] = [];
  const skipped: Skipped[] = [];
  let reserved = 0;
  let paidLaunched = 0;

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
        const known = o.estimatedCostUsd ?? 0;
        const charged = o.run.errorKind === "timeout" ? hold : known;
        ledger.actualUsd += known;
        ledger.chargedUsd += charged;
        if (paid && known > hold + EPS) {
          ledger.anomaly = `${c.model.slug} cost ${known} above its reserved worst case ${hold}`;
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
        if (ledger.anomaly) {
          skip(c, "spend_anomaly", "Stopped: a call cost more than its reserved worst case.");
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
  for (;;) {
    const m = meaningfulness(outcomes, selection, limits.minCandidates);
    if (m.meaningful) {
      stopReason = `Meaningful comparison reached: ${m.paid} paid models, ${m.passes} passed, all price tiers, ${m.creators} creators.`;
      for (const c of remaining) skip(c, "meaningful", "Not needed: the comparison was already meaningful.");
      break;
    }
    if (ledger.anomaly) {
      stopReason = `Stopped for safety: ${ledger.anomaly}.`;
      for (const c of remaining) skip(c, "spend_anomaly", "Stopped: a call cost more than its reserved worst case.");
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
  return { outcomes, skipped, ledger, stopReason, meaningful: final.meaningful, paidAttempted: final.paid };
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
