import { assert, describe, it } from "@effect/vitest";
import { UsageDay } from "@t3tools/contracts";
import type { BoatSandbox } from "@t3tools/shared/boatCloudApi";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  computeBuckets,
  readHours,
  settleHistory,
  syncMachine,
  type StoredUsageMachine,
  type UsageRead,
} from "./BoatCloudUsageHistory.ts";

const HOUR = 3_600_000;
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const DAY_START = Date.UTC(2026, 10, 18);

/** A small VM (multiplier 0.5) billed by the second over these wall-time spans. */
const boatOver = (spans: ReadonlyArray<readonly [number, number]>, multiplier = 0.5) => {
  const reads: Array<readonly [number, number]> = [];
  const read = (since: number, until: number) =>
    Effect.sync((): UsageRead => {
      reads.push([since, until]);
      const wallSeconds = spans.reduce(
        (sum, [start, end]) => sum + Math.max(0, Math.min(end, until) - Math.max(start, since)),
        0,
      );
      const seconds = Math.round((wallSeconds / 1000) * multiplier);
      return { seconds, dollars: seconds / 100_000, multiplier };
    });
  return { read, reads };
};

const sandbox = (overrides: Partial<BoatSandbox> = {}): BoatSandbox => ({
  id: "bx_one",
  name: "Boat cloud",
  state: "idle",
  type: "small",
  createdAt: iso(DAY_START),
  ...overrides,
});

const machine = (overrides: Partial<StoredUsageMachine> = {}): StoredUsageMachine => ({
  machineType: "small",
  environmentId: null,
  settledUntil: null,
  hours: [],
  open: null,
  gone: false,
  ...overrides,
});

describe("readHours", () => {
  it.effect("finds the billed hours of a sparse range in few reads", () =>
    Effect.gen(function* () {
      const boat = boatOver([[DAY_START + 3.5 * HOUR, DAY_START + 5 * HOUR]]);
      const hours = yield* readHours(boat.read, DAY_START, DAY_START + 16 * HOUR);
      assert.deepStrictEqual(
        hours.map((hour) => [(hour.start - DAY_START) / HOUR, hour.seconds]),
        [
          [3, 900],
          [4, 1800],
        ],
      );
      assert.isBelow(boat.reads.length, 16);
    }),
  );

  it.effect("splits a range on throughout evenly without reading each hour", () =>
    Effect.gen(function* () {
      const boat = boatOver([[DAY_START, DAY_START + 24 * HOUR]]);
      const hours = yield* readHours(boat.read, DAY_START, DAY_START + 24 * HOUR);
      assert.strictEqual(hours.length, 24);
      assert.isTrue(hours.every((hour) => hour.seconds === 1800));
      assert.strictEqual(boat.reads.length, 1);
    }),
  );
});

describe("syncMachine", () => {
  it.effect("reads only what is new and keeps the unfinished hour apart", () =>
    Effect.gen(function* () {
      const spans = [[DAY_START + 1 * HOUR, DAY_START + 10.5 * HOUR]] as const;
      const first = yield* syncMachine(
        undefined,
        { sandbox: sandbox(), environmentId: "env-a" },
        boatOver(spans).read,
        DAY_START + 6.5 * HOUR,
      );
      assert.strictEqual(first.settledUntil, DAY_START + 6 * HOUR);
      assert.strictEqual(first.hours.length, 5);
      assert.deepStrictEqual(first.open, {
        start: DAY_START + 6 * HOUR,
        end: DAY_START + 6.5 * HOUR,
        seconds: 900,
        dollars: 0.009,
      });

      const later = boatOver(spans);
      const second = yield* syncMachine(
        first,
        // The VM is gone from T3's registry, so the environment it served is kept.
        { sandbox: sandbox(), environmentId: null },
        later.read,
        DAY_START + 12 * HOUR,
      );
      assert.isTrue(later.reads.every(([since]) => since >= DAY_START + 6 * HOUR));
      assert.strictEqual(second.environmentId, "env-a");
      assert.strictEqual(
        second.hours.reduce((sum, hour) => sum + hour.seconds, 0),
        9.5 * 1800,
      );
      assert.isNull(second.open);
    }),
  );

  it.effect("asks nothing of a VM stopped since the last sync", () =>
    Effect.gen(function* () {
      const boat = boatOver([]);
      const synced = yield* syncMachine(
        machine({ settledUntil: DAY_START + 5 * HOUR }),
        {
          sandbox: sandbox({
            state: "archived",
            stoppedAt: iso(DAY_START + 4 * HOUR),
          }),
          environmentId: null,
        },
        boat.read,
        DAY_START + 9.25 * HOUR,
      );
      assert.strictEqual(boat.reads.length, 0);
      assert.strictEqual(synced.settledUntil, DAY_START + 9 * HOUR);
    }),
  );
});

