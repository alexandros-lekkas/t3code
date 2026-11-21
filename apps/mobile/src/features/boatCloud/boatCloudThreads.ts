import { useAtomValue } from "@effect/atom-react";
import { createBoatCloudThreadListAtoms } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { managedBoatCloudEnvironmentIdsAtom } from "./boatCloudManagedEnvironments";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";

const MAX_REMEMBERED = 500;
const NONE: ReadonlyArray<ScopedThreadRef> = [];

const openedThreadsAtom = Atom.make(
  (get) =>
    AsyncResult.getOrElse(get(mobilePreferencesAtom), () => null)?.boatCloudOpenedThreads ?? NONE,
).pipe(Atom.withLabel("mobile-boat-cloud-opened-threads"));

const openedThreadList = createBoatCloudThreadListAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  openedThreadsAtom,
});

/**
 * Which threads lists show on a Boat VM: those this phone started or opened, or all of them on
 * a VM a connected machine handed out, where an agent may have started threads this phone never
 * opened. Null for an environment that is not a VM, which lists everything.
 */
export const boatCloudThreadList = {
  onBoatCloudAtom: openedThreadList.onBoatCloudAtom,
  listedThreadIdsAtom: Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlySet<ThreadId> | null =>
      get(managedBoatCloudEnvironmentIdsAtom).has(environmentId)
        ? null
        : get(openedThreadList.listedThreadIdsAtom(environmentId)),
    ).pipe(Atom.withLabel(`mobile-boat-cloud-listed-thread-ids:${environmentId}`)),
  ),
};

const preferencesLoadedAtom = Atom.make((get) => AsyncResult.isSuccess(get(mobilePreferencesAtom)));
const NO_ENVIRONMENT_ATOM = Atom.make(false);

/** Lists an opened VM thread here from now on; the catalog and preferences load after the route. */
export function useRememberOpenedBoatCloudThread(ref: ScopedThreadRef | null): void {
  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  const onBoatCloud = useAtomValue(
    environmentId === null
      ? NO_ENVIRONMENT_ATOM
      : boatCloudThreadList.onBoatCloudAtom(environmentId),
  );
  const loaded = useAtomValue(preferencesLoadedAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the visit in stored preferences, outside React
  useEffect(() => {
    if (!onBoatCloud || !loaded || environmentId === null || threadId === null) return;
    const opened = appAtomRegistry.get(openedThreadsAtom);
    if (
      opened.some((other) => other.environmentId === environmentId && other.threadId === threadId)
    ) {
      return;
    }
    void savePreferences({
      boatCloudOpenedThreads: [...opened, { environmentId, threadId }].slice(-MAX_REMEMBERED),
    });
  }, [onBoatCloud, loaded, environmentId, threadId, savePreferences]);
}
