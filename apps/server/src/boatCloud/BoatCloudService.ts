import {
  BOAT_CLOUD_START_STEPS,
  type BoatCloudAcquireInput,
  type BoatCloudConfigureEnvironmentInput,
  type BoatCloudConfigureMachinesInput,
  type BoatCloudConnectInput,
  type BoatCloudEnvironment,
  type BoatCloudEnvironmentUsage,
  BoatCloudError,
  type BoatCloudMachineStats,
  BoatCloudMachineType,
  BoatCloudMachineUsage,
  type BoatCloudMachine,
  type BoatCloudRootEnvironment,
  type BoatCloudRootEnvironmentEdits,
  type BoatCloudSnapshot,
  type BoatCloudRunSetupInput,
  BoatCloudMachineState,
  type BoatCloudSession,
  type BoatCloudSetup,
  type BoatCloudStartStep,
  type BoatCloudStepProgress,
  type BoatCloudStatus,
  type BoatCloudWakeInput,
  EnvironmentId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  BOAT_MACHINE_SPECS,
  type BoatApi,
  BoatApiError,
  type BoatLimits,
  machineTypeOptions,
  type BoatEnvironmentOutline,
  type BoatSandbox,
  type BoatSnapshot,
  cloudEnvironments,
  makeBoatApi,
} from "@t3tools/shared/boatCloudApi";
import {
  buildSnapshot,
  exec,
  findSandboxByHttpBaseUrl,
  type ReportStep,
  latestCliRelease,
  makeSpareKeeper,
  snapshotToBuild,
  startMachine,
  startingSnapshot,
  vmFailure,
  waitRunning,
  wakeMachine,
} from "@t3tools/shared/boatCloudStart";
import {
  BOAT_CLOUD_BLOCKER_MESSAGES,
  boatCloudBlocker,
  IDLE_TTL_SECONDS,
  MACHINE_LABEL_FILTER,
  MACHINE_LABELS,
  SPARE_NAME,
  VM_BACKUP_ARCHIVE,
  VM_SKILLS_ARCHIVE,
  backupScript,
  extractSkillsScript,
  idleScript,
  idleSecondsOf,
  machineLabelOf,
  machineStateOf,
  parseRepository,
  parseStats,
  restoreScript,
  statsScript,
  snapshotBuildOf,
} from "@t3tools/shared/boatCloudVm";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";

const API_KEY_SECRET = "boat-cloud-api-key";
const SKILL_DIRECTORIES = [".claude/skills", ".agents/skills", ".codex/skills"];
const IDLE_SWEEP_INTERVAL = Duration.minutes(1);
const START_LINGER = Duration.minutes(2);
/**
 * This machine backs a VM up and stops it a minute before the VM's own deadline
 * would stop it without a backup. Idle time counts from the last turn on any of
 * its threads, or from when it was handed out, whichever is later.
 */
const IDLE_STOP_SECONDS = IDLE_TTL_SECONDS - 60;
/**
 * While a client watches the status, Boat's billed usage is read this often, and each
 * running VM measures its load this often. Nothing is read while no client watches.
 */
const USAGE_REFRESH_INTERVAL = Duration.minutes(1);
const STATS_REFRESH_INTERVAL = Duration.seconds(30);
const USAGE_REFRESH_COOLDOWN = Duration.seconds(10);

