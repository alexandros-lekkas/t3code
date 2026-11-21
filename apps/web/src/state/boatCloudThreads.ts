import { useAtomValue } from "@effect/atom-react";
import { createBoatCloudThreadListAtoms } from "@t3tools/client-runtime/state/threads";
import {
  type BoatCloudMachine,
  type BoatCloudStatus,
  type EnvironmentId,
  ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import {
  boatCloudMachineOfThread,
  boatCloudThreadMachineKey as machineKey,
} from "../boatCloudMachines.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

const STORAGE_KEY = "t3code:boat-cloud-opened-threads";
const MAX_REMEMBERED = 500;
const OpenedThreads = Schema.Array(ScopedThreadRef);

function readStored(): ReadonlyArray<ScopedThreadRef> {
  try {
    return getLocalStorageItem(STORAGE_KEY, OpenedThreads) ?? [];
  } catch {
    return [];
  }
}

/** Boat cloud VM threads this browser started or opened, the only VM threads its lists show. */
const openedThreadsAtom = Atom.make(readStored()).pipe(
  Atom.keepAlive,
  Atom.withLabel("boat-cloud-opened-threads"),
);

export const boatCloudThreadList = createBoatCloudThreadListAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  openedThreadsAtom,
});

const MACHINES_STORAGE_KEY = "t3code:boat-cloud-thread-machines";
/** `environmentId:threadId` to the Boat sandbox the thread started on. */
const ThreadMachines = Schema.Record(Schema.String, Schema.String);

function readStoredMachines(): Readonly<Record<string, string>> {
  try {
    return getLocalStorageItem(MACHINES_STORAGE_KEY, ThreadMachines) ?? {};
  } catch {
    return {};
  }
}

/**
 * The VM each thread this browser started went to. A VM's environment can serve threads of
 * several starts (and a fake Boat serves every VM from one), so the sandbox names the VM.
 */
const threadMachinesAtom = Atom.make(readStoredMachines()).pipe(
  Atom.keepAlive,
  Atom.withLabel("boat-cloud-thread-machines"),
);

function rememberThreadMachine(ref: ScopedThreadRef, sandboxId: string) {
  const key = machineKey(ref);
  if (appAtomRegistry.get(threadMachinesAtom)[key] === sandboxId) return;
  const entries = Object.entries({ ...readStoredMachines(), [key]: sandboxId });
  const next = Object.fromEntries(entries.slice(-MAX_REMEMBERED));
  appAtomRegistry.set(threadMachinesAtom, next);
  try {
    setLocalStorageItem(MACHINES_STORAGE_KEY, next, ThreadMachines);
  } catch {
    // The mapping still holds for this session.
  }
}

/** The sandbox each started thread runs on, by `environmentId:threadId`. */
export function useBoatCloudThreadMachines(): Readonly<Record<string, string>> {
  return useAtomValue(threadMachinesAtom);
}

/** The same, read once, for a handler that should not re-render on every change. */
export function readBoatCloudThreadMachines(): Readonly<Record<string, string>> {
  return appAtomRegistry.get(threadMachinesAtom);
}

/** Call only with a thread on a Boat cloud VM; `sandboxId` when this browser started it there. */
export function rememberOpenedBoatCloudThread(ref: ScopedThreadRef, sandboxId?: string): void {
  if (sandboxId !== undefined) rememberThreadMachine(ref, sandboxId);
  const same = (other: ScopedThreadRef) =>
    other.environmentId === ref.environmentId && other.threadId === ref.threadId;
  if (appAtomRegistry.get(openedThreadsAtom).some(same)) return;
  // Re-read storage so another tab's threads survive this write.
  const next = [...readStored().filter((other) => !same(other)), ref].slice(-MAX_REMEMBERED);
  appAtomRegistry.set(openedThreadsAtom, next);
  try {
    setLocalStorageItem(STORAGE_KEY, next, OpenedThreads);
  } catch {
    // The list still holds for this session.
  }
}

