import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Boat cloud runs agents on Boat (boat.dev) VMs. Each VM runs its own T3 server,
 * so it is an ordinary environment that clients pair with over its public URL.
 * The environment holding the Boat API key creates, wakes and stops the VMs.
 */

/** Boat serves every VM's ports under this domain, so its URL marks an environment as a VM. */
const BOAT_HOST_SUFFIX = ".on.boat.dev";

export function isBoatCloudHttpBaseUrl(httpBaseUrl: string | null | undefined): boolean {
  if (!httpBaseUrl) return false;
  try {
    return new URL(httpBaseUrl).hostname.endsWith(BOAT_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/** The API key scopes Boat cloud uses, in Boat's own scope names. */
export const BOAT_CLOUD_REQUIRED_SCOPES = [
  "sandbox.create",
  "sandbox.read",
  "sandbox.update",
  "sandbox.stop",
  "sandbox.resume",
  "sandbox.delete",
  "exec",
  "file.read",
  "file.write",
  "host",
  "ssh",
  "snapshot.read",
  "snapshot.write",
  "environment.read",
  "environment.write",
  "account.read",
  // Reading which AI credentials a profile holds needs it; Boat never returns their values.
  "account.admin",
] as const;

export const BOAT_CLOUD_SETUP_STEPS = [
  "create-vm",
  "install-server",
  "copy-skills",
  "save-snapshot",
] as const;
export const BoatCloudSetupStep = Schema.Literals(BOAT_CLOUD_SETUP_STEPS);
export type BoatCloudSetupStep = typeof BoatCloudSetupStep.Type;

export const BoatCloudSetup = Schema.Struct({
  status: Schema.Literals(["idle", "running", "ready", "failed"]),
  /** The step running, or the one that failed. */
  step: Schema.NullOr(BoatCloudSetupStep),
  error: Schema.NullOr(Schema.String),
});
export type BoatCloudSetup = typeof BoatCloudSetup.Type;

/** Boat's machine sizes, smallest first. */
export const BOAT_CLOUD_MACHINE_TYPES = ["small", "default", "large", "xlarge"] as const;
export const BoatCloudMachineType = Schema.Literals(BOAT_CLOUD_MACHINE_TYPES);
export type BoatCloudMachineType = typeof BoatCloudMachineType.Type;

/** One machine size a new cloud thread can start on, with Boat's price for it. */
export const BoatCloudMachineTypeOption = Schema.Struct({
  id: BoatCloudMachineType,
  vcpu: Schema.Number,
  memoryGB: Schema.Number,
  /** Null until Boat's prices are read. */
  hourlyDollars: Schema.NullOr(Schema.Number),
  /**
   * `boat`: Boat's own rate for this size (its VM-hour price, times the billing multiplier
   * Boat reported for a VM of this size). `derived`: Boat's VM-hour price times the size
   * ratio Boat documents (small half, large twice, xlarge four times).
   */
  priceSource: Schema.Literals(["boat", "derived"]),
  /** Whether this account's plan can start it; `reason` says why not. */
  available: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});
export type BoatCloudMachineTypeOption = typeof BoatCloudMachineTypeOption.Type;

export const BoatCloudMachineState = Schema.Literals(["running", "starting", "stopped", "gone"]);
export type BoatCloudMachineState = typeof BoatCloudMachineState.Type;

/** What Boat bills for one VM since it was created, from Boat's usage endpoint. */
export const BoatCloudMachineUsage = Schema.Struct({
  /** Billed machine seconds: wall time on, times the machine type's billing multiplier. */
  seconds: Schema.Number,
  /** Boat's own dollar figure for those seconds. */
  dollars: Schema.Number,
  /** When this holder last read it from Boat. */
  updatedAt: Schema.String,
});
export type BoatCloudMachineUsage = typeof BoatCloudMachineUsage.Type;

/**
 * A live sample of a running VM, measured on the VM itself while a client watches the status:
 * Boat reports only per-process samples.
 */
export const BoatCloudMachineStats = Schema.Struct({
  /** Busy share of all CPUs over about a second, 0 to 100. */
  cpuPercent: Schema.Number,
  cpus: Schema.Number,
  memoryUsedBytes: Schema.Number,
  memoryTotalBytes: Schema.Number,
  /** Of the root filesystem; null when `df` did not answer. */
  diskUsedBytes: Schema.NullOr(Schema.Number),
  diskTotalBytes: Schema.NullOr(Schema.Number),
  sampledAt: Schema.String,
});
export type BoatCloudMachineStats = typeof BoatCloudMachineStats.Type;

export const BoatCloudMachine = Schema.Struct({
  sandboxId: TrimmedNonEmptyString,
  environmentId: Schema.NullOr(EnvironmentId),
  label: Schema.String,
  httpBaseUrl: Schema.NullOr(Schema.String),
  state: BoatCloudMachineState,
  repositories: Schema.Array(Schema.String),
  /** When this machine last copied the VM's sessions and workspaces, before stopping it. */
  backedUpAt: Schema.NullOr(Schema.String),
  /** The Boat environment the VM started on. Boat keeps it across stops and resumes. */
  environment: Schema.NullOr(Schema.String),
  /** Boat's machine type, such as `default`. Null until Boat has reported it. */
  machineType: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  vcpu: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  memoryGB: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Null until the holder has read it from Boat. */
  usage: Schema.NullOr(BoatCloudMachineUsage).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Null while no client watches, and for a VM that is not running. */
  stats: Schema.NullOr(BoatCloudMachineStats).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type BoatCloudMachine = typeof BoatCloudMachine.Type;

/**
 * Starting a thread on Boat cloud, in order. `server` and `repository` run at
 * the same time; the holder reports the first three and the client the rest.
 * Acquire returns once the server is up, so `repository` can still be running.
 */
export const BOAT_CLOUD_START_STEPS = [
  "machine",
  "server",
  "repository",
  "connect",
  "project",
  "thread",
] as const;
export const BoatCloudStartStep = Schema.Literals(BOAT_CLOUD_START_STEPS);
export type BoatCloudStartStep = typeof BoatCloudStartStep.Type;

export const BoatCloudStepProgress = Schema.Struct({
  step: BoatCloudStartStep,
  state: Schema.Literals(["pending", "active", "done", "failed"]),
  /** What the step is doing, such as which VM it reuses or which repository it clones. */
  detail: Schema.NullOr(Schema.String),
});
export type BoatCloudStepProgress = typeof BoatCloudStepProgress.Type;

/** One acquire in flight on the holder, so the client that asked can show its steps. */
export const BoatCloudStart = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  steps: Schema.Array(BoatCloudStepProgress),
});
export type BoatCloudStart = typeof BoatCloudStart.Type;

/** What a Boat environment passes to its VMs, in Boat's own field names. */
export const BoatCloudEnvironmentAccess = Schema.Struct({
  passGithub: Schema.Boolean,
  passSandboxCredentials: Schema.Boolean,
  passSecrets: Schema.Boolean,
  passAgentsCredentials: Schema.Boolean,
});
export type BoatCloudEnvironmentAccess = typeof BoatCloudEnvironmentAccess.Type;

export const BoatCloudEnvironment = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isDefault: Schema.Boolean,
  ...BoatCloudEnvironmentAccess.fields,
  /** Boat's ids of the AI credentials its VMs get, such as `anthropic-api-key`. Null when unknown. */
  agentCredentials: Schema.NullOr(Schema.Array(Schema.String)),
});
export type BoatCloudEnvironment = typeof BoatCloudEnvironment.Type;

/**
 * One Boat cloud environment (the T3 server on a VM, and so its threads): the VM serving it
 * now, live stats while a client watches, and what it has cost, summed over every VM that
 * served it, since a restore after Boat deleted a VM moves the environment to a new one.
 * Subagents run inside their parent's VM, so they have no entry of their own.
 */
export const BoatCloudEnvironmentUsage = Schema.Struct({
  environmentId: EnvironmentId,
  /** The VM serving it now. */
  sandboxId: TrimmedNonEmptyString,
  state: BoatCloudMachineState,
  machineType: Schema.NullOr(Schema.String),
  vcpu: Schema.NullOr(Schema.Number),
  memoryGB: Schema.NullOr(Schema.Number),
  /** Billed seconds, summed from Boat's usage figures. */
  seconds: Schema.Number,
  hours: Schema.Number,
  /** Boat's own dollar figures, summed. */
  dollars: Schema.Number,
  /**
   * More than one start was handed this environment's VM (or its history is unknown), so the
   * figure is the VM's total, shared by its threads, not one thread's share.
   */
  shared: Schema.Boolean,
  /** How many VMs the cost sums. */
  machines: Schema.Number,
  /** The oldest usage read among them; null before the first. */
  usageUpdatedAt: Schema.NullOr(Schema.String),
  stats: Schema.NullOr(BoatCloudMachineStats),
});
export type BoatCloudEnvironmentUsage = typeof BoatCloudEnvironmentUsage.Type;

/**
 * The Boat account's VM time left, from Boat's limits. All figures are billed seconds
 * (default-size VM seconds). Boat spends the plan's monthly grant first, then bought credit.
 */
export const BoatCloudCredit = Schema.Struct({
  /** Plan and bought credit left together. */
  balanceSeconds: Schema.Number,
  /** The plan's monthly grant and what is left of it; null without a plan. */
  planSeconds: Schema.NullOr(Schema.Number),
  planRemainingSeconds: Schema.NullOr(Schema.Number),
  /** The plan's monthly price in dollars; null without a plan or when Boat does not say. */
  planDollars: Schema.NullOr(Schema.Number),
  /** When the plan's month ends and its grant renews; null when Boat does not say. */
  periodEnd: Schema.NullOr(Schema.String),
  /** Bought credit left, which does not expire with the month. */
  purchasedRemainingSeconds: Schema.Number,
  usedSeconds: Schema.Number,
  last24hSeconds: Schema.Number,
  secondsPerDollar: Schema.Number,
  canStart: Schema.Boolean,
  blockedReason: Schema.NullOr(Schema.String),
  /** Starts past the plan's limits, billed up to a monthly cap; null when Boat does not offer it. */
  overage: Schema.NullOr(
    Schema.Struct({
      enabled: Schema.Boolean,
      usedDollars: Schema.Number,
      capDollars: Schema.Number,
    }),
  ),
});
export type BoatCloudCredit = typeof BoatCloudCredit.Type;

/** The agent drivers a holder can pass its own sign-ins to. */
const BOAT_CLOUD_LOCAL_SIGN_IN_DRIVERS = ["claudeAgent", "codex"] as const;

/** A sign-in of the holder's own that its VMs' agents get. Its value never leaves the holder's server. */
export const BoatCloudLocalSignIn = Schema.Struct({
  driver: Schema.Literals(BOAT_CLOUD_LOCAL_SIGN_IN_DRIVERS),
  /**
   * `token`: the long-lived Claude token the holder made with `claude setup-token`.
   * `environment`: a key or token in the holder server's environment.
   * `login`: the CLI's own sign-in, passed without its refresh token.
   */
  source: Schema.Literals(["token", "environment", "login"]),
  /** When the passed sign-in stops working; null when it is long-lived. */
  expiresAt: Schema.NullOr(Schema.String),
});
export type BoatCloudLocalSignIn = typeof BoatCloudLocalSignIn.Type;

/** A `claude setup-token` sign-in the holder is running. */
export const BoatCloudClaudeTokenFlow = Schema.Struct({
  state: Schema.Literals(["running", "failed"]),
  /** The sign-in page, for a browser on another machine than the holder. */
  url: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type BoatCloudClaudeTokenFlow = typeof BoatCloudClaudeTokenFlow.Type;

export const BoatCloudLocalSignIns = Schema.Struct({
  /** Whether new and woken VMs get the sign-ins in `available`. */
  enabled: Schema.Boolean,
  available: Schema.Array(BoatCloudLocalSignIn),
  claudeTokenStored: Schema.Boolean,
  claudeTokenFlow: Schema.NullOr(BoatCloudClaudeTokenFlow),
});
export type BoatCloudLocalSignIns = typeof BoatCloudLocalSignIns.Type;

export const BOAT_CLOUD_NO_LOCAL_SIGN_INS: BoatCloudLocalSignIns = {
  enabled: false,
  available: [],
  claudeTokenStored: false,
  claudeTokenFlow: null,
};

/**
 * A VM's lease on Boat: Boat stops it this many minutes after its deadline last moved, even
 * when no holder is alive. The VM renews it while a turn runs or a terminal is busy.
 */
export const BOAT_CLOUD_IDLE_STOP_MINUTES = { default: 15, min: 5, max: 120 } as const;
/** Days after a stop that a holder deletes a VM it handed out, once it holds a backup of it. */
export const BOAT_CLOUD_DELETE_STOPPED_DAYS = { default: 7, min: 1, max: 14 } as const;

const IdleStopMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: BOAT_CLOUD_IDLE_STOP_MINUTES.min,
    maximum: BOAT_CLOUD_IDLE_STOP_MINUTES.max,
  }),
);
const DeleteStoppedDays = Schema.Int.check(
  Schema.isBetween({
    minimum: BOAT_CLOUD_DELETE_STOPPED_DAYS.min,
    maximum: BOAT_CLOUD_DELETE_STOPPED_DAYS.max,
  }),
);

