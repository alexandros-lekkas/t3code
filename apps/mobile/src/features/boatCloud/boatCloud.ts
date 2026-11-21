import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  BOAT_CLOUD_START_STEPS,
  type BoatCloudAcquireInput,
  type BoatCloudMachineType,
  type BoatCloudSession,
  type BoatCloudStartStep,
  type BoatCloudStatus,
  type BoatCloudStepProgress,
  type EnvironmentId,
} from "@t3tools/contracts";
import { boatCloudAgentDrivers } from "@t3tools/shared/boatCloudVm";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react-native";
import { useEffect, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { environmentCatalog } from "../../connection/catalog";
import { connectPairingCode } from "../../connection/onboarding";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import {
  type BoatCloudHolder,
  boatCloudHoldersAtom,
  boatCloudMachinesAtom,
  boatCloudResizingAtom,
  boatCloudWakingAtom,
  noteBoatCloudHolders,
  readBoatCloudHoldersOnce,
} from "./boatCloudManaged";
import { boatCloudMachineEnvironments } from "./boatCloudMachineModel";
import { managedBoatCloudEnvironmentIds } from "./boatCloudManagedEnvironments";
import {
  ensurePhoneBoatCloudLoaded,
  phoneBoatCloudAtom,
  startOnPhone,
  wakeOnPhone,
} from "./phoneBoatCloud";

/**
 * Boat cloud VMs are ordinary environments. A holder of the Boat key hands out
 * a VM, and this app pairs with it like any other machine. The holder is a
 * connected machine when one has the key, else this phone.
 */

const PROJECT_APPEAR_TIMEOUT_MS = 60_000;
const RECONNECT_TIMEOUT_MS = 15_000;
const WAKE_CONNECT_TIMEOUT_MS = 90_000;

export { boatCloudHoldersAtom, boatCloudMachinesAtom };

/** Who starts a VM: a connected machine with the key, or this phone with its own. */
type BoatCloudStarter =
  | { readonly kind: "machine"; readonly environmentId: EnvironmentId }
  | { readonly kind: "phone" };

/** Connected machines whose T3 Code predates Boat cloud, so they cannot take the key yet. */
export const boatCloudOutdatedMachinesAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const machines = get(boatCloudMachinesAtom);
  return get(connectedEnvironmentIdsAtom).filter((environmentId) => {
    if (machines.has(environmentId)) return false;
    const config = get(serverEnvironment.configValueAtom(environmentId));
    return config !== null && config.environment.capabilities.boatCloud !== true;
  });
}).pipe(Atom.withLabel("mobile-boat-cloud:outdated-machines"));

function boatCloudReady(status: BoatCloudStatus | null | undefined) {
  return status?.connected === true && (status.setup.status === "ready" || status.snapshotReady);
}

/**
 * The holder that should start a VM: the draft's own machine when it can, then
 * any ready machine, which keeps session backups, then this phone.
 */
function boatCloudStarterFor(
  holders: ReadonlyArray<BoatCloudHolder>,
  phone: BoatCloudStatus,
  preferredEnvironmentId: EnvironmentId | null,
): BoatCloudStarter | null {
  const ready = holders.filter((holder) => boatCloudReady(holder.status));
  const machine =
    ready.find((holder) => holder.environmentId === preferredEnvironmentId) ?? ready[0];
  if (machine) return { kind: "machine", environmentId: machine.environmentId };
  return boatCloudReady(phone) ? { kind: "phone" } : null;
}

export function useBoatCloudStarter(preferredEnvironmentId: EnvironmentId | null) {
  const holders = useAtomValue(boatCloudHoldersAtom);
  const phone = useAtomValue(phoneBoatCloudAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this phone's Boat key from the keychain once per launch
  useEffect(() => {
    void ensurePhoneBoatCloudLoaded();
  }, []);
  return boatCloudStarterFor(holders, phone, preferredEnvironmentId);
}

/** The status of the holder that would start a VM now: its sizes, prices and environment. */
export function useBoatCloudStarterStatus(
  preferredEnvironmentId: EnvironmentId | null,
): BoatCloudStatus | null {
  const holders = useAtomValue(boatCloudHoldersAtom);
  const phone = useAtomValue(phoneBoatCloudAtom);
  const starter = boatCloudStarterFor(holders, phone, preferredEnvironmentId);
  if (starter?.kind === "machine") {
    return holders.find((holder) => holder.environmentId === starter.environmentId)?.status ?? null;
  }
  return starter?.kind === "phone" ? phone : null;
}

/** The providers a new VM from this starter has sign-ins for, or null when unknown. */
export function useBoatCloudProviderDrivers(preferredEnvironmentId: EnvironmentId | null) {
  return boatCloudAgentDrivers(useBoatCloudStarterStatus(preferredEnvironmentId));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : m(msg("An error occurred."));
}

/** Paired VMs as the holder takes them, so it skips their pairing code. */
const pairedBoatCloudEnvironments = (): NonNullable<BoatCloudAcquireInput["paired"]> =>
  [...appAtomRegistry.get(boatCloudMachinesAtom)].map(([environmentId, httpBaseUrl]) => ({
    environmentId,
    httpBaseUrl,
  }));

const reconnectFailed = new Error("Could not reconnect to the Boat machine.");

/** Resolves once the environment is connected, or false after `timeoutMs`. */
function waitForConnected(environmentId: EnvironmentId, timeoutMs: number): Promise<boolean> {
  const connected = () => appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(environmentId);
  if (connected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (result: boolean) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = appAtomRegistry.subscribe(connectedEnvironmentIdsAtom, () => {
      if (connected()) finish(true);
    });
  });
}

