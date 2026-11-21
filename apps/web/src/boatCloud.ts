import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { mostWorkedRepositories } from "@t3tools/client-runtime/state/threads";
import {
  connectionCatalogDisplayUrl,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  AuthOrchestrationOperateScope,
  BOAT_CLOUD_SNAPSHOT_REPOSITORIES,
  type BoatCloudAcquireInput,
  type BoatCloudMachineType,
  type BoatCloudSession,
  type BoatCloudStartStep,
  type BoatCloudStepProgress,
  type BoatCloudStatus,
  type EnvironmentId,
  isBoatCloudHttpBaseUrl,
} from "@t3tools/contracts";
import {
  boatCloudAgentDrivers,
  boatCloudBlocker,
  parseRepository,
} from "@t3tools/shared/boatCloudVm";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import {
  type BoatCloudStartProgress,
  completeStep,
  failProgress,
  markAcquired,
  markSent,
  startingProgress,
  wakingProgress,
  withHolderSteps,
} from "./boatCloudStart.logic";
import { type DraftStart, makeDraftStarts } from "./boatCloudDraftStarts.logic";
import { boatCloudMachinesToPair, managedBoatCloudMachine } from "./boatCloudMachines.logic";
import { type DraftId, useComposerDraftStore } from "./composerDraftStore";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { environmentCatalog } from "./connection/catalog";
import { connectPairing } from "./connection/onboarding";
import { randomUUID } from "./lib/utils";
import { appAtomRegistry } from "./rpc/atomRegistry";
import {
  readEnvironment,
  readPrimaryEnvironmentId,
  useEnvironment,
  usePrimaryEnvironmentId,
} from "./state/environments";
import { environmentPresentations, environmentSummaries } from "./state/presentation";
import { threadEnvironment } from "./state/threads";
import { environmentSession, sessionHasScope } from "./state/session";
import { environmentProjects } from "./state/projects";
import { useEnvironmentQuery } from "./state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "./state/server";
import { waitForAtomValue } from "./state/waitForAtomValue";

/**
 * Boat cloud VMs are ordinary environments. This machine (the primary
 * environment) holds the Boat key, hands out a VM, and the client pairs with it.
 */

const PROJECT_APPEAR_TIMEOUT_MS = 60_000;
/** The checkout and worktree run in one VM command, which the holder gives ten minutes. */
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;
const RECONNECT_TIMEOUT_MS = 15_000;
/** How often a draft renews its hold on its start's VM; unheld, the holder soon deletes it. */
const HOLD_INTERVAL_MS = 60_000;

/** An environment's Boat cloud status, while it is connected. */
export function useBoatCloudStatus(environmentId: EnvironmentId | null): BoatCloudStatus | null {
  const connected = useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom);
  return useEnvironmentQuery(
    environmentId !== null && connected.includes(environmentId)
      ? serverEnvironment.boatCloudStatus({ environmentId, input: {} })
      : null,
  ).data;
}

/**
 * Each connected machine's Boat status: null while it loads, "unsupported" when its
 * T3 Code predates Boat cloud and cannot take the key.
 */
const boatCloudKeyHolderStatesAtom = Atom.make((get) => {
  const states = new Map<EnvironmentId, BoatCloudStatus | "unsupported" | null>();
  for (const environmentId of get(environmentSummaries.connectedEnvironmentIdsAtom)) {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (config === null) {
      states.set(environmentId, null);
    } else if (config.environment.capabilities.boatCloud !== true) {
      states.set(environmentId, "unsupported");
    } else {
      const status = get(serverEnvironment.boatCloudStatus({ environmentId, input: {} }));
      states.set(
        environmentId,
        AsyncResult.getOrElse(status, () => null),
      );
    }
  }
  return states;
}).pipe(Atom.withLabel("boat-cloud:key-holder-states"));

export function useBoatCloudKeyHolderStates() {
  return useAtomValue(boatCloudKeyHolderStatesAtom);
}

/** The status of this machine, which hands out VMs for the threads started here. */
export function usePrimaryBoatCloudStatus() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return {
    holderEnvironmentId: primaryEnvironmentId,
    status: useBoatCloudStatus(primaryEnvironmentId),
  };
}

