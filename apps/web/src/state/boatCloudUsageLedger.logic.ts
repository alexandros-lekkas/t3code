import {
  EnvironmentId,
  UsageBucket,
  UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Model usage of the Boat VMs' threads, kept here because a VM's transcripts go when Boat
 * deletes it. Buckets only grow, so a later read of the same cell replaces an earlier one only
 * when it counts at least as many records.
 */
export const BoatCloudUsageLedgerEntry = Schema.Struct({
  timeZone: Schema.String,
  contractVersion: Schema.Number,
  readAt: Schema.String,
  sources: Schema.Array(UsageSource),
  buckets: Schema.Array(UsageBucket),
});
export type BoatCloudUsageLedgerEntry = typeof BoatCloudUsageLedgerEntry.Type;

export const BoatCloudUsageLedger = Schema.Record(EnvironmentId, BoatCloudUsageLedgerEntry);
export type BoatCloudUsageLedger = typeof BoatCloudUsageLedger.Type;

const MAX_ENVIRONMENTS = 200;

const cellKey = (bucket: UsageBucket) =>
  JSON.stringify([
    bucket.hourStart === undefined ? "day" : "hour",
    bucket.day,
    bucket.hourStart ?? null,
    bucket.provider,
    bucket.model,
    bucket.sourcePath ?? null,
  ]);

/** Folds one unfiltered read of a VM into its entry. A read in another time zone starts over. */
export function recordBoatCloudUsage(
  ledger: BoatCloudUsageLedger,
  environmentId: EnvironmentId,
  summary: UsageSummary,
): BoatCloudUsageLedger {
  if (summary.modelFilter !== undefined) return ledger;
  const previous = ledger[environmentId];
  const kept = previous?.timeZone === summary.timeZone ? previous.buckets : [];
  const cells = new Map(kept.map((bucket) => [cellKey(bucket), bucket] as const));
  for (const bucket of summary.buckets) {
    const key = cellKey(bucket);
    const current = cells.get(key);
    if (current === undefined || bucket.records >= current.records) cells.set(key, bucket);
  }
  const entry: BoatCloudUsageLedgerEntry = {
    timeZone: summary.timeZone,
    contractVersion: summary.contractVersion,
    readAt: summary.readAt,
    sources: summary.sources
      .filter((source) => source.status !== "missing")
      .map(({ refreshing: _refreshing, ...source }) => ({ ...source, status: "ok" as const })),
    buckets: [...cells.values()],
  };
  const others = Object.entries(ledger).filter(([id]) => id !== environmentId);
  return Object.fromEntries([...others.slice(-(MAX_ENVIRONMENTS - 1)), [environmentId, entry]]);
}

const hourFloor = (iso: string) => {
  const millis = Date.parse(iso);
  return Number.isNaN(millis) ? null : Math.floor(millis / 3_600_000) * 3_600_000;
};

/** What the ledger holds of a VM for one usage window, as that VM would have reported it. */
export function boatCloudUsageSummaryOf(
  entry: BoatCloudUsageLedgerEntry | undefined,
  input: UsageSummaryInput,
): UsageSummary | null {
  if (entry === undefined || entry.timeZone !== input.timeZone) return null;
  const hourly = input.resolution === "hour";
  const since = hourly && input.sinceTime !== undefined ? hourFloor(input.sinceTime) : null;
  const until = hourly && input.untilTime !== undefined ? Date.parse(input.untilTime) : null;
  const buckets = entry.buckets.filter((bucket) => {
    if (hourly !== (bucket.hourStart !== undefined)) return false;
    if (bucket.day < input.sinceDay || bucket.day > input.untilDay) return false;
    if (bucket.hourStart === undefined) return true;
    const start = Date.parse(bucket.hourStart);
    return (since === null || start >= since) && (until === null || start < until);
  });
  if (buckets.length === 0) return null;
  return {
    contractVersion: entry.contractVersion,
    readAt: entry.readAt,
    timeZone: entry.timeZone,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    buckets,
    sources: entry.sources,
    pricing: { status: "cached", source: "Boat VM", fetchedAt: entry.readAt, knownModels: 0 },
    scanDurationMs: 0,
  };
}
