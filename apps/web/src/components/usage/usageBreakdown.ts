import type { UsageTokenTotals } from "@t3tools/contracts";
import {
  isModelCostUnknown,
  type CategoryCost,
  type ComputeFigures,
  type DailyTotals,
  type HourlyTotals,
  type ModelTotals,
  type SpeedCost,
} from "@t3tools/shared/usageMerge";

import { msg } from "gt-react";

import type { ShareSegment } from "./UsageShareBar";
import { COMPUTE_PRESENTATION } from "./usageProviders";

export function sortModelsByTokens(models: readonly ModelTotals[]) {
  return models.toSorted(
    (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
  );
}

/** Unknown cost yields null cost share; unpriced models still have token shares. */
export function modelShare(model: ModelTotals, metric: "cost" | "tokens"): number | null {
  if (metric === "tokens") return model.tokenShare;
  return isModelCostUnknown(model) ? null : model.costShare;
}

/** Returns null without input; cache writes count as misses because input was fully processed. */
export function cacheHitRate({ tokens }: ModelTotals): number | null {
  const input = tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheCreationTokens;
  return input === 0 ? null : tokens.cachedInputTokens / input;
}

/** Effective USD per million priced tokens, or `null` when none were priced. */
export function costPerMillionTokens(model: ModelTotals): number | null {
  const pricedTokens = model.totalTokens - model.unpricedTokens;
  return pricedTokens <= 0 || isModelCostUnknown(model)
    ? null
    : (model.costUsd / pricedTokens) * 1_000_000;
}

const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;

const TYPE_COLORS = {
  input: ink(60),
  cacheRead: ink(30),
  cacheWrite: ink(72),
  output: ink(100),
  other: ink(44),
};

export function costTypeSegments(cost: CategoryCost): readonly ShareSegment[] {
  return [
    { label: msg("Input"), value: cost.input, color: TYPE_COLORS.input },
    { label: msg("Cache read"), value: cost.cacheRead, color: TYPE_COLORS.cacheRead },
    { label: msg("Cache write"), value: cost.cacheWrite, color: TYPE_COLORS.cacheWrite },
    { label: msg("Output"), value: cost.output, color: TYPE_COLORS.output },
    {
      label: msg("Other"),
      value: cost.unsplit >= 0.005 ? cost.unsplit : 0,
      color: TYPE_COLORS.other,
    },
  ];
}

export function computeCostSegment(dollars: number): ShareSegment {
  return { label: msg("Boat VMs"), value: dollars, color: COMPUTE_PRESENTATION.color };
}

export interface BreakdownPeriod {
  /** The day, or the hour start in an hourly window. */
  readonly key: string;
  readonly totals: DailyTotals | HourlyTotals | undefined;
  readonly compute: ComputeFigures | undefined;
  /** Model cost plus Boat's VM cost. */
  readonly costUsd: number;
}

/** Newest first, every period with model usage or Boat VM time. */
export function breakdownPeriods(
  periods: readonly (DailyTotals | HourlyTotals)[],
  computeByPeriod: ReadonlyMap<string, ComputeFigures>,
): readonly BreakdownPeriod[] {
  const byKey = new Map(
    periods.map((period) => ["hourStart" in period ? period.hourStart : period.day, period]),
  );
  return [...new Set([...byKey.keys(), ...computeByPeriod.keys()])]
    .toSorted((a, b) => b.localeCompare(a))
    .map((key) => {
      const totals = byKey.get(key);
      const compute = computeByPeriod.get(key);
      return {
        key,
        totals,
        compute,
        costUsd: (totals?.costUsd ?? 0) + (compute?.dollars ?? 0),
      };
    });
}

export function tokenTypeSegments(
  tokens: Omit<UsageTokenTotals, "reasoningTokens">,
): readonly ShareSegment[] {
  return [
    { label: msg("Input"), value: tokens.uncachedInputTokens, color: TYPE_COLORS.input },
    { label: msg("Cache read"), value: tokens.cachedInputTokens, color: TYPE_COLORS.cacheRead },
    { label: msg("Cache write"), value: tokens.cacheCreationTokens, color: TYPE_COLORS.cacheWrite },
    { label: msg("Output"), value: tokens.outputTokens, color: TYPE_COLORS.output },
  ];
}

export function speedCostSegments(cost: SpeedCost): readonly ShareSegment[] {
  return [
    { label: msg("Standard"), value: cost.standard, color: ink(34) },
    { label: msg("Fast"), value: cost.fast, color: ink(66) },
    { label: msg("Ultrafast"), value: cost.ultrafast, color: ink(100) },
  ];
}