/**
 * Connects this app to the VM: with its saved credential when the holder sent no
 * pairing code, else by pairing. Throws what failed.
 */
async function attach(
  session: Pick<BoatCloudSession, "environmentId" | "httpBaseUrl" | "pairingCode">,
) {
  if (appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(session.environmentId)) return;
  if (session.pairingCode === null) {
    // A stopped VM left its connection backing off; retry now that the server is up.
    void environmentCatalog.retryNow.run(appAtomRegistry, session.environmentId);
    if (!(await waitForConnected(session.environmentId, RECONNECT_TIMEOUT_MS))) {
      throw reconnectFailed;
    }
    return;
  }
  const paired = await runAtomCommand(
    appAtomRegistry,
    connectPairingCode,
    {
      host: session.httpBaseUrl,
      pairingCode: session.pairingCode,
      expectedEnvironmentId: session.environmentId,
    },
    { label: connectPairingCode.label, reportFailure: false, reportDefect: true },
  );
  if (paired._tag === "Failure") throw squashAtomCommandFailure(paired);
}

function waitForProject(
  find: (projects: ReadonlyArray<EnvironmentProject>) => EnvironmentProject | undefined,
): Promise<EnvironmentProject | null> {
  const atom = environmentProjects.projectsAtom;
  const now = find(appAtomRegistry.get(atom));
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const finish = (project: EnvironmentProject | null) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(project);
    };
    const timeout = setTimeout(() => finish(null), PROJECT_APPEAR_TIMEOUT_MS);
    const unsubscribe = appAtomRegistry.subscribe(atom, (projects) => {
      const project = find(projects);
      if (project) finish(project);
    });
  });
}

const cancelled = new Error("Boat cloud start cancelled");

const HOLDER_STEPS = new Set<BoatCloudStartStep>(["machine", "server", "repository"]);

const pendingBoatCloudSteps = (): ReadonlyArray<BoatCloudStepProgress> =>
  BOAT_CLOUD_START_STEPS.map((step) => ({ step, state: "pending", detail: null }));

/**
 * Starts the VM through a connected machine. Its steps arrive in that machine's
 * status, the checkout's after the acquire returns, so the caller stops watching.
 */
function startOnMachine(input: {
  readonly environmentId: EnvironmentId;
  readonly repositoryUrl: string;
  readonly baseBranch: string | null;
  readonly paired: BoatCloudAcquireInput["paired"];
  readonly machineType: BoatCloudMachineType | null;
  readonly onHolderSteps: (steps: ReadonlyArray<BoatCloudStepProgress>) => void;
}) {
  const requestId = uuidv4();
  const statusAtom = serverEnvironment.boatCloudStatus({
    environmentId: input.environmentId,
    input: {},
  });
  const stopWatching = appAtomRegistry.subscribe(statusAtom, (result) => {
    const start = AsyncResult.getOrElse(result, () => null)?.starts.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (start) input.onHolderSteps(start.steps.filter((step) => HOLDER_STEPS.has(step.step)));
  });
  const session = runAtomCommand(
    appAtomRegistry,
    serverEnvironment.acquireBoatCloud,
    {
      environmentId: input.environmentId,
      input: {
        repositoryUrl: input.repositoryUrl,
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        ...(input.machineType ? { machineType: input.machineType } : {}),
        requestId,
        paired: input.paired,
      },
    },
    { label: serverEnvironment.acquireBoatCloud.label, reportFailure: false, reportDefect: true },
  ).then((acquired): BoatCloudSession => {
    if (acquired._tag === "Failure") {
      throw isAtomCommandInterrupted(acquired) ? cancelled : squashAtomCommandFailure(acquired);
    }
    return acquired.value;
  });
  return { session, stopWatching };
}

