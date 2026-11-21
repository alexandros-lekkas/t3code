import { type UsageComputeBucket, UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import type { BoatApi, BoatApiError, BoatSandbox } from "@t3tools/shared/boatCloudApi";
import {
  MACHINE_LABEL_FILTER,
  SETUP_LABEL_FILTER,
  machineStateOf,
} from "@t3tools/shared/boatCloudVm";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/**
 * Boat bills each VM by the second and answers `/usage` for any range, but only while the VM
 * exists: a deleted VM's usage is gone (404). So every VM T3 started is read hour by hour and
 * recorded here, and a deleted VM keeps the hours recorded before Boat dropped it.
 */

const HOUR_MS = 3_600_000;
const SLOT_MS = 15 * 60_000;
/** The usage page's longest window, plus margin for time zones. */
const HISTORY_DAYS = 92;
const SYNC_COOLDOWN = Duration.minutes(1);

const StoredHour = Schema.Struct({
  start: Schema.Number,
  seconds: Schema.Number,
  dollars: Schema.Number,
  /** The size Boat reported when the hour was read; absent in older files: the VM's size. */
  machineType: Schema.optional(Schema.String),
});

const StoredMachine = Schema.Struct({
  machineType: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  /** Whole hours before this instant are recorded for good; null before the first read. */
  settledUntil: Schema.NullOr(Schema.Number),
  hours: Schema.Array(StoredHour),
  /** The unfinished hour, read again on each sync. */
  open: Schema.NullOr(
    Schema.Struct({
      start: Schema.Number,
      end: Schema.Number,
      seconds: Schema.Number,
      dollars: Schema.Number,
      machineType: Schema.optional(Schema.String),
    }),
  ),
  /** Boat no longer lists it, so its hours are final. */
  gone: Schema.Boolean,
});
export type StoredUsageMachine = typeof StoredMachine.Type;

const StoredHistory = Schema.Struct({
  machines: Schema.Record(Schema.String, StoredMachine),
});
export type StoredUsageHistory = typeof StoredHistory.Type;
const decodeHistory = Schema.decodeUnknownOption(Schema.fromJsonString(StoredHistory));
const encodeHistory = Schema.encodeSync(Schema.fromJsonString(StoredHistory));

export interface UsageRead {
  readonly seconds: number;
  readonly dollars: number;
  readonly multiplier: number | null;
}

type HourUsage = typeof StoredHour.Type;

const floorHour = (millis: number) => Math.floor(millis / HOUR_MS) * HOUR_MS;

/**
 * The billed usage of each hour in `[from, to)` (whole hours), with as few reads as it takes:
 * an empty range stops, a range on throughout is split evenly, any other halves.
 */
export const readHours = <E, R>(
  read: (sinceMs: number, untilMs: number) => Effect.Effect<UsageRead | null, E, R>,
  fromMs: number,
  toMs: number,
): Effect.Effect<Array<HourUsage>, E, R> => {
  // Untraced: a span per bisection step would flood the trace of one sync.
  const visit: (a: number, b: number) => Effect.Effect<Array<HourUsage>, E, R> = Effect.fnUntraced(
    function* (a: number, b: number) {
      const usage = yield* read(a, b);
      if (usage === null || usage.seconds <= 0) return [];
      const hours = Math.round((b - a) / HOUR_MS);
      if (hours <= 1) return [{ start: a, seconds: usage.seconds, dollars: usage.dollars }];
      // Boat rounds to whole seconds, so on throughout is within a second of the full range.
      if (usage.multiplier !== null && usage.seconds >= hours * 3600 * usage.multiplier - 1) {
        return Array.from({ length: hours }, (_, index) => ({
          start: a + index * HOUR_MS,
          seconds: usage.seconds / hours,
          dollars: usage.dollars / hours,
        }));
      }
      const middle = a + Math.floor(hours / 2) * HOUR_MS;
      const before = yield* visit(a, middle);
      const after = yield* visit(middle, b);
      return [...before, ...after];
    },
  );
  return toMs <= fromMs ? Effect.succeed([]) : visit(fromMs, toMs);
};

export interface ListedMachine {
  readonly sandbox: BoatSandbox;
  readonly environmentId: string | null;
}

/** Reads what is new for one VM since its last sync. */
export const syncMachine = Effect.fn("BoatUsageHistory.syncMachine")(function* <E, R>(
  previous: StoredUsageMachine | undefined,
  listed: ListedMachine,
  read: (sinceMs: number, untilMs: number) => Effect.Effect<UsageRead | null, E, R>,
  nowMs: number,
) {
  const { sandbox } = listed;
  const createdMs = sandbox.createdAt ? Date.parse(sandbox.createdAt) : Number.NaN;
  const oldest = floorHour(nowMs - HISTORY_DAYS * 24 * HOUR_MS);
  const currentHour = floorHour(nowMs);
  const from = Math.max(
    previous?.settledUntil ?? (Number.isNaN(createdMs) ? oldest : floorHour(createdMs)),
    oldest,
  );
  const stoppedMs = sandbox.stoppedAt ? Date.parse(sandbox.stoppedAt) : Number.NaN;
  // A VM stopped since before the last sync has billed nothing new.
  const idleSinceLastSync =
    previous?.settledUntil !== null &&
    previous?.settledUntil !== undefined &&
    machineStateOf(sandbox.state) === "stopped" &&
    !Number.isNaN(stoppedMs) &&
    stoppedMs <= previous.settledUntil;
  const added = idleSinceLastSync ? [] : yield* readHours(read, from, currentHour);
  const open = idleSinceLastSync || nowMs <= currentHour ? null : yield* read(currentHour, nowMs);
  const kept = (previous?.hours ?? []).filter(
    (hour) => hour.start >= oldest && !added.some((entry) => entry.start === hour.start),
  );
  const machineType = sandbox.type ?? previous?.machineType ?? null;
  // A resize keeps the VM, so each hour records the size it was read at.
  const sized = machineType === null ? {} : { machineType };
  return {
    machineType,
    environmentId: listed.environmentId ?? previous?.environmentId ?? null,
    settledUntil: Math.max(currentHour, previous?.settledUntil ?? 0),
    hours: [...kept, ...added.map((hour) => ({ ...hour, ...sized }))].toSorted(
      (a, b) => a.start - b.start,
    ),
    open:
      open === null || open.seconds <= 0
        ? null
        : {
            start: currentHour,
            end: nowMs,
            seconds: open.seconds,
            dollars: open.dollars,
            ...sized,
          },
    gone: false,
  } satisfies StoredUsageMachine;
});

function dayFormatter(timeZone: string): (millis: number) => string {
  const options = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" });
  }
  // @effect-diagnostics-next-line globalDate:off
  return (millis) => format.format(new Date(millis));
}

