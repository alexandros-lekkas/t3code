import type {
  BoatCloudMachine,
  BoatCloudMachineState,
  BoatCloudMachineTypeOption,
  BoatCloudStatus,
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
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
 * A new thread never starts on a Boat VM, which serves only the thread it was started for. It
 * goes to an open copy of the same project on one of the user's machines, this one first, and
 * stays put only when there is none.
 */
export function newThreadProjectRef<
  P extends {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly archivedAt?: string | null | undefined;
  },
>(input: {
  readonly projectRef: ScopedProjectRef;
  readonly projects: ReadonlyArray<P>;
  readonly logicalProjectKeyOf: (project: P) => string;
  readonly boatCloudEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): ScopedProjectRef {
  const { projectRef, boatCloudEnvironmentIds } = input;
  if (!boatCloudEnvironmentIds.has(projectRef.environmentId)) return projectRef;
  const requested = input.projects.find(
    (project) =>
      project.environmentId === projectRef.environmentId && project.id === projectRef.projectId,
  );
  if (requested === undefined) return projectRef;
  const key = input.logicalProjectKeyOf(requested);
  const candidates = input.projects.filter(
    (project) =>
      project.archivedAt == null &&
      !boatCloudEnvironmentIds.has(project.environmentId) &&
      input.logicalProjectKeyOf(project) === key,
  );
  const target =
    candidates.find((project) => project.environmentId === input.primaryEnvironmentId) ??
    candidates[0];
  return target ? { environmentId: target.environmentId, projectId: target.id } : projectRef;
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

/**
 * Paired Boat VM environments this machine no longer holds in any state: Boat deleted the VM
 * and no backup can bring it back, so nothing of it can open again. A VM listed as stopped or
 * gone stays, since waking a thread on it restores it. One that is connected is alive (another
 * holder's, say) and stays too.
 */
export function boatCloudEnvironmentsToForget(input: {
  readonly status: BoatCloudStatus | null;
  readonly boatCloudEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<EnvironmentId> {
  const { status } = input;
  // A start in flight pairs its client before the holder may list the VM's environment.
  if (status === null || !status.connected || status.starts.length > 0) return [];
  const held = new Set(status.machines.map((machine) => machine.environmentId));
  return input.boatCloudEnvironmentIds.filter(
    (environmentId) =>
      !held.has(environmentId) && !input.connectedEnvironmentIds.has(environmentId),
  );
}

/** The listed top-level threads on each VM, by sandbox. */
export function boatCloudThreadsByMachine<
  Shell extends {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly lineage: { readonly relationshipToParent: string | null };
  },
>(input: {
  readonly status: BoatCloudStatus | null;
  readonly threadMachines: Readonly<Record<string, string>>;
  readonly shells: ReadonlyArray<Shell>;
  readonly onBoatCloud: (environmentId: EnvironmentId) => boolean;
}): ReadonlyMap<string, ReadonlyArray<Shell>> {
  const byMachine = new Map<string, Array<Shell>>();
  for (const shell of input.shells) {
    if (shell.lineage.relationshipToParent === "subagent") continue;
    const machine = boatCloudMachineOfThread({
      status: input.status,
      threadMachines: input.threadMachines,
      ref: { environmentId: shell.environmentId, threadId: shell.id },
      onBoatCloud: input.onBoatCloud(shell.environmentId),
    });
    if (machine === null) continue;
    const list = byMachine.get(machine.sandboxId) ?? [];
    list.push(shell);
    byMachine.set(machine.sandboxId, list);
  }
  return byMachine;
}

/** Where a VM's load reads as an error. */
export const BOAT_CLOUD_LOAD_ERROR_PERCENT = 90;

export type BoatCloudMachineStateLabel = BoatCloudMachineState | "resizing";

/** A resize reads as itself rather than the wake it runs as. */
export function boatCloudMachineStateLabel(
  machine: Pick<BoatCloudMachine, "state" | "resizingTo">,
  resizeSent: boolean,
): BoatCloudMachineStateLabel {
  return machine.resizingTo !== null || resizeSent ? "resizing" : machine.state;
}

/** Boat cannot resize a VM mid-wake or mid-resize, nor one it only keeps a saved copy of. */
export function boatCloudResizeBlocked(
  machine: Pick<BoatCloudMachine, "state" | "resizingTo">,
): boolean {
  return machine.resizingTo !== null || machine.state === "starting" || machine.state === "gone";
}

/**
 * Memory nearly full with a roomier size the plan can start. CPU is left out, since a build
 * pegs it, and disk too: a resize keeps the VM's disk as it is.
 */
export function boatCloudLowOnMemory(input: {
  readonly memoryPercent: number | null;
  readonly memoryGB: number | null;
  readonly machineTypes: ReadonlyArray<BoatCloudMachineTypeOption>;
}): boolean {
  const { memoryPercent, memoryGB } = input;
  return (
    memoryPercent !== null &&
    memoryGB !== null &&
    memoryPercent >= BOAT_CLOUD_LOAD_ERROR_PERCENT &&
    input.machineTypes.some((option) => option.available && option.memoryGB > memoryGB)
  );
}

/**
 * What a resize interrupts, so it asks first; null when nothing runs on the VM to stop.
 * `shared` when other threads use the VM, whether or not this client lists them.
 */
export function boatCloudResizeInterrupts(input: {
  readonly machine: Pick<BoatCloudMachine, "state">;
  readonly threads: ReadonlyArray<{ readonly running: boolean }>;
  readonly shared: boolean;
}): { readonly shared: boolean } | null {
  if (input.machine.state !== "running") return null;
  const shared = input.shared || input.threads.length > 1;
  return shared || input.threads.some((thread) => thread.running) ? { shared } : null;
}
