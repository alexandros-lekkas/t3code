import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pendingBoatCloudThreadRows } from "./boatCloudPendingThreads.logic";
import { DraftId, type DraftSessionState } from "./composerDraftStore";

const local = EnvironmentId.make("local");
const vm = EnvironmentId.make("vm");
const threadId = ThreadId.make("thread-1");
const draftId = DraftId.make("draft-1");

const draft = (overrides: Partial<DraftSessionState> = {}): DraftSessionState => ({
  threadId,
  environmentId: local,
  projectId: ProjectId.make("project-1"),
  logicalProjectKey: "repo",
  environmentSelection: "cloud",
  createdAt: "2026-11-20T10:00:00.000Z",
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  envMode: "worktree",
  startFromOrigin: true,
  promotedTo: null,
  ...overrides,
});

const entry = (error: string | null = null) => ({
  draftId,
  pending: { title: "Fix the login", sentAt: "2026-11-20T10:00:05.000Z", modelSelection: null },
  error,
});

describe("pendingBoatCloudThreadRows", () => {
  it("lists a waiting draft as its thread, setting up, until that thread lists", () => {
    const [row] = pendingBoatCloudThreadRows([entry()], [draft()], []);
    expect(row?.ref).toEqual({ environmentId: local, threadId });
    expect(row?.shell.title).toBe("Fix the login");
    expect(row?.shell.runtime?.status).toBe("preparing");

    // Sent: the draft is promoted onto the VM before the VM's thread reaches the list.
    const promoted = draft({
      environmentId: vm,
      promotedTo: { environmentId: vm, threadId },
    });
    expect(pendingBoatCloudThreadRows([entry()], [promoted], [])[0]?.ref).toEqual({
      environmentId: vm,
      threadId,
    });
    expect(
      pendingBoatCloudThreadRows([entry()], [promoted], [{ environmentId: vm, id: threadId }]),
    ).toEqual([]);
  });

  it("keeps a failed start's row, failed, and drops a draft that left Boat", () => {
    const [failed] = pendingBoatCloudThreadRows([entry("The VM did not start.")], [draft()], []);
    expect(failed?.shell.runtime).toMatchObject({
      status: "failed",
      lastError: "The VM did not start.",
    });
    expect(
      pendingBoatCloudThreadRows([entry()], [draft({ environmentSelection: "manual" })], []),
    ).toEqual([]);
    expect(pendingBoatCloudThreadRows([entry()], [null], [])).toEqual([]);
  });
});