/** The providers a new Boat VM has sign-ins for, or null when Boat's credentials are unknown. */
export function useBoatCloudProviderDrivers() {
  const { status } = usePrimaryBoatCloudStatus();
  return boatCloudAgentDrivers(status);
}

export function boatCloudReady(status: BoatCloudStatus | null) {
  return boatCloudBlocker(status) === null;
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : m(msg("An error occurred."));
}

/** A toast with Boat's own message for a command that failed. */
export function reportBoatCloudFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add(
    stackedThreadToast({ type: "error", title, description: failureMessage(result) }),
  );
}

/** The VM size each cloud draft picked; null keeps the holder's default. */
export const boatCloudDraftMachineTypeAtom = Atom.family((_draftId: string) =>
  Atom.make<BoatCloudMachineType | null>(null).pipe(Atom.keepAlive),
);

/** The start in progress for each draft, shown above its composer. */
export const boatCloudStartProgressAtom = Atom.family((_draftId: string) =>
  Atom.make<BoatCloudStartProgress | null>(null).pipe(Atom.keepAlive),
);

function updateProgress(
  draftId: DraftId | null,
  update: (progress: BoatCloudStartProgress) => BoatCloudStartProgress,
) {
  if (draftId === null) return;
  const atom = boatCloudStartProgressAtom(draftId);
  const current = appAtomRegistry.get(atom);
  if (current) appAtomRegistry.set(atom, update(current));
}

/** The draft's send now waits on its start, so the thread shows the steps still left. */
export function markBoatCloudStartSent(draftId: DraftId | null) {
  updateProgress(draftId, (progress) => markSent(progress, new Date().toISOString()));
}

/** The send stopped waiting without going out; the steps leave the thread. */
export function unmarkBoatCloudStartSent(draftId: DraftId | null) {
  updateProgress(draftId, (progress) => ({ ...progress, sent: null }));
}

/** The draft's thread was made on its VM, which now keeps the VM; its start is over. */
export function finishBoatCloudStart(draftId: DraftId) {
  draftStarts.finish(draftId);
  syncHolds();
  appAtomRegistry.set(boatCloudStartProgressAtom(draftId), null);
}

/** The draft gave its start up, so the holder deletes the VM, unless a thread runs on it. */
export function abandonBoatCloudStart(draftId: DraftId) {
  draftStarts.abandon(draftId);
  syncHolds();
  appAtomRegistry.set(boatCloudStartProgressAtom(draftId), null);
}

/** Boat cloud VMs this client already paired with, so the holder skips their pairing code. */
function pairedBoatCloudEnvironments(): NonNullable<BoatCloudAcquireInput["paired"]> {
  const paired: Array<{ environmentId: EnvironmentId; httpBaseUrl: string }> = [];
  for (const [environmentId, presentation] of appAtomRegistry.get(
    environmentPresentations.presentationsAtom,
  )) {
    const httpBaseUrl = connectionCatalogDisplayUrl(presentation.entry);
    if (httpBaseUrl !== null && isBoatCloudHttpBaseUrl(httpBaseUrl)) {
      paired.push({ environmentId, httpBaseUrl });
    }
  }
  return paired;
}

const isConnected = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom).includes(environmentId);

/**
 * Connects this client to the VM: with its saved credential when the holder sent
 * no pairing code, else by pairing. Returns the failure text.
 */
async function attach(session: BoatCloudSession): Promise<string | null> {
  if (isConnected(session.environmentId)) return null;
  if (session.pairingCode === null) {
    // A stopped VM left its connection backing off; retry now that the server is up.
    void environmentCatalog.retryNow.run(appAtomRegistry, session.environmentId);
    const reconnected = await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentSummaries.connectedEnvironmentIdsAtom,
      predicate: (ids) => ids.includes(session.environmentId),
      timeoutMs: RECONNECT_TIMEOUT_MS,
    });
    return reconnected ? null : m(msg("Could not reconnect to the VM."));
  }
  const paired = await runAtomCommand(
    appAtomRegistry,
    connectPairing,
    {
      host: session.httpBaseUrl,
      pairingCode: session.pairingCode,
      expectedEnvironmentId: session.environmentId,
    },
    { label: connectPairing.label, reportFailure: false, reportDefect: true },
  );
  if (paired._tag === "Success" || isAtomCommandInterrupted(paired)) return null;
  return failureMessage(paired);
}