/** Drops what this browser remembers of a VM's threads, once the VM is gone for good. */
export function forgetBoatCloudEnvironmentThreads(environmentId: EnvironmentId): void {
  const opened = readStored().filter((ref) => ref.environmentId !== environmentId);
  const prefix = `${environmentId}:`;
  const machines = Object.fromEntries(
    Object.entries(readStoredMachines()).filter(([key]) => !key.startsWith(prefix)),
  );
  appAtomRegistry.set(openedThreadsAtom, opened);
  appAtomRegistry.set(threadMachinesAtom, machines);
  try {
    setLocalStorageItem(STORAGE_KEY, opened, OpenedThreads);
    setLocalStorageItem(MACHINES_STORAGE_KEY, machines, ThreadMachines);
  } catch {
    // Storage holds a stale copy; the lists skip environments the catalog no longer has.
  }
}

const NO_LISTED_THREADS_ATOM = Atom.make<ReadonlySet<ThreadId> | null>(null).pipe(
  Atom.withLabel("boat-cloud-listed-thread-ids:none"),
);

/**
 * Lists a VM thread here once a route opens it. True until then: the thread reads as hidden
 * for that render, and the route must not send the visit home for it.
 */
export function useOpenBoatCloudThread(ref: ScopedThreadRef | null): boolean {
  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  const listed = useAtomValue(
    environmentId === null
      ? NO_LISTED_THREADS_ATOM
      : boatCloudThreadList.listedThreadIdsAtom(environmentId),
  );
  const unlisted = listed !== null && threadId !== null && !listed.has(threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the visit in browser storage, outside React
  useEffect(() => {
    if (unlisted && environmentId !== null && threadId !== null) {
      rememberOpenedBoatCloudThread({ environmentId, threadId });
    }
  }, [unlisted, environmentId, threadId]);
  return unlisted;
}

/** This machine's Boat status, while its server supports Boat cloud. */
const primaryBoatCloudStatusAtom = Atom.make((get): BoatCloudStatus | null => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  const config = get(serverEnvironment.configValueAtom(environmentId));
  if (config?.environment.capabilities.boatCloud !== true) return null;
  return AsyncResult.getOrElse(
    get(serverEnvironment.boatCloudStatus({ environmentId, input: {} })),
    () => null,
  );
}).pipe(Atom.withLabel("boat-cloud-primary-status"));

const boatCloudThreadMachineAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  return Atom.make((get) =>
    boatCloudMachineOfThread({
      status: get(primaryBoatCloudStatusAtom),
      threadMachines: get(threadMachinesAtom),
      ref: { environmentId, threadId },
      onBoatCloud: get(boatCloudThreadList.onBoatCloudAtom(environmentId)),
    }),
  ).pipe(Atom.withLabel(`boat-cloud-thread-machine:${key}`));
});

const NO_MACHINE_ATOM = Atom.make<BoatCloudMachine | null>(null).pipe(
  Atom.withLabel("boat-cloud-thread-machine:none"),
);

/** The Boat VM a thread runs on, with its live figures; null when it is not on Boat cloud. */
export function useBoatCloudThreadMachine(ref: ScopedThreadRef | null): BoatCloudMachine | null {
  return useAtomValue(
    ref === null
      ? NO_MACHINE_ATOM
      : boatCloudThreadMachineAtom(JSON.stringify([ref.environmentId, ref.threadId])),
  );
}

const boatCloudThreadMachineStateAtom = Atom.family((key: string) =>
  Atom.make((get) => get(boatCloudThreadMachineAtom(key))?.state ?? null).pipe(
    Atom.withLabel(`boat-cloud-thread-machine-state:${key}`),
  ),
);

/** Only the VM's state, so a list row re-renders when it sleeps or wakes, not on every sample. */
export function useBoatCloudThreadMachineState(
  ref: ScopedThreadRef,
): BoatCloudMachine["state"] | null {
  return useAtomValue(
    boatCloudThreadMachineStateAtom(JSON.stringify([ref.environmentId, ref.threadId])),
  );
}
