import type { BoatCloudStatus, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

/** Kept apart from the holder atoms so the thread state can read it without the server state. */

export interface BoatCloudHolder {
  readonly environmentId: EnvironmentId;
  readonly status: BoatCloudStatus;
}

/** The environments a connected machine handed a VM to, so all their threads are this user's. */
export function managedBoatCloudEnvironmentIds(
  statuses: ReadonlyArray<BoatCloudStatus>,
): Set<EnvironmentId> {
  const ids = new Set<EnvironmentId>();
  for (const status of statuses) {
    for (const machine of status.machines) {
      if (machine.environmentId !== null) ids.add(machine.environmentId);
    }
    for (const entry of status.environmentUsage) ids.add(entry.environmentId);
  }
  return ids;
}

const NO_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();

/**
 * Environments a connected machine handed a Boat VM to, as last read from the machines' status.
 * Their threads are all listed, including those an agent started that this phone never opened.
 */
export const managedBoatCloudEnvironmentIdsAtom = Atom.make(NO_ENVIRONMENTS).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-boat-cloud:managed-environments"),
);

/** Remembers which environments the machines manage, from statuses just read. */
export function noteBoatCloudHolders(holders: ReadonlyArray<BoatCloudHolder>): void {
  const next = managedBoatCloudEnvironmentIds(holders.map((holder) => holder.status));
  const current = appAtomRegistry.get(managedBoatCloudEnvironmentIdsAtom);
  if (next.size === current.size && [...next].every((id) => current.has(id))) return;
  appAtomRegistry.set(managedBoatCloudEnvironmentIdsAtom, next);
}