export const BoatCloudStatus = Schema.Struct({
  connected: Schema.Boolean,
  /** The Boat account the key belongs to. */
  account: Schema.NullOr(Schema.String),
  setup: BoatCloudSetup,
  /** VMs can start from the saved snapshot, even while setup rebuilds it. */
  snapshotReady: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  machines: Schema.Array(BoatCloudMachine),
  starts: Schema.Array(BoatCloudStart),
  /** The Boat environment new VMs start on, by name. */
  environment: Schema.NullOr(Schema.String),
  environments: Schema.Array(BoatCloudEnvironment),
  /** Why the environments could not be listed, such as a key without `environment.read`. */
  environmentsError: Schema.NullOr(Schema.String),
  /**
   * Whether Boat's GitHub app is installed for the account, which private clones and pushes
   * need. Null until Boat has been asked.
   */
  githubConnected: Schema.NullOr(Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * False (the default): each new cloud thread gets a VM of its own, reusing only the ready
   * spare, when one is kept. True: a start may join a running VM that has room, so threads share VMs.
   */
  shareMachines: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Keeps an idle VM at the default size running, so a start skips the boot. It is billed. */
  keepReadyMachine: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** The size a new cloud thread starts on when its start names none. */
  defaultMachineType: BoatCloudMachineType.pipe(
    Schema.withDecodingDefault(Effect.succeed("small" as const)),
  ),
  idleStopMinutes: Schema.Number.pipe(
    Schema.withDecodingDefault(Effect.succeed(BOAT_CLOUD_IDLE_STOP_MINUTES.default)),
  ),
  deleteStoppedAfterDays: Schema.Number.pipe(
    Schema.withDecodingDefault(Effect.succeed(BOAT_CLOUD_DELETE_STOPPED_DAYS.default)),
  ),
  /** Every size, with its price and whether the plan allows it. */
  machineTypes: Schema.Array(BoatCloudMachineTypeOption).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** One entry per Boat cloud environment this holder knows. */
  environmentUsage: Schema.Array(BoatCloudEnvironmentUsage).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Null until Boat's limits have been read. */
  credit: Schema.optional(Schema.NullOr(BoatCloudCredit)),
  /** This holder's own provider sign-ins, which its VMs get alongside the Boat profile's. */
  localSignIns: BoatCloudLocalSignIns.pipe(
    Schema.withDecodingDefault(Effect.succeed(BOAT_CLOUD_NO_LOCAL_SIGN_INS)),
  ),
});
export type BoatCloudStatus = typeof BoatCloudStatus.Type;

/** The saved snapshot new VMs start from. */
export const BoatCloudSnapshot = Schema.Struct({
  name: Schema.String,
  /** The t3 build in it; null for a snapshot from before builds were named. */
  t3Version: Schema.NullOr(Schema.String),
  withSkills: Schema.Boolean,
  builtAt: Schema.NullOr(Schema.String),
});
export type BoatCloudSnapshot = typeof BoatCloudSnapshot.Type;

/**
 * What a Boat environment gives every new VM. Variable values and secret file contents
 * are write-only: only their names and paths are ever read back.
 */
export const BoatCloudRootEnvironment = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isDefault: Schema.Boolean,
  /** The latest version, which VMs started from now get. */
  version: Schema.NullOr(Schema.Number),
  /** Passes nothing of the account's to VMs, whatever the other switches say. */
  safeForThirdParties: Schema.Boolean,
  ...BoatCloudEnvironmentAccess.fields,
  variables: Schema.Array(Schema.String),
  secretFiles: Schema.Array(Schema.String),
  repositories: Schema.Array(
    Schema.Struct({ repository: Schema.String, baseBranch: Schema.NullOr(Schema.String) }),
  ),
  /** VMs stay on the version they started on until upgraded. */
  versions: Schema.Array(
    Schema.Struct({ version: Schema.Number, machines: Schema.Number, createdAt: Schema.String }),
  ),
});
export type BoatCloudRootEnvironment = typeof BoatCloudRootEnvironment.Type;

const EnvironmentVariableKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
);
const SecretFilePath = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
const GitHubRepositoryName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
);

/** Edits to a root environment, applied in field order. Each edit makes a new Boat version. */
export const BoatCloudRootEnvironmentEdits = Schema.Struct({
  safeForThirdParties: Schema.optional(Schema.Boolean),
  passGithub: Schema.optional(Schema.Boolean),
  passSandboxCredentials: Schema.optional(Schema.Boolean),
  passSecrets: Schema.optional(Schema.Boolean),
  passAgentsCredentials: Schema.optional(Schema.Boolean),
  removeVariables: Schema.optional(
    Schema.Array(EnvironmentVariableKey).check(Schema.isMaxLength(50)),
  ),
  removeSecretFiles: Schema.optional(Schema.Array(SecretFilePath).check(Schema.isMaxLength(50))),
  addRepositories: Schema.optional(
    Schema.Array(
      Schema.Struct({
        repository: GitHubRepositoryName,
        baseBranch: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
      }),
    ).check(Schema.isMaxLength(20)),
  ),
  removeRepositories: Schema.optional(
    Schema.Array(GitHubRepositoryName).check(Schema.isMaxLength(20)),
  ),
  /** Moves VMs already on this environment to the new version: running ones now. */
  upgradeMachines: Schema.optional(Schema.Boolean),
});
export type BoatCloudRootEnvironmentEdits = typeof BoatCloudRootEnvironmentEdits.Type;