interface BoatCloudPrepareInput {
  readonly draftId: DraftId;
  readonly holderEnvironmentId: EnvironmentId;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
  readonly machineType: BoatCloudMachineType;
}

/** Where the draft moves: the VM's project, and the worktree the VM cut for it when it did. */
export interface BoatCloudTarget {
  readonly project: EnvironmentProject;
  readonly worktree: BoatCloudSession["worktree"] | null;
  readonly sandboxId: string;
}

/**
 * Gets a VM with the repository checked out and returns its project there,
 * so the draft can move onto it and send. Progress goes to the draft's
 * `boatCloudStartProgressAtom`; the caller completes the "thread" step.
 * Null when it failed, with the failure in the progress.
 */
async function prepareBoatCloudProjectNow(
  input: BoatCloudPrepareInput,
  start: DraftStart<BoatCloudTarget>,
): Promise<BoatCloudTarget | null> {
  const { draftId } = input;
  const progressAtom = boatCloudStartProgressAtom(draftId);
  appAtomRegistry.set(
    progressAtom,
    startingProgress(
      parseRepository(input.repositoryUrl)?.name ?? null,
      appAtomRegistry.get(progressAtom),
    ),
  );
  // The holder logs its own steps as "boat cloud start timing"; this is the client's share.
  const startedAt = performance.now();
  const endedAtMs: Record<string, number> = {};
  const markEnded = (step: string) => {
    endedAtMs[step] = Math.round(performance.now() - startedAt);
  };
  const logTiming = (outcome: "ready" | "failed") =>
    console.info("[boat-cloud] start timing", {
      outcome,
      totalMs: Math.round(performance.now() - startedAt),
      endedAtMs,
    });
  const fail = (error: string, step?: BoatCloudStartStep) => {
    updateProgress(draftId, (progress) => failProgress(progress, error, step));
    logTiming("failed");
    return null;
  };
  const requestId = randomUUID();
  // The holder reports its steps under the request id, the checkout's after the acquire returns.
  let repositoryFailed: (error: string) => void = () => undefined;
  let repositoryDone: () => void = () => undefined;
  const watchCheckout = () => ({
    failure: new Promise<string>((resolve) => {
      repositoryFailed = resolve;
    }),
    done: new Promise<true>((resolve) => {
      repositoryDone = () => resolve(true);
    }),
  });
  const checkout = watchCheckout();
  const stopWatchingHolder = appAtomRegistry.subscribe(
    serverEnvironment.boatCloudStatus({ environmentId: input.holderEnvironmentId, input: {} }),
    (result) => {
      const start = AsyncResult.getOrElse(result, () => null)?.starts.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (!start) return;
      updateProgress(draftId, (progress) => withHolderSteps(progress, start.steps));
      const repository = start.steps.find((entry) => entry.step === "repository");
      if (repository?.state === "failed") {
        repositoryFailed(repository.detail ?? "Could not get the repository on the VM.");
      }
      if (repository?.state === "done") repositoryDone();
    },
  );
  try {
    const acquire = (paired: BoatCloudAcquireInput["paired"]) =>
      runAtomCommand(
        appAtomRegistry,
        serverEnvironment.acquireBoatCloud,
        {
          environmentId: input.holderEnvironmentId,
          input: {
            repositoryUrl: input.repositoryUrl,
            baseBranch: input.baseBranch,
            machineType: input.machineType,
            requestId,
            paired,
          },
        },
        {
          label: serverEnvironment.acquireBoatCloud.label,
          reportFailure: false,
          reportDefect: true,
        },
      );
    const acquired = await acquire(pairedBoatCloudEnvironments());
    if (acquired._tag === "Failure") {
      if (isAtomCommandInterrupted(acquired)) {
        appAtomRegistry.set(progressAtom, null);
        return null;
      }
      if (start.abandoned()) return null;
      return fail(failureMessage(acquired));
    }
    if (!start.handedOut(acquired.value.sandboxId)) return null;
    updateProgress(draftId, markAcquired);
    markEnded("acquire");
    let attachFailure = await attach(acquired.value);
    if (attachFailure !== null && !start.abandoned()) {
      // The saved credential no longer works, or the pairing did not go through, so this
      // client pairs again with the same VM rather than start another.
      const repaired = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.wakeBoatCloud,
        {
          environmentId: input.holderEnvironmentId,
          input: {
            environmentId: acquired.value.environmentId,
            httpBaseUrl: acquired.value.httpBaseUrl,
          },
        },
        { label: serverEnvironment.wakeBoatCloud.label, reportFailure: false, reportDefect: true },
      );
      attachFailure =
        repaired._tag === "Success"
          ? await attach({
              ...acquired.value,
              httpBaseUrl: repaired.value.httpBaseUrl,
              pairingCode: repaired.value.pairingCode,
            })
          : failureMessage(repaired);
    }
    if (start.abandoned()) return null;
    if (attachFailure !== null) return fail(attachFailure, "connect");
    updateProgress(draftId, (progress) => completeStep(progress, "connect"));
    markEnded("connect");
    const session = acquired.value;

    // Uploads need the VM's server config and the send needs its operate grant,
    // so the draft moves once all three have arrived. A thread that takes the VM's worktree
    // also waits for the holder to say it is cut.
    const worktree = session.worktree ?? null;
    const findProject = (projects: ReadonlyArray<EnvironmentProject>) =>
      projects.find(
        (project) =>
          project.environmentId === session.environmentId &&
          project.workspaceRoot === session.workspaceRoot,
      );
    // A large repository can still be cloning, and the project only appears after it.
    const cloning =
      appAtomRegistry
        .get(progressAtom)
        ?.steps.some((entry) => entry.step === "repository" && entry.state === "active") ?? false;
    const appearTimeoutMs = cloning ? CHECKOUT_TIMEOUT_MS : PROJECT_APPEAR_TIMEOUT_MS;
    const arrived = await Promise.race([
      Promise.all([
        waitForAtomValue({
          registry: appAtomRegistry,
          atom: environmentProjects.projectsAtom,
          predicate: (projects) => findProject(projects) !== undefined,
          timeoutMs: appearTimeoutMs,
        }),
        waitForAtomValue({
          registry: appAtomRegistry,
          atom: environmentServerConfigsAtom,
          predicate: (configs) => configs.has(session.environmentId),
          timeoutMs: appearTimeoutMs,
        }),
        waitForAtomValue({
          registry: appAtomRegistry,
          atom: environmentSession.sessionStateAtom(session.environmentId),
          predicate: (result) => sessionHasScope(result, AuthOrchestrationOperateScope),
          timeoutMs: appearTimeoutMs,
        }),
        worktree === null
          ? true
          : Promise.race([
              checkout.done,
              new Promise<false>((resolve) =>
                setTimeout(() => resolve(false), CHECKOUT_TIMEOUT_MS),
              ),
            ]),
      ]),
      checkout.failure,
      start.givenUp.then(() => null),
    ]);
    if (arrived === null) return null;
    if (typeof arrived === "string") return fail(arrived, "repository");
    const project = findProject(appAtomRegistry.get(environmentProjects.projectsAtom));
    if (arrived.includes(false) || !project) return fail("The VM did not open the project.");
    // The project is added after the checkout, so it appearing means the checkout is done.
    updateProgress(draftId, (progress) =>
      completeStep(completeStep(progress, "repository"), "project"),
    );
    markEnded("project");
    logTiming("ready");
    return { project, worktree, sandboxId: session.sandboxId };
  } finally {
    stopWatchingHolder();
  }
}

