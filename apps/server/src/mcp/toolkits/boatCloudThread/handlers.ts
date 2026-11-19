import {
  type BoatCloudError,
  type BoatCloudSession,
  type BoatCloudStatus,
  type ModelSelection,
  OrchestratorMcpFailure,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Tool from "effect/ai/Tool";
import { BOAT_CLOUD_BLOCKER_MESSAGES, boatCloudBlocker } from "@t3tools/shared/boatCloudVm";

import * as BoatCloud from "../../../boatCloud/BoatCloudService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { runtimeModeRank } from "../../delegatedTaskModes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "../project/tools.ts";
import { BoatCloudThreadToolkit } from "./tools.ts";

type LaunchInput = Tool.Parameters<
  (typeof BoatCloudThreadToolkit.tools)["t3_boat_cloud_thread_launch"]
>;

/** The checkout script gives up after ten minutes; this only bounds a start that never reports. */
const CHECKOUT_WAIT = Duration.minutes(15);
const MAX_PROJECT_PAGES = 20;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const linksOff = failure(
  "capability_denied",
  "Boat threads are reached as linked environments, and Linked environments is off here. The user can turn it on in Settings → Labs.",
);

const boatFailure = (error: BoatCloudError) =>
  failure("orchestration_error", `Could not start on Boat: ${error.message}`);

/** The git remote a start clones: a fork's own remote, where the agent can push, as the composer picks it. */
const projectRemote = Effect.fn("mcp.boatCloud.projectRemote")(function* (projectId: ProjectId) {
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects.getById(projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project))
    return yield* failure("invalid_request", "The project was not found.");
  const identity = project.value.repositoryIdentity;
  const remoteUrl = identity?.origin?.remoteUrl ?? identity?.locator.remoteUrl;
  if (remoteUrl === undefined)
    return yield* failure(
      "invalid_request",
      `${project.value.title} has no git remote for the VM to clone. Push it to a remote, or pass repositoryUrl.`,
    );
  return remoteUrl;
});

/** Machine types are refused here with Boat's reason, before a VM is asked for. */
const machineTypeOf = (status: BoatCloudStatus, requested: LaunchInput["machineType"]) => {
  const machineType = requested ?? status.defaultMachineType;
  const option = status.machineTypes.find((candidate) => candidate.id === machineType);
  if (option === undefined || option.available) return Effect.succeed(option ?? null);
  const others = status.machineTypes
    .filter((candidate) => candidate.available)
    .map((candidate) => candidate.id);
  return Effect.fail(
    failure(
      "invalid_request",
      `Boat cannot start ${machineType} VMs on this account: ${option.reason ?? "its plan does not include it."}${
        others.length === 0 ? "" : ` Pick machineType ${others.join(", ")}.`
      }`,
    ),
  );
};

/**
 * Waits for the start's repository step: the VM's project exists once it is done. A start
 * listing that already ended counts as done; the project lookup then says what is missing.
 */
const checkoutDone = (boat: BoatCloud.BoatCloudService["Service"], requestId: string) =>
  boat.changes.pipe(
    Stream.map((status) =>
      status.starts
        .find((start) => start.requestId === requestId)
        ?.steps.find((step) => step.step === "repository"),
    ),
    Stream.filter((step) => step === undefined || step.state === "done" || step.state === "failed"),
    Stream.runHead,
    Effect.map((step) => Option.getOrUndefined(step)?.state !== "failed"),
    Effect.timeoutOrElse({ duration: CHECKOUT_WAIT, orElse: () => Effect.succeed(false) }),
  );

