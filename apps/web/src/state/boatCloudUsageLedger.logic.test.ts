import {
  EnvironmentId,
  UsageDay,
  type UsageBucket,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boatCloudUsageSummaryOf, recordBoatCloudUsage } from "./boatCloudUsageLedger.logic";

const vm = EnvironmentId.make("vm-env");
const zone = "America/Chicago";

const bucket = (day: string, records: number, hourStart?: string): UsageBucket => ({
  day: UsageDay.make(day),
  ...(hourStart === undefined ? {} : { hourStart }),
  provider: "claude",
  model: "claude-haiku",
  totals: {
    uncachedInputTokens: records * 10,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: records,
    reasoningTokens: 0,
  },
  costUsd: records / 100,
  cacheSavingsUsd: 0,
  costSource: "modelPriced",
  records,
  unpricedRecords: 0,
  sessions: 1,
});

const summary = (buckets: UsageBucket[], extra: Partial<UsageSummary> = {}): UsageSummary => ({
  contractVersion: 6,
  readAt: "2026-11-20T12:00:00.000Z",
  timeZone: zone,
  sinceDay: UsageDay.make("2026-08-23"),
  untilDay: UsageDay.make("2026-11-20"),
  buckets,
  sources: [],
  pricing: { status: "fresh", source: "models.dev", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
  ...extra,
});

const window = (input: Partial<UsageSummaryInput> = {}): UsageSummaryInput => ({
  sinceDay: UsageDay.make("2026-11-14"),
  untilDay: UsageDay.make("2026-11-20"),
  timeZone: zone,
  ...input,
});

describe("Boat cloud usage ledger", () => {
  it("keeps a VM's usage after it is gone, never losing records a later read lacks", () => {
    let ledger = recordBoatCloudUsage({}, vm, summary([bucket("2026-11-19", 5)]));
    ledger = recordBoatCloudUsage(
      ledger,
      vm,
      summary([bucket("2026-11-19", 3), bucket("2026-11-20", 2), bucket("2026-11-01", 9)]),
    );
    const kept = boatCloudUsageSummaryOf(ledger[vm], window());
    expect(kept?.buckets.map((entry) => [entry.day, entry.records])).toEqual([
      ["2026-11-19", 5],
      ["2026-11-20", 2],
    ]);
  });

  it("answers an hourly window only from hourly cells inside it", () => {
    const ledger = recordBoatCloudUsage(
      {},
      vm,
      summary([
        bucket("2026-11-20", 4),
        bucket("2026-11-19", 1, "2026-11-19T10:00:00.000Z"),
        bucket("2026-11-20", 3, "2026-11-20T09:00:00.000Z"),
      ]),
    );
    const kept = boatCloudUsageSummaryOf(
      ledger[vm],
      window({
        sinceDay: UsageDay.make("2026-11-19"),
        resolution: "hour",
        sinceTime: "2026-11-19T12:30:00.000Z",
        untilTime: "2026-11-20T12:30:00.000Z",
      }),
    );
    expect(kept?.buckets.map((entry) => entry.hourStart)).toEqual(["2026-11-20T09:00:00.000Z"]);
  });

  it("skips filtered reads and windows in another time zone", () => {
    const filtered = recordBoatCloudUsage(
      {},
      vm,
      summary([bucket("2026-11-20", 1)], { modelFilter: { include: [{ model: "x" }] } }),
    );
    expect(filtered).toEqual({});
    const ledger = recordBoatCloudUsage({}, vm, summary([bucket("2026-11-20", 1)]));
    expect(boatCloudUsageSummaryOf(ledger[vm], window({ timeZone: "UTC" }))).toBeNull();
  });
});