const StoredMachine = Schema.Struct({
  sandboxId: Schema.String,
  environmentId: Schema.NullOr(EnvironmentId),
  label: Schema.String,
  httpBaseUrl: Schema.NullOr(Schema.String),
  state: BoatCloudMachineState,
  repositories: Schema.Array(Schema.String),
  backedUpAt: Schema.NullOr(Schema.String),
  /** Only the environment that hands out a VM watches it for idleness, so two never race to stop it. */
  acquiredAt: Schema.NullOr(Schema.String),
  environment: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  machineType: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  vcpu: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  memoryGB: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  usage: Schema.NullOr(BoatCloudMachineUsage).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * How many starts this VM (and the VMs it replaced) was handed to; more than one means its
   * threads share it. Null for a VM recorded before this was counted, or one another holder
   * handed out.
   */
  handOuts: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
type StoredMachine = typeof StoredMachine.Type;

/** A VM Boat deleted that a restore replaced; its cost stays with its environment. */
const RetiredMachine = Schema.Struct({
  sandboxId: Schema.String,
  environmentId: EnvironmentId,
  machineType: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(BoatCloudMachineUsage),
});

const StoredState = Schema.Struct({
  account: Schema.NullOr(Schema.String),
  machines: Schema.Array(StoredMachine),
  /** The Boat environment new VMs start on, by name, as Boat's create and list name it. */
  environment: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Git remotes the snapshot checks out, from the client that last ran setup. */
  snapshotRepositories: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  shareMachines: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  keepReadyMachine: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultMachineType: BoatCloudMachineType.pipe(
    Schema.withDecodingDefault(Effect.succeed("small" as const)),
  ),
  retired: Schema.Array(RetiredMachine).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
type StoredState = typeof StoredState.Type;
const decodeStoredState = Schema.decodeUnknownOption(Schema.fromJsonString(StoredState));
const encodeStoredState = Schema.encodeSync(Schema.fromJsonString(StoredState));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const isBoatApiError = Schema.is(BoatApiError);
const isMachineType = Schema.is(BoatCloudMachineType);
/** Boat errors carry fixed or attribute-built messages; any other failure's text stays in `cause`. */
const describe = (error: unknown) => {
  if (!isBoatApiError(error)) return null;
  if (error.status === 401) return "Boat rejected the API key.";
  if (error.status === 403) return "The Boat API key is missing access.";
  return error.message;
};

/**
 * Clients get the message only: the cause can hold VM output and Boat's error bodies, so it
 * stays in this server's log. Effect redacts the Authorization header, so the key never shows.
 */
const failCloud =
  (message: (cause: unknown) => string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, BoatCloudError, R> =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("boat cloud request failed", { cause }).pipe(
          Effect.andThen(Effect.fail(new BoatCloudError({ message: message(cause) }))),
        ),
      ),
    );
const cloudError = (message: string) =>
  failCloud((cause) => `${message} ${describe(cause) ?? ""}`.trim());

const pendingSteps = (): Array<BoatCloudStepProgress> =>
  BOAT_CLOUD_START_STEPS.map((step) => ({ step, state: "pending", detail: null }));

/**
 * Each environment's VM now, and its cost summed over every VM that served it. Subagents
 * run in their parent's VM, so a thread's figure is its environment's.
 */
export function environmentUsageOf(
  machines: ReadonlyArray<StoredMachine>,
  retired: ReadonlyArray<typeof RetiredMachine.Type>,
  stats: ReadonlyMap<string, BoatCloudMachineStats>,
): Array<BoatCloudEnvironmentUsage> {
  const entries: Array<BoatCloudEnvironmentUsage> = [];
  for (const machine of machines) {
    const { environmentId } = machine;
    if (environmentId === null) continue;
    const served = [...retired.filter((entry) => entry.environmentId === environmentId), machine];
    const reads = served.flatMap((entry) => (entry.usage === null ? [] : [entry.usage]));
    const seconds = reads.reduce((sum, usage) => sum + usage.seconds, 0);
    const dollars = reads.reduce((sum, usage) => sum + usage.dollars, 0);
    const oldest = reads.map((usage) => usage.updatedAt).sort()[0] ?? null;
    entries.push({
      environmentId,
      sandboxId: machine.sandboxId,
      state: machine.state,
      machineType: machine.machineType,
      vcpu: machine.vcpu,
      memoryGB: machine.memoryGB,
      seconds,
      hours: Math.round((seconds / 3600) * 1000) / 1000,
      dollars: Math.round(dollars * 10_000) / 10_000,
      shared: machine.handOuts === null || machine.handOuts > 1,
      machines: served.length,
      usageUpdatedAt: oldest,
      stats: machine.state === "running" ? (stats.get(machine.sandboxId) ?? null) : null,
    });
  }
  return entries;
}

export class BoatCloudService extends Context.Service<
  BoatCloudService,
  {
    readonly subscribe: Stream.Stream<BoatCloudStatus>;
    /** The status now, then as it changes, without the Boat reads `subscribe` starts. */
    readonly changes: Stream.Stream<BoatCloudStatus>;
    readonly connect: (
      input: BoatCloudConnectInput,
    ) => Effect.Effect<BoatCloudStatus, BoatCloudError>;
    readonly disconnect: Effect.Effect<BoatCloudStatus, BoatCloudError>;
    readonly runSetup: (
      input: BoatCloudRunSetupInput,
    ) => Effect.Effect<BoatCloudStatus, BoatCloudError>;
    readonly configureEnvironment: (
      input: BoatCloudConfigureEnvironmentInput,
    ) => Effect.Effect<BoatCloudStatus, BoatCloudError>;
    readonly configureMachines: (
      input: BoatCloudConfigureMachinesInput,
    ) => Effect.Effect<BoatCloudStatus, BoatCloudError>;
    readonly acquire: (
      input: BoatCloudAcquireInput,
    ) => Effect.Effect<BoatCloudSession, BoatCloudError>;
    readonly wake: (input: BoatCloudWakeInput) => Effect.Effect<BoatCloudSession, BoatCloudError>;
    /** The status with what only Boat knows: the snapshot, the root environment, VM sizes and usage. */
    readonly inspect: Effect.Effect<BoatCloudInspection, BoatCloudError>;
    /** Edits the chosen Boat environment, or the one named. Secret values are never read back. */
    readonly updateRootEnvironment: (
      input: BoatCloudRootEnvironmentUpdate,
    ) => Effect.Effect<BoatCloudRootEnvironmentUpdated, BoatCloudError>;
    /** Backs a managed VM up and stops it. */
    readonly stopMachine: (sandboxId: string) => Effect.Effect<BoatCloudMachine, BoatCloudError>;
    /** Turns a managed VM on and starts its T3 server, without a pairing code. */
    readonly wakeMachine: (sandboxId: string) => Effect.Effect<BoatCloudMachine, BoatCloudError>;
    /**
     * Deletes a managed VM. A running one needs `force`. This machine keeps its backup, so a
     * thread's VM stays listed as gone and waking it restores it.
     */
    readonly deleteMachine: (input: {
      readonly sandboxId: string;
      readonly force: boolean;
    }) => Effect.Effect<void, BoatCloudError>;
    /** Reads every VM's usage and load now, rate-limited, and returns the status. */
    readonly refreshUsage: Effect.Effect<BoatCloudStatus>;
  }
>()("t3/boatCloud/BoatCloudService") {}

export interface BoatCloudInspection {
  readonly status: BoatCloudStatus;
  readonly snapshot: BoatCloudSnapshot | null;
  readonly rootEnvironment: BoatCloudRootEnvironment | null;
}

export interface BoatCloudRootEnvironmentUpdate extends BoatCloudRootEnvironmentEdits {
  /** A Boat environment's name or id; the one new VMs start on when absent. */
  readonly environment?: string | undefined;
  readonly setVariables?: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly setSecretFiles?: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
}

export interface BoatCloudRootEnvironmentUpdated {
  readonly rootEnvironment: BoatCloudRootEnvironment;
  /** Null when VMs were not upgraded. */
  readonly upgraded: { readonly machines: number; readonly failed: number } | null;
}

const rootEnvironmentOf = (outline: BoatEnvironmentOutline): BoatCloudRootEnvironment => ({
  id: outline.id,
  name: outline.name,
  isDefault: outline.isDefault,
  version: outline.version,
  safeForThirdParties: outline.safeForThirdParties,
  passGithub: outline.passGithub,
  passSandboxCredentials: outline.passSandboxCredentials,
  passSecrets: outline.passSecrets,
  passAgentsCredentials: outline.passAgentsCredentials,
  variables: outline.variables,
  secretFiles: outline.secretFiles,
  repositories: outline.repositories.map(({ fullName, baseBranch }) => ({
    repository: fullName,
    baseBranch,
  })),
  versions: outline.versions,
});

const snapshotOf = (snapshot: BoatSnapshot): BoatCloudSnapshot => {
  const build = snapshotBuildOf(snapshot.name);
  return {
    name: snapshot.name,
    t3Version: build?.version ?? null,
    withSkills: build?.withSkills ?? false,
    builtAt: snapshot.createdAt ?? null,
  };
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  // Background work ends with the server, so a setup VM is deleted and the spare keeper resets.
  const scope = yield* Effect.scope;

  const directory = path.join(config.stateDir, "boat-cloud");
  const statePath = path.join(directory, "state.json");
  const backupDirectory = path.join(directory, "backups");
  const backupPathOf = (environmentId: string) =>
    path.join(backupDirectory, `${environmentId}.tar.gz`);

  const readKey = secrets.get(API_KEY_SECRET).pipe(
    Effect.map(Option.map((bytes) => textDecoder.decode(bytes))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const stored = yield* fs.readFileString(statePath).pipe(
    Effect.map((text) => Option.getOrUndefined(decodeStoredState(text))),
    Effect.orElseSucceed(() => undefined),
  );
  let state: StoredState = stored ?? {
    account: null,
    machines: [],
    environment: null,
    snapshotRepositories: [],
    shareMachines: false,
    keepReadyMachine: false,
    defaultMachineType: "small",
    retired: [],
  };
  let setup: BoatCloudSetup = { status: "idle", step: null, error: null };
  /** The saved snapshot new VMs start from, or null before setup. */
  let snapshotName: string | null = null;
  let environments: ReadonlyArray<BoatCloudEnvironment> = [];
  let environmentsError: string | null = null;
  let githubConnected: boolean | null = null;
  let limits: BoatLimits | null = null;
  /** Billing multipliers Boat reported per machine type, from its usage answers. */
  const observedMultipliers = new Map<string, number>();
  /** Live load of running VMs, measured only while a client watches. */
  const stats = new Map<string, BoatCloudMachineStats>();
  let subscribers = 0;
  const starts = new Map<string, Array<BoatCloudStepProgress>>();
  const registryLock = yield* Semaphore.make(1);
  /**
   * VMs a start or wake is handing out, counted per request, and VMs the idle sweep is backing
   * up and stopping, each with the signal its stop sends when done. The sweep never stops a
   * claimed VM and a start never picks a stopping one. Each check and mark is one synchronous
   * step, so no other fiber runs between them.
   */
  const claims = new Map<string, number>();
  const stopping = new Map<string, Deferred.Deferred<void>>();
  const claim = (sandboxId: string) => claims.set(sandboxId, (claims.get(sandboxId) ?? 0) + 1);
  const release = (sandboxIds: ReadonlyArray<string>) =>
    Effect.sync(() => {
      for (const sandboxId of sandboxIds) {
        const count = (claims.get(sandboxId) ?? 0) - 1;
        if (count > 0) claims.set(sandboxId, count);
        else claims.delete(sandboxId);
      }
    });
  /** Claims the VM once no stop of it is running; a stop that began finishes first. */
  const claimWhenFree = (sandboxId: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const stopped = stopping.get(sandboxId);
      if (stopped !== undefined) {
        return Deferred.await(stopped).pipe(Effect.andThen(claimWhenFree(sandboxId)));
      }
      claim(sandboxId);
      return Effect.void;
    });
  /** Two wakes of one environment would both restore it, so they take turns. */
  const wakeLocks = new Map<string, Semaphore.Semaphore>();
  const wakeLockOf = (environmentId: string) => {
    let lock = wakeLocks.get(environmentId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      wakeLocks.set(environmentId, lock);
    }
    return lock;
  };
  const spares = makeSpareKeeper();

  const statusRef = yield* SubscriptionRef.make<BoatCloudStatus>({
    connected: false,
    account: null,
    setup,
    snapshotReady: false,
    machines: [],
    starts: [],
    environment: null,
    environments: [],
    environmentsError: null,
    githubConnected: null,
    shareMachines: state.shareMachines,
    keepReadyMachine: state.keepReadyMachine,
    defaultMachineType: state.defaultMachineType,
    machineTypes: machineTypeOptions(null, observedMultipliers),
    environmentUsage: [],
  });
  const publish = Effect.gen(function* () {
    const connected = Option.isSome(yield* readKey);
    yield* SubscriptionRef.set(statusRef, {
      connected,
      account: connected ? state.account : null,
      setup:
        setup.status === "idle" && snapshotName !== null ? { ...setup, status: "ready" } : setup,
      snapshotReady: connected && snapshotName !== null,
      machines: connected
        ? state.machines.map(({ acquiredAt: _acquiredAt, handOuts: _handOuts, ...machine }) => ({
            ...machine,
            stats: machine.state === "running" ? (stats.get(machine.sandboxId) ?? null) : null,
          }))
        : [],
      starts: [...starts].map(([requestId, steps]) => ({ requestId, steps })),
      environment: connected ? state.environment : null,
      environments: connected ? environments : [],
      environmentsError: connected ? environmentsError : null,
      githubConnected: connected ? githubConnected : null,
      shareMachines: state.shareMachines,
      keepReadyMachine: state.keepReadyMachine,
      defaultMachineType: state.defaultMachineType,
      machineTypes: machineTypeOptions(connected ? limits : null, observedMultipliers),
      environmentUsage: connected ? environmentUsageOf(state.machines, state.retired, stats) : [],
    });
  });
  /**
   * Every registry change goes through here. The update reads the state as it is under the
   * lock, so concurrent starts, wakes and sweeps never write back a stale copy. Untraced: the
   * operation that changes the registry already has the span.
   */
  const commit = Effect.fnUntraced(function* (update: (current: StoredState) => StoredState) {
    const next = update(state);
    if (next === state) return;
    state = next;
    yield* writeFileStringAtomically({
      filePath: statePath,
      contents: encodeStoredState(next),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) =>
        Effect.logWarning("boat cloud could not save its state", { cause }),
      ),
    );
    yield* publish;
  }, registryLock.withPermits(1));
  const updateMachine = (sandboxId: string, patch: Partial<StoredMachine>) =>
    commit((current) => ({
      ...current,
      machines: current.machines.map((machine) =>
        machine.sandboxId === sandboxId ? { ...machine, ...patch } : machine,
      ),
    }));
  const addMachine = (sandboxId: string) =>
    commit((current) =>
      current.machines.some((machine) => machine.sandboxId === sandboxId)
        ? current
        : {
            ...current,
            machines: [
              ...current.machines,
              {
                sandboxId,
                environmentId: null,
                label: machineLabelOf(sandboxId),
                httpBaseUrl: null,
                state: "starting",
                repositories: [],
                backedUpAt: null,
                acquiredAt: null,
                environment: null,
                machineType: null,
                vcpu: null,
                memoryGB: null,
                usage: null,
                handOuts: 0,
              },
            ],
          },
    );
  const findMachine = (sandboxId: string) =>
    state.machines.find((machine) => machine.sandboxId === sandboxId);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const requireApi = Effect.gen(function* () {
    const key = yield* readKey;
    if (Option.isNone(key)) {
      return yield* new BoatCloudError({ message: "Connect Boat in Settings, Cloud first." });
    }
    return makeBoatApi(http, key.value);
  });

  const refreshSnapshot = (api: BoatApi) =>
    api.listSnapshots().pipe(
      Effect.tap((snapshots) =>
        Effect.sync(() => {
          snapshotName = startingSnapshot(snapshots);
        }),
      ),
      Effect.ignore,
    );

  /**
   * Reads Boat's environments. With none chosen yet, Boat's default becomes the
   * choice, so later VMs stay on it even if the Boat default changes.
   */
  const refreshEnvironments = Effect.fn("BoatCloud.refreshEnvironments")(function* (api: BoatApi) {
    const [listed, profiles, github] = yield* Effect.all(
      [
        api.listEnvironments().pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              environmentsError = describe(error) ?? "Could not read the Boat environments.";
            }),
          ),
          Effect.option,
        ),
        // Without it the sign-ins are unknown, and every provider stays offered.
        api.listCredentialProfiles().pipe(Effect.option),
        api.githubConnected().pipe(Effect.option),
      ],
      { concurrency: "unbounded" },
    );
    if (Option.isSome(github)) githubConnected = github.value;
    if (Option.isSome(listed)) {
      environments = cloudEnvironments(listed.value, Option.getOrNull(profiles));
      environmentsError = null;
      const fallback = listed.value.find((environment) => environment.isDefault)?.name ?? null;
      if (fallback !== null) {
        yield* commit((current) =>
          current.environment === null ? { ...current, environment: fallback } : current,
        );
      }
    }
    // The list, and a key that was just saved, live outside the registry, so a commit
    // that changed nothing has not published them.
    yield* publish;
  });

  const transferFailure = (cause: unknown) =>
    isBoatApiError(cause)
      ? cause
      : new BoatApiError({
          status: 0,
          code: "transfer",
          message: "Could not copy files between this machine and the VM.",
          retryable: false,
          cause,
        });

  const uploadFile = Effect.fn("BoatCloud.uploadFile")(function* (
    api: BoatApi,
    sandboxId: string,
    remotePath: string,
    localPath: string,
  ) {
    const signedUrl = yield* api.uploadUrl(sandboxId, remotePath);
    const request = yield* HttpClientRequest.put(signedUrl).pipe(
      HttpClientRequest.bodyFile(localPath, { contentType: "application/octet-stream" }),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(transferFailure),
    );
    const response = yield* http.execute(request).pipe(Effect.mapError(transferFailure));
    if (response.status < 200 || response.status >= 300) return yield* api.fail(response);
  });

  const downloadFile = Effect.fn("BoatCloud.downloadFile")(function* (
    api: BoatApi,
    sandboxId: string,
    remotePath: string,
    localPath: string,
  ) {
    const signedUrl = yield* api.downloadUrl(sandboxId, remotePath);
    const response = yield* http.get(signedUrl).pipe(Effect.mapError(transferFailure));
    if (response.status < 200 || response.status >= 300) return yield* api.fail(response);
    yield* response.stream.pipe(
      Stream.run(fs.sink(localPath, { mode: 0o600 })),
      Effect.mapError(transferFailure),
    );
  });

  /** Boat's size for a VM, keeping what was known when Boat's list leaves it out. */
  const sizeOf = (sandbox: BoatSandbox, known: StoredMachine | null) => {
    const machineType = sandbox.type ?? known?.machineType ?? null;
    const spec =
      machineType !== null && isMachineType(machineType) ? BOAT_MACHINE_SPECS[machineType] : null;
    return {
      machineType,
      vcpu: sandbox.vcpu ?? spec?.vcpu ?? known?.vcpu ?? null,
      memoryGB: sandbox.memoryGB ?? spec?.memoryGB ?? known?.memoryGB ?? null,
    };
  };

  /** Folds Boat's list into the registry: a VM deleted in Boat stays only while its backup can bring it back. */
  const reconcile = Effect.fn("BoatCloud.reconcile")(function* (api: BoatApi) {
    // A VM added after the list was read is missing from it only because it is new.
    const listedFrom = new Set(state.machines.map((machine) => machine.sandboxId));
    const sandboxes = yield* api.listSandboxes(MACHINE_LABEL_FILTER);
    spares.reconcile(sandboxes);
    const byId = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
    const backedUp = new Set<string>();
    for (const machine of state.machines) {
      if (byId.has(machine.sandboxId) || machine.environmentId === null) continue;
      const hasBackup = yield* fs
        .exists(backupPathOf(machine.environmentId))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasBackup) backedUp.add(machine.sandboxId);
    }
    yield* commit((current) => {
      const machines: Array<StoredMachine> = [];
      for (const machine of current.machines) {
        const sandbox = byId.get(machine.sandboxId);
        if (sandbox) {
          machines.push({
            ...machine,
            state: machineStateOf(sandbox.state),
            environment: sandbox.environment ?? null,
            ...sizeOf(sandbox, machine),
          });
        } else if (!listedFrom.has(machine.sandboxId)) {
          machines.push(machine);
        } else if (backedUp.has(machine.sandboxId)) {
          machines.push({ ...machine, state: "gone" });
        }
      }
      const known = new Set(current.machines.map((machine) => machine.sandboxId));
      // VMs another holder made with the same key are shared, but only swept there. The spare
      // joins once a start takes it.
      for (const sandbox of byId.values()) {
        if (known.has(sandbox.id) || sandbox.name === SPARE_NAME) continue;
        machines.push({
          sandboxId: sandbox.id,
          environmentId: null,
          label: machineLabelOf(sandbox.id),
          httpBaseUrl: null,
          state: machineStateOf(sandbox.state),
          repositories: [],
          backedUpAt: null,
          acquiredAt: null,
          environment: sandbox.environment ?? null,
          ...sizeOf(sandbox, null),
          usage: null,
          handOuts: null,
        });
      }
      return { ...current, machines };
    });
    return sandboxes;
  });

  /** Rebuilds a VM Boat deleted from the snapshot plus this machine's last backup of it. */
  const restore = Effect.fn("BoatCloud.restore")(function* (
    api: BoatApi,
    machine: StoredMachine,
    environmentId: EnvironmentId,
  ) {
    if (snapshotName === null) yield* refreshSnapshot(api);
    if (snapshotName === null) return yield* vmFailure("Boat has no T3 Code snapshot.");
    const created = yield* api.createSandbox({
      name: "Boat cloud",
      type:
        machine.machineType !== null && isMachineType(machine.machineType)
          ? machine.machineType
          : "default",
      labels: MACHINE_LABELS,
      from: snapshotName,
      ttlSeconds: IDLE_TTL_SECONDS,
      // The rebuilt VM keeps the environment the deleted one had.
      ...(machine.environment === null ? {} : { environment: machine.environment }),
    });
    // A VM that never got the backup is deleted; the old entry stays gone, so a retry restores.
    const discard = api.delete(created.id).pipe(
      Effect.ignore,
      Effect.andThen(
        commit((current) => ({
          ...current,
          machines: current.machines.filter((candidate) => candidate.sandboxId !== created.id),
        })),
      ),
    );
    yield* Effect.gen(function* () {
      yield* addMachine(created.id);
      yield* waitRunning(api, created.id);
      yield* uploadFile(api, created.id, VM_BACKUP_ARCHIVE, backupPathOf(environmentId));
      yield* exec(api, created.id, restoreScript, 600);
    }).pipe(Effect.onError(() => discard));
    // Same environment on a new VM: the new entry takes over the old one's history, and the
    // old VM's cost stays with the environment.
    yield* commit((current) => ({
      ...current,
      retired: [
        ...current.retired.filter((entry) => entry.sandboxId !== machine.sandboxId),
        {
          sandboxId: machine.sandboxId,
          environmentId,
          machineType: machine.machineType,
          usage: findMachine(machine.sandboxId)?.usage ?? machine.usage,
        },
      ],
      machines: current.machines
        .filter((candidate) => candidate.sandboxId !== machine.sandboxId)
        .map((candidate) =>
          candidate.sandboxId === created.id
            ? {
                ...candidate,
                environmentId,
                repositories: machine.repositories,
                backedUpAt: machine.backedUpAt,
                handOuts: machine.handOuts,
              }
            : candidate,
        ),
    }));
    return created.id;
  });

  /** Copies the VM's sessions and workspaces here, so a VM Boat deletes can come back. */
  const backup = Effect.fn("BoatCloud.backup")(function* (
    api: BoatApi,
    sandboxId: string,
    environmentId: EnvironmentId,
  ) {
    const target = backupPathOf(environmentId);
    const partial = `${target}.partial`;
    yield* exec(api, sandboxId, backupScript, 600);
    // Backups hold the VM's sessions and workspaces, so only this user reads them.
    yield* fs.makeDirectory(backupDirectory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(backupDirectory, 0o700);
    yield* fs.remove(partial, { force: true });
    yield* downloadFile(api, sandboxId, VM_BACKUP_ARCHIVE, partial);
    yield* fs.rename(partial, target);
    yield* updateMachine(sandboxId, { backedUpAt: yield* now });
  });

  const backupAndStop = Effect.fn("BoatCloud.backupAndStop")(function* (
    api: BoatApi,
    machine: StoredMachine,
  ) {
    const { sandboxId } = machine;
    const handedOutAgain = () => {
      const current = findMachine(sandboxId);
      return current?.state !== "running" || current.acquiredAt !== machine.acquiredAt;
    };
    // A start or wake may have taken the VM while the sweep probed it. From here on none does.
    const stopped = Deferred.makeUnsafe<void>();
    const began = yield* Effect.sync(() => {
      if (claims.has(sandboxId) || stopping.has(sandboxId) || handedOutAgain()) return false;
      stopping.set(sandboxId, stopped);
      return true;
    });
    if (!began) return false;
    yield* Effect.gen(function* () {
      if (machine.environmentId !== null) {
        // The VM's own deadline is a minute away; the backup must not be cut off by it.
        yield* api.extend(machine.sandboxId, IDLE_TTL_SECONDS).pipe(Effect.ignore);
        yield* backup(api, machine.sandboxId, machine.environmentId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("boat cloud could not back up a VM before stopping it", {
              sandboxId: machine.sandboxId,
              cause,
            }),
          ),
        );
      }
      if (handedOutAgain()) return;
      yield* api.stop(machine.sandboxId);
      yield* updateMachine(machine.sandboxId, { state: "stopped" });
      // Its cost stops growing here, so the figure is read once more.
      yield* refreshUsage(api, [machine.sandboxId]).pipe(Effect.forkIn(scope));
      yield* Effect.logInfo("boat cloud stopped a VM", { sandboxId: machine.sandboxId });
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          stopping.delete(sandboxId);
          return Deferred.succeed(stopped, undefined);
        }),
      ),
    );
    return true;
  });

  /**
   * Reads Boat's billed usage of these VMs (default: every one Boat may still bill, plus any
   * never read) and records it in one registry change.
   */
  const refreshUsage = Effect.fn("BoatCloud.refreshUsage")(function* (
    api: BoatApi,
    sandboxIds?: ReadonlyArray<string>,
  ) {
    const targets =
      sandboxIds ??
      state.machines
        .filter(
          (machine) =>
            machine.state === "running" ||
            machine.state === "starting" ||
            (machine.state === "stopped" && machine.usage === null),
        )
        .map((machine) => machine.sandboxId);
    if (targets.length === 0) return;
    const read = yield* Effect.forEach(
      targets,
      (sandboxId) =>
        api.usage(sandboxId).pipe(
          Effect.map((usage) => [sandboxId, usage] as const),
          Effect.orElseSucceed(() => [sandboxId, null] as const),
        ),
      { concurrency: 4 },
    );
    const updatedAt = yield* now;
    const byId = new Map<string, NonNullable<(typeof read)[number][1]>>();
    for (const [sandboxId, usage] of read) {
      if (usage === null) continue;
      byId.set(sandboxId, usage);
      if (usage.sandboxType && usage.billingMultiplier !== undefined) {
        observedMultipliers.set(usage.sandboxType, usage.billingMultiplier);
      }
    }
    if (byId.size === 0) return;
    yield* commit((current) => ({
      ...current,
      machines: current.machines.map((machine) => {
        const usage = byId.get(machine.sandboxId);
        if (usage === undefined) return machine;
        const machineType = usage.sandboxType ?? machine.machineType;
        const spec =
          machineType !== null && isMachineType(machineType)
            ? BOAT_MACHINE_SPECS[machineType]
            : null;
        return {
          ...machine,
          machineType,
          vcpu: machine.vcpu ?? spec?.vcpu ?? null,
          memoryGB: machine.memoryGB ?? spec?.memoryGB ?? null,
          usage: { seconds: usage.seconds, dollars: usage.dollars, updatedAt },
        };
      }),
    }));
  });

  /** Measures each running VM's load on the VM itself: Boat keeps only per-process samples. */
  const refreshStats = Effect.fn("BoatCloud.refreshStats")(function* (api: BoatApi) {
    const running = new Set(
      state.machines
        .filter((machine) => machine.state === "running" && !stopping.has(machine.sandboxId))
        .map((machine) => machine.sandboxId),
    );
    for (const sandboxId of stats.keys()) if (!running.has(sandboxId)) stats.delete(sandboxId);
    yield* Effect.forEach(
      running,
      (sandboxId) =>
        exec(api, sandboxId, statsScript, 20).pipe(
          Effect.map(parseStats),
          Effect.orElseSucceed(() => null),
          Effect.flatMap((measured) =>
            Effect.map(now, (sampledAt) => {
              if (measured === null) stats.delete(sandboxId);
              else stats.set(sandboxId, { ...measured, sampledAt });
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
    yield* publish;
  });

  const refreshLimits = (api: BoatApi) =>
    api.limits().pipe(
      Effect.tap((read) =>
        Effect.sync(() => {
          limits = read;
        }),
      ),
      Effect.ignore,
    );

  /** Runs `refresh` with the key while a client watches the status; it never fails. */
  const whileWatched = Effect.fn("BoatCloud.whileWatched")(
    function* <E>(refresh: (api: BoatApi) => Effect.Effect<void, E>) {
      if (subscribers === 0) return;
      const key = yield* readKey;
      if (Option.isNone(key)) return;
      yield* refresh(makeBoatApi(http, key.value));
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("boat cloud could not refresh VM usage", { cause }),
    ),
  );

  const sweepIdle = Effect.gen(function* () {
    const key = yield* readKey;
    if (Option.isNone(key)) return;
    const api = makeBoatApi(http, key.value);
    yield* reconcile(api);
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    for (const machine of state.machines) {
      // A VM this machine never handed out belongs to the holder that did.
      if (machine.state !== "running" || machine.acquiredAt === null) continue;
      if (claims.has(machine.sandboxId)) continue;
      const handedOutSecondsAgo = (nowMillis - Date.parse(machine.acquiredAt)) / 1000;
      if (handedOutSecondsAgo < IDLE_STOP_SECONDS) continue;
      const idleSeconds = yield* exec(api, machine.sandboxId, idleScript, 30).pipe(
        Effect.map((output) => idleSecondsOf(output, handedOutSecondsAgo)),
        // A VM that cannot answer is not provably idle.
        Effect.orElseSucceed(() => null),
      );
      if (idleSeconds === null || idleSeconds < IDLE_STOP_SECONDS) continue;
      yield* backupAndStop(api, machine);
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("boat cloud idle sweep failed", { cause })),
  );

  const skillDirectories = Effect.gen(function* () {
    const present: Array<string> = [];
    for (const directoryName of SKILL_DIRECTORIES) {
      if (yield* fs.exists(path.join(homeDirectory, directoryName))) present.push(directoryName);
    }
    return present;
  }).pipe(Effect.orElseSucceed((): Array<string> => []));

  const copySkills = Effect.fn("BoatCloud.copySkills")(function* (
    api: BoatApi,
    sandboxId: string,
    present: ReadonlyArray<string>,
  ) {
    yield* fs.makeDirectory(directory, { recursive: true });
    const archive = path.join(directory, "skills.tar.gz");
    const packed = yield* runner.run({
      command: "tar",
      // -h copies what symlinked skills point at; the VM cannot reach their targets.
      args: ["-czhf", archive, "--exclude=node_modules", "-C", homeDirectory, ...present],
      timeout: Duration.minutes(2),
    });
    if (packed.code !== 0) {
      return yield* vmFailure("Could not pack this machine's skills.", "skills", packed.stderr);
    }
    yield* uploadFile(api, sandboxId, VM_SKILLS_ARCHIVE, archive);
    yield* fs.remove(archive).pipe(Effect.ignore);
    yield* exec(api, sandboxId, extractSkillsScript, 300);
  }, Effect.mapError(transferFailure));

  /** Keeps the spare, when the user wants one, in step with the snapshot, environment and size. */
  const keepSpare = (api: BoatApi) =>
    Effect.suspend(() =>
      snapshotName === null || !state.keepReadyMachine
        ? Effect.void
        : spares.keep(api, snapshotName, state.environment, state.defaultMachineType),
    );

  const finishSetup = (api: BoatApi, saved: string | null, error: string | null) =>
    Effect.suspend(() => {
      if (saved !== null) snapshotName = saved;
      setup =
        saved !== null
          ? { status: "idle", step: null, error: null }
          : { status: "failed", step: setup.step, error };
      return saved === null
        ? publish
        : Effect.andThen(publish, keepSpare(api).pipe(Effect.forkIn(scope), Effect.asVoid));
    });

  /** Setup outlives the request that starts it; the page follows it through the status stream. */
  const startSetup = Effect.fn("BoatCloud.startSetup")(function* (
    api: BoatApi,
    knownVersion?: string,
  ) {
    if (setup.status === "running") return;
    setup = { status: "running", step: "create-vm", error: null };
    yield* publish;
    yield* Effect.gen(function* () {
      const version = knownVersion ?? (yield* latestCliRelease(http));
      const present = yield* skillDirectories;
      return yield* buildSnapshot({
        api,
        version,
        repositories: state.snapshotRepositories,
        ...(present.length > 0
          ? { copySkills: (sandboxId: string) => copySkills(api, sandboxId, present) }
          : {}),
        setStep: (step) =>
          Effect.suspend(() => {
            setup = { status: "running", step, error: null };
            return publish;
          }),
      });
    }).pipe(
      Effect.matchCauseEffect({
        onSuccess: (saved) => finishSetup(api, saved, null),
        onFailure: (cause) =>
          Effect.logWarning("boat cloud setup failed", { cause }).pipe(
            Effect.andThen(
              finishSetup(
                api,
                null,
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => "Setup stopped.",
                  onSome: (error) => describe(error) ?? "Setup failed.",
                }),
              ),
            ),
          ),
      }),
      Effect.forkIn(scope),
    );
  });

  const runSetup = Effect.fn("BoatCloud.runSetup")(function* (input: BoatCloudRunSetupInput) {
    const api = yield* requireApi;
    const repositories = input.repositories;
    if (repositories !== undefined) {
      yield* commit((current) => ({ ...current, snapshotRepositories: repositories }));
    }
    yield* startSetup(api);
    return yield* SubscriptionRef.get(statusRef);
  });

  /**
   * Saves the latest t3 build once Boat has none of it, or none with this machine's skills.
   * VMs keep starting from the old snapshot until the new one is saved. A failed setup
   * waits for the Rebuild button or a reconnect, so opening the page never loops.
   */
  const renewSnapshot = Effect.fn("BoatCloud.renewSnapshot")(
    function* (api: BoatApi) {
      yield* refreshSnapshot(api);
      // Before the first setup, the page offers it.
      if (snapshotName === null || setup.status !== "idle") return;
      const withSkills = (yield* skillDirectories).length > 0;
      const version = yield* snapshotToBuild(api, http, withSkills);
      if (version === null) return;
      yield* Effect.logInfo("boat cloud saves a snapshot of the latest t3 build", {
        version,
        withSkills,
      });
      yield* startSetup(api, version);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("boat cloud could not check the snapshot's t3 build", { cause }),
    ),
  );

  /** Each repository a machine is known to have, as its checkout path on the VM. */
  const knownWorkspaceRoots = (sandboxId: string) =>
    (findMachine(sandboxId)?.repositories ?? []).flatMap((key) => {
      const parsed = parseRepository(`https://${key}`);
      return parsed ? [parsed.workspaceRoot] : [];
    });

  /** Records a step of the start or wake listed under `requestId` and publishes it. */
  const reportStep =
    (
      requestId: string,
      onSettled: (step: BoatCloudStartStep) => Effect.Effect<void> = () => Effect.void,
    ): ReportStep =>
    (step, stepState, detail) =>
      Effect.suspend(() => {
        const steps = starts.get(requestId);
        if (!steps) return Effect.void;
        starts.set(
          requestId,
          steps.map((entry) => (entry.step === step ? { step, state: stepState, detail } : entry)),
        );
        return stepState === "done" || stepState === "failed"
          ? Effect.andThen(onSettled(step), publish)
          : publish;
      });

  const acquire = Effect.fn("BoatCloud.acquire")(function* (input: BoatCloudAcquireInput) {
    const api = yield* requireApi;
    const repository = parseRepository(input.repositoryUrl);
    if (repository === null) {
      return yield* new BoatCloudError({
        message: "Boat needs a project with a git remote it can clone.",
      });
    }
    // Opening the page and connecting refresh it, so a ready snapshot needs no check per start.
    if (snapshotName === null) yield* refreshSnapshot(api);
    const snapshot = snapshotName;
    if (snapshot === null) {
      return yield* new BoatCloudError({ message: BOAT_CLOUD_BLOCKER_MESSAGES["no-snapshot"] });
    }
    // Refused before any VM is made: a VM without sign-ins can run no agent.
    if (environments.length === 0) yield* refreshEnvironments(api);
    if (boatCloudBlocker(yield* SubscriptionRef.get(statusRef)) === "no-agents") {
      return yield* new BoatCloudError({ message: BOAT_CLOUD_BLOCKER_MESSAGES["no-agents"] });
    }
    starts.set(input.requestId, pendingSteps());
    // When each step ended, in ms since the request, so a slow start shows where it waited.
    const startedAt = yield* Clock.currentTimeMillis;
    const endedAtMs: Partial<Record<BoatCloudStartStep | "reconcile" | "handedOut", number>> = {};
    const markEnded = (step: keyof typeof endedAtMs) =>
      Effect.map(Clock.currentTimeMillis, (at) => {
        endedAtMs[step] = at - startedAt;
      });
    const logTiming = (outcome: "ready" | "failed", sandboxId: string | null) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Effect.logInfo("boat cloud start timing", {
          outcome,
          sandboxId,
          repository: repository.key,
          totalMs: at - startedAt,
          endedAtMs,
        }),
      );
    const finish = Effect.suspend(() => {
      starts.delete(input.requestId);
      return publish;
    });
    const machineType = input.machineType ?? state.defaultMachineType;
    const shareMachines = state.shareMachines;
    const readySpare = yield* spares.take(snapshot, state.environment, machineType);
    const environment = state.environment;
    // Every VM this start may pick stays claimed until its hand-out is recorded.
    const claimed: Array<string> = [];
    const started = yield* Effect.gen(function* () {
      // A held spare is handed out from what this machine knows, so Boat's list can wait.
      let sandboxes: ReadonlyArray<BoatSandbox> | undefined;
      if (readySpare === null) {
        const listed = yield* reconcile(api);
        // A VM on another environment is never picked, and a stopping one is gone in a moment.
        sandboxes = listed.filter(
          (sandbox) =>
            !stopping.has(sandbox.id) &&
            (environment === null || sandbox.environment === environment),
        );
        for (const sandbox of sandboxes) claim(sandbox.id);
        claimed.push(...sandboxes.map((sandbox) => sandbox.id));
      } else {
        claim(readySpare.sandboxId);
        claimed.push(readySpare.sandboxId);
      }
      yield* markEnded("reconcile");
      const machine = yield* startMachine({
        api,
        repository,
        baseBranch: input.baseBranch ?? null,
        environment,
        snapshot,
        readySpare,
        ...(sandboxes === undefined ? {} : { sandboxes }),
        knownWorkspaceRoots,
        shareMachines,
        machineType,
        paired: input.paired ?? [],
        report: reportStep(input.requestId, markEnded),
        onAdded: addMachine,
        // Without this the sweep sees a resumed VM's old hand-out and stops it once unclaimed.
        onReused: (sandboxId) =>
          Effect.flatMap(now, (acquiredAt) => updateMachine(sandboxId, { acquiredAt })),
        onDeleted: (sandboxId) =>
          commit((current) => ({
            ...current,
            machines: current.machines.filter((candidate) => candidate.sandboxId !== sandboxId),
          })),
      });
      const acquiredAt = yield* now;
      yield* commit((current) => ({
        ...current,
        machines: current.machines.map((candidate) =>
          candidate.sandboxId === machine.sandboxId
            ? {
                ...candidate,
                environmentId: machine.environmentId,
                httpBaseUrl: machine.httpBaseUrl,
                state: "running",
                acquiredAt,
                handOuts: candidate.handOuts === null ? null : candidate.handOuts + 1,
                // A start never lands on a VM of another size, so a new one is sized before Boat lists it.
                machineType: candidate.machineType ?? machineType,
                vcpu: candidate.vcpu ?? BOAT_MACHINE_SPECS[machineType].vcpu,
                memoryGB: candidate.memoryGB ?? BOAT_MACHINE_SPECS[machineType].memoryGB,
              }
            : candidate,
        ),
      }));
      return machine;
    }).pipe(
      Effect.ensuring(Effect.suspend(() => release(claimed))),
      Effect.onError(() => Effect.andThen(logTiming("failed", null), finish)),
      // Clients title this failure "Could not start on Boat cloud", so the message is just the cause.
      failCloud((cause) => describe(cause) ?? "Something went wrong on Boat."),
    );
    yield* markEnded("handedOut");
    // The new thread's details show the VM's load without waiting for the next sample.
    yield* whileWatched(refreshStats).pipe(Effect.forkIn(scope));
    // The start may have taken the spare, so the next one is readied while this one checks out.
    yield* keepSpare(api).pipe(Effect.forkIn(scope));
    // The client connects while the checkout runs; its repository step tells it how that ended.
    yield* started.checkout.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const repositories = findMachine(started.sandboxId)?.repositories ?? [];
          return repositories.includes(repository.key)
            ? Effect.void
            : updateMachine(started.sandboxId, {
                repositories: [...repositories, repository.key],
              });
        }),
      ),
      Effect.matchEffect({
        // The last step stays listed long enough for the client to read it: a client that
        // takes the worktree waits for it.
        onSuccess: () =>
          Effect.andThen(
            logTiming("ready", started.sandboxId),
            finish.pipe(Effect.delay(START_LINGER)),
          ),
        onFailure: () =>
          Effect.andThen(
            logTiming("failed", started.sandboxId),
            finish.pipe(Effect.delay(START_LINGER)),
          ),
      }),
      Effect.forkIn(scope),
    );
    return {
      sandboxId: started.sandboxId,
      environmentId: started.environmentId,
      httpBaseUrl: started.httpBaseUrl,
      pairingCode: started.pairingCode,
      workspaceRoot: started.workspaceRoot,
      worktree: started.worktree,
    } satisfies BoatCloudSession;
  });

  const wake = (input: BoatCloudWakeInput) => wakeWith(input, true);
  const wakeWith = Effect.fn("BoatCloud.wake")(function* (
    input: BoatCloudWakeInput,
    pair: boolean,
  ) {
    const api = yield* requireApi;
    const { requestId } = input;
    const report = requestId === undefined ? undefined : reportStep(requestId);
    if (requestId !== undefined) {
      starts.set(requestId, pendingSteps());
      yield* reportStep(requestId)("machine", "active", null);
    }
    return yield* Effect.gen(function* () {
      yield* reconcile(api);
      const machine = state.machines.find(
        (candidate) => candidate.environmentId === input.environmentId,
      );
      let sandboxId: string;
      if (machine) {
        sandboxId =
          machine.state === "gone"
            ? yield* restore(api, machine, input.environmentId)
            : machine.sandboxId;
      } else {
        const sandbox = input.httpBaseUrl
          ? yield* findSandboxByHttpBaseUrl(api, input.httpBaseUrl)
          : null;
        if (sandbox === null) {
          return yield* vmFailure("This machine does not know that Boat VM.");
        }
        yield* addMachine(sandbox.id);
        sandboxId = sandbox.id;
      }
      const woken = yield* Effect.acquireUseRelease(
        claimWhenFree(sandboxId),
        () =>
          Effect.gen(function* () {
            const woken = yield* wakeMachine(api, sandboxId, {
              pair,
              ...(report === undefined ? {} : { report }),
            });
            yield* updateMachine(sandboxId, {
              environmentId: woken.environmentId,
              httpBaseUrl: woken.httpBaseUrl,
              state: "running",
              acquiredAt: yield* now,
            });
            return woken;
          }),
        () => release([sandboxId]),
      );
      return {
        sandboxId,
        environmentId: woken.environmentId,
        httpBaseUrl: woken.httpBaseUrl,
        pairingCode: woken.pairingCode,
        workspaceRoot: null,
      } satisfies BoatCloudSession;
    }).pipe(
      wakeLockOf(input.environmentId).withPermits(1),
      // The client marks the steps done from the reply, so the listing can end with it.
      Effect.ensuring(
        Effect.suspend(() => {
          if (requestId === undefined) return Effect.void;
          starts.delete(requestId);
          return publish;
        }),
      ),
      cloudError("Could not wake the Boat machine."),
    );
  });

  const configureEnvironment = Effect.fn("BoatCloud.configureEnvironment")(function* (
    input: BoatCloudConfigureEnvironmentInput,
  ) {
    const api = yield* requireApi;
    return yield* Effect.gen(function* () {
      if (input.access) yield* api.updateEnvironment(input.environmentId, input.access);
      yield* refreshEnvironments(api);
      const chosen = environments.find((environment) => environment.id === input.environmentId);
      if (!chosen) return yield* vmFailure("Boat has no such environment.");
      // VMs already running keep theirs; only new ones start on the choice.
      yield* commit((current) => ({ ...current, environment: chosen.name }));
      return yield* SubscriptionRef.get(statusRef);
    }).pipe(cloudError("Could not change the Boat environment."));
  });

  const configureMachines = Effect.fn("BoatCloud.configureMachines")(function* (
    input: BoatCloudConfigureMachinesInput,
  ) {
    const changesSpare =
      (input.defaultMachineType !== undefined &&
        input.defaultMachineType !== state.defaultMachineType) ||
      (input.keepReadyMachine !== undefined && input.keepReadyMachine !== state.keepReadyMachine);
    yield* commit((current) => ({
      ...current,
      ...(input.shareMachines === undefined ? {} : { shareMachines: input.shareMachines }),
      ...(input.keepReadyMachine === undefined ? {} : { keepReadyMachine: input.keepReadyMachine }),
      ...(input.defaultMachineType === undefined
        ? {}
        : { defaultMachineType: input.defaultMachineType }),
    }));
    yield* publish;
    if (changesSpare) {
      // The spare is kept at the default size, so a new one is readied at the new size.
      const key = yield* readKey;
      if (Option.isSome(key)) {
        const api = makeBoatApi(http, key.value);
        if (state.keepReadyMachine) yield* keepSpare(api).pipe(Effect.forkIn(scope));
        else
          yield* spares
            .release(api)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("boat cloud could not delete its spare VM", { cause }),
              ),
            );
      }
    }
    return yield* SubscriptionRef.get(statusRef);
  });

  const inspect = Effect.gen(function* () {
    const key = yield* readKey;
    if (Option.isNone(key)) {
      return {
        status: yield* SubscriptionRef.get(statusRef),
        snapshot: null,
        rootEnvironment: null,
      } satisfies BoatCloudInspection;
    }
    const api = makeBoatApi(http, key.value);
    // Each part is optional, so a key missing one scope still shows the rest.
    const [snapshots, outlines] = yield* Effect.all(
      [
        api.listSnapshots().pipe(Effect.orElseSucceed(() => null)),
        api.environmentOutlines().pipe(Effect.orElseSucceed(() => [])),
      ],
      { concurrency: "unbounded" },
    );
    if (snapshots !== null) snapshotName = startingSnapshot(snapshots);
    yield* refreshEnvironments(api);
    yield* reconcile(api).pipe(Effect.ignore);
    yield* refreshUsage(api).pipe(Effect.ignore);
    const starting = snapshots?.find((snapshot) => snapshot.name === snapshotName);
    const chosen = outlines.find((outline) => outline.name === state.environment);
    return {
      status: yield* SubscriptionRef.get(statusRef),
      snapshot: starting === undefined ? null : snapshotOf(starting),
      rootEnvironment: chosen === undefined ? null : rootEnvironmentOf(chosen),
    } satisfies BoatCloudInspection;
  }).pipe(cloudError("Could not read Boat."), Effect.withSpan("BoatCloud.inspect"));

  const updateRootEnvironment = Effect.fn("BoatCloud.updateRootEnvironment")(function* (
    input: BoatCloudRootEnvironmentUpdate,
  ) {
    const api = yield* requireApi;
    return yield* Effect.gen(function* () {
      const named = input.environment ?? state.environment;
      const outlines = yield* api.environmentOutlines();
      const target = outlines.find((outline) =>
        named === null
          ? outline.isDefault
          : outline.id === named || outline.name.toLowerCase() === named.toLowerCase(),
      );
      if (target === undefined) return yield* vmFailure("Boat has no such environment.");
      const { id } = target;
      const switches = {
        ...(input.safeForThirdParties === undefined
          ? {}
          : { safeForThirdParties: input.safeForThirdParties }),
        ...(input.passGithub === undefined ? {} : { passGithub: input.passGithub }),
        ...(input.passSandboxCredentials === undefined
          ? {}
          : { passSandboxCredentials: input.passSandboxCredentials }),
        ...(input.passSecrets === undefined ? {} : { passSecrets: input.passSecrets }),
        ...(input.passAgentsCredentials === undefined
          ? {}
          : { passAgentsCredentials: input.passAgentsCredentials }),
      };
      if (Object.keys(switches).length > 0) yield* api.updateEnvironment(id, switches);
      for (const { key, value } of input.setVariables ?? []) {
        yield* api.setEnvironmentVariable(id, key, value);
      }
      for (const key of input.removeVariables ?? []) {
        yield* api.removeEnvironmentVariable(id, key);
      }
      for (const { path: filePath, contents } of input.setSecretFiles ?? []) {
        yield* api.setEnvironmentFile(id, filePath, contents);
      }
      for (const filePath of input.removeSecretFiles ?? []) {
        yield* api.removeEnvironmentFile(id, filePath);
      }
      for (const { repository, baseBranch } of input.addRepositories ?? []) {
        const repositoryId = yield* api.findRepository(repository);
        if (repositoryId === null) {
          return yield* vmFailure(
            `Boat's GitHub app cannot reach ${repository}. Install it on that repository first.`,
          );
        }
        yield* api.addEnvironmentRepository(id, repositoryId, baseBranch);
      }
      for (const repository of input.removeRepositories ?? []) {
        const selected = target.repositories.find(
          (candidate) => candidate.fullName.toLowerCase() === repository.toLowerCase(),
        );
        if (selected !== undefined) {
          yield* api.removeEnvironmentRepository(id, selected.databaseId);
        }
      }
      const upgraded =
        input.upgradeMachines === true
          ? yield* api
              .upgradeEnvironment(id)
              .pipe(Effect.map(({ upgraded, failed }) => ({ machines: upgraded, failed })))
          : null;
      const updated = (yield* api.environmentOutlines()).find((outline) => outline.id === id);
      if (updated === undefined) return yield* vmFailure("Boat deleted the environment.");
      // The switches feed the status every client shows.
      if (Object.keys(switches).length > 0) yield* refreshEnvironments(api);
      return { rootEnvironment: rootEnvironmentOf(updated), upgraded };
    }).pipe(cloudError("Could not change the Boat environment."));
  });

  /** A VM this machine manages, as Boat lists it now. */
  const managedMachine = Effect.fn("BoatCloud.managedMachine")(function* (
    api: BoatApi,
    sandboxId: string,
  ) {
    yield* reconcile(api);
    const machine = findMachine(sandboxId);
    if (machine === undefined) {
      return yield* vmFailure("This T3 Code does not manage that Boat VM.");
    }
    return machine;
  });

  /** The VM as clients see it in the status. */
  const publicMachine = (sandboxId: string) =>
    Effect.flatMap(SubscriptionRef.get(statusRef), (status) => {
      const machine = status.machines.find((candidate) => candidate.sandboxId === sandboxId);
      return machine === undefined
        ? vmFailure("Boat deleted this VM.", "gone")
        : Effect.succeed(machine);
    });

  const busy = () =>
    vmFailure("A thread is starting on that VM, or it is stopping. Try again soon.");

  const stopMachine = Effect.fn("BoatCloud.stopMachine")(function* (sandboxId: string) {
    const api = yield* requireApi;
    return yield* Effect.gen(function* () {
      const machine = yield* managedMachine(api, sandboxId);
      if (machine.state === "running" || machine.state === "starting") {
        if (!(yield* backupAndStop(api, machine))) return yield* busy();
      }
      return yield* publicMachine(sandboxId);
    }).pipe(cloudError("Could not stop the Boat machine."));
  });

  /** A thread's VM wakes through `wake`, which restores it when Boat deleted it. */
  const wakeManaged = Effect.fn("BoatCloud.wakeMachine")(function* (sandboxId: string) {
    const api = yield* requireApi;
    const machine = yield* managedMachine(api, sandboxId).pipe(
      cloudError("Could not wake the Boat machine."),
    );
    if (machine.environmentId !== null) {
      const woken = yield* wakeWith({ environmentId: machine.environmentId }, false);
      return yield* publicMachine(woken.sandboxId).pipe(
        cloudError("Could not wake the Boat machine."),
      );
    }
    return yield* Effect.acquireUseRelease(
      claimWhenFree(sandboxId),
      () =>
        Effect.gen(function* () {
          const woken = yield* wakeMachine(api, sandboxId, { pair: false });
          yield* updateMachine(sandboxId, {
            environmentId: woken.environmentId,
            httpBaseUrl: woken.httpBaseUrl,
            state: "running",
            acquiredAt: yield* now,
          });
          return yield* publicMachine(sandboxId);
        }),
      () => release([sandboxId]),
    ).pipe(cloudError("Could not wake the Boat machine."));
  });

  const deleteMachine = Effect.fn("BoatCloud.deleteMachine")(function* (input: {
    readonly sandboxId: string;
    readonly force: boolean;
  }) {
    const api = yield* requireApi;
    const { sandboxId } = input;
    return yield* Effect.gen(function* () {
      const machine = yield* managedMachine(api, sandboxId);
      if (machine.state === "gone") return;
      if (!input.force && (machine.state === "running" || machine.state === "starting")) {
        return yield* vmFailure(
          "That VM is running and may have live threads. Pass `force: true` to delete it anyway.",
        );
      }
      // Starts never pick a VM that is stopping, and a wake waits for it.
      const deleted = Deferred.makeUnsafe<void>();
      const began = yield* Effect.sync(() => {
        if (claims.has(sandboxId) || stopping.has(sandboxId)) return false;
        stopping.set(sandboxId, deleted);
        return true;
      });
      if (!began) return yield* busy();
      yield* Effect.gen(function* () {
        yield* api.delete(sandboxId);
        // A VM with a backup stays listed as gone, so waking its threads restores it.
        const backedUp =
          machine.environmentId !== null &&
          (yield* fs
            .exists(backupPathOf(machine.environmentId))
            .pipe(Effect.orElseSucceed(() => false)));
        yield* commit((current) => ({
          ...current,
          machines: backedUp
            ? current.machines.map((candidate) =>
                candidate.sandboxId === sandboxId ? { ...candidate, state: "gone" } : candidate,
              )
            : current.machines.filter((candidate) => candidate.sandboxId !== sandboxId),
        }));
        yield* Effect.logInfo("boat cloud deleted a VM", { sandboxId, backedUp });
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            stopping.delete(sandboxId);
            return Deferred.succeed(deleted, undefined);
          }),
        ),
      );
    }).pipe(cloudError("Could not delete the Boat machine."));
  });

  let usageRefreshedAt = 0;
  /** Reads usage and load now, at most once per `USAGE_REFRESH_COOLDOWN`; later calls get the status. */
  const refreshUsageNow = Effect.gen(function* () {
    const key = yield* readKey;
    const nowMillis = yield* Clock.currentTimeMillis;
    if (
      Option.isSome(key) &&
      nowMillis - usageRefreshedAt >= Duration.toMillis(USAGE_REFRESH_COOLDOWN)
    ) {
      usageRefreshedAt = nowMillis;
      const api = makeBoatApi(http, key.value);
      yield* reconcile(api).pipe(Effect.ignore);
      yield* Effect.all([refreshUsage(api), refreshStats(api)], {
        concurrency: 2,
        discard: true,
      }).pipe(Effect.ignore);
    }
    return yield* SubscriptionRef.get(statusRef);
  }).pipe(Effect.withSpan("BoatCloud.refreshUsageNow"));

  const connect = Effect.fn("BoatCloud.connect")(function* (input: BoatCloudConnectInput) {
    const api = makeBoatApi(http, input.apiKey);
    const account = yield* api.me().pipe(cloudError("Could not connect Boat."));
    yield* secrets
      .set(API_KEY_SECRET, textEncoder.encode(input.apiKey))
      .pipe(cloudError("Could not save the Boat API key."));
    yield* refreshSnapshot(api);
    yield* renewSnapshot(api).pipe(Effect.forkIn(scope));
    // Another account's environments, VMs and backups mean nothing to this key; a wake
    // must never restore one account's backup onto another's VM.
    yield* commit((current) =>
      current.account === account
        ? current
        : { ...current, account, environment: null, machines: [], retired: [] },
    );
    yield* refreshLimits(api);
    yield* refreshEnvironments(api);
    return yield* SubscriptionRef.get(statusRef);
  });

  const disconnect = Effect.gen(function* () {
    yield* secrets.remove(API_KEY_SECRET).pipe(cloudError("Could not remove the Boat API key."));
    snapshotName = null;
    setup = { status: "idle", step: null, error: null };
    // The account stays recorded, so reconnecting it keeps its VMs and backups.
    yield* publish;
    return yield* SubscriptionRef.get(statusRef);
  }).pipe(Effect.withSpan("BoatCloud.disconnect"));

  yield* publish;
  // Boat answers in seconds at best, so the server starts on the last known state.
  yield* forkParked(
    Effect.gen(function* () {
      const key = yield* readKey;
      if (Option.isNone(key)) return;
      const api = makeBoatApi(http, key.value);
      yield* Effect.all([refreshSnapshot(api), refreshLimits(api), refreshEnvironments(api)], {
        concurrency: 3,
      });
      yield* publish;
    }),
  );
  yield* forkParked(
    sweepIdle.pipe(
      Effect.delay(IDLE_SWEEP_INTERVAL),
      Effect.repeat(Schedule.spaced(IDLE_SWEEP_INTERVAL)),
    ),
  );

  // Opening the page refreshes from Boat in the background; the stream starts on the last known state.
  const refreshInBackground = Effect.gen(function* () {
    const key = yield* readKey;
    if (Option.isNone(key)) return;
    const api = makeBoatApi(http, key.value);
    yield* renewSnapshot(api);
    yield* refreshEnvironments(api);
    yield* reconcile(api).pipe(Effect.ignore);
    yield* Effect.all([refreshLimits(api), refreshUsage(api), refreshStats(api)], {
      concurrency: 3,
      discard: true,
    }).pipe(Effect.ignore);
    yield* publish;
    // A client is here, so a start may follow.
    yield* keepSpare(api);
  }).pipe(Effect.forkIn(scope));

  // Usage and load are read only while a client watches, so an unwatched holder costs nothing.
  yield* forkParked(
    whileWatched(refreshUsage).pipe(
      Effect.delay(USAGE_REFRESH_INTERVAL),
      Effect.repeat(Schedule.spaced(USAGE_REFRESH_INTERVAL)),
    ),
  );
  yield* forkParked(
    whileWatched(refreshStats).pipe(
      Effect.delay(STATS_REFRESH_INTERVAL),
      Effect.repeat(Schedule.spaced(STATS_REFRESH_INTERVAL)),
    ),
  );

  const watch = Effect.acquireRelease(
    Effect.sync(() => {
      subscribers += 1;
    }),
    () =>
      Effect.sync(() => {
        subscribers -= 1;
      }),
  );

  return BoatCloudService.of({
    subscribe: Stream.unwrap(
      watch.pipe(
        Effect.andThen(refreshInBackground),
        Effect.as(SubscriptionRef.changes(statusRef)),
      ),
    ),
    changes: SubscriptionRef.changes(statusRef),
    connect,
    disconnect,
    runSetup,
    configureEnvironment,
    configureMachines,
    acquire,
    wake,
    inspect,
    updateRootEnvironment,
    stopMachine,
    wakeMachine: wakeManaged,
    deleteMachine,
    refreshUsage: refreshUsageNow,
  });
});

export const layer = Layer.effect(BoatCloudService, make).pipe(Layer.provide(ProcessRunner.layer));