/** Each draft's start, from when Boat cloud was picked until its thread is made or it gives up. */
const draftStarts = makeDraftStarts<BoatCloudPrepareInput, BoatCloudTarget>({
  run: prepareBoatCloudProjectNow,
  release: (sandboxId, input) => holdOnHolder(input.holderEnvironmentId, sandboxId, true),
  hold: (sandboxId, input) => holdOnHolder(input.holderEnvironmentId, sandboxId, false),
});

function holdOnHolder(holderEnvironmentId: EnvironmentId, sandboxId: string, release: boolean) {
  void runAtomCommand(
    appAtomRegistry,
    serverEnvironment.holdBoatCloudStart,
    { environmentId: holderEnvironmentId, input: { sandboxId, release } },
    {
      label: serverEnvironment.holdBoatCloudStart.label,
      reportFailure: false,
      reportDefect: false,
    },
  );
}

let holdTimer: ReturnType<typeof setInterval> | null = null;
/** Holds the VMs of drafts still on Boat cloud, and gives up the starts of the rest. */
function syncHolds() {
  if (draftStarts.size() === 0) {
    if (holdTimer !== null) clearInterval(holdTimer);
    holdTimer = null;
  } else if (holdTimer === null) {
    holdTimer = setInterval(() => {
      const store = useComposerDraftStore.getState();
      draftStarts.hold((draftId) => {
        const draft = store.getDraftSession(draftId as DraftId);
        if (draft?.promotedTo) return "done";
        if (draft?.environmentSelection !== "cloud") {
          appAtomRegistry.set(boatCloudStartProgressAtom(draftId), null);
          return "gone";
        }
        return "wanted";
      });
      syncHolds();
    }, HOLD_INTERVAL_MS);
  }
}