describe("computeBuckets", () => {
  const history = {
    machines: {
      bx_one: machine({
        environmentId: "env-a",
        hours: [
          // 23:00 UTC on the 18th is 18:00 in New York, and 04:30 on the 19th in Kolkata.
          { start: DAY_START + 23 * HOUR, seconds: 1800, dollars: 0.018 },
          { start: DAY_START + 24 * HOUR, seconds: 1800, dollars: 0.018 },
        ],
        open: {
          start: DAY_START + 25 * HOUR,
          end: DAY_START + 25.5 * HOUR,
          seconds: 900,
          dollars: 0.009,
        },
      }),
    },
  };

  it("buckets by day in the summary's time zone", () => {
    const buckets = computeBuckets(history, {
      sinceDay: UsageDay.make("2026-11-17"),
      untilDay: UsageDay.make("2026-11-19"),
      timeZone: "UTC",
    });
    assert.deepStrictEqual(
      buckets.map((bucket) => [
        bucket.day as string,
        bucket.seconds,
        bucket.environmentId as string,
      ]),
      [
        ["2026-11-18", 1800, "env-a"],
        ["2026-11-19", 2700, "env-a"],
      ],
    );
    const newYork = computeBuckets(history, {
      sinceDay: UsageDay.make("2026-11-18"),
      untilDay: UsageDay.make("2026-11-18"),
      timeZone: "America/New_York",
    });
    assert.deepStrictEqual(
      newYork.map((bucket) => [bucket.day, bucket.seconds]),
      [["2026-11-18", 4500]],
    );
  });

  it("splits an hour that a zone's midnight cuts by time", () => {
    const buckets = computeBuckets(
      {
        machines: {
          bx_one: machine({
            hours: [{ start: DAY_START + 18 * HOUR, seconds: 1800, dollars: 0.018 }],
          }),
        },
      },
      {
        sinceDay: UsageDay.make("2026-11-18"),
        untilDay: UsageDay.make("2026-11-19"),
        timeZone: "Asia/Kolkata",
      },
    );
    assert.deepStrictEqual(
      buckets.map((bucket) => [bucket.day, bucket.seconds]),
      [
        ["2026-11-18", 900],
        ["2026-11-19", 900],
      ],
    );
  });

  it("shares stored hours out to the rolling hours of a 24-hour window", () => {
    const sinceTime = iso(DAY_START + 1.75 * HOUR);
    const buckets = computeBuckets(history, {
      sinceDay: UsageDay.make("2026-11-18"),
      untilDay: UsageDay.make("2026-11-19"),
      timeZone: "UTC",
      resolution: "hour",
      sinceTime,
      untilTime: iso(DAY_START + 25.75 * HOUR),
    });
    assert.deepStrictEqual(
      buckets.map((bucket) => [bucket.hourStart, bucket.seconds]),
      [
        [iso(DAY_START + 22.75 * HOUR), 1350],
        [iso(DAY_START + 23.75 * HOUR), 1800],
        [iso(DAY_START + 24.75 * HOUR), 450 + 900],
      ],
    );
  });
});

describe("settleHistory", () => {
  it("keeps the hours of a VM Boat deleted and drops ones past the longest window", () => {
    const now = DAY_START + 100 * 24 * HOUR;
    const settled = settleHistory(
      {
        machines: {
          bx_deleted: machine({
            hours: [
              { start: DAY_START, seconds: 1800, dollars: 0.018 },
              { start: now - 2 * HOUR, seconds: 1800, dollars: 0.018 },
            ],
          }),
          bx_expired: machine({ hours: [{ start: DAY_START, seconds: 1800, dollars: 0.018 }] }),
        },
      },
      new Map(),
      new Set(),
      now,
    );
    assert.deepStrictEqual(Object.keys(settled.machines), ["bx_deleted"]);
    assert.isTrue(settled.machines.bx_deleted?.gone);
    assert.strictEqual(settled.machines.bx_deleted?.hours.length, 1);
  });
});
