import { connectionCatalogDisplayUrl } from "@t3tools/client-runtime/connection";
import {
  type BoatCloudStatus,
  type EnvironmentId,
  isBoatCloudHttpBaseUrl,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom, environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import type { BoatCloudHolder } from "./boatCloudManagedEnvironments";

export type { BoatCloudHolder };
export {
  managedBoatCloudEnvironmentIdsAtom,
  noteBoatCloudHolders,
} from "./boatCloudManagedEnvironments";

/**
 * What the thread lists need to know about Boat VMs, kept apart from the start and wake flows,
 * which import the thread state themselves.
 */

/** Paired Boat VMs, by environment, with the URL each one is reached at. */
export const boatCloudMachinesAtom = Atom.make((get) => {
  const machines = new Map<EnvironmentId, string>();
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    const url = connectionCatalogDisplayUrl(presentation.entry);
    if (url !== null && isBoatCloudHttpBaseUrl(url)) machines.set(environmentId, url);
  }
  return machines;
}).pipe(Atom.withLabel("mobile-boat-cloud:machines"));

/** Connected machines that are not Boat VMs, each of which may hold the key. */
const holderCandidatesAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const machines = get(boatCloudMachinesAtom);
  return get(connectedEnvironmentIdsAtom).filter((environmentId) => !machines.has(environmentId));
}).pipe(Atom.withLabel("mobile-boat-cloud:holder-candidates"));

/**
 * Connected machines that answer for Boat cloud, without the VMs, which answer too. Reading it
 * subscribes to each machine's status, which samples its running VMs, so only screens about
 * Boat mount it.
 */
export const boatCloudHoldersAtom = Atom.make((get): ReadonlyArray<BoatCloudHolder> =>
  get(holderCandidatesAtom).flatMap((environmentId) => {
    const status = AsyncResult.getOrElse(
      get(serverEnvironment.boatCloudStatus({ environmentId, input: {} })),
      () => null,
    );
    return status ? [{ environmentId, status }] : [];
  }),
).pipe(Atom.withLabel("mobile-boat-cloud:holders"));

/** Whether this app is turning a VM back on, so its thread shows "Waking" rather than "Sleeping". */
export const boatCloudWakingAtom = Atom.family((_environmentId: EnvironmentId | null) =>
  Atom.make(false).pipe(Atom.keepAlive),
);

/** Whether this app is moving a VM to another size, so its thread shows "Resizing". */
export const boatCloudResizingAtom = Atom.family((_environmentId: EnvironmentId | null) =>
  Atom.make(false).pipe(Atom.keepAlive),
);

/**
 * Reads every connected machine's Boat status once, without keeping the subscription, which
 * samples VMs for as long as it is open. Resolves with the machines that answered in time.
 */
export function readBoatCloudHoldersOnce(
  timeoutMs = 10_000,
): Promise<ReadonlyArray<BoatCloudHolder>> {
  // Machines without Boat cloud would only answer with an error.
  const candidates = appAtomRegistry
    .get(holderCandidatesAtom)
    .filter(
      (environmentId) =>
        appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.environment
          .capabilities.boatCloud === true,
    );
  return Promise.all(
    candidates.map(
      (environmentId) =>
        new Promise<BoatCloudHolder | null>((resolve) => {
          const atom = serverEnvironment.boatCloudStatus({ environmentId, input: {} });
          let unsubscribe: () => void = () => undefined;
          const finish = (status: BoatCloudStatus | null) => {
            clearTimeout(timeout);
            // Deferred: the first value can arrive while subscribe is still returning.
            queueMicrotask(() => unsubscribe());
            resolve(status ? { environmentId, status } : null);
          };
          const timeout = setTimeout(() => finish(null), timeoutMs);
          const read = (result: AsyncResult.AsyncResult<BoatCloudStatus, unknown>) => {
            if (AsyncResult.isSuccess(result)) finish(result.value);
            else if (AsyncResult.isFailure(result)) finish(null);
          };
          unsubscribe = appAtomRegistry.subscribe(atom, read, { immediate: true });
        }),
    ),
  ).then((holders) => holders.filter((holder) => holder !== null));
}

export type BoatCloudThreadMachineState = "awake" | "sleeping" | "waking" | "resizing";

/** A thread list row's Boat VM: null when the thread is not on one. */
export const boatCloudEnvironmentStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): BoatCloudThreadMachineState | null => {
    if (!get(boatCloudMachinesAtom).has(environmentId)) return null;
    if (get(boatCloudResizingAtom(environmentId))) return "resizing";
    if (get(boatCloudWakingAtom(environmentId))) return "waking";
    // A VM that is not reachable stopped itself after its threads went quiet.
    return get(connectedEnvironmentIdsAtom).includes(environmentId) ? "awake" : "sleeping";
  }).pipe(Atom.withLabel(`mobile-boat-cloud:environment-state:${environmentId}`)),
);
