import {
  type BoatCloudMachine,
  type BoatCloudStatus,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boatCloudMachineOfThread,
  boatCloudMachinesToPair,
  boatCloudThreadMachineKey,
  managedBoatCloudMachine,
} from "./boatCloudMachines.logic";

const vmEnvironment = EnvironmentId.make("vm-env");
const pairedEnvironment = EnvironmentId.make("paired-env");

const machine = (
  sandboxId: string,
  state: BoatCloudMachine["state"],
  environmentId: EnvironmentId | null,
): BoatCloudMachine => ({
  sandboxId,
  environmentId,
  label: sandboxId,
  httpBaseUrl: `https://${sandboxId}.boat.dev`,
  state,
  repositories: [],
  backedUpAt: null,
  environment: null,
  machineType: "small",
  vcpu: 2,
  memoryGB: 4,
  usage: null,
  stats: null,
});

const status = (
  machines: ReadonlyArray<BoatCloudMachine>,
  starts: BoatCloudStatus["starts"] = [],
): BoatCloudStatus => ({ connected: true, machines, starts }) as unknown as BoatCloudStatus;

describe("boatCloudMachinesToPair", () => {
  const machines = [
    machine("running-new", "running", vmEnvironment),
    machine("running-paired", "running", pairedEnvironment),
    machine("sleeping", "stopped", EnvironmentId.make("sleeping-env")),
    machine("spare", "running", null),
  ];
  const toPair = (input: Partial<Parameters<typeof boatCloudMachinesToPair>[0]>) =>
    boatCloudMachinesToPair({
      status: status(machines),
      knownEnvironmentIds: new Set([pairedEnvironment]),
      attemptedSandboxIds: new Set(),
      ...input,
    }).map((entry) => entry.sandboxId);

  it("pairs only running VMs serving an environment this client does not know", () => {
    expect(toPair({})).toEqual(["running-new"]);
  });

  it("tries each VM once, and waits while a start pairs its own client", () => {
    expect(toPair({ attemptedSandboxIds: new Set(["running-new"]) })).toEqual([]);
    expect(toPair({ status: status(machines, [{ requestId: "start", steps: [] }]) })).toEqual([]);
    expect(toPair({ status: null })).toEqual([]);
  });
});

describe("boatCloudMachineOfThread", () => {
  const ref = { environmentId: vmEnvironment, threadId: ThreadId.make("thread") };
  const first = machine("first", "running", vmEnvironment);
  const second = machine("second", "stopped", vmEnvironment);

  it("finds the VM this browser started the thread on, even when VMs share an environment", () => {
    expect(
      boatCloudMachineOfThread({
        status: status([first, second]),
        threadMachines: { [boatCloudThreadMachineKey(ref)]: "second" },
        ref,
        onBoatCloud: true,
      })?.sandboxId,
    ).toBe("second");
  });

  it("falls back to the only VM serving a Boat environment, and to none when it is ambiguous", () => {
    const of = (machines: ReadonlyArray<BoatCloudMachine>, onBoatCloud = true) =>
      boatCloudMachineOfThread({ status: status(machines), threadMachines: {}, ref, onBoatCloud })
        ?.sandboxId ?? null;
    expect(of([first])).toBe("first");
    expect(of([first, second])).toBeNull();
    expect(of([first], false)).toBeNull();
  });

  it("names the VM serving a linked thread's environment", () => {
    expect(managedBoatCloudMachine(status([first]), vmEnvironment)?.sandboxId).toBe("first");
    expect(managedBoatCloudMachine(status([first]), pairedEnvironment)).toBeNull();
  });
});