/** A new pairing code for a VM a start handed out, so the app pairs with it rather than start another. */
async function repair(starter: BoatCloudStarter, session: BoatCloudSession) {
  if (starter.kind === "phone") return wakeOnPhone(session.httpBaseUrl, true);
  const woken = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.wakeBoatCloud,
    {
      environmentId: starter.environmentId,
      input: { environmentId: session.environmentId, httpBaseUrl: session.httpBaseUrl },
    },
    { label: serverEnvironment.wakeBoatCloud.label, reportFailure: false, reportDefect: true },
  );
  if (woken._tag === "Failure") throw squashAtomCommandFailure(woken);
  return woken.value;
}

/**
 * Gets a VM with the repository checked out and returns its project there, so
 * a draft can move onto it, reporting every step on the way. The caller marks
 * the last step, moving the thread, done. Null after telling the user what failed.
 */
export async function prepareBoatCloudProject(input: {
  readonly starter: BoatCloudStarter;
  readonly repositoryUrl: string;
  readonly baseBranch: string | null;
  /** The VM size; the holder's default when null. */
  readonly machineType: BoatCloudMachineType | null;
  readonly onProgress: (steps: ReadonlyArray<BoatCloudStepProgress>) => void;
}): Promise<EnvironmentProject | null> {
  let steps = pendingBoatCloudSteps();
  const set = (step: BoatCloudStartStep, patch: Partial<BoatCloudStepProgress>) => {
    steps = steps.map((entry) => (entry.step === step ? { ...entry, ...patch } : entry));
    input.onProgress(steps);
  };
  // The checkout keeps running after the acquire returns, and only its step says how it ended.
  let checkoutFailed: (error: Error) => void = () => undefined;
  const checkoutFailure = new Promise<never>((_, reject) => {
    checkoutFailed = reject;
  });
  const setHolderStep = (step: BoatCloudStartStep, patch: Partial<BoatCloudStepProgress>) => {
    set(step, patch);
    if (step === "repository" && patch.state === "failed") {
      checkoutFailed(new Error(patch.detail ?? "Could not get the repository on the VM."));
    }
  };
  const setHolderSteps = (holderSteps: ReadonlyArray<BoatCloudStepProgress>) => {
    for (const entry of holderSteps) setHolderStep(entry.step, entry);
  };
  const stops: Array<() => void> = [];
  const start = (paired: BoatCloudAcquireInput["paired"]) => {
    if (input.starter.kind === "phone") {
      return startOnPhone({
        repositoryUrl: input.repositoryUrl,
        baseBranch: input.baseBranch,
        paired,
        machineType: input.machineType ?? undefined,
        report: (step, state, detail) => Effect.sync(() => setHolderStep(step, { state, detail })),
      });
    }
    const started = startOnMachine({
      environmentId: input.starter.environmentId,
      repositoryUrl: input.repositoryUrl,
      baseBranch: input.baseBranch,
      paired,
      machineType: input.machineType,
      onHolderSteps: setHolderSteps,
    });
    stops.push(started.stopWatching);
    return started.session;
  };
  let current: BoatCloudStartStep = "machine";
  try {
    let session = await start(pairedBoatCloudEnvironments());
    // The VM and its server are up; the checkout may still run while this app connects.
    set("machine", { state: "done" });
    set("server", { state: "done" });
    if (steps.find((entry) => entry.step === "repository")?.state === "pending") {
      set("repository", { state: "active" });
    }
    current = "connect";
    set("connect", { state: "active" });
    try {
      await attach(session);
    } catch (error) {
      if (error !== reconnectFailed) throw error;
      // The saved credential no longer works, so pair again with the same VM, as a new app.
      const repaired = await repair(input.starter, session);
      session = {
        ...session,
        httpBaseUrl: repaired.httpBaseUrl,
        pairingCode: repaired.pairingCode,
      };
      await attach(session);
    }
    set("connect", { state: "done" });
    current = "project";
    const project = await Promise.race([
      waitForProject((projects) =>
        projects.find(
          (candidate) =>
            candidate.environmentId === session.environmentId &&
            candidate.workspaceRoot === session.workspaceRoot,
        ),
      ),
      checkoutFailure,
    ]);
    if (!project) throw new Error("The Boat machine did not open the project.");
    // The project is added after the checkout, so it appearing means the checkout is done.
    set("repository", { state: "done" });
    set("project", { state: "done" });
    set("thread", { state: "active" });
    return project;
  } catch (error) {
    if (!steps.some((entry) => entry.state === "failed")) {
      set(current, { state: "failed" });
    }
    if (error !== cancelled)
      Dialog.alert(
        m(msg("Could not start on {product}", { product: "Boat" })),
        errorMessage(error),
      );
    return null;
  } finally {
    for (const stop of stops) stop();
  }
}

