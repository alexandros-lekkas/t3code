import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type BoatCloudAcquireInput,
  BoatCloudError,
  type BoatCloudStatus,
  EnvironmentId,
  type PeerLinkCreateInput,
  type Project as ProjectRecord,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  BOAT_CLOUD_NO_LOCAL_SIGN_INS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as BoatCloud from "../../../boatCloud/BoatCloudService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BoatCloudThreadHandlers from "./handlers.ts";
import { BoatCloudThreadToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:mac");
const vmEnvironmentId = EnvironmentId.make("environment:boat-vm");
const callerThreadId = ThreadId.make("thread:caller");
const localProjectId = ProjectId.make("project:mcp-test");
const vmProjectId = ProjectId.make("project:vm");
const REMOTE = "https://github.com/acme/app.git";
const WORKSPACE = "/home/boat/projects/acme/app";
const EPOCH = "2026-01-01T00:00:00.000Z";

const machineTypes: BoatCloudStatus["machineTypes"] = [
  {
    id: "small",
    vcpu: 1,
    memoryGB: 2,
    hourlyDollars: 0.05,
    priceSource: "derived",
    available: true,
    reason: null,
  },
  {
    id: "default",
    vcpu: 2,
    memoryGB: 4,
    hourlyDollars: 0.1,
    priceSource: "boat",
    available: true,
    reason: null,
  },
  {
    id: "xlarge",
    vcpu: 8,
    memoryGB: 16,
    hourlyDollars: 0.4,
    priceSource: "derived",
    available: false,
    reason: "xlarge needs the Team plan.",
  },
];

const readyStatus: BoatCloudStatus = {
  connected: true,
  account: "acme",
  setup: { status: "ready", step: null, error: null },
  snapshotReady: true,
  machines: [],
  starts: [],
  environment: null,
  environments: [],
  environmentsError: null,
  githubConnected: true,
  shareMachines: false,
  keepReadyMachine: false,
  defaultMachineType: "small",
  machineTypes,
  environmentUsage: [],
  localSignIns: BOAT_CLOUD_NO_LOCAL_SIGN_INS,
};

const vmProject = {
  id: vmProjectId,
  title: "app",
  workspaceRoot: WORKSPACE,
  defaultModelSelection: null,
  scripts: [],
  createdAt: EPOCH,
  updatedAt: EPOCH,
  deletedAt: null,
} as unknown as ProjectRecord;

interface Recorded {
  readonly acquired: Array<BoatCloudAcquireInput>;
  readonly linked: Array<PeerLinkCreateInput>;
  readonly launched: Array<Record<string, unknown>>;
}

/**
 * A fake Boat holder: `acquire` hands out one VM and lists its start with the checkout still
 * running, which ends as `checkout` says once someone watches it running.
 */
const harness = (input: {
  readonly status?: Partial<BoatCloudStatus>;
  readonly checkout?: "done" | "failed";
  readonly linksEnabled?: boolean;
  readonly acquireError?: string;
}) =>
  Effect.gen(function* () {
    const recorded: Recorded = { acquired: [], linked: [], launched: [] };
    const status = yield* SubscriptionRef.make<BoatCloudStatus>({
      ...readyStatus,
      ...input.status,
    });
    const setRepositoryStep = (requestId: string, state: "active" | "done" | "failed") =>
      SubscriptionRef.update(status, (current) => ({
        ...current,
        starts: [
          {
            requestId,
            steps: [
              { step: "machine" as const, state: "done" as const, detail: null },
              { step: "repository" as const, state, detail: "acme/app" },
            ],
          },
        ],
      }));
    const layer = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:boat",
        thread: {
          threadId: callerThreadId,
          providerSessionId: "provider:boat",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
        linkedEnvironments: true,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(callerThreadId)),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            ...vmProject,
            id: localProjectId,
            repositoryIdentity: {
              canonicalKey: "github.com/acme/app",
              locator: { source: "git-remote", remoteName: "origin", remoteUrl: REMOTE },
            },
          } as unknown as ProjectRecord),
      }),
      Layer.mock(BoatCloud.BoatCloudService)({
        changes: SubscriptionRef.changes(status).pipe(
          Stream.tap((current) => {
            const start = current.starts[0];
            return start?.steps.some((step) => step.state === "active")
              ? setRepositoryStep(start.requestId, input.checkout ?? "done")
              : Effect.void;
          }),
        ),
        acquire: (acquire) =>
          Effect.gen(function* () {
            recorded.acquired.push(acquire);
            if (input.acquireError !== undefined)
              return yield* new BoatCloudError({ message: input.acquireError });
            yield* setRepositoryStep(acquire.requestId, "active");
            return {
              sandboxId: "bx_fake",
              environmentId: vmEnvironmentId,
              httpBaseUrl: "https://fake-3773.on.boat.dev",
              pairingCode: "PAIR-1",
              workspaceRoot: WORKSPACE,
              worktree:
                acquire.baseBranch === undefined
                  ? null
                  : {
                      path: "/home/boat/.t3/worktrees/app/t3code-1",
                      branch: "t3code/1",
                      baseBranch: acquire.baseBranch,
                    },
            };
          }),
      }),
      Layer.mock(PeerLinks.PeerLinks)({
        enabled: Effect.succeed(input.linksEnabled ?? true),
        get: () => Effect.succeedNone,
        link: (link) =>
          Effect.gen(function* () {
            recorded.linked.push(link);
            const now = yield* DateTime.now;
            return {
              environmentId: vmEnvironmentId,
              label: "boat",
              urls: [link.url],
              access: link.access,
              linkedAt: now,
              expiresAt: DateTime.add(now, { days: 30 }),
              lastReachedAt: now,
              lastError: null,
            };
          }),
      }),
      Layer.mock(PeerForwarding.PeerForwarding)({
        call: (_scope, tool, target, params) =>
          Effect.sync(() => {
            expect(target).toBe(vmEnvironmentId);
            if (tool.name === "t3_project_list")
              return { projects: [vmProject], nextCursor: null } as never;
            recorded.launched.push(params as Record<string, unknown>);
            return {
              threadId: ThreadId.make("thread:vm"),
              link: "t3-thread://environment:boat-vm/thread:vm",
              projectId: vmProjectId,
              modelSelection: (params as { modelSelection: unknown }).modelSelection,
              runId: RunId.make("run:vm"),
              status: "running",
            } as never;
          }),
      }),
      NodeCrypto.layer,
    );
    const toolkit = yield* BoatCloudThreadToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(BoatCloudThreadHandlers.layer).pipe(
          Layer.provideMerge(layer),
        ),
      ),
    );
    const call = (params: Parameters<typeof toolkit.handle<"t3_boat_cloud_thread_launch">>[1]) =>
      toolkit.handle("t3_boat_cloud_thread_launch", params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result),
        Effect.provide(layer),
      );
    return { call, recorded };
  });

