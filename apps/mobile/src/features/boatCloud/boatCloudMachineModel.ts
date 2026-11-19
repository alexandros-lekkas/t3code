import {
  type BoatCloudEnvironmentUsage,
  type BoatCloudMachine,
  type BoatCloudMachineType,
  type BoatCloudMachineTypeOption,
  type BoatCloudStatus,
  type EnvironmentId,
  isListedThreadLineage,
  type OrchestrationV2AppThreadLineage,
} from "@t3tools/contracts";
import { msg } from "gt-react-native";

/** Boat's sizes by id. `default` reads as Medium. */
export const BOAT_CLOUD_MACHINE_TYPE_LABELS: Record<BoatCloudMachineType, string> = {
  small: msg("Small", { $context: "VM size" }),
  default: msg("Medium", { $context: "VM size" }),
  large: msg("Large", { $context: "VM size" }),
  xlarge: msg("Extra large", { $context: "VM size" }),
};

export const BOAT_CLOUD_MACHINE_STATE_LABELS: Record<BoatCloudMachine["state"], string> = {
  running: msg("Running", { $context: "Boat VM state" }),
  starting: msg("Waking", { $context: "Boat VM state" }),
  stopped: msg("Sleeping", { $context: "Boat VM state" }),
  gone: msg("Saved copy", { $context: "Boat VM state, deleted but backed up" }),
};

export function isBoatCloudMachineType(id: string): id is BoatCloudMachineType {
  return Object.hasOwn(BOAT_CLOUD_MACHINE_TYPE_LABELS, id);
}

const sameUrl = (left: string, right: string) =>
  left.replace(/\/+$/u, "").toLowerCase() === right.replace(/\/+$/u, "").toLowerCase();

/**
 * Which environment each VM serves, at most one per VM and one VM per environment. Several VMs
 * can report the same environment (a restored VM and its gone original, or VMs from one image),
 * so the VM this app is paired with by URL wins, then the one the holder says serves it now, and
 * a VM's own report counts only when no other VM claims that environment.
 */
export function boatCloudMachineEnvironments(input: {
  readonly machines: ReadonlyArray<
    Pick<BoatCloudMachine, "sandboxId" | "environmentId" | "httpBaseUrl">
  >;
  readonly environmentUsage: ReadonlyArray<
    Pick<BoatCloudEnvironmentUsage, "environmentId" | "sandboxId">
  >;
  /** Paired Boat VMs, by environment, at the URL each is reached at. */
  readonly pairedUrls: ReadonlyMap<EnvironmentId, string>;
}): Map<string, EnvironmentId> {
  const bySandbox = new Map<string, EnvironmentId>();
  const claimed = new Set<EnvironmentId>();
  const assign = (sandboxId: string, environmentId: EnvironmentId) => {
    if (bySandbox.has(sandboxId) || claimed.has(environmentId)) return;
    bySandbox.set(sandboxId, environmentId);
    claimed.add(environmentId);
  };
  const known = new Set(input.machines.map((machine) => machine.sandboxId));
  for (const [environmentId, url] of input.pairedUrls) {
    const machine = input.machines.find(
      (candidate) => candidate.httpBaseUrl !== null && sameUrl(candidate.httpBaseUrl, url),
    );
    if (machine) assign(machine.sandboxId, environmentId);
  }
  for (const entry of input.environmentUsage) {
    if (known.has(entry.sandboxId)) assign(entry.sandboxId, entry.environmentId);
  }
  const reports = new Map<EnvironmentId, Array<string>>();
  for (const machine of input.machines) {
    if (machine.environmentId === null || bySandbox.has(machine.sandboxId)) continue;
    reports.set(machine.environmentId, [
      ...(reports.get(machine.environmentId) ?? []),
      machine.sandboxId,
    ]);
  }
  for (const [environmentId, sandboxIds] of reports) {
    if (sandboxIds.length === 1) assign(sandboxIds[0]!, environmentId);
  }
  return bySandbox;
}