const round = (value: number, digits: number) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/**
 * The recorded usage in the summary's window, by day or by its rolling hours. Usage within an
 * hour is taken as even, so a period that cuts an hour gets its share by time.
 */
export function computeBuckets(
  history: StoredUsageHistory,
  input: UsageSummaryInput,
): Array<UsageComputeBucket> {
  const hourly =
    input.resolution === "hour" && input.sinceTime !== undefined && input.untilTime !== undefined
      ? { since: Date.parse(input.sinceTime), until: Date.parse(input.untilTime) }
      : null;
  const dayOf = dayFormatter(input.timeZone);
  const buckets = new Map<
    string,
    { -readonly [K in keyof UsageComputeBucket]: UsageComputeBucket[K] }
  >();
  const add = (
    sandboxId: string,
    machine: StoredUsageMachine,
    machineType: string | null,
    day: string,
    hourStart: string | undefined,
    seconds: number,
    dollars: number,
  ) => {
    const key = `${day}\u0000${hourStart ?? ""}\u0000${sandboxId}\u0000${machineType ?? ""}`;
    const bucket = buckets.get(key);
    if (bucket !== undefined) {
      bucket.seconds += seconds;
      bucket.dollars += dollars;
      return;
    }
    buckets.set(key, {
      day: UsageDay.make(day),
      ...(hourStart === undefined ? {} : { hourStart }),
      sandboxId,
      machineType,
      environmentId: machine.environmentId as UsageComputeBucket["environmentId"],
      seconds,
      dollars,
    });
  };

  for (const [sandboxId, machine] of Object.entries(history.machines)) {
    const spans = [
      ...machine.hours.map((hour) => ({ ...hour, end: hour.start + HOUR_MS })),
      ...(machine.open === null ? [] : [machine.open]),
    ];
    for (const span of spans) {
      const length = span.end - span.start;
      if (length <= 0) continue;
      const machineType = span.machineType ?? machine.machineType;
      if (hourly !== null) {
        const first = Math.max(0, Math.floor((span.start - hourly.since) / HOUR_MS));
        for (let index = first; ; index += 1) {
          const periodStart = hourly.since + index * HOUR_MS;
          if (periodStart >= hourly.until || periodStart >= span.end) break;
          const periodEnd = Math.min(periodStart + HOUR_MS, hourly.until);
          const overlap = Math.min(periodEnd, span.end) - Math.max(periodStart, span.start);
          if (overlap <= 0) continue;
          const share = overlap / length;
          add(
            sandboxId,
            machine,
            machineType,
            dayOf(periodStart),
            DateTime.formatIso(DateTime.makeUnsafe(periodStart)),
            span.seconds * share,
            span.dollars * share,
          );
        }
        continue;
      }
      // Quarter hours, so zones offset by 30 or 45 minutes split an hour at their midnight.
      for (let slot = span.start; slot < span.end; slot += SLOT_MS) {
        const share = (Math.min(slot + SLOT_MS, span.end) - slot) / length;
        const day = dayOf(slot);
        if (day < input.sinceDay || day > input.untilDay) continue;
        add(
          sandboxId,
          machine,
          machineType,
          day,
          undefined,
          span.seconds * share,
          span.dollars * share,
        );
      }
    }
  }
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      seconds: round(bucket.seconds, 2),
      dollars: round(bucket.dollars, 6),
    }))
    .filter((bucket) => bucket.seconds > 0 || bucket.dollars > 0)
    .toSorted(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
        a.sandboxId.localeCompare(b.sandboxId),
    );
}

