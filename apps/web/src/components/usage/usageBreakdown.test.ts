import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { breakdownPeriods, cacheHitRate, costPerMillionTokens } from "./usageBreakdown";

const model = (
  name: string,
  totalTokens: number,
  costUsd: number,
  overrides: Partial<ModelTotals> = {},
): ModelTotals => ({
  model: name,
  provider: "codex",
  costUsd,
  totalTokens,
  tokens: {
    uncachedInputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 0,
  tokenShare: 0,
  ...overrides,
});

describe("model rates", () => {
  it("counts cache writes as misses and leaves unpriced tokens out of $/1M", () => {
    const mixed = model("mixed", 4_000_000, 6, {
      tokens: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationTokens: 2_000_000,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      records: 4,
      unpricedRecords: 1,
      unpricedTokens: 1_000_000,
    });

    expect(cacheHitRate(mixed)).toBe(0.25);
    expect(costPerMillionTokens(mixed)).toBe(2);
    expect(costPerMillionTokens({ ...mixed, unpricedRecords: 4 })).toBeNull();
  });
});

describe("breakdownPeriods", () => {
  it("lists days with only Boat VM time and adds its cost to the day's total", () => {
    const rows = breakdownPeriods(
      [{ day: "2026-08-01", costUsd: 4, totalTokens: 40, byProvider: new Map() }],
      new Map([
        ["2026-08-01", { seconds: 3600, dollars: 0.5 }],
        ["2026-08-03", { seconds: 1800, dollars: 0.25 }],
      ]),
    );
    expect(rows.map((row) => [row.key, row.costUsd, row.totals?.totalTokens])).toEqual([
      ["2026-08-03", 0.25, undefined],
      ["2026-08-01", 4.5, 40],
    ]);
  });
});