const startKey = (input: BoatCloudPrepareInput) =>
  `${input.holderEnvironmentId} ${input.machineType} ${input.repositoryUrl}`;

/**
 * Starts getting a VM as soon as the draft picks Boat cloud, so it is usually ready by the
 * time the message is written. The draft keeps one start: picking Boat again reuses it, and
 * a new size or repository gives the old VM up.
 */
export function prewarmBoatCloudProject(input: BoatCloudPrepareInput) {
  draftStarts.begin(input.draftId, startKey(input), input);
  syncHolds();
}

/** The draft's start when it is for this repository and size and did not fail, else a new one. */
export function prepareBoatCloudProject(input: BoatCloudPrepareInput) {
  const target = draftStarts.prepare(input.draftId, startKey(input), input);
  syncHolds();
  return target;
}

const WAKE_CONNECT_TIMEOUT_MS = 90_000;
const wakesInFlight = new Map<EnvironmentId, Promise<boolean>>();

/** The wake this client runs for each VM, so its thread shows the steps rather than "Sleeping". */
const boatCloudWakeProgressAtom = Atom.family((_environmentId: EnvironmentId | null) =>
  Atom.make<BoatCloudStartProgress | null>(null).pipe(Atom.keepAlive),
);

function updateWake(
  environmentId: EnvironmentId,
  update: (progress: BoatCloudStartProgress) => BoatCloudStartProgress,
) {
  const atom = boatCloudWakeProgressAtom(environmentId);
  const current = appAtomRegistry.get(atom);
  if (current) appAtomRegistry.set(atom, update(current));
}

/**
 * Turns a stopped or deleted VM back on, from this machine's copy, and resolves
 * once this client is connected to it again. False after telling the user what failed.
 */
