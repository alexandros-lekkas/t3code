import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  hasRelayRoute,
  isBoatCloudConnectionEntry,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  environmentPresentations,
  environmentSummaries,
  useEnvironmentPresentation,
} from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { relayEnvironmentDiscovery } from "./relay";
import { usePreparedConnection } from "./session";

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
  /**
   * A Boat cloud VM. Lists of machines leave these out, since the one Boat
   * cloud entry stands for all of them, and they all go by that name.
   */
  readonly boatCloud: boolean;
}

export const BOAT_CLOUD_LABEL = "Boat";

function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
): EnvironmentPresentation {
  const displayUrl = connectionCatalogDisplayUrl(presentation.entry);
  const boatCloud = isBoatCloudConnectionEntry(presentation.entry);
  return {
    ...presentation,
    environmentId,
    label: boatCloud ? BOAT_CLOUD_LABEL : presentation.entry.target.label,
    displayUrl,
    relayManaged: hasRelayRoute(presentation.entry),
    boatCloud,
  };
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);

  const environments = [...presentationById.entries()].map(([environmentId, presentation]) =>
    projectEnvironmentPresentation(environmentId, presentation),
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

/**
 * One of the user's machines: anything but a Boat cloud VM, which is one thread's throwaway
 * server. Pickers, settings scopes and machine lists keep only these; lookups of a thread's own
 * environment use `useEnvironments`. A VM serving this page itself (its own web UI) stays.
 */
export function isMachineEnvironment(environment: Pick<BaseEnvironmentPresentation, "entry">) {
  return (
    environment.entry.target._tag === "PrimaryConnectionTarget" ||
    !isBoatCloudConnectionEntry(environment.entry)
  );
}

/** Boat VMs among the saved connections, so server pushes never recompute it. */
const boatCloudEnvironmentIdsAtom = Atom.make((get) => {
  const next = new Set<EnvironmentId>();
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (!isMachineEnvironment({ entry })) next.add(environmentId);
  }
  const previous = Option.getOrNull(get.self<ReadonlySet<EnvironmentId>>());
  return previous !== null &&
    previous.size === next.size &&
    [...next].every((id) => previous.has(id))
    ? previous
    : next;
});

export function useBoatCloudEnvironmentIds(): ReadonlySet<EnvironmentId> {
  return useAtomValue(boatCloudEnvironmentIdsAtom);
}

export function readBoatCloudEnvironmentIds(): ReadonlySet<EnvironmentId> {
  return appAtomRegistry.get(boatCloudEnvironmentIdsAtom);
}

export function machineEnvironmentsOf<T extends Pick<BaseEnvironmentPresentation, "entry">>(
  environments: ReadonlyArray<T>,
): T[] {
  return environments.filter(isMachineEnvironment);
}

export function useMachineEnvironments() {
  const result = useEnvironments();
  return { ...result, environments: machineEnvironmentsOf(result.environments) };
}

/** Provider statuses change on every push, so they live apart from the presentations. */
export function useEnvironmentProviders() {
  return useAtomValue(environmentPresentations.providersByEnvironmentAtom);
}

export function readEnvironmentProviders(environmentId: EnvironmentId) {
  return appAtomRegistry
    .get(environmentPresentations.providersByEnvironmentAtom)
    .get(environmentId);
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function readPrimaryEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(primaryEnvironmentIdAtom);
}

/** The environment's state now, for handlers that should not re-render on every change. */
export function readEnvironment(environmentId: EnvironmentId): EnvironmentPresentation | null {
  const presentation = appAtomRegistry
    .get(environmentPresentations.presentationsAtom)
    .get(environmentId);
  return presentation ? projectEnvironmentPresentation(environmentId, presentation) : null;
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  return environmentId === null || presentation === null
    ? null
    : projectEnvironmentPresentation(environmentId, presentation);
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  return useEnvironment(usePrimaryEnvironmentId());
}

export function useEnvironmentHttpBaseUrl(environmentId: EnvironmentId | null): string | null {
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}

export function useRelayEnvironmentDiscovery(): Discovery.RelayEnvironmentDiscoveryState {
  return useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
}

/**
 * The account's T3 Connect machines for a view that keeps one in front of the user. A refresh
 * empties the list until it answers; the machines last seen stay meanwhile.
 */
export function useRetainedRelayEnvironments() {
  const discovery = useRelayEnvironmentDiscovery();
  const [seen, setSeen] = useState(discovery.environments);
  const emptied = discovery.refreshing && discovery.environments.size === 0;
  if (!emptied && seen !== discovery.environments) setSeen(discovery.environments);
  return emptied ? seen : discovery.environments;
}

export function useEnvironmentIdentities() {
  return useAtomValue(environmentSummaries.identitiesAtom);
}

export function usePullRequestsSupported() {
  return useAtomValue(environmentSummaries.pullRequestsSupportedAtom);
}

export function useIssuesSupported() {
  return useAtomValue(environmentSummaries.issuesSupportedAtom);
}

export function useEnvironmentMachines() {
  return useAtomValue(environmentSummaries.machineByIdAtom);
}

export function useConnectedEnvironmentIds() {
  return useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom);
}
