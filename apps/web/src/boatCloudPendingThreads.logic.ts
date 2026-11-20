import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentThreadShell,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { asLaunchingThread } from "@t3tools/client-runtime/state/thread-inbox";
import { type ModelSelection, ProviderInstanceId, type ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { DraftId, DraftSessionState } from "./composerDraftStore";

/** A cloud draft whose first message waits on its Boat VM, listed as a thread until the VM has it. */
export interface PendingBoatCloudThread {
  readonly title: string;
  readonly sentAt: string;
  readonly modelSelection: ModelSelection | null;
}

const FALLBACK_PROVIDER = ProviderInstanceId.make("codex");

/**
 * The row a waiting draft lists as: its thread to be, setting up, or failed with the start's
 * error. It takes the draft's thread id and environment, so the thread the VM creates for it
 * replaces it under the same key.
 */
function pendingBoatCloudThreadShell(input: {
  readonly draft: Pick<
    DraftSessionState,
    | "threadId"
    | "environmentId"
    | "projectId"
    | "runtimeMode"
    | "interactionMode"
    | "branch"
    | "worktreePath"
  >;
  readonly pending: PendingBoatCloudThread;
  readonly error: string | null;
}): EnvironmentThreadShell {
  const { draft, pending, error } = input;
  const at = DateTime.makeUnsafe(pending.sentAt);
  const modelSelection = pending.modelSelection ?? { instanceId: FALLBACK_PROVIDER, model: "" };
  const shell = presentThreadShell(draft.environmentId, {
    id: draft.threadId,
    projectId: draft.projectId,
    title: pending.title,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: draft.runtimeMode,
    interactionMode: draft.interactionMode,
    // The VM usually cuts the thread's worktree before it starts, so the row has a branch line
    // from the start (the base until then) and keeps its height when the thread replaces it.
    branch: draft.branch,
    worktreePath: draft.worktreePath,
    activeProviderThreadId: null,
    lineage: { rootThreadId: draft.threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: at,
    hasActionableProposedPlan: false,
    itemCount: 1,
    visibleItemCount: 1,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: at,
    deletedAt: null,
  });
  if (error === null) return asLaunchingThread(shell);
  return {
    ...shell,
    runtime: {
      status: "failed",
      activeRunId: null,
      providerInstanceId: shell.providerInstanceId,
      providerName: null,
      lastError: error,
      updatedAt: shell.updatedAt,
    },
  };
}

export interface PendingBoatCloudThreadRow {
  readonly draftId: DraftId;
  readonly ref: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
}

/**
 * The rows waiting drafts list as. A draft is promoted as its send goes out, before its thread
 * reaches the list, so it keeps its row until a thread in `listed` takes its place.
 */
export function pendingBoatCloudThreadRows(
  entries: ReadonlyArray<{
    readonly draftId: DraftId;
    readonly pending: PendingBoatCloudThread;
    readonly error: string | null;
  }>,
  drafts: ReadonlyArray<DraftSessionState | null>,
  listed: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "id">>,
): ReadonlyArray<PendingBoatCloudThreadRow> {
  return entries.flatMap(({ draftId, pending, error }, index) => {
    const draft = drafts[index];
    if (!draft || draft.environmentSelection !== "cloud") return [];
    const ref = draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId);
    if (
      listed.some(
        (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
      )
    ) {
      return [];
    }
    return [
      {
        draftId,
        ref,
        shell: pendingBoatCloudThreadShell({
          draft: { ...draft, environmentId: ref.environmentId, threadId: ref.threadId },
          pending,
          error,
        }),
      },
    ];
  });
}
