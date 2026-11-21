import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useMatches } from "@tanstack/react-router";
import { useState } from "react";

import {
  getAppModalReturnThreadTarget,
  isAppModalPage,
} from "../components/sidebar/mainAppLocation";
import { useBoatCloudWaitingSendDraftIds } from "../boatCloudPendingThreads";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import { INITIAL_THREAD_VIEW_SLOTS, nextThreadViewSlots } from "../threadViewSlots.logic";
import { useThreadRouteTarget } from "./useThreadRouteTarget";

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

/** Settings and Usage render over the thread that opened them; that thread stays the shown one. */
export function useShownThreadRouteTarget() {
  const routeTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  const [backgroundTarget, setBackgroundTarget] = useState(() =>
    modalOpen ? getAppModalReturnThreadTarget() : routeTarget,
  );
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(routeTarget)) {
    setBackgroundTarget(routeTarget);
  }
  return { shownTarget: modalOpen ? backgroundTarget : routeTarget, modalOpen };
}

function continuesDraft(draftId: DraftId, target: ThreadRouteTarget | null) {
  if (target?.kind !== "server") return false;
  const store = useComposerDraftStore.getState();
  const redirect = store.getPromotedDraftRedirect(draftId);
  return (
    store.getDraftIdByRef(target.threadRef) === draftId ||
    (redirect !== null && scopedThreadKey(redirect) === scopedThreadKey(target.threadRef))
  );
}

/** The shown thread view's key, and the drafts kept mounted while their message waits on Boat. */
export function useThreadViewSlots(shownTarget: ThreadRouteTarget | null) {
  const waiting = useBoatCloudWaitingSendDraftIds();
  const [slots, setSlots] = useState(() => INITIAL_THREAD_VIEW_SLOTS(shownTarget));
  const next = nextThreadViewSlots(slots, { target: shownTarget, waiting, continuesDraft });
  if (next !== slots) setSlots(next);
  return next;
}
