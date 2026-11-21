import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { DraftId } from "./composerDraftStore";
import type { ThreadRouteTarget } from "./threadRoutes";

/**
 * The thread views the chat layout keeps mounted: the one on screen, and each draft whose
 * message still waits on a Boat VM. A view keeps its key while it moves between the two, so the
 * instance that took the message is the one that sends it.
 */
export interface ThreadViewSlots {
  readonly shownKey: string;
  readonly shownTarget: ThreadRouteTarget | null;
  readonly parked: ReadonlyArray<{ readonly key: string; readonly draftId: DraftId }>;
  readonly minted: number;
}

export const INITIAL_THREAD_VIEW_SLOTS = (target: ThreadRouteTarget | null): ThreadViewSlots => ({
  shownKey: "view:0",
  shownTarget: target,
  parked: [],
  minted: 1,
});

function targetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

export function nextThreadViewSlots(
  slots: ThreadViewSlots,
  input: {
    readonly target: ThreadRouteTarget | null;
    readonly waiting: ReadonlyArray<DraftId>;
    /** The target is the thread this draft became, shown by the same view. */
    readonly continuesDraft: (draftId: DraftId, target: ThreadRouteTarget | null) => boolean;
  },
): ThreadViewSlots {
  const { target, waiting, continuesDraft } = input;
  const stillParked = slots.parked.filter((view) => waiting.includes(view.draftId));
  const parkedUnchanged = stillParked.length === slots.parked.length;
  if (targetKey(target) === targetKey(slots.shownTarget)) {
    return parkedUnchanged ? slots : { ...slots, parked: stillParked };
  }
  const left = slots.shownTarget;
  const parksLeft =
    left?.kind === "draft" &&
    waiting.includes(left.draftId) &&
    !continuesDraft(left.draftId, target);
  const returning =
    target?.kind === "draft"
      ? (stillParked.find((view) => view.draftId === target.draftId) ?? null)
      : null;
  const parked = [
    ...stillParked.filter((view) => view !== returning),
    ...(parksLeft ? [{ key: slots.shownKey, draftId: left.draftId }] : []),
  ];
  if (returning !== null) {
    return { ...slots, shownKey: returning.key, shownTarget: target, parked };
  }
  if (!parksLeft) return { ...slots, shownTarget: target, parked };
  return {
    shownKey: `view:${slots.minted}`,
    shownTarget: target,
    parked,
    minted: slots.minted + 1,
  };
}