const launch = Effect.fn("mcp.boatCloud.launchThread")(function* (
  input: LaunchInput,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const context = yield* readCaller();
  const links = yield* PeerLinks.PeerLinks;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const boat = yield* BoatCloud.BoatCloudService;
  if (scope.linkedEnvironments === false || !(yield* links.enabled)) return yield* linksOff;

  const repositoryUrl =
    input.repositoryUrl ??
    (yield* projectRemote(yield* resolveProjectId(context, input.projectId)));
  const status = Option.getOrUndefined(yield* Stream.runHead(boat.changes));
  if (status === undefined || !status.connected)
    return yield* failure(
      "capability_denied",
      "Boat is not connected on this machine. The user connects a Boat API key in Settings → Environments → Boat.",
    );
  if (!status.snapshotReady && status.setup.status === "running")
    return yield* failure(
      "orchestration_error",
      "Boat setup is still building its snapshot. Try again once Settings → Environments → Boat shows it ready.",
    );
  if (boatCloudBlocker(status) === "no-agents")
    return yield* failure("capability_denied", BOAT_CLOUD_BLOCKER_MESSAGES["no-agents"]);
  const option = yield* machineTypeOf(status, input.machineType);
  const machineType = option?.id ?? input.machineType ?? status.defaultMachineType;

  const random = yield* SecureRandom.SecureRandom;
  const requestId = `mcp:${yield* random.uuidV4()}`;
  // The holder refuses an unfinished setup and a missing key itself, with what to do.
  const session = yield* boat
    .acquire({
      repositoryUrl,
      machineType,
      requestId,
      ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
    })
    .pipe(Effect.mapError(boatFailure));
  // From here the VM is handed out; the idle sweep stops it if nothing runs on it.
  const onVm = (message: string) =>
    failure("orchestration_error", `${message} Boat VM ${session.sandboxId} stays up until idle.`);

  yield* linkVm(links, session, runtimeMode).pipe(
    Effect.mapError((error) => onVm(`Could not link the Boat VM: ${error.message}`)),
  );
  if (!(yield* checkoutDone(boat, requestId)))
    return yield* onVm(
      `The VM could not get ${repositoryUrl}${input.baseBranch === undefined ? "" : ` at ${input.baseBranch}`}. Boat clones with the GitHub access set in its dashboard, under Environments, and a base branch must be pushed.`,
    );
  const projectId = yield* vmProject(scope, forwarding, session).pipe(
    Effect.mapError((error) => onVm(error.message)),
  );
  const modelSelection: ModelSelection | undefined =
    input.modelSelection ?? context.caller?.modelSelection;
  const launched = yield* forwarding
    .call(scope, ProjectToolkit.tools.t3_thread_launch, session.environmentId, {
      projectId,
      title: input.title,
      message: input.message,
      runtimeMode,
      interactionMode,
      ...(modelSelection === undefined ? {} : { modelSelection }),
      ...(session.worktree
        ? {
            workspaceStrategy: {
              type: "existing_worktree" as const,
              worktreePath: session.worktree.path,
            },
          }
        : {}),
      // A lost reply inside the forward retries the same launch, not a second thread.
      clientRequestId: requestId,
    })
    .pipe(Effect.mapError((error) => onVm(error.message)));
  const machine = status.machineTypes.find((candidate) => candidate.id === machineType);
  return {
    threadId: launched.threadId,
    ...(launched.link === undefined ? {} : { link: launched.link }),
    environmentId: session.environmentId,
    projectId: launched.projectId,
    modelSelection: launched.modelSelection,
    runId: launched.runId,
    status: launched.status,
    worktree: session.worktree
      ? { path: session.worktree.path, branch: session.worktree.branch }
      : null,
    sandboxId: session.sandboxId,
    machineType,
    vcpu: machine?.vcpu ?? 0,
    memoryGB: machine?.memoryGB ?? 0,
    hourlyDollars: machine?.hourlyDollars ?? null,
  };
});

/**
 * Links this environment to the VM with the start's one-time code, so the launch and every
 * later `t3_thread_*` call reach it like any linked machine. The link never allows more than
 * the caller's mode, unless an earlier start on a shared VM already linked it with more.
 */
const linkVm = Effect.fn("mcp.boatCloud.linkVm")(function* (
  links: PeerLinks.PeerLinks["Service"],
  session: BoatCloudSession,
  runtimeMode: RuntimeMode,
) {
  const existing = Option.getOrUndefined(yield* links.get(session.environmentId));
  const live =
    existing !== undefined && DateTime.isGreaterThan(existing.expiresAt, yield* DateTime.now)
      ? existing
      : undefined;
  if (session.pairingCode === null) {
    if (live !== undefined) return;
    return yield* failure("orchestration_error", "The VM issued no pairing code.");
  }
  const access =
    live !== undefined &&
    live.access !== "read-only" &&
    runtimeModeRank(live.access) > runtimeModeRank(runtimeMode)
      ? live.access
      : runtimeMode;
  yield* links.link({
    url: session.httpBaseUrl,
    pairingCode: session.pairingCode,
    access,
    expectedEnvironmentId: session.environmentId,
    expectedLabel: `Boat VM ${session.sandboxId}`,
  });
});

/** The project the VM's checkout added, found by its folder. */
const vmProject = Effect.fn("mcp.boatCloud.vmProject")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  forwarding: PeerForwarding.PeerForwarding["Service"],
  session: BoatCloudSession,
) {
  let cursor = 0;
  for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
    const listed = yield* forwarding.call(
      scope,
      ProjectToolkit.tools.t3_project_list,
      session.environmentId,
      { cursor, limit: 100 },
    );
    const found = listed.projects.find(
      (project) => project.workspaceRoot === session.workspaceRoot,
    );
    if (found !== undefined) return found.id;
    if (listed.nextCursor === null) break;
    cursor = listed.nextCursor;
  }
  return yield* failure(
    "orchestration_error",
    `The VM checked out ${session.workspaceRoot ?? "the repository"} but lists no project for it.`,
  );
});

export const layer = McpToolAccess.toLayer(BoatCloudThreadToolkit, {
  t3_boat_cloud_thread_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode }) => launch(input, runtimeMode, interactionMode),
    // Linked work spends nothing of this machine's: a VM is billed to its Boat key.
    { refused: "start Boat VMs on this machine's Boat account" },
  ),
});