const wakesInFlight = new Map<EnvironmentId, Promise<boolean>>();

/**
 * Turns a stopped VM back on. A machine that owns it can also restore it from
 * its backup and hands out a new pairing; the phone reconnects to the same server.
 */
function wakeBoatCloudMachine(environmentId: EnvironmentId, httpBaseUrl: string): Promise<boolean> {
  const inFlight = wakesInFlight.get(environmentId);
  if (inFlight) return inFlight;
  const waking = boatCloudWakingAtom(environmentId);
  appAtomRegistry.set(waking, true);
  const wake = (async () => {
    await ensurePhoneBoatCloudLoaded();
    const holders = appAtomRegistry.get(boatCloudHoldersAtom);
    const phoneHasKey = appAtomRegistry.get(phoneBoatCloudAtom).connected;
    // The machine that started the VM can restore it; any other machine with the key can wake it.
    const owner =
      holders.find((holder) =>
        holder.status.machines.some((machine) => machine.environmentId === environmentId),
      ) ?? (phoneHasKey ? undefined : holders.find((holder) => holder.status.connected));
    if (owner) {
      const woken = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.wakeBoatCloud,
        { environmentId: owner.environmentId, input: { environmentId, httpBaseUrl } },
        { label: serverEnvironment.wakeBoatCloud.label, reportFailure: false, reportDefect: true },
      );
      if (woken._tag === "Failure") {
        if (!isAtomCommandInterrupted(woken)) {
          Dialog.alert(
            m(msg("Could not wake the {product} machine", { product: "Boat" })),
            errorMessage(squashAtomCommandFailure(woken)),
          );
        }
        return false;
      }
      // A restored VM has a new address, so pair again rather than wait for the old one.
      return attach(woken.value).then(
        () => true,
        (error: unknown) => {
          Dialog.alert(
            m(msg("Could not reconnect to {product}", { product: "Boat" })),
            errorMessage(error),
          );
          return false;
        },
      );
    }
    if (!phoneHasKey) return false;
    return wakeOnPhone(httpBaseUrl).then(
      () => true,
      (error: unknown) => {
        Dialog.alert(
          m(msg("Could not wake the {product} machine", { product: "Boat" })),
          errorMessage(error),
        );
        return false;
      },
    );
  })().finally(() => {
    wakesInFlight.delete(environmentId);
    appAtomRegistry.set(waking, false);
  });
  wakesInFlight.set(environmentId, wake);
  return wake;
}

/**
 * Wakes a Boat VM that is not connected before a command runs on it. False when it
 * did not come back; true when it is connected or is not a Boat VM at all.
 */
export async function wakeBoatCloudIfAsleep(environmentId: EnvironmentId): Promise<boolean> {
  if (appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(environmentId)) return true;
  const httpBaseUrl = appAtomRegistry.get(boatCloudMachinesAtom).get(environmentId);
  if (httpBaseUrl === undefined) return true;
  if (!(await wakeBoatCloudMachine(environmentId, httpBaseUrl))) return false;
  // A VM woken in place keeps its server, so its saved connection retries now instead of backing off.
  void environmentCatalog.retryNow.run(appAtomRegistry, environmentId);
  return waitForConnected(environmentId, WAKE_CONNECT_TIMEOUT_MS);
}

export interface BoatCloudSleep {
  readonly state: "sleeping" | "waking" | "resizing";
  readonly wake: () => void;
}

/**
 * A Boat VM that is not reachable is asleep: it stopped itself after its threads
 * went quiet. A message sent meanwhile waits in the queue and wakes it, so its
 * thread reads "Sleeping" rather than disconnected.
 */
export function useBoatCloudSleep(
  environmentId: EnvironmentId | null,
  phase: EnvironmentConnectionPhase | null,
): BoatCloudSleep | null {
  const machines = useAtomValue(boatCloudMachinesAtom);
  const waking = useAtomValue(boatCloudWakingAtom(environmentId));
  const resizing = useAtomValue(boatCloudResizingAtom(environmentId));
  const httpBaseUrl = environmentId === null ? null : (machines.get(environmentId) ?? null);
  if (environmentId === null || httpBaseUrl === null || phase === null || phase === "connected") {
    return null;
  }
  // A message sent meanwhile waits in the queue until the resized VM is back.
  if (resizing) return { state: "resizing", wake: () => undefined };
  // Retries cycle the phase, so only this app's own wake reads as waking.
  return {
    state: waking ? "waking" : "sleeping",
    wake: () => void wakeBoatCloudMachine(environmentId, httpBaseUrl),
  };
}