export const BoatCloudEnvironmentVariableKey = EnvironmentVariableKey;
export const BoatCloudSecretFilePath = SecretFilePath;

export const BoatCloudSubscribeInput = Schema.Struct({});
export type BoatCloudSubscribeInput = typeof BoatCloudSubscribeInput.Type;

export const BoatCloudConnectInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type BoatCloudConnectInput = typeof BoatCloudConnectInput.Type;

/** Picks the environment for new VMs, and optionally changes what it passes to them. */
export const BoatCloudConfigureEnvironmentInput = Schema.Struct({
  environmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  access: Schema.optional(BoatCloudEnvironmentAccess),
});
export type BoatCloudConfigureEnvironmentInput = typeof BoatCloudConfigureEnvironmentInput.Type;

/** Changes how the holder hands out VMs to new threads. */
export const BoatCloudConfigureMachinesInput = Schema.Struct({
  shareMachines: Schema.optional(Schema.Boolean),
  defaultMachineType: Schema.optional(BoatCloudMachineType),
  keepReadyMachine: Schema.optional(Schema.Boolean),
  /** Passes this holder's own Claude and Codex sign-ins to its VMs. */
  useLocalSignIns: Schema.optional(Schema.Boolean),
  idleStopMinutes: Schema.optional(IdleStopMinutes),
  deleteStoppedAfterDays: Schema.optional(DeleteStoppedDays),
});
export type BoatCloudConfigureMachinesInput = typeof BoatCloudConfigureMachinesInput.Type;