/** Marks VMs Boat no longer lists, and drops hours past the longest window. */
export function settleHistory(
  history: StoredUsageHistory,
  synced: ReadonlyMap<string, StoredUsageMachine>,
  listedIds: ReadonlySet<string>,
  nowMs: number,
): StoredUsageHistory {
  const oldest = floorHour(nowMs - HISTORY_DAYS * 24 * HOUR_MS);
  const machines: Record<string, StoredUsageMachine> = {};
  for (const [sandboxId, machine] of Object.entries(history.machines)) {
    if (listedIds.has(sandboxId)) continue;
    const hours = machine.hours.filter((hour) => hour.start >= oldest);
    if (hours.length === 0 && machine.open === null) continue;
    machines[sandboxId] = { ...machine, hours, gone: true };
  }
  for (const [sandboxId, machine] of synced) machines[sandboxId] = machine;
  return { machines };
}

export interface BoatUsageHistory {
  /** Reads Boat for what is new, at most once a minute; a failed read keeps what was recorded. */
  readonly sync: (
    api: BoatApi,
    environmentOf: (sandboxId: string) => string | null,
  ) => Effect.Effect<void>;
  readonly buckets: (input: UsageSummaryInput) => Effect.Effect<Array<UsageComputeBucket>>;
}

export const makeBoatUsageHistory = Effect.fn("BoatUsageHistory.make")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let history: StoredUsageHistory = yield* fs.readFileString(filePath).pipe(
    Effect.map((text) => Option.getOrElse(decodeHistory(text), () => ({ machines: {} }))),
    Effect.orElseSucceed(() => ({ machines: {} })),
  );
  const lock = yield* Semaphore.make(1);
  let syncedAt = Number.NEGATIVE_INFINITY;

  const sync = (api: BoatApi, environmentOf: (sandboxId: string) => string | null) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          if (nowMs - syncedAt < Duration.toMillis(SYNC_COOLDOWN)) return;
          const listed = yield* Effect.forEach(
            [MACHINE_LABEL_FILTER, SETUP_LABEL_FILTER],
            (label) => api.listSandboxes(label),
            { concurrency: 2 },
          ).pipe(Effect.map((lists) => lists.flat()));
          const synced = new Map<string, StoredUsageMachine>();
          yield* Effect.forEach(
            listed,
            (sandbox) => {
              const read = (sinceMs: number, untilMs: number) =>
                api
                  .usage(sandbox.id, {
                    since: DateTime.formatIso(DateTime.makeUnsafe(sinceMs)),
                    until: DateTime.formatIso(DateTime.makeUnsafe(untilMs)),
                  })
                  .pipe(
                    Effect.map((usage): UsageRead | null =>
                      usage === null
                        ? null
                        : {
                            seconds: usage.seconds,
                            dollars: usage.dollars,
                            multiplier: usage.billingMultiplier ?? null,
                          },
                    ),
                  );
              return syncMachine(
                history.machines[sandbox.id],
                { sandbox, environmentId: environmentOf(sandbox.id) },
                read,
                nowMs,
              ).pipe(
                Effect.tap((machine) => Effect.sync(() => synced.set(sandbox.id, machine))),
                Effect.catch((cause: BoatApiError) =>
                  Effect.logWarning("boat cloud could not read a VM's usage history", {
                    sandboxId: sandbox.id,
                    cause,
                  }).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        const previous = history.machines[sandbox.id];
                        if (previous !== undefined) synced.set(sandbox.id, previous);
                      }),
                    ),
                  ),
                ),
              );
            },
            { concurrency: 4, discard: true },
          );
          history = settleHistory(history, synced, new Set(listed.map((entry) => entry.id)), nowMs);
          syncedAt = nowMs;
          yield* writeFileStringAtomically({ filePath, contents: encodeHistory(history) }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("boat cloud could not record VM usage history", { cause }),
        ),
        Effect.withSpan("BoatUsageHistory.sync"),
      );

  return {
    sync,
    buckets: (input) => Effect.sync(() => computeBuckets(history, input)),
  } satisfies BoatUsageHistory;
});
