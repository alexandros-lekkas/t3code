import { describe, expect, it } from "vite-plus/test";

import { type BoatCloudMachine, boatCloudUsageReadAt } from "./boatCloud.ts";

const machine = (
  sandboxId: string,
  state: BoatCloudMachine["state"],
  updatedAt: string | null,
): BoatCloudMachine => ({
  sandboxId,
  environmentId: null,
  label: sandboxId,
  httpBaseUrl: null,
  state,
  repositories: [],
  backedUpAt: null,
  environment: null,
  machineType: "small",
  vcpu: 2,
  memoryGB: 4,
  usage: updatedAt === null ? null : { seconds: 60, dollars: 0.01, updatedAt },
  stats: null,
});

describe("boatCloudUsageReadAt", () => {
  it("is the oldest read among the VMs still billed", () => {
    expect(
      boatCloudUsageReadAt([
        machine("a", "running", "2026-11-20T23:45:00.000Z"),
        machine("b", "starting", "2026-11-20T23:44:00.000Z"),
      ]),
    ).toBe("2026-11-20T23:44:00.000Z");
  });

  it("is not aged by a sleeping VM, whose cost was read for the last time when it stopped", () => {
    expect(
      boatCloudUsageReadAt([
        machine("asleep", "stopped", "2026-11-20T16:40:00.000Z"),
        machine("saved", "gone", "2026-11-19T10:00:00.000Z"),
        machine("live", "running", "2026-11-20T23:45:00.000Z"),
      ]),
    ).toBe("2026-11-20T23:45:00.000Z");
  });

  it("is null when no VM runs or none has been read", () => {
    expect(boatCloudUsageReadAt([machine("asleep", "stopped", "2026-11-20T16:40:00.000Z")])).toBe(
      null,
    );
    expect(boatCloudUsageReadAt([machine("fresh", "running", null)])).toBe(null);
  });
});