const connectsInFlight = new Map<EnvironmentId, Promise<boolean>>();
/** Running VMs this launch already tried to pair with, so a failing one is not retried on every visit. */
const connectAttempted = new Set<string>();

/**
 * Pairs this app with a Boat VM a connected machine handed out, such as one an agent started a
 * thread on, through that machine's wake, which hands out a pairing code. False when no
 * connected machine manages it or the pairing failed.
 */
export function connectManagedBoatCloudEnvironment(
  environmentId: EnvironmentId,
  holders?: ReadonlyArray<BoatCloudHolder>,
): Promise<boolean> {
  if (appAtomRegistry.get(boatCloudMachinesAtom).has(environmentId)) {
    return Promise.resolve(true);
  }
  const inFlight = connectsInFlight.get(environmentId);
  if (inFlight) return inFlight;
  const connect = (async () => {
    const known = holders ?? (await readBoatCloudHoldersOnce());
    noteBoatCloudHolders(known);
    const owner = known.find((holder) =>
      managedBoatCloudEnvironmentIds([holder.status]).has(environmentId),
    );
    if (!owner) return false;
    const woken = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.wakeBoatCloud,
      { environmentId: owner.environmentId, input: { environmentId } },
      { label: serverEnvironment.wakeBoatCloud.label, reportFailure: false, reportDefect: true },
    );
    if (woken._tag === "Failure") return false;
    return attach(woken.value).then(
      () => true,
      () => false,
    );
  })().finally(() => connectsInFlight.delete(environmentId));
  connectsInFlight.set(environmentId, connect);
  return connect;
}

/**
 * Pairs with every running VM the connected machines manage that this app has not paired with,
 * so threads agents started there join the lists. Sleeping VMs stay asleep.
 */
export async function connectManagedBoatCloudMachines(): Promise<void> {
  const holders = await readBoatCloudHoldersOnce();
  noteBoatCloudHolders(holders);
  const paired = appAtomRegistry.get(boatCloudMachinesAtom);
  for (const holder of holders) {
    const environments = boatCloudMachineEnvironments({
      machines: holder.status.machines,
      environmentUsage: holder.status.environmentUsage,
      pairedUrls: paired,
    });
    for (const machine of holder.status.machines) {
      const environmentId = environments.get(machine.sandboxId);
      if (machine.state !== "running" || environmentId === undefined) continue;
      if (paired.has(environmentId) || connectAttempted.has(machine.sandboxId)) continue;
      connectAttempted.add(machine.sandboxId);
      await connectManagedBoatCloudEnvironment(environmentId, holders);
    }
  }
}

/**
 * Pairs with the Boat VM behind a thread this app has no connection for, such as one a link
 * names that an agent started. True while it tries, so the route waits rather than giving up.
 */
export function useConnectManagedBoatCloud(
  environmentId: EnvironmentId | null,
  unknownEnvironment: boolean,
): boolean {
  const wanted = environmentId !== null && unknownEnvironment;
  const [tried, setTried] = useState<EnvironmentId | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pairs with the VM through the machine that manages it, outside React
  useEffect(() => {
    if (!wanted || environmentId === null) return;
    let current = true;
    void connectManagedBoatCloudEnvironment(environmentId).finally(() => {
      if (current) setTried(environmentId);
    });
    return () => {
      current = false;
    };
  }, [wanted, environmentId]);
  return wanted && tried !== environmentId;
}

const MANAGED_CHECK_INTERVAL_MS = 60_000;
let lastManagedCheck = { key: "", at: 0 };

/**
 * Lists the threads on VMs the connected machines manage: reads their Boat status once when a
 * thread list opens or a machine connects, at most once a minute otherwise, and pairs with
 * running VMs this app has not seen.
 */
export function useConnectManagedBoatCloudMachines(): void {
  const key = useAtomValue(connectedEnvironmentIdsAtom).slice().sort().join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the machines' Boat status and pairs with new VMs, outside React
  useEffect(() => {
    if (key === "") return;
    const now = Date.now();
    if (key === lastManagedCheck.key && now - lastManagedCheck.at < MANAGED_CHECK_INTERVAL_MS) {
      return;
    }
    lastManagedCheck = { key, at: now };
    void connectManagedBoatCloudMachines();
  }, [key]);
}