/** A VM this holder manages, by Boat's sandbox id. */
export const BoatCloudMachineInput = Schema.Struct({
  sandboxId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type BoatCloudMachineInput = typeof BoatCloudMachineInput.Type;

export const BoatCloudDeleteMachineInput = Schema.Struct({
  sandboxId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** Deletes a running VM, which may have live threads. Its backup still restores it. */
  force: Schema.optional(Schema.Boolean),
});
export type BoatCloudDeleteMachineInput = typeof BoatCloudDeleteMachineInput.Type;

/** Makes, cancels or removes the long-lived Claude token, or answers its sign-in with a code. */
export const BoatCloudClaudeTokenInput = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["create", "cancel", "remove"]) }),
  Schema.Struct({
    action: Schema.Literal("code"),
    code: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  }),
]);
export type BoatCloudClaudeTokenInput = typeof BoatCloudClaudeTokenInput.Type;

export const BoatCloudEmptyInput = Schema.Struct({});
export type BoatCloudEmptyInput = typeof BoatCloudEmptyInput.Type;

/** How many repositories the snapshot checks out. */
export const BOAT_CLOUD_SNAPSHOT_REPOSITORIES = 10;

export const BoatCloudRunSetupInput = Schema.Struct({
  /**
   * Git remotes the snapshot checks out, most worked first. The holder keeps them for later
   * rebuilds; absent keeps the ones it has.
   */
  repositories: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))).check(
      Schema.isMaxLength(BOAT_CLOUD_SNAPSHOT_REPOSITORIES),
    ),
  ),
});
export type BoatCloudRunSetupInput = typeof BoatCloudRunSetupInput.Type;

