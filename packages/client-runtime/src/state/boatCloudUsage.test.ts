import { describe, expect, it } from "vite-plus/test";
import { BoatCloudStatus, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { boatCloudEnvironmentUsageOf } from "./boatCloudUsage.ts";

const decodeStatus = Schema.decodeSync(BoatCloudStatus);

describe("boatCloudEnvironmentUsageOf", () => {
  it("finds a cloud environment's VM and cost in its holder's status", () => {
    // An older holder sends no usage, so the field decodes empty.
    const status = decodeStatus({
      connected: true,
      account: null,
      setup: { status: "ready", step: null, error: null },
      machines: [],
      starts: [],
      environment: null,
      environments: [],
      environmentsError: null,
    });
    expect(status.environmentUsage).toEqual([]);
    expect(status.shareMachines).toBe(false);
    expect(status.keepReadyMachine).toBe(false);
    expect(status.githubConnected).toBeNull();
    expect(status.defaultMachineType).toBe("small");
    const entry = {
      environmentId: EnvironmentId.make("env-1"),
      sandboxId: "vm-1",
      state: "running" as const,
      machineType: "small",
      vcpu: 2,
      memoryGB: 4,
      seconds: 3600,
      hours: 1,
      dollars: 0.018,
      shared: false,
      machines: 1,
      usageUpdatedAt: "2026-11-19T00:00:00.000Z",
      stats: null,
    };
    const withUsage = { ...status, environmentUsage: [entry] };
    expect(boatCloudEnvironmentUsageOf(withUsage, EnvironmentId.make("env-1"))).toEqual(entry);
    expect(boatCloudEnvironmentUsageOf(withUsage, EnvironmentId.make("env-2"))).toBeNull();
    expect(boatCloudEnvironmentUsageOf(null, EnvironmentId.make("env-1"))).toBeNull();
  });
});
