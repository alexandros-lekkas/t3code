import {
  BoatCloudEnvironment,
  BoatCloudEnvironmentVariableKey,
  BoatCloudMachine,
  BoatCloudMachineType,
  BoatCloudRootEnvironment,
  BoatCloudRootEnvironmentEdits,
  BoatCloudSecretFilePath,
  BoatCloudSetup,
  BoatCloudSnapshot,
  OrchestratorMcpFailure,
  SecretRef,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Tool, Toolkit } from "effect/ai";
import * as BoatCloud from "../../../boatCloud/BoatCloudService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    BoatCloud.BoatCloudService,
  ],
};

const BoatEnvironmentName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).annotate({ description: "A Boat environment's name or id." });
const SandboxId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const SecretValue = Schema.String.check(Schema.isMaxLength(256 * 1024));

// Live load is the settings page's; the agent gets the size and what the VM cost.
const Machine = Schema.Struct(Struct.omit(BoatCloudMachine.fields, ["stats"]));

const BoatCloudStatusTool = Tool.make("t3_boat_cloud_status", {
  ...shared,
  description:
    "Read Boat: connection, snapshot, the root environment new VMs start from (names only, never secret values), and managed VMs.",
  success: Schema.Struct({
    connected: Schema.Boolean,
    account: Schema.NullOr(Schema.String),
    snapshot: Schema.NullOr(BoatCloudSnapshot),
    snapshotReady: Schema.Boolean,
    setup: BoatCloudSetup,
    environment: Schema.NullOr(Schema.String),
    rootEnvironment: Schema.NullOr(BoatCloudRootEnvironment),
    environments: Schema.Array(BoatCloudEnvironment),
    environmentsError: Schema.NullOr(Schema.String),
    shareMachines: Schema.Boolean,
    defaultMachineType: BoatCloudMachineType,
    machines: Schema.Array(Machine),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const BoatCloudConfigureTool = Tool.make("t3_boat_cloud_configure", {
  ...shared,
  description:
    "Set what new Boat VMs start with: the Boat environment, the default size, and whether threads share VMs. Running VMs keep theirs. Omitted fields are unchanged. Live full-access or default caller thread only.",
  parameters: Schema.Struct({
    boatEnvironment: Schema.optionalKey(BoatEnvironmentName),
    defaultMachineType: Schema.optionalKey(BoatCloudMachineType),
    shareMachines: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({
    environment: Schema.NullOr(Schema.String),
    environments: Schema.Array(BoatCloudEnvironment),
    shareMachines: Schema.Boolean,
    defaultMachineType: BoatCloudMachineType,
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const BoatCloudRootEnvironmentUpdateTool = Tool.make("t3_boat_cloud_root_environment_update", {
  ...shared,
  description:
    "Edit what new Boat VMs get from their Boat environment: repositories (`owner/repo`), variables, secret files (paths relative to the workspace), switches. Give each value as `value`/`contents`, or a secret as `secretRef` from `request_secret`; values are never read back. Running VMs change only with `upgradeMachines`. Live full-access or default caller thread only.",
  parameters: Schema.Struct({
    boatEnvironment: Schema.optionalKey(
      BoatEnvironmentName.annotate({ description: "Defaults to the one new VMs start on." }),
    ),
    ...BoatCloudRootEnvironmentEdits.fields,
    setVariables: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          key: BoatCloudEnvironmentVariableKey,
          value: Schema.optionalKey(SecretValue),
          secretRef: Schema.optionalKey(SecretRef),
        }),
      ).check(Schema.isMaxLength(50)),
    ),
    setSecretFiles: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          path: BoatCloudSecretFilePath,
          contents: Schema.optionalKey(SecretValue),
          secretRef: Schema.optionalKey(SecretRef),
        }),
      ).check(Schema.isMaxLength(20)),
    ),
  }),
  success: Schema.Struct({
    rootEnvironment: BoatCloudRootEnvironment,
    upgraded: Schema.NullOr(Schema.Struct({ machines: Schema.Number, failed: Schema.Number })),
  }),
  dependencies: [...shared.dependencies, SecretRequests.SecretRequests],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const BoatCloudSnapshotRebuildTool = Tool.make("t3_boat_cloud_snapshot_rebuild", {
  ...shared,
  description:
    "Rebuild the snapshot new Boat VMs start from, as Settings does. Runs in the background; `t3_boat_cloud_status` shows `setup`. Live full-access or default caller thread only.",
  success: Schema.Struct({ setup: BoatCloudSetup, snapshot: Schema.NullOr(BoatCloudSnapshot) }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const BoatCloudMachineTool = Tool.make("t3_boat_cloud_machine", {
  ...shared,
  description:
    "Stop (after a backup), wake, or delete a Boat VM this T3 Code manages. A deleted VM with a backup stays restorable by waking its thread. Deleting a running VM needs `force: true`; delete needs a live full-access or default caller thread.",
  parameters: Schema.Struct({
    action: Schema.Literals(["stop", "wake", "delete"]),
    sandboxId: SandboxId,
    force: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({ machine: Schema.NullOr(Machine) }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const BoatCloudToolkit = Toolkit.make(
  BoatCloudStatusTool,
  BoatCloudConfigureTool,
  BoatCloudRootEnvironmentUpdateTool,
  BoatCloudSnapshotRebuildTool,
  BoatCloudMachineTool,
);
