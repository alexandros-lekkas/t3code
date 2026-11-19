import type { BoatCloudMachine, BoatCloudStatus } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boatCloudMachineEnvironments,
  boatCloudThreadsByMachine,
  formatBoatCloudCost,
  mergeBoatCloudMachines,
} from "./boatCloudMachineModel";
import { managedBoatCloudEnvironmentIds } from "./boatCloudManagedEnvironments";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const holderId = EnvironmentId.make("mac");

const machine = (patch: Partial<BoatCloudMachine> & { sandboxId: string }): BoatCloudMachine => ({
  environmentId: null,
  label: patch.sandboxId,
  httpBaseUrl: `https://${patch.sandboxId}-3773.on.boat.dev`,
  state: "running",
  repositories: [],
  backedUpAt: null,
  environment: null,
  machineType: "small",
  vcpu: 2,
  memoryGB: 4,
  usage: null,
  stats: null,
  ...patch,
});

const status = (patch: Partial<BoatCloudStatus>): BoatCloudStatus => ({
  connected: true,
  account: null,
  setup: { status: "ready", step: null, error: null },
  snapshotReady: true,
  machines: [],
  starts: [],
  environment: null,
  environments: [],
  environmentsError: null,
  githubConnected: null,
  shareMachines: false,
  keepReadyMachine: false,
  defaultMachineType: "small",
  machineTypes: [],
  environmentUsage: [],
  ...patch,
});

const thread = (environmentId: EnvironmentId, id: string, subagent = false) => ({
  environmentId,
  id: ThreadId.make(id),
  lineage: {
    parentThreadId: subagent ? ThreadId.make("parent") : null,
    relationshipToParent: subagent ? ("subagent" as const) : null,
    rootThreadId: ThreadId.make(id),
  },
});

describe("boatCloudMachineEnvironments", () => {
  it("gives each environment to one VM when two VMs report the same one", () => {
    // Two VMs from one image both say they serve env-a; only the paired one does.
    const machines = [
      machine({ sandboxId: "vm1", environmentId: envA }),
      machine({ sandboxId: "vm2", environmentId: envA }),
    ];
    const environments = boatCloudMachineEnvironments({
      machines,
      environmentUsage: [],
      pairedUrls: new Map([[envA, "https://vm2-3773.on.boat.dev/"]]),
    });
    expect([...environments]).toEqual([["vm2", envA]]);
    const threads = boatCloudThreadsByMachine(environments, [
      thread(envA, "t1"),
      thread(envB, "t2"),
    ]);
    expect(threads.get("vm1")).toBeUndefined();
    expect(threads.get("vm2")?.map((entry) => entry.id)).toEqual(["t1"]);
  });

  it("follows the holder's VM for an environment over a VM's own report", () => {
    const environments = boatCloudMachineEnvironments({
      machines: [
        machine({ sandboxId: "old", environmentId: envA, state: "gone" }),
        machine({ sandboxId: "new", environmentId: envA }),
      ],
      environmentUsage: [{ environmentId: envA, sandboxId: "new" }],
      pairedUrls: new Map(),
    });
    expect([...environments]).toEqual([["new", envA]]);
  });

  it("trusts a VM's own report only when no other VM claims the environment", () => {
    const environments = boatCloudMachineEnvironments({
      machines: [
        machine({ sandboxId: "vm1", environmentId: envA }),
        machine({ sandboxId: "vm2", environmentId: envA }),
        machine({ sandboxId: "vm3", environmentId: envB }),
        machine({ sandboxId: "spare" }),
      ],
      environmentUsage: [],
      pairedUrls: new Map(),
    });
    expect([...environments]).toEqual([["vm3", envB]]);
  });
});

describe("boatCloudThreadsByMachine", () => {
  it("leaves subagents to their parent", () => {
    const threads = boatCloudThreadsByMachine(new Map([["vm", envA]]), [
      thread(envA, "parent"),
      thread(envA, "child", true),
    ]);
    expect(threads.get("vm")?.map((entry) => entry.id)).toEqual(["parent"]);
  });
});

describe("mergeBoatCloudMachines", () => {
  it("lists each VM once, from the machine that read its cost before this phone", () => {
    const usage = { seconds: 4680, dollars: 0.02, updatedAt: "2026-11-19T12:00:00.000Z" };
    const merged = mergeBoatCloudMachines(
      [
        {
          environmentId: EnvironmentId.make("other"),
          status: status({ machines: [machine({ sandboxId: "vm" })] }),
        },
        {
          environmentId: holderId,
          status: status({ machines: [machine({ sandboxId: "vm", usage })] }),
        },
      ],
      status({ machines: [machine({ sandboxId: "vm" }), machine({ sandboxId: "phone-only" })] }),
    );
    expect(merged.map((entry) => [entry.machine.sandboxId, entry.holderEnvironmentId])).toEqual([
      ["vm", holderId],
      ["phone-only", null],
    ]);
  });
});

describe("managedBoatCloudEnvironmentIds", () => {
  it("collects the environments the machines handed VMs to", () => {
    const ids = managedBoatCloudEnvironmentIds([
      status({
        machines: [
          machine({ sandboxId: "vm", environmentId: envA }),
          machine({ sandboxId: "spare" }),
        ],
      }),
      status({
        environmentUsage: [
          {
            environmentId: envB,
            sandboxId: "vm2",
            state: "stopped",
            machineType: null,
            vcpu: null,
            memoryGB: null,
            seconds: 0,
            hours: 0,
            dollars: 0,
            shared: false,
            machines: 1,
            usageUpdatedAt: null,
            stats: null,
          },
        ],
      }),
    ]);
    expect([...ids].sort()).toEqual([envA, envB]);
  });
});

describe("formatBoatCloudCost", () => {
  it("reads hours and dollars, and marks a tiny cost", () => {
    expect(formatBoatCloudCost(4680, 0.0234)).toBe("1.3 h · $0.02");
    expect(formatBoatCloudCost(60, 0.0004)).toBe("0.0 h · <$0.01");
    expect(formatBoatCloudCost(0, 0)).toBe("0.0 h · $0.00");
  });
});
