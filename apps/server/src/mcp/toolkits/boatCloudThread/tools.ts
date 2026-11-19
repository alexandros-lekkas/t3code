import {
  BoatCloudMachineType,
  EnvironmentId,
  ModelSelection,
  OrchestratorMcpFailure,
  OrchestrationV2RunStatus,
  ProjectId,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BoatCloud from "../../../boatCloud/BoatCloudService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * Its own tool rather than a `t3_thread_launch` target: that tool's `environmentId` is routed
 * to an existing link before any handler runs, and its `projectId` and workspace name things
 * in the environment it runs in, while a Boat VM exists only once this call starts it.
 */
const BoatCloudThreadLaunchTool = Tool.make("t3_boat_cloud_thread_launch", {
  description:
    "Spawn a new top-level thread on a Boat cloud VM (boat.dev), as in 'run this on Boat'. Starts a `machineType` VM, clones the project's git remote and sends `message`. Takes a minute or more; do not retry. Follow it with `t3_thread_read` or `t3_thread_wait` and the returned `environmentId`.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString,
    message: Schema.String.check(Schema.isMaxLength(120000)).annotate({
      description: "First prompt.",
    }),
    machineType: Schema.optional(
      BoatCloudMachineType.annotate({ description: "VM size. Omit for the user's default." }),
    ),
    projectId: Schema.optional(
      ProjectId.annotate({
        description: "Project here whose git remote the VM clones. Omit for yours.",
      }),
    ),
    repositoryUrl: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(2048)).annotate({
        description: "Git remote to clone instead of a project's.",
      }),
    ),
    baseBranch: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
        description:
          "Pushed branch to cut the thread's new worktree from. Omit to work in the VM's checkout.",
      }),
    ),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    link: Schema.optional(Schema.String),
    /** The VM's T3 environment, linked from here. */
    environmentId: EnvironmentId,
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
    worktree: Schema.NullOr(Schema.Struct({ path: Schema.String, branch: Schema.String })),
    sandboxId: Schema.String,
    machineType: BoatCloudMachineType,
    vcpu: Schema.Number,
    memoryGB: Schema.Number,
    hourlyDollars: Schema.NullOr(Schema.Number),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
    BoatCloud.BoatCloudService,
    PeerLinks.PeerLinks,
    PeerForwarding.PeerForwarding,
    ProjectService.ProjectService,
  ],
})
  .annotate(Tool.Title, "Launch a thread on Boat cloud")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const BoatCloudThreadToolkit = Toolkit.make(BoatCloudThreadLaunchTool);