/**
 * The listed threads on each VM, by the environment each VM serves. Subagents and side chats
 * run inside their parent's VM, so only their parent names it.
 */
export function boatCloudThreadsByMachine<
  Thread extends {
    readonly environmentId: EnvironmentId;
    readonly lineage: OrchestrationV2AppThreadLineage;
  },
>(
  environments: ReadonlyMap<string, EnvironmentId>,
  threads: ReadonlyArray<Thread>,
): Map<string, Array<Thread>> {
  const byEnvironment = new Map<EnvironmentId, Array<Thread>>();
  for (const thread of threads) {
    if (!isListedThreadLineage(thread.lineage)) continue;
    byEnvironment.set(thread.environmentId, [
      ...(byEnvironment.get(thread.environmentId) ?? []),
      thread,
    ]);
  }
  const bySandbox = new Map<string, Array<Thread>>();
  for (const [sandboxId, environmentId] of environments) {
    const onIt = byEnvironment.get(environmentId);
    if (onIt) bySandbox.set(sandboxId, onIt);
  }
  return bySandbox;
}

/** A VM and the holder that reports it: a connected machine, or null for this phone. */
export interface BoatCloudManagedMachine {
  readonly machine: BoatCloudMachine;
  readonly holderEnvironmentId: EnvironmentId | null;
}

/**
 * Every VM once, from the connected machines holding the key and then this phone. A machine's
 * report comes first: it reads usage and stats, and can stop, wake and delete with backups.
 */
export function mergeBoatCloudMachines(
  holders: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly status: BoatCloudStatus;
  }>,
  phone: BoatCloudStatus,
): Array<BoatCloudManagedMachine> {
  const bySandbox = new Map<string, BoatCloudManagedMachine>();
  for (const holder of holders) {
    for (const machine of holder.status.machines) {
      const known = bySandbox.get(machine.sandboxId);
      // Two machines can both list a VM; the one that has read its cost reports it.
      if (known && (known.machine.usage !== null || machine.usage === null)) continue;
      bySandbox.set(machine.sandboxId, { machine, holderEnvironmentId: holder.environmentId });
    }
  }
  for (const machine of phone.machines) {
    if (!bySandbox.has(machine.sandboxId)) {
      bySandbox.set(machine.sandboxId, { machine, holderEnvironmentId: null });
    }
  }
  return [...bySandbox.values()];
}

/** The oldest cost read among the VMs, which is how fresh the figures are. */
export function boatCloudUsageUpdatedAt(machines: ReadonlyArray<BoatCloudMachine>): string | null {
  return (
    machines.flatMap((machine) => (machine.usage ? [machine.usage.updatedAt] : [])).sort()[0] ??
    null
  );
}

/** `$0.018/h`, with `~` when worked out from Boat's base rate rather than quoted. */
export function formatBoatCloudHourly(
  option: BoatCloudMachineTypeOption | undefined,
): string | null {
  if (!option || option.hourlyDollars === null) return null;
  const price = `$${option.hourlyDollars.toFixed(option.hourlyDollars < 1 ? 3 : 2)}/h`;
  return option.priceSource === "derived" ? `~${price}` : price;
}

/** `1.3 h · $0.02`, and `<$0.01` for a tiny cost. */
export function formatBoatCloudCost(seconds: number, dollars: number): string {
  const cost = dollars > 0 && dollars < 0.01 ? "<$0.01" : `$${dollars.toFixed(2)}`;
  return `${(seconds / 3600).toFixed(1)} h · ${cost}`;
}

/** `1.2 / 4.0 GB`. */
export function formatBoatCloudBytes(used: number, total: number): string {
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return `${gb(used)} / ${gb(total)} GB`;
}

export function boatCloudPercent(used: number, total: number): number {
  return total > 0 ? Math.round(Math.max(0, Math.min(100, (used / total) * 100))) : 0;
}
