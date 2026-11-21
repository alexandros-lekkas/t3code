import { expect, it } from "@effect/vitest";
import {
  BoatCloudError,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  type RuntimeMode,
  SecretRef,
  SecretRequestError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BoatCloud from "../../../boatCloud/BoatCloudService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BoatCloudHandlers from "./handlers.ts";
import { BoatCloudToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:boat");
const threadId = ThreadId.make("thread:boat");
const ref = SecretRef.make("secret-ref:boat");

const ROOT_ENVIRONMENT = {
  id: "env-base",
  name: "base",
  isDefault: true,
  version: 5,
  safeForThirdParties: false,
  passGithub: true,
  passSandboxCredentials: true,
  passSecrets: true,
  passAgentsCredentials: true,
  variables: ["API_KEY"],
  secretFiles: [".env"],
  repositories: [],
  versions: [],
};

const run = (runtimeMode: RuntimeMode) =>
  Effect.gen(function* () {
    const updates: Array<BoatCloud.BoatCloudRootEnvironmentUpdate> = [];
    const machineCalls: Array<string> = [];
    const consumed: Array<string> = [];
    const caller: OrchestrationV2ThreadShell = liveThreadShell(threadId, { runtimeMode });
    const dependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:boat",
        thread: {
          threadId,
          providerSessionId: "provider:boat",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(SecretRequests.SecretRequests)({
        consume: (input) =>
          input.ref === ref && input.projectId === caller.projectId
            ? Effect.sync(() => {
                consumed.push(input.ref);
                return "sk_from_ref";
              })
            : Effect.fail(new SecretRequestError({ reason: "consume_failed" })),
      }),
      Layer.mock(BoatCloud.BoatCloudService)({
        updateRootEnvironment: (input) =>
          Effect.sync(() => {
            updates.push(input);
            return { rootEnvironment: ROOT_ENVIRONMENT, upgraded: null };
          }),
        stopMachine: (sandboxId) =>
          Effect.sync(() => machineCalls.push(`stop ${sandboxId}`)).pipe(
            Effect.andThen(Effect.fail(new BoatCloudError({ message: "Boat deleted this VM." }))),
          ),
        resizeMachine: ({ sandboxId, machineType }) =>
          Effect.sync(() => machineCalls.push(`resize ${sandboxId} ${machineType}`)).pipe(
            Effect.andThen(
              Effect.fail(new BoatCloudError({ message: "Your Boat plan cannot run xlarge VMs." })),
            ),
          ),
        deleteMachine: ({ sandboxId, force }) =>
          Effect.sync(() => {
            machineCalls.push(`delete ${sandboxId} ${force}`);
          }),
      }),
    );
    return yield* Effect.gen(function* () {
      const toolkit = yield* BoatCloudToolkit;
      const call = <Name extends keyof typeof toolkit.tools>(
        name: Name,
        params: Parameters<typeof toolkit.handle<Name>>[1],
      ) =>
        toolkit.handle(name, params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );
      return {
        updated: yield* call("t3_boat_cloud_root_environment_update", {
          setVariables: [
            { key: "API_KEY", secretRef: ref },
            { key: "REGION", value: "eu" },
          ],
          setSecretFiles: [{ path: ".env", contents: "A=1" }],
        }),
        both: yield* call("t3_boat_cloud_root_environment_update", {
          setVariables: [{ key: "API_KEY", value: "x", secretRef: ref }],
        }),
        stop: yield* call("t3_boat_cloud_machine", { action: "stop", sandboxId: "vm-1" }),
        resize: yield* call("t3_boat_cloud_machine", {
          action: "resize",
          sandboxId: "vm-1",
          machineType: "xlarge",
        }),
        resizeWithoutSize: yield* call("t3_boat_cloud_machine", {
          action: "resize",
          sandboxId: "vm-1",
        }),
        deleted: yield* call("t3_boat_cloud_machine", {
          action: "delete",
          sandboxId: "vm-1",
          force: true,
        }),
        updates,
        machineCalls,
        consumed,
      };
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(BoatCloudHandlers.layer).pipe(
          Layer.provideMerge(dependencies),
        ),
      ),
    );
  });

it.effect("hands secrets to the root environment write-only, consuming each secretRef", () =>
  Effect.gen(function* () {
    const result = yield* run("full-access");
    expect(result.updated).toEqual({ rootEnvironment: ROOT_ENVIRONMENT, upgraded: null });
    expect(result.consumed).toEqual([ref]);
    expect(result.updates).toEqual([
      {
        environment: undefined,
        setVariables: [
          { key: "API_KEY", value: "sk_from_ref" },
          { key: "REGION", value: "eu" },
        ],
        setSecretFiles: [{ path: ".env", contents: "A=1" }],
      },
    ]);
    expect(result.both).toMatchObject({ code: "invalid_request" });
    expect(result.stop).toMatchObject({
      code: "orchestration_error",
      message: "Boat deleted this VM.",
    });
    expect(result.resize).toMatchObject({
      code: "orchestration_error",
      message: "Your Boat plan cannot run xlarge VMs.",
    });
    expect(result.resizeWithoutSize).toMatchObject({ code: "invalid_request" });
    expect(result.machineCalls).toEqual(["stop vm-1", "resize vm-1 xlarge", "delete vm-1 true"]);
    expect(result.deleted).toEqual({ machine: null });
  }),
);

it.effect(
  "lets a thread below full access stop or resize a VM but not edit Boat cloud or delete one",
  () =>
    Effect.gen(function* () {
      const result = yield* run("auto-accept-edits");
      expect(result.updated).toMatchObject({ code: "capability_denied" });
      expect(result.deleted).toMatchObject({ code: "capability_denied" });
      expect(result.updates).toEqual([]);
      expect(result.consumed).toEqual([]);
      expect(result.machineCalls).toEqual(["stop vm-1", "resize vm-1 xlarge"]);
    }),
);
