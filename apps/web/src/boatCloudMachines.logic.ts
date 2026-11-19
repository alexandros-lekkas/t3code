import type {
  BoatCloudMachine,
  BoatCloudStatus,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";

/** How the browser records which VM each thread it started went to. */
export const boatCloudThreadMachineKey = (ref: ScopedThreadRef) =>
  `${ref.environmentId}:${ref.threadId}`;

/**
 * Running VMs this machine handed out that this client has never paired with, such as one an
 * agent launched a thread on. Pairing with a running VM costs nothing, so the client does it to
 * list their threads; a sleeping one waits until a thread on it is opened.
 */
export function boatCloudMachinesToPair(input: {
  readonly status: BoatCloudStatus | null;
  readonly knownEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly attemptedSandboxIds: ReadonlySet<string>;
}): ReadonlyArray<BoatCloudMachine & { readonly environmentId: EnvironmentId }> {
  // A start in flight pairs its own client with the VM it hands out.
  if (input.status === null || !input.status.connected || input.status.starts.length > 0) return [];
  return input.status.machines.flatMap((machine) =>
    machine.state === "running" &&
    machine.environmentId !== null &&
    !input.knownEnvironmentIds.has(machine.environmentId) &&
    !input.attemptedSandboxIds.has(machine.sandboxId)
      ? [{ ...machine, environmentId: machine.environmentId }]
      : [],
  );
}

/** The VM this machine handed out for an environment, so a link to its thread can reach it. */
export function managedBoatCloudMachine(
  status: BoatCloudStatus | null,
  environmentId: EnvironmentId | null,
): BoatCloudMachine | null {
  if (status === null || !status.connected || environmentId === null) return null;
  return status.machines.find((machine) => machine.environmentId === environmentId) ?? null;
}

/**
 * The VM a thread runs on: the one this browser started it on, or else the only VM serving its
 * Boat cloud environment (a thread an agent launched there, or one opened from a link).
 */
export function boatCloudMachineOfThread(input: {
  readonly status: BoatCloudStatus | null;
  readonly threadMachines: Readonly<Record<string, string>>;
  readonly ref: ScopedThreadRef;
  readonly onBoatCloud: boolean;
}): BoatCloudMachine | null {
  const { status, ref } = input;
  if (status === null || !status.connected) return null;
  const sandboxId = input.threadMachines[boatCloudThreadMachineKey(ref)];
  if (sandboxId !== undefined) {
    return status.machines.find((machine) => machine.sandboxId === sandboxId) ?? null;
  }
  if (!input.onBoatCloud) return null;
  const serving = status.machines.filter((machine) => machine.environmentId === ref.environmentId);
  return serving.length === 1 ? serving[0]! : null;
}

/**
 * A draft on Boat starts a VM of its own when it sends, so the VM its project sits on now is
 * neither woken nor shown as sleeping for it.
 */
export function draftStartsOwnBoatCloudMachine(
  draft: {
    readonly environmentSelection?: string | undefined;
    readonly promotedTo?: unknown;
  } | null,
): boolean {
  return draft?.environmentSelection === "cloud" && !draft.promotedTo;
}
