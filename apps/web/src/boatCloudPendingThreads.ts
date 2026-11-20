import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useShallow } from "zustand/react/shallow";

import { boatCloudStartProgressAtom } from "./boatCloud";
import {
  type PendingBoatCloudThread,
  type PendingBoatCloudThreadRow,
  pendingBoatCloudThreadRows,
} from "./boatCloudPendingThreads.logic";
import { type DraftId, useComposerDraftStore } from "./composerDraftStore";
import { appAtomRegistry } from "./rpc/atomRegistry";

const pendingAtom = Atom.make<Readonly<Record<string, PendingBoatCloudThread>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("boat-cloud-pending-threads"),
);

/** The draft's message waits on its VM: the sidebar lists the thread from now on. */
export function markBoatCloudThreadPending(draftId: DraftId, pending: PendingBoatCloudThread) {
  appAtomRegistry.set(pendingAtom, { ...appAtomRegistry.get(pendingAtom), [draftId]: pending });
}

/** The message went back to the composer, or the draft left Boat: the draft lists as a draft again. */
export function clearBoatCloudThreadPending(draftId: DraftId) {
  const current = appAtomRegistry.get(pendingAtom);
  if (!(draftId in current)) return;
  const { [draftId]: _removed, ...rest } = current;
  appAtomRegistry.set(pendingAtom, rest);
}

const pendingWithErrorsAtom = Atom.make((get) =>
  Object.entries(get(pendingAtom)).map(([draftId, pending]) => ({
    draftId: draftId as DraftId,
    pending,
    error: get(boatCloudStartProgressAtom(draftId))?.error ?? null,
  })),
).pipe(Atom.withLabel("boat-cloud-pending-threads-with-errors"));

const NO_PENDING_THREADS: ReadonlyArray<PendingBoatCloudThreadRow> = [];

/**
 * The threads Boat cloud drafts are waiting to start, until their draft becomes the VM's
 * thread. A thread already in `listed` lists on its own, so its placeholder goes.
 */
export function usePendingBoatCloudThreads(
  listed: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "id">>,
): ReadonlyArray<PendingBoatCloudThreadRow> {
  const entries = useAtomValue(pendingWithErrorsAtom);
  const drafts = useComposerDraftStore(
    useShallow((store) =>
      entries.map(({ draftId }) => store.draftThreadsByThreadKey[draftId] ?? null),
    ),
  );
  if (entries.length === 0) return NO_PENDING_THREADS;
  return pendingBoatCloudThreadRows(entries, drafts, listed);
}

/** The draft waiting on a Boat VM to start this thread, if one is. */
export function pendingBoatCloudDraftIdOf(ref: ScopedThreadRef): DraftId | null {
  const drafts = useComposerDraftStore.getState().draftThreadsByThreadKey;
  for (const draftId of Object.keys(appAtomRegistry.get(pendingAtom))) {
    const draft = drafts[draftId];
    if (
      draft &&
      !draft.promotedTo &&
      draft.environmentId === ref.environmentId &&
      draft.threadId === ref.threadId
    ) {
      return draftId as DraftId;
    }
  }
  return null;
}

/** The title a draft waiting on its Boat VM already lists under, or null. */
export function usePendingBoatCloudThreadTitle(draftId: DraftId | null): string | null {
  const pending = useAtomValue(pendingAtom);
  return draftId === null ? null : (pending[draftId]?.title ?? null);
}
