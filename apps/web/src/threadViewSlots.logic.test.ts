import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "./composerDraftStore";
import type { ThreadRouteTarget } from "./threadRoutes";
import { INITIAL_THREAD_VIEW_SLOTS, nextThreadViewSlots } from "./threadViewSlots.logic";

const draftA = DraftId.make("draft-a");
const draft = (draftId: DraftId): ThreadRouteTarget => ({ kind: "draft", draftId });
const thread = (id: string): ThreadRouteTarget => ({
  kind: "server",
  threadRef: scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(id)),
});
const never = () => false;

describe("nextThreadViewSlots", () => {
  it("keeps a draft's view while its message waits on Boat, and gives it back on return", () => {
    const start = INITIAL_THREAD_VIEW_SLOTS(draft(draftA));
    const away = nextThreadViewSlots(start, {
      target: thread("other"),
      waiting: [draftA],
      continuesDraft: never,
    });
    expect(away.parked).toEqual([{ key: start.shownKey, draftId: draftA }]);
    expect(away.shownKey).not.toBe(start.shownKey);

    const back = nextThreadViewSlots(away, {
      target: draft(draftA),
      waiting: [draftA],
      continuesDraft: never,
    });
    expect(back.shownKey).toBe(start.shownKey);
    expect(back.parked).toEqual([]);
  });

  it("drops a parked view once its message went out", () => {
    const away = nextThreadViewSlots(INITIAL_THREAD_VIEW_SLOTS(draft(draftA)), {
      target: thread("other"),
      waiting: [draftA],
      continuesDraft: never,
    });
    const sent = nextThreadViewSlots(away, {
      target: thread("other"),
      waiting: [],
      continuesDraft: never,
    });
    expect(sent.parked).toEqual([]);
    expect(sent.shownKey).toBe(away.shownKey);
  });

  it("keeps one view when the route follows a draft to its thread or nothing waits", () => {
    const start = INITIAL_THREAD_VIEW_SLOTS(draft(draftA));
    const promoted = nextThreadViewSlots(start, {
      target: thread("a"),
      waiting: [draftA],
      continuesDraft: () => true,
    });
    expect(promoted.shownKey).toBe(start.shownKey);
    expect(promoted.parked).toEqual([]);

    const idle = nextThreadViewSlots(start, {
      target: thread("other"),
      waiting: [],
      continuesDraft: never,
    });
    expect(idle.shownKey).toBe(start.shownKey);
    expect(
      nextThreadViewSlots(idle, { target: thread("other"), waiting: [], continuesDraft: never }),
    ).toBe(idle);
  });
});
