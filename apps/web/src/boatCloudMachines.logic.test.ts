import {
  type BoatCloudMachine,
  type BoatCloudStatus,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boatCloudEnvironmentsToForget,
  boatCloudMachineOfThread,
  boatCloudMachinesToPair,
  boatCloudThreadMachineKey,
  draftStartsOwnBoatCloudMachine,
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

describe("boatCloudEnvironmentsToForget", () => {
  const stopped = EnvironmentId.make("stopped-env");
  const gone = EnvironmentId.make("gone-env");
  const deleted = EnvironmentId.make("deleted-env");
  const live = EnvironmentId.make("other-holder-env");
  const held = status([
    machine("running", "running", vmEnvironment),
    machine("stopped", "stopped", stopped),
    machine("restorable", "gone", gone),
  ]);
  const forget = (input: Partial<Parameters<typeof boatCloudEnvironmentsToForget>[0]>) =>
    boatCloudEnvironmentsToForget({
      status: held,
      boatCloudEnvironmentIds: [vmEnvironment, stopped, gone, deleted, live],
      connectedEnvironmentIds: new Set([vmEnvironment, live]),
      ...input,
    });

  it("forgets only VMs the holder dropped, keeping ones a wake can still restore", () => {
    expect(forget({})).toEqual([deleted]);
  });

  it("forgets nothing until the holder's list is in, or while a start pairs its VM", () => {
    expect(forget({ status: null })).toEqual([]);
    expect(forget({ status: { ...held, connected: false } })).toEqual([]);
    expect(forget({ status: status(held.machines, [{ requestId: "start", steps: [] }]) })).toEqual(
      [],
    );
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

describe("draftStartsOwnBoatCloudMachine", () => {
  it("is true for a Boat draft, so a sleeping VM its project sits on is not shown or woken", () => {
    expect(draftStartsOwnBoatCloudMachine({ environmentSelection: "cloud" })).toBe(true);
    expect(draftStartsOwnBoatCloudMachine({ environmentSelection: "manual" })).toBe(false);
    expect(
      draftStartsOwnBoatCloudMachine({
        environmentSelection: "cloud",
        promotedTo: { environmentId: vmEnvironment, threadId: ThreadId.make("t") },
      }),
    ).toBe(false);
    expect(draftStartsOwnBoatCloudMachine(null)).toBe(false);
  });
});