it.effect("starts a VM, links it, and launches the thread in its checkout once it is done", () =>
  Effect.gen(function* () {
    const { call, recorded } = yield* harness({});
    const result = yield* call({
      title: "Fix the flaky test",
      message: "Fix it",
      baseBranch: "main",
    });

    expect(recorded.acquired).toMatchObject([
      { repositoryUrl: REMOTE, baseBranch: "main", machineType: "small" },
    ]);
    // The caller runs at full access, so the link allows no more than that.
    expect(recorded.linked).toEqual([
      {
        url: "https://fake-3773.on.boat.dev",
        pairingCode: "PAIR-1",
        access: "full-access",
        expectedEnvironmentId: vmEnvironmentId,
        expectedLabel: "Boat VM bx_fake",
      },
    ]);
    expect(recorded.launched).toEqual([
      {
        projectId: vmProjectId,
        title: "Fix the flaky test",
        message: "Fix it",
        runtimeMode: "full-access",
        interactionMode: "default",
        modelSelection: liveThreadShell(callerThreadId).modelSelection,
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: "/home/boat/.t3/worktrees/app/t3code-1",
        },
        clientRequestId: recorded.acquired[0]!.requestId,
      },
    ]);
    expect(result).toMatchObject({
      threadId: "thread:vm",
      link: "t3-thread://environment:boat-vm/thread:vm",
      environmentId: vmEnvironmentId,
      projectId: vmProjectId,
      worktree: { path: "/home/boat/.t3/worktrees/app/t3code-1", branch: "t3code/1" },
      sandboxId: "bx_fake",
      machineType: "small",
      vcpu: 1,
      memoryGB: 2,
      hourlyDollars: 0.05,
    });

    // Without a base branch the thread works in the VM's checkout.
    const root = yield* call({
      title: "Look around",
      message: "Read the README",
      machineType: "default",
      repositoryUrl: "https://github.com/acme/other.git",
    });
    expect(recorded.acquired[1]).toMatchObject({
      repositoryUrl: "https://github.com/acme/other.git",
      machineType: "default",
    });
    expect(recorded.launched[1]).not.toHaveProperty("workspaceStrategy");
    expect(root).toMatchObject({ worktree: null, machineType: "default", hourlyDollars: 0.1 });
  }),
);

