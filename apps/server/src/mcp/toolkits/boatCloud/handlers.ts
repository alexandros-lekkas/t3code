import {
  type BoatCloudMachine,
  OrchestratorMcpFailure,
  type ProjectId,
  type SecretRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as BoatCloud from "../../../boatCloud/BoatCloudService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import type { Caller } from "../../threadAccess.ts";
import { BoatCloudToolkit } from "./tools.ts";

const withoutStats = ({ stats: _stats, ...machine }: BoatCloudMachine) => machine;

const boatFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

/** Environment writes hold the caller's thread lock and recheck its modes after the wait. */
const underCallerLock = Effect.fn("BoatCloudMcp.underCallerLock")(function* <A, E, R, RC>(
  write: (caller: Caller) => Effect.Effect<A, E, R>,
  check: Effect.Effect<Caller, OrchestratorMcpFailure, RC>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const run = Effect.flatMap(check, write);
  return yield* scope.thread === undefined ? run : executor.withLock(scope.thread.threadId, run);
});

/** Exactly one of a plain value or a one-use `secretRef`, which this call consumes. */
const valueOf = Effect.fn("BoatCloudMcp.valueOf")(function* (
  name: string,
  plain: string | undefined,
  secretRef: SecretRef | undefined,
  projectId: ProjectId | undefined,
) {
  if ((plain === undefined) === (secretRef === undefined)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Give ${name} a value or a secretRef, not both.`,
    });
  }
  if (secretRef === undefined) return plain ?? "";
  if (projectId === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "A secretRef needs a calling thread.",
    });
  }
  const secrets = yield* SecretRequests.SecretRequests;
  return yield* secrets
    .consume({ ref: secretRef, projectId })
    .pipe(
      Effect.mapError(
        (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
      ),
    );
});

export const layer = McpToolAccess.toLayer(BoatCloudToolkit, {
  t3_boat_cloud_status: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const boat = yield* BoatCloud.BoatCloudService;
      const { status, snapshot, rootEnvironment } = yield* boat.inspect.pipe(
        Effect.mapError(boatFailure),
      );
      return {
        connected: status.connected,
        account: status.account,
        snapshot,
        snapshotReady: status.snapshotReady,
        setup: status.setup,
        environment: status.environment,
        rootEnvironment,
        environments: status.environments,
        environmentsError: status.environmentsError,
        shareMachines: status.shareMachines,
        defaultMachineType: status.defaultMachineType,
        machines: status.machines.map(withoutStats),
      };
    }),
  ),
  t3_boat_cloud_configure: McpToolAccess.writesEnvironment(
    ({ boatEnvironment, defaultMachineType, shareMachines }, check) =>
      underCallerLock(
        () =>
          Effect.gen(function* () {
            const boat = yield* BoatCloud.BoatCloudService;
            if (boatEnvironment !== undefined) {
              const { status } = yield* boat.inspect.pipe(Effect.mapError(boatFailure));
              const wanted = boatEnvironment.toLowerCase();
              const chosen = status.environments.find(
                (environment) =>
                  environment.id === boatEnvironment || environment.name.toLowerCase() === wanted,
              );
              if (chosen === undefined) {
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `Boat has no environment "${boatEnvironment}".`,
                });
              }
              yield* boat
                .configureEnvironment({ environmentId: chosen.id })
                .pipe(Effect.mapError(boatFailure));
            }
            const next = yield* boat
              .configureMachines({
                ...(defaultMachineType === undefined ? {} : { defaultMachineType }),
                ...(shareMachines === undefined ? {} : { shareMachines }),
              })
              .pipe(Effect.mapError(boatFailure));
            return {
              environment: next.environment,
              environments: next.environments,
              shareMachines: next.shareMachines,
              defaultMachineType: next.defaultMachineType,
            };
          }),
        check,
      ),
  ),
  t3_boat_cloud_root_environment_update: McpToolAccess.writesEnvironment(
    ({ boatEnvironment, setVariables, setSecretFiles, ...edits }, check) =>
      underCallerLock(
        (caller) =>
          Effect.gen(function* () {
            const projectId = caller.caller?.projectId;
            const variables = [];
            for (const variable of setVariables ?? []) {
              variables.push({
                key: variable.key,
                value: yield* valueOf(
                  `variable ${variable.key}`,
                  variable.value,
                  variable.secretRef,
                  projectId,
                ),
              });
            }
            const files = [];
            for (const file of setSecretFiles ?? []) {
              files.push({
                path: file.path,
                contents: yield* valueOf(
                  `secret file ${file.path}`,
                  file.contents,
                  file.secretRef,
                  projectId,
                ),
              });
            }
            const boat = yield* BoatCloud.BoatCloudService;
            return yield* boat
              .updateRootEnvironment({
                ...edits,
                environment: boatEnvironment,
                setVariables: variables,
                setSecretFiles: files,
              })
              .pipe(Effect.mapError(boatFailure));
          }),
        check,
      ),
  ),
  t3_boat_cloud_snapshot_rebuild: McpToolAccess.writesEnvironment((_params, check) =>
    underCallerLock(
      () =>
        Effect.gen(function* () {
          const boat = yield* BoatCloud.BoatCloudService;
          const status = yield* boat.runSetup({}).pipe(Effect.mapError(boatFailure));
          const { snapshot } = yield* boat.inspect.pipe(Effect.mapError(boatFailure));
          return { setup: status.setup, snapshot };
        }),
      check,
    ),
  ),
  t3_boat_cloud_machine: McpToolAccess.either(
    ({ action }) => action === "delete",
    McpToolAccess.writesEnvironment(({ sandboxId, force }, check) =>
      underCallerLock(
        () =>
          Effect.gen(function* () {
            const boat = yield* BoatCloud.BoatCloudService;
            yield* boat
              .deleteMachine({ sandboxId, force: force === true })
              .pipe(Effect.mapError(boatFailure));
            return { machine: null };
          }),
        check,
      ),
    ),
    McpToolAccess.writes(
      ({ action, sandboxId }) =>
        Effect.gen(function* () {
          const boat = yield* BoatCloud.BoatCloudService;
          const machine = yield* (
            action === "wake" ? boat.wakeMachine(sandboxId) : boat.stopMachine(sandboxId)
          ).pipe(Effect.mapError(boatFailure));
          return { machine: withoutStats(machine) };
        }),
      { linkedCallers: { refused: "stop or wake this environment's Boat VMs" } },
    ),
  ),
});