function wakeBoatCloudMachine(input: {
  readonly holderEnvironmentId: EnvironmentId;
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string | null;
}): Promise<boolean> {
  const inFlight = wakesInFlight.get(input.environmentId);
  if (inFlight) return inFlight;
  const { environmentId } = input;
  appAtomRegistry.set(
    boatCloudWakeProgressAtom(environmentId),
    wakingProgress(new Date().toISOString()),
  );
  // The holder reports the machine and server steps under the request id.
  const requestId = randomUUID();
  const stopWatchingHolder = appAtomRegistry.subscribe(
    serverEnvironment.boatCloudStatus({ environmentId: input.holderEnvironmentId, input: {} }),
    (result) => {
      const start = AsyncResult.getOrElse(result, () => null)?.starts.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (start) updateWake(environmentId, (progress) => withHolderSteps(progress, start.steps));
    },
  );
  const wake = (async () => {
    const woken = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.wakeBoatCloud,
      {
        environmentId: input.holderEnvironmentId,
        input: {
          environmentId,
          requestId,
          ...(input.httpBaseUrl ? { httpBaseUrl: input.httpBaseUrl } : {}),
        },
      },
      { label: serverEnvironment.wakeBoatCloud.label, reportFailure: false, reportDefect: true },
    );
    if (woken._tag === "Failure") {
      reportBoatCloudFailure(m(msg("Could not wake the Boat machine")), woken);
      return false;
    }
    updateWake(environmentId, markAcquired);
    // A restored VM has a new address, so the holder pairs again rather than wait for the old one.
    const attachFailure = await attach(woken.value);
    if (attachFailure !== null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not reconnect to Boat")),
          description: attachFailure,
        }),
      );
      return false;
    }
    // The send that follows needs the VM's grant too, which loads just after it connects.
    const connected =
      (await waitForAtomValue({
        registry: appAtomRegistry,
        atom: environmentSummaries.connectedEnvironmentIdsAtom,
        predicate: (ids) => ids.includes(input.environmentId),
        timeoutMs: WAKE_CONNECT_TIMEOUT_MS,
      })) &&
      (await waitForAtomValue({
        registry: appAtomRegistry,
        atom: environmentSession.sessionStateAtom(input.environmentId),
        predicate: (result) => sessionHasScope(result, AuthOrchestrationOperateScope),
        timeoutMs: WAKE_CONNECT_TIMEOUT_MS,
      }));
    if (connected) updateWake(environmentId, (progress) => completeStep(progress, "connect"));
    if (!connected) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not reconnect to Boat")),
          description: m(msg("The machine is on, but this client did not reach it in time.")),
        }),
      );
    }
    return connected;
  })().finally(() => {
    stopWatchingHolder();
    wakesInFlight.delete(environmentId);
    appAtomRegistry.set(boatCloudWakeProgressAtom(environmentId), null);
  });
  wakesInFlight.set(input.environmentId, wake);
  return wake;
}

/**
 * Wakes a Boat VM that is not connected before an action runs on it. False when it
 * could not be woken; true when it is connected or is not a Boat VM at all.
 */
export function wakeBoatCloudIfAsleep(environmentId: EnvironmentId): Promise<boolean> {
  if (isConnected(environmentId)) return Promise.resolve(true);
  const environment = readEnvironment(environmentId);
  const holderEnvironmentId = readPrimaryEnvironmentId();
  if (
    environment?.boatCloud !== true ||
    holderEnvironmentId === null ||
    holderEnvironmentId === environmentId
  ) {
    return Promise.resolve(true);
  }
  return wakeBoatCloudMachine({
    holderEnvironmentId,
    environmentId,
    httpBaseUrl: environment.displayUrl ?? null,
  });
}

export interface BoatCloudSleep {
  readonly state: "sleeping" | "waking";
  /** This client's wake of the VM, while it runs. */
  readonly wakeSteps: ReadonlyArray<BoatCloudStepProgress> | null;
  /** Turns the VM on and resolves once it is connected; false when that failed. */
  readonly wake: () => Promise<boolean>;
}

/**
 * A Boat VM that is not reachable is asleep: it stopped itself after its threads
 * went quiet. The next message wakes it, so its thread reads "Sleeping", not offline.
 * Any environment at a Boat URL counts, not only the VMs in this machine's list.
 */
export function useBoatCloudSleep(
  environmentId: EnvironmentId | null,
  phase: EnvironmentConnectionPhase | null,
): BoatCloudSleep | null {
  const holderEnvironmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId);
  const wakeProgress = useAtomValue(boatCloudWakeProgressAtom(environmentId));
  const httpBaseUrl = environment?.displayUrl ?? null;
  if (
    environment?.boatCloud !== true ||
    environmentId === null ||
    holderEnvironmentId === null ||
    phase === null ||
    phase === "connected"
  ) {
    return null;
  }
  // Retries cycle the phase, so only this client's own wake reads as waking.
  return {
    state: wakeProgress !== null ? "waking" : "sleeping",
    wakeSteps: wakeProgress?.steps ?? null,
    wake: () => wakeBoatCloudMachine({ holderEnvironmentId, environmentId, httpBaseUrl }),
  };
}