export const BoatCloudAcquireInput = Schema.Struct({
  /** The project's git remote; the VM clones it when it does not have it yet. */
  repositoryUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  /** The thread's base branch; the start fails early when the remote does not have it. */
  baseBranch: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  /**
   * The VM size; the holder's `defaultMachineType` when absent. The thread never lands on a
   * running VM of another size.
   */
  machineType: Schema.optional(BoatCloudMachineType),
  /** Names this start in `BoatCloudStatus.starts`. */
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** Boat cloud VMs the client already paired with; picking one of them skips the pairing code. */
  paired: Schema.optional(
    Schema.Array(
      Schema.Struct({
        environmentId: EnvironmentId,
        httpBaseUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
      }),
    ).check(Schema.isMaxLength(64)),
  ),
});
export type BoatCloudAcquireInput = typeof BoatCloudAcquireInput.Type;

/**
 * Keeps a VM a start handed out from being deleted for want of a thread while the client
 * still means to use it, or gives it up so it is deleted now when no thread runs on it.
 */
export const BoatCloudHoldStartInput = Schema.Struct({
  sandboxId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  release: Schema.optional(Schema.Boolean),
});
export type BoatCloudHoldStartInput = typeof BoatCloudHoldStartInput.Type;

export const BoatCloudWakeInput = Schema.Struct({
  environmentId: EnvironmentId,
  /** Finds a VM this holder did not start, such as one another holder made with the same key. */
  httpBaseUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  /** The holder reports the wake's machine and server steps under this id in its status. */
  requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type BoatCloudWakeInput = typeof BoatCloudWakeInput.Type;

/** What a client needs to reach a VM's T3 server: a one-time pairing code for its URL. */
export const BoatCloudSession = Schema.Struct({
  sandboxId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  httpBaseUrl: TrimmedNonEmptyString,
  /** Null when the client is already paired with this environment and reconnects instead. */
  pairingCode: Schema.NullOr(TrimmedNonEmptyString),
  /** Repository checkout on the VM; null for a wake. */
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * The thread's worktree, which the VM cuts while its server starts. Ready once the start's
   * `repository` step is done. Absent from older holders and for a start with no base branch.
   */
  worktree: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: TrimmedNonEmptyString,
        branch: TrimmedNonEmptyString,
        baseBranch: TrimmedNonEmptyString,
      }),
    ),
  ),
});
export type BoatCloudSession = typeof BoatCloudSession.Type;

/** The message only: what went wrong on Boat or the VM stays in the server's log. */
export class BoatCloudError extends Schema.TaggedError<BoatCloudError>()("BoatCloudError", {
  message: Schema.String,
}) {}