it.effect("refuses before starting a VM when Boat cannot serve the request", () =>
  Effect.gen(function* () {
    const unavailable = yield* harness({});
    expect(
      yield* unavailable.call({ title: "Big", message: "Build", machineType: "xlarge" }),
    ).toEqual(
      expect.objectContaining({
        code: "invalid_request",
        message:
          "Boat cannot start xlarge VMs on this account: xlarge needs the Team plan. Pick machineType small, default.",
      }),
    );
    expect(unavailable.recorded.acquired).toEqual([]);

    const disconnected = yield* harness({ status: { connected: false } });
    expect(yield* disconnected.call({ title: "T", message: "M" })).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("Settings → Boat"),
    });
    const building = yield* harness({
      status: { snapshotReady: false, setup: { status: "running", step: null, error: null } },
    });
    expect(yield* building.call({ title: "T", message: "M" })).toMatchObject({
      code: "orchestration_error",
      message: expect.stringContaining("still building its snapshot"),
    });
    const noSignIns = yield* harness({
      status: {
        environment: "base",
        environments: [
          {
            id: "env-base",
            name: "base",
            isDefault: true,
            passGithub: true,
            passSandboxCredentials: false,
            passSecrets: false,
            passAgentsCredentials: true,
            agentCredentials: [],
          },
        ],
      },
    });
    expect(yield* noSignIns.call({ title: "T", message: "M" })).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("has a Claude or ChatGPT sign-in"),
    });
    const linksOff = yield* harness({ linksEnabled: false });
    expect(yield* linksOff.call({ title: "T", message: "M" })).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("Settings → Labs"),
    });
    for (const refused of [disconnected, building, noSignIns, linksOff])
      expect(refused.recorded.acquired).toEqual([]);

    // The holder's own refusal, such as an unfinished setup, reaches the agent as it said it.
    const unfinished = yield* harness({
      acquireError: "Finish Boat setup in Settings → Boat.",
    });
    expect(yield* unfinished.call({ title: "T", message: "M" })).toMatchObject({
      code: "orchestration_error",
      message: "Could not start on Boat: Finish Boat setup in Settings → Boat.",
    });
  }),
);

it.effect("launches nothing when the VM could not check the repository out", () =>
  Effect.gen(function* () {
    const { call, recorded } = yield* harness({ checkout: "failed" });
    expect(yield* call({ title: "T", message: "M", baseBranch: "feature" })).toMatchObject({
      code: "orchestration_error",
      message: expect.stringMatching(/could not get .* at feature.*Boat VM bx_fake stays up/su),
    });
    expect(recorded.launched).toEqual([]);
  }),
);