/** What the Boat cloud snapshot checks out: the most worked repositories on every machine. */
export function boatCloudSnapshotRepositories(): Array<string> {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  return mostWorkedRepositories(
    [...enabledEnvironmentIds(catalog)].map((environmentId) =>
      appAtomRegistry.get(threadEnvironment.snapshotAtom(environmentId)),
    ),
    BOAT_CLOUD_SNAPSHOT_REPOSITORIES,
  );
}

const pairingAttempted = new Set<string>();

/** Pairs this client with a running VM it never saw, and says nothing when that fails. */
async function pairQuietly(holderEnvironmentId: EnvironmentId, environmentId: EnvironmentId) {
  const woken = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.wakeBoatCloud,
    { environmentId: holderEnvironmentId, input: { environmentId } },
    { label: serverEnvironment.wakeBoatCloud.label, reportFailure: false, reportDefect: false },
  );
  if (woken._tag === "Success") await attach(woken.value);
}

/**
 * Lists the threads on running VMs this machine handed out that this client never paired with,
 * such as the ones an agent launched, by pairing with each VM once.
 */
export function useBoatCloudMachinePairing() {
  const { holderEnvironmentId, status } = usePrimaryBoatCloudStatus();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const toPair =
    holderEnvironmentId === null
      ? []
      : boatCloudMachinesToPair({
          status,
          knownEnvironmentIds: new Set(catalog.entries.keys()),
          attemptedSandboxIds: pairingAttempted,
        });
  // Sandbox and environment ids hold no spaces, so one string carries the list into the effect.
  const pairKey = toPair
    .map((machine) => `${machine.sandboxId} ${machine.environmentId}`)
    .join(" ");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pairs with VMs over the network, outside React
  useEffect(() => {
    if (holderEnvironmentId === null || pairKey === "") return;
    const ids = pairKey.split(" ");
    for (let index = 0; index < ids.length; index += 2) {
      const sandboxId = ids[index]!;
      if (pairingAttempted.has(sandboxId)) continue;
      pairingAttempted.add(sandboxId);
      void pairQuietly(holderEnvironmentId, ids[index + 1] as EnvironmentId);
    }
  }, [holderEnvironmentId, pairKey]);
}

/**
 * Connects this client to the VM serving an environment this machine handed out, waking it
 * when it sleeps, so a link to one of its threads opens. False when it is no such VM or failed.
 */
export function connectBoatCloudEnvironment(environmentId: EnvironmentId): Promise<boolean> {
  if (isConnected(environmentId)) return Promise.resolve(true);
  const holderEnvironmentId = readPrimaryEnvironmentId();
  if (holderEnvironmentId === null || holderEnvironmentId === environmentId) {
    return Promise.resolve(false);
  }
  const status = AsyncResult.getOrElse(
    appAtomRegistry.get(
      serverEnvironment.boatCloudStatus({ environmentId: holderEnvironmentId, input: {} }),
    ),
    () => null,
  );
  const machine = managedBoatCloudMachine(status, environmentId);
  if (machine === null) return Promise.resolve(false);
  return wakeBoatCloudMachine({
    holderEnvironmentId,
    environmentId,
    httpBaseUrl: machine.httpBaseUrl,
  });
}

/** Whether this machine handed out the VM serving `environmentId`. */
export function useManagedBoatCloudMachine(environmentId: EnvironmentId | null) {
  const { status } = usePrimaryBoatCloudStatus();
  return managedBoatCloudMachine(status, environmentId);
}

const connectAttempted = new Set<EnvironmentId>();

/** Opening a thread on a VM this machine handed out, but this client never paired with, connects it. */
export function useConnectBoatCloudThreadEnvironment(environmentId: EnvironmentId | null) {
  const machine = useManagedBoatCloudMachine(environmentId);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const unpaired =
    environmentId !== null && machine !== null && !catalog.entries.has(environmentId)
      ? environmentId
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pairs with the VM over the network, outside React
  useEffect(() => {
    if (unpaired === null || connectAttempted.has(unpaired)) return;
    connectAttempted.add(unpaired);
    void connectBoatCloudEnvironment(unpaired);
  }, [unpaired]);
}
