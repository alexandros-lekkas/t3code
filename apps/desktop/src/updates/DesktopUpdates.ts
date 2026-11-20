import {
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  DESKTOP_UPDATE_IN_PROGRESS_MARKER_FILE,
  DESKTOP_UPDATE_IN_PROGRESS_TTL_MS,
  DesktopUpdateChannelSchema,
  type DesktopRuntimeInfo,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import { errorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import {
  normalizeDesktopUpdateReleaseNotes,
  releaseNotesOfOfferedVersion,
} from "./releaseNotes.ts";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  DESKTOP_UPDATE_LAUNCHED_MARKER_FILE,
  UNSIGNED_UPDATES_PACKAGE_KEY,
  UnsignedMacUpdateError,
  bootCheckUnsignedMacUpdate,
  isWritableMacInstall,
  macUpdateAssetUrl,
  prepareUnsignedMacUpdate,
  resolveMacAppBundlePath,
  selectMacUpdateZip,
  startUnsignedMacSwap,
  unsignedMacInstallBlocker,
  type MacUpdateZip,
  type PreparedMacUpdate,
} from "./unsignedMacUpdate.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
  resolveNotAppliedInstallVersion,
} from "./updateMachine.ts";

const CHANNEL_CHANGE_RETRY_DELAY = Duration.seconds(1);
const CHANNEL_CHANGE_RETRIES = 30;
const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 hours";
const UPDATE_CHECK_WAIT = Duration.seconds(90);

type UpdateAction = "check" | "download" | "install" | "install-recovery" | "channel";

interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
  // Malformed notes must not block update-state decoding; normalizeDesktopUpdateReleaseNotes validates separately.
  releaseNotes: Schema.optional(Schema.Unknown),
  releaseName: Schema.optional(Schema.NullOr(Schema.String)),
  releaseDate: Schema.optional(Schema.String),
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
export const DESKTOP_UPDATE_INSTALL_RECORD_FILE = "desktop-update-install.json";
const DesktopUpdateInstallRecord = Schema.fromJsonString(
  Schema.Struct({ fromVersion: Schema.String, targetVersion: Schema.String }),
);
const decodeInstallRecord = Schema.decodeUnknownEffect(DesktopUpdateInstallRecord);
const encodeInstallRecord = Schema.encodeEffect(DesktopUpdateInstallRecord);

const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install", "channel"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedError<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} desktop update channel.`;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedError<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedError<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle desktop update ${this.event} event.`;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedError<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "channel", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop updater ${this.operation} operation reported an error.`;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedError<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.action} action failed unexpectedly.`;
  }
}

export class DesktopUpdateChannelManagedError extends Schema.TaggedError<DesktopUpdateChannelManagedError>()(
  "DesktopUpdateChannelManagedError",
  {
    channel: DesktopUpdateChannelSchema,
    policyMessage: Schema.String,
  },
) {
  override get message(): string {
    return `${this.policyMessage} The ${this.channel} channel is not available.`;
  }
}

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
  DesktopUpdateChannelManagedError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly isActionActive: Effect.Effect<boolean>;
    readonly isInstallActive: Effect.Effect<boolean>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: DesktopUpdateState;
        readonly changes: Stream.Stream<DesktopUpdateState>;
      },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    /** `minimumVersion` is a track switch's checked release; nothing older is offered after. */
    readonly setChannel: (
      channel: DesktopUpdateChannel,
      options?: { readonly minimumVersion?: string | undefined },
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    /** `allowDowngrade` is for a guarded track switch, which checked that older release. */
    readonly check: (
      reason: string,
      options?: { readonly allowDowngrade?: boolean },
    ) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
    readonly installPrepared: (
      expectedVersion: string,
    ) => Effect.Effect<DesktopPreparedUpdateInstallResult>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function redactMessage(message: string): string {
  return (message.split(/[\r\n]/, 1)[0] ?? "")
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted credential]")
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=].*$/gi,
      "[redacted header]",
    )
    .replace(
      /\b[\w-]*(?:token|password|secret|credential|api[_-]?key)[\w-]*\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "[redacted credential]",
    )
    .slice(0, 512);
}

function summarizeCause(cause: unknown, depth: number): string {
  if (depth >= 3) return "[truncated cause]";
  if (Cause.isCause(cause)) {
    return cause.reasons
      .slice(0, 3)
      .map((reason) =>
        reason._tag === "Fail"
          ? summarizeCause(reason.error, depth + 1)
          : reason._tag === "Die"
            ? summarizeCause(reason.defect, depth + 1)
            : "Interrupted",
      )
      .join("; ");
  }
  if (typeof cause === "string") return redactMessage(cause);
  if (typeof cause !== "object" || cause === null) return errorTag(cause);

  const error = cause as {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly cause?: unknown;
  };
  const code =
    typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
      ? ` [${error.code}]`
      : "";
  const message = typeof error.message === "string" ? `: ${redactMessage(error.message)}` : "";
  const nested =
    error.cause === undefined ? "" : `; caused by ${summarizeCause(error.cause, depth + 1)}`;
  return `${errorTag(cause)}${code}${message}${nested}`;
}

export function describeUpdateErrorCause(cause: unknown): string {
  try {
    return summarizeCause(cause, 0).slice(0, 1024);
  } catch {
    return "UnknownError";
  }
}

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  disabledReason: Option.Option<string>,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DesktopUpdateState {
  const enabled = Option.isNone(disabledReason);
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
    message: Option.getOrNull(disabledReason),
  };
}

function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

function isOffered(state: DesktopUpdateState): boolean {
  return state.status === "available" || state.status === "downloaded";
}

function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

function getAutoUpdateDisabledReason(args: {
  policy: DesktopUpdatePolicy.UpdatePolicy;
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  isDebPackage: boolean;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (args.policy.mode === "off") {
    return args.policy.message ?? "Updates are turned off on this machine.";
  }
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage && !args.isDebPackage) {
    return "Automatic updates on Linux require the AppImage or the .deb package.";
  }
  return null;
}

function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const policy = yield* DesktopUpdatePolicy.DesktopUpdatePolicy;
  // Any user can set the mock flag, so it never replaces an administrator's update source.
  const mockUpdates = config.mockUpdates && policy.message === null;

  // Fork: unsigned macOS builds of alexandros-lekkas/t3code install updates themselves
  // (unsignedMacUpdate.ts), only from the fork's own feed, and only after the downloaded build
  // boots against a copy of this machine's state. Official builds never set the flag.
  const unsignedMacInstall =
    environment.platform === "darwin" &&
    (yield* fileSystem
      .readFileString(environment.path.join(environment.appPath, "package.json"))
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({ [UNSIGNED_UPDATES_PACKAGE_KEY]: Schema.optional(Schema.Boolean) }),
            ),
          ),
        ),
        Effect.map((metadata) => metadata[UNSIGNED_UPDATES_PACKAGE_KEY] === true),
        Effect.orElseSucceed(() => false),
      ));
  const macBundlePath = resolveMacAppBundlePath(environment.resourcesPath);
  const unsignedUpdateWorkDir = environment.path.join(
    environment.baseDir,
    "caches",
    "desktop-update",
  );
  // The zip the feed offers for the available version, or why this app cannot update in place.
  const unsignedZipRef = yield* Ref.make<
    Option.Option<{ version: string; url: string; zip: MacUpdateZip } | { blocker: string }>
  >(Option.none());
  const preparedMacUpdateRef = yield* Ref.make(Option.none<PreparedMacUpdate>());
  // A version whose boot check failed is never offered again by this run.
  const bootCheckFailedVersionRef = yield* Ref.make(Option.none<string>());
  const electronApp = yield* Effect.serviceOption(ElectronApp.ElectronApp);

  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const activeUpdateActionRef = yield* Ref.make<Option.Option<UpdateAction>>(Option.none());
  const installRunningBackendsRef = yield* Ref.make<
    ReadonlyArray<DesktopBackendPool.DesktopBackendInstance>
  >([]);
  const finishedUpdateActions = yield* PubSub.unbounded<UpdateAction>();
  const updaterConfiguredRef = yield* Ref.make(false);
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const notAppliedVersionRef = yield* Ref.make(Option.none<string>());
  // The release a track switch's database check cleared. A build crosses to another track only
  // through such a switch, and never below that release: version order alone cannot tell whether
  // a Stable knows a Nightly's migrations.
  const releaseFloorRef = yield* Ref.make(Option.none<string>());
  const offerable = (version: string, state: DesktopUpdateState) =>
    Ref.get(releaseFloorRef).pipe(
      Effect.map(
        (floor) =>
          desktopUpdateChannelOf(version) === state.channel &&
          (Option.isSome(floor)
            ? compareSemverVersions(version, floor.value) >= 0
            : desktopUpdateChannelOf(environment.appVersion) === state.channel),
      ),
    );
  const updateStateRef = yield* Ref.make<DesktopUpdateState>(
    createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
  );

  const stateChanges = yield* PubSub.sliding<DesktopUpdateState>(16);
  // Serialize writes and publishes against subscription so snapshots cannot overlap the first change.
  const stateMutex = yield* Semaphore.make(1);

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    stateMutex
      .withPermits(1)(
        Ref.set(updateStateRef, state).pipe(Effect.andThen(PubSub.publish(stateChanges, state))),
      )
      .pipe(Effect.andThen(emitState));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  // electron-updater uses this marker to install .deb updates with dpkg.
  const isDebPackage =
    environment.platform === "linux" && environment.isPackaged
      ? yield* fileSystem
          .readFileString(environment.path.join(environment.resourcesPath, "package-type"))
          .pipe(
            Effect.map((packageType) => packageType.trim() === "deb"),
            Effect.orElseSucceed(() => false),
          )
      : false;

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map(
      (appUpdateYmlConfig) =>
        Option.isSome(appUpdateYmlConfig) || mockUpdates || policy.feedUrl !== undefined,
    ),
  );

  const resolveDisabledReason = Effect.gen(function* () {
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        policy,
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(config.appImagePath),
        isDebPackage,
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
      }),
    );
  });

  // Without nightly, an install on that channel stays put until its user picks stable: moving it
  // silently would be a downgrade nobody asked for, and checking nightly would break the policy.
  const channelBlockedReason = (channel: DesktopUpdateChannel): Option.Option<string> =>
    channel === "nightly" && !policy.allowNightly
      ? Option.some(
          `${policy.message ?? "Nightly updates are turned off on this machine."} Switch to the stable channel to keep getting updates.`,
        )
      : Option.none();

  const resolveStateDisabledReason = (channel: DesktopUpdateChannel) =>
    resolveDisabledReason.pipe(Effect.map(Option.orElse(() => channelBlockedReason(channel))));

  const activeUpdateAction = Ref.get(activeUpdateActionRef);

  const tryStartUpdateAction = (action: UpdateAction): Effect.Effect<boolean> =>
    Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) ? [false, activeAction] : [true, Option.some(action)],
    );

  const tryStartChannelChange = Ref.modify(activeUpdateActionRef, (activeAction) =>
    Option.isSome(activeAction)
      ? [activeAction, activeAction]
      : [Option.none<UpdateAction>(), Option.some<UpdateAction>("channel")],
  );

  const finishUpdateAction = (action: UpdateAction): Effect.Effect<void> =>
    Ref.modify(activeUpdateActionRef, (activeAction) => {
      const finished = Option.isSome(activeAction) && activeAction.value === action;
      return [finished, finished ? Option.none() : activeAction] as const;
    }).pipe(
      Effect.flatMap((finished) =>
        finished ? PubSub.publish(finishedUpdateActions, action).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  // Re-runs admit after each finished action, so a caller waiting on a check decides on its result.
  const admitAfterCheck = Effect.fn("desktop.updates.admitAfterCheck")(function* (
    admit: Effect.Effect<"admitted" | "refused" | "wait-for-check">,
  ) {
    const actionCompletions = yield* PubSub.subscribe(finishedUpdateActions);
    let admission = yield* stateMutex.withPermits(1)(admit);
    while (admission === "wait-for-check") {
      const finishedAction = yield* PubSub.take(actionCompletions).pipe(
        Effect.timeoutOption(UPDATE_CHECK_WAIT),
      );
      admission = Option.isNone(finishedAction)
        ? "refused"
        : yield* stateMutex.withPermits(1)(admit);
    }
    return admission;
  });

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "nightly";
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    // An older build can lack migrations this one ran. Only a guarded track switch's own check
    // may offer one.
    yield* electronUpdater.setAllowDowngrade(false);
    yield* electronUpdater.setFullChangelog(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      fullChangelog: allowsPrerelease,
    });
  });

  // The flag is shared updater state, so callers flip it only while holding a reservation.
  const runUpdaterCheck = Effect.fn("desktop.updates.runUpdaterCheck")(function* (
    allowDowngrade: boolean,
  ) {
    const restoreDowngrade = yield* electronUpdater.allowDowngrade;
    if (allowDowngrade) yield* electronUpdater.setAllowDowngrade(true);
    return yield* electronUpdater.checkForUpdates.pipe(
      Effect.ensuring(electronUpdater.setAllowDowngrade(restoreDowngrade).pipe(Effect.ignore)),
    );
  });

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (
    reason: string,
    actionReservation: "acquire" | "held" = "acquire",
    allowDowngrade = false,
  ) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;

    const state = yield* Ref.get(updateStateRef);
    // A configured updater is disabled only by a channel the managed policy blocks.
    if (state.status === "disabled") return false;
    if (state.status === "downloading") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    if (actionReservation === "acquire" && !(yield* tryStartUpdateAction("check"))) return false;

    const check = Effect.gen(function* () {
      // An offer stays on screen while re-checking, so finding it again changes nothing.
      if (!isOffered(state)) {
        yield* setState(reduceDesktopUpdateStateOnCheckStart(state, yield* currentIsoTimestamp));
      }
      yield* logUpdaterInfo("checking for updates", { reason });

      return yield* runUpdaterCheck(allowDowngrade).pipe(
        Effect.as(true),
        Effect.catchTags({
          ElectronUpdaterCheckForUpdatesError: Effect.fn(
            "desktop.updates.handleCheckForUpdatesFailure",
          )(function* (error) {
            const failedAt = yield* currentIsoTimestamp;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              cause: describeUpdateErrorCause(error.cause),
              channel: error.channel,
            });
            return true;
          }),
        }),
      );
    });

    return yield* actionReservation === "held"
      ? check
      : check.pipe(
          Effect.onInterrupt(() => setState(state)),
          Effect.ensuring(finishUpdateAction("check")),
        );
  });

  // Downloads, verifies and boot-checks the offered build. A failed boot check hides the offer:
  // nothing is shown, the reason is logged, and that version is not offered again this run.
  const downloadUnsignedMacUpdate = Effect.gen(function* () {
    const offered = yield* Ref.get(unsignedZipRef);
    if (Option.isNone(offered) || macBundlePath === null || "blocker" in offered.value) {
      return yield* new UnsignedMacUpdateError({
        step: "download",
        detail:
          Option.isSome(offered) && "blocker" in offered.value
            ? offered.value.blocker
            : "the update feed listed no zip for this Mac",
      });
    }
    const { version, url, zip } = offered.value;
    yield* Ref.set(preparedMacUpdateRef, Option.none());
    yield* logUpdaterInfo("downloading unsigned macOS update", { version });
    const prepared = yield* prepareUnsignedMacUpdate({
      version,
      url,
      zip,
      workDir: unsignedUpdateWorkDir,
      currentBundlePath: macBundlePath,
      onProgress: (percent) => handleDownloadProgress({ percent }),
    });
    yield* logUpdaterInfo("boot-checking the downloaded update", { version });
    const bootCheck = yield* bootCheckUnsignedMacUpdate({
      prepared,
      liveStateDir: environment.stateDir,
      workDir: environment.path.join(unsignedUpdateWorkDir, "boot-check"),
      env: process.env,
    }).pipe(Effect.exit);
    if (Exit.isFailure(bootCheck)) {
      yield* Ref.set(bootCheckFailedVersionRef, Option.some(version));
      yield* fileSystem
        .remove(unsignedUpdateWorkDir, { recursive: true, force: true })
        .pipe(Effect.ignore);
      yield* logUpdaterError("the downloaded update failed its boot check; not offering it", {
        version,
        cause: describeUpdateErrorCause(bootCheck.cause),
      });
      yield* setState(
        reduceDesktopUpdateStateOnNoUpdate(
          yield* Ref.get(updateStateRef),
          yield* currentIsoTimestamp,
        ),
      );
      return false;
    }
    yield* logUpdaterInfo("the downloaded update passed its boot check", { version });
    yield* Ref.set(preparedMacUpdateRef, Option.some(prepared));
    yield* handleUpdateDownloaded({ version: prepared.version });
    return true;
  });

  // Install refreshes before downloading, and a second check could pick a stale, older release.
  const downloadAvailableUpdate = Effect.fn("desktop.updates.downloadAvailableUpdate")(function* (
    refresh: boolean,
  ) {
    const admission = yield* Effect.scoped(
      admitAfterCheck(
        Effect.gen(function* () {
          const state = yield* Ref.get(updateStateRef);
          if (!(yield* Ref.get(updaterConfiguredRef)) || state.status !== "available") {
            return "refused" as const;
          }
          const activeAction = yield* Ref.get(activeUpdateActionRef);
          if (Option.isSome(activeAction)) {
            return activeAction.value === "check"
              ? ("wait-for-check" as const)
              : ("refused" as const);
          }
          return (yield* tryStartUpdateAction("download"))
            ? ("admitted" as const)
            : ("refused" as const);
        }),
      ),
    );
    if (admission === "refused") {
      return { accepted: false, completed: false };
    }

    const offered = yield* Ref.get(updateStateRef);
    let state = offered;
    return yield* Effect.gen(function* () {
      if (refresh) {
        // electron-updater downloads what its last check found, which can be hours old.
        yield* logUpdaterInfo("checking for updates", { reason: "download" });
        yield* runUpdaterCheck(
          offered.channel !== desktopUpdateChannelOf(environment.appVersion),
        ).pipe(
          // A failed check keeps electron-updater's earlier result, so the known offer still downloads.
          Effect.catchTags({
            ElectronUpdaterCheckForUpdatesError: (error) =>
              logUpdaterWarning(error.message, {
                errorTag: error._tag,
                cause: describeUpdateErrorCause(error.cause),
              }),
          }),
        );
      }
      state = yield* Ref.get(updateStateRef);
      if (state.status !== "available") {
        return { accepted: true, completed: false };
      }
      yield* setState(reduceDesktopUpdateStateOnDownloadStart(state));
      if (unsignedMacInstall) {
        return { accepted: true, completed: yield* downloadUnsignedMacUpdate };
      }
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logUpdaterInfo("downloading update");
      yield* electronUpdater.downloadUpdate;
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catchTags({
        UnsignedMacUpdateError: Effect.fn("desktop.updates.handleUnsignedDownloadFailure")(
          function* (error) {
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              step: error.step,
              cause: describeUpdateErrorCause(error.cause),
            });
            return { accepted: true, completed: false };
          },
        ),
        ElectronUpdaterDownloadUpdateError: Effect.fn("desktop.updates.handleDownloadFailure")(
          function* (error) {
            const cause = describeUpdateErrorCause(error.cause);
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnDownloadFailure(current, `${error.message} ${cause}`),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              cause,
              channel: error.channel,
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() =>
        updateState((current) => (current.status === "downloading" ? state : current)).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdateUnexpectedActionError({ action: "download", cause });
        return Effect.gen(function* () {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            cause: describeUpdateErrorCause(error.cause),
            action: error.action,
          });
          return { accepted: true, completed: false };
        });
      }),
      Effect.ensuring(finishUpdateAction("download")),
    );
  });

  const updateRestartMarkerDir = environment.path.join(environment.baseDir, "runtime");
  const updateRestartMarkerPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_RESTART_MARKER_FILE,
  );
  const writeUpdateRestartMarker = fileSystem
    .makeDirectory(updateRestartMarkerDir, { recursive: true })
    .pipe(
      Effect.andThen(fileSystem.writeFileString(updateRestartMarkerPath, "")),
      Effect.catch((error) =>
        logUpdaterWarning("Could not write the update restart marker.", { errorTag: error._tag }),
      ),
    );

  const updateInProgressMarkerPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_IN_PROGRESS_MARKER_FILE,
  );
  const encodeUpdateMarker = Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ startedAt: Schema.Number, expiresAt: Schema.Number })),
  );
  const updateInProgressTempPath = `${updateInProgressMarkerPath}.tmp`;
  const writeUpdateInProgressMarker = Effect.gen(function* () {
    const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
    const contents = yield* encodeUpdateMarker({
      startedAt,
      expiresAt: startedAt + DESKTOP_UPDATE_IN_PROGRESS_TTL_MS,
    });
    yield* fileSystem.writeFileString(updateInProgressTempPath, contents);
    yield* fileSystem.rename(updateInProgressTempPath, updateInProgressMarkerPath);
  }).pipe(
    Effect.ensuring(
      fileSystem.remove(updateInProgressTempPath, { force: true }).pipe(Effect.ignore),
    ),
    Effect.catch((error) =>
      logUpdaterWarning("Could not write the update-in-progress marker.", { errorTag: error._tag }),
    ),
  );
  const removeUpdateInProgressMarker = fileSystem
    .remove(updateInProgressMarkerPath, { force: true })
    .pipe(Effect.ignore);

  // Failed or interrupted installs leave no replacement backend; later quits must release the tunnel.
  const removeUpdateRestartMarker = fileSystem
    .remove(updateRestartMarkerPath, { force: true })
    .pipe(Effect.ignore);

  const installRecordPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  );
  const writeInstallRecord = (targetVersion: string) =>
    encodeInstallRecord({ fromVersion: environment.appVersion, targetVersion }).pipe(
      Effect.flatMap((text) => fileSystem.writeFileString(installRecordPath, text)),
      Effect.catch((error) =>
        logUpdaterWarning("Could not record the update install.", { errorTag: error._tag }),
      ),
    );
  const removeInstallRecord = fileSystem
    .remove(installRecordPath, { force: true })
    .pipe(Effect.ignore);

  const launchedMarkerPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_LAUNCHED_MARKER_FILE,
  );
  // Tells a waiting unsigned-update helper that this version got through startup.
  const writeLaunchedMarker = fileSystem
    .makeDirectory(updateRestartMarkerDir, { recursive: true })
    .pipe(
      Effect.andThen(fileSystem.writeFileString(launchedMarkerPath, environment.appVersion)),
      Effect.catch((error) =>
        logUpdaterWarning("Could not write the update launch marker.", { errorTag: error._tag }),
      ),
    );

  const hasPreparedMacUpdate = (version: string | null) =>
    Ref.get(preparedMacUpdateRef).pipe(
      Effect.map((prepared) => Option.isSome(prepared) && prepared.value.version === version),
    );

  // Hands the swap to the detached helper, then quits normally. The helper starts the new bundle
  // with this app's environment once this process is gone, and restores and restarts the old
  // bundle the same way if the new one never reports a started launch.
  const installUnsignedMacUpdate = Effect.gen(function* () {
    const prepared = yield* Ref.get(preparedMacUpdateRef);
    if (Option.isNone(prepared) || macBundlePath === null) {
      return yield* new UnsignedMacUpdateError({
        step: "install",
        detail: "no downloaded update is ready",
      });
    }
    if (Option.isNone(electronApp)) {
      return yield* new UnsignedMacUpdateError({
        step: "install",
        detail: "the app cannot quit itself here",
      });
    }
    yield* startUnsignedMacSwap({
      prepared: prepared.value,
      appPid: process.pid,
      bundlePath: macBundlePath,
      currentExecutable: environment.path.relative(macBundlePath, process.execPath),
      workDir: unsignedUpdateWorkDir,
      launchedMarkerPath,
      logPath: environment.path.join(environment.logDir, "desktop-update-helper.log"),
      env: process.env,
    });
    yield* logUpdaterInfo("quitting for unsigned macOS update", {
      version: prepared.value.version,
    });
    yield* electronApp.value.quit;
  });

  const readNotAppliedInstallVersion = fileSystem.readFileString(installRecordPath).pipe(
    Effect.flatMap(decodeInstallRecord),
    Effect.option,
    Effect.map((record) =>
      Option.flatMap(record, (value) =>
        Option.fromNullishOr(resolveNotAppliedInstallVersion(value, environment.appVersion)),
      ),
    ),
    Effect.tap((notAppliedVersion) =>
      Option.isNone(notAppliedVersion) ? removeInstallRecord : Effect.void,
    ),
  );

  const baseUpdateState = (channel: DesktopUpdateChannel, disabledReason: Option.Option<string>) =>
    Ref.get(notAppliedVersionRef).pipe(
      Effect.map((notAppliedVersion) => ({
        ...createBaseUpdateState(channel, disabledReason, environment),
        // Callers fall back to the channel's reason only when nothing else turns updates off.
        ...(Option.isSome(disabledReason) &&
        disabledReason.value === Option.getOrUndefined(channelBlockedReason(channel))
          ? { channelBlockedByPolicy: true as const }
          : {}),
        ...Option.match(notAppliedVersion, {
          onNone: () => ({}),
          onSome: (version) => ({ notAppliedVersion: version }),
        }),
      })),
    );

  const resetInstallAction = Effect.all(
    [
      finishUpdateAction("install"),
      Ref.set(desktopState.quitting, false),
      Ref.set(installRunningBackendsRef, []),
      removeUpdateRestartMarker,
      removeUpdateInProgressMarker,
      removeInstallRecord,
    ],
    { discard: true },
  );

  const recoverFailedInstall = Effect.fn("desktop.updates.recoverFailedInstall")(function* (
    message: string,
  ) {
    const ownsRecovery = yield* Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) && activeAction.value === "install"
        ? ([true, Option.some<UpdateAction>("install-recovery")] as const)
        : ([false, activeAction] as const),
    );
    if (!ownsRecovery) return;

    yield* Ref.set(desktopState.quitting, false);
    yield* removeUpdateRestartMarker;
    yield* removeUpdateInProgressMarker;
    yield* removeInstallRecord;
    yield* Effect.gen(function* () {
      const runningInstances = yield* Ref.getAndSet(installRunningBackendsRef, []);
      const instances = (yield* pool.list).filter((instance) =>
        runningInstances.includes(instance),
      );
      const restartExit = yield* Effect.forEach(instances, (instance) => instance.start, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.exit);
      yield* updateState((current) => reduceDesktopUpdateStateOnInstallFailure(current, message));
      if (Exit.isFailure(restartExit)) {
        yield* logUpdaterError("Desktop update install recovery could not restart every backend.");
      }
    }).pipe(
      Effect.catchCause(() =>
        logUpdaterError("Desktop update install recovery failed unexpectedly."),
      ),
      Effect.ensuring(finishUpdateAction("install-recovery")),
    );
  });

  const installDownloadedUpdate = (expectedVersion?: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const admission = yield* admitAfterCheck(
          Effect.gen(function* () {
            const state = yield* Ref.get(updateStateRef);
            const activeAction = yield* Ref.get(activeUpdateActionRef);
            const hasExpectedDownload =
              state.downloadedVersion !== null &&
              (expectedVersion === undefined || state.downloadedVersion === expectedVersion);
            if (
              (yield* Ref.get(desktopState.quitting)) ||
              !(yield* Ref.get(updaterConfiguredRef)) ||
              (unsignedMacInstall && !(yield* hasPreparedMacUpdate(state.downloadedVersion))) ||
              !hasExpectedDownload
            ) {
              return "refused" as const;
            }
            if (Option.isSome(activeAction)) {
              return activeAction.value === "check"
                ? ("wait-for-check" as const)
                : ("refused" as const);
            }
            const hasInstallableDownload =
              state.status === "downloaded" ||
              (state.status === "error" &&
                (state.errorContext === null || state.errorContext === "install"));
            if (!hasInstallableDownload) return "refused" as const;
            return (yield* tryStartUpdateAction("install"))
              ? ("admitted" as const)
              : ("refused" as const);
          }),
        );
        if (admission === "refused") {
          return { accepted: false, completed: false, failed: false };
        }

        yield* Ref.set(desktopState.quitting, true);
        yield* Ref.set(installRunningBackendsRef, []);

        return yield* Effect.gen(function* () {
          yield* writeUpdateRestartMarker;
          yield* writeUpdateInProgressMarker;
          const { downloadedVersion } = yield* Ref.get(updateStateRef);
          if (downloadedVersion !== null) yield* writeInstallRecord(downloadedVersion);
          // Stop pooled backends and SSH tunnels before quitAndInstall can outrun their scope finalizers.
          const instances = yield* pool.list;
          // stop clears desiredRunning, so retain the recovery set beforehand.
          const runningInstances = yield* Effect.filter(instances, (instance) =>
            instance.snapshot.pipe(Effect.map((snapshot) => snapshot.desiredRunning)),
          );
          yield* Ref.set(installRunningBackendsRef, runningInstances);
          yield* Effect.all(
            [
              Effect.forEach(
                instances,
                (instance) =>
                  instance.stop({ timeout: DesktopBackendManager.BACKEND_QUIT_STOP_TIMEOUT }),
                { concurrency: "unbounded" },
              ),
              sshEnvironment.closeAllTunnels,
            ],
            { concurrency: "unbounded" },
          );
          if (unsignedMacInstall) {
            yield* installUnsignedMacUpdate;
            return { accepted: true, completed: false, failed: false };
          }
          yield* electronUpdater.quitAndInstall({
            isSilent: true,
            isForceRunAfter: true,
          });
          return { accepted: true, completed: false, failed: false };
        }).pipe(
          Effect.catchTags({
            UnsignedMacUpdateError: Effect.fn("desktop.updates.handleUnsignedInstallFailure")(
              function* (error) {
                yield* recoverFailedInstall(error.message);
                yield* logUpdaterError(error.message, {
                  errorTag: error._tag,
                  step: error.step,
                  cause: describeUpdateErrorCause(error.cause),
                });
                return { accepted: true, completed: false, failed: true };
              },
            ),
            ElectronUpdaterQuitAndInstallError: Effect.fn("desktop.updates.handleInstallFailure")(
              function* (error) {
                yield* recoverFailedInstall(error.message);
                yield* logUpdaterError(error.message, {
                  errorTag: error._tag,
                  cause: describeUpdateErrorCause(error.cause),
                  channel: error.channel,
                  isSilent: error.isSilent,
                  isForceRunAfter: error.isForceRunAfter,
                });
                return { accepted: true, completed: false, failed: true };
              },
            ),
          }),
          Effect.onInterrupt(() => resetInstallAction),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) {
                return yield* Effect.failCause(cause);
              }
              const error = new DesktopUpdateUnexpectedActionError({ action: "install", cause });
              yield* recoverFailedInstall(error.message);
              yield* logUpdaterError(error.message, {
                errorTag: error._tag,
                cause: describeUpdateErrorCause(error.cause),
                action: error.action,
              });
              return { accepted: true, completed: false, failed: true };
            }),
          ),
        );
      }),
    ).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const installWithExpectedVersion = Effect.fn("desktop.updates.install")(function* (
    expectedVersion?: string,
  ) {
    if (yield* Ref.get(desktopState.quitting)) {
      return {
        accepted: false,
        completed: false,
        failed: false,
        state: yield* Ref.get(updateStateRef),
      };
    }
    let installVersion = expectedVersion;
    // A download can be hours old: a release published since replaces it before restarting.
    const retained = yield* Ref.get(updateStateRef);
    if (
      retained.downloadedVersion !== null &&
      (expectedVersion === undefined || retained.downloadedVersion === expectedVersion) &&
      (yield* checkForUpdates(
        "install",
        "acquire",
        retained.channel !== desktopUpdateChannelOf(environment.appVersion),
      )) &&
      (yield* Ref.get(updateStateRef)).status === "available"
    ) {
      const refreshed = yield* Ref.get(updateStateRef);
      // electron-updater compares a stale feed with the running build, not the retained download.
      if (
        refreshed.availableVersion === null ||
        compareSemverVersions(refreshed.availableVersion, retained.downloadedVersion) <= 0
      ) {
        yield* setState(retained);
      } else {
        const download = yield* downloadAvailableUpdate(false);
        if (!download.completed) {
          return {
            accepted: download.accepted,
            completed: false,
            failed: download.accepted,
            state: yield* Ref.get(updateStateRef),
          };
        }
        if (expectedVersion !== undefined) {
          installVersion = (yield* Ref.get(updateStateRef)).downloadedVersion ?? expectedVersion;
        }
      }
    }
    const result = yield* installDownloadedUpdate(installVersion);
    return {
      accepted: result.accepted,
      completed: result.completed,
      failed: result.failed,
      state: yield* Ref.get(updateStateRef),
    };
  });

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "startup", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.forever,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "poll", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  // Records the zip to install in place, or why this app cannot replace itself.
  const planUnsignedMacUpdate = Effect.fn("desktop.updates.planUnsignedMacUpdate")(function* (
    info: unknown,
    version: string,
  ) {
    const writable = macBundlePath === null ? false : yield* isWritableMacInstall(macBundlePath);
    const blocker = unsignedMacInstallBlocker({ bundlePath: macBundlePath, writable });
    const zip = selectMacUpdateZip(info, environment.runtimeInfo.hostArch);
    const appUpdateYml = Option.getOrUndefined(yield* Ref.get(appUpdateYmlConfigRef));
    const feed = mockUpdates
      ? { provider: "generic" as const, url: `http://localhost:${config.mockUpdateServerPort}` }
      : policy.feedUrl !== undefined
        ? { provider: "generic" as const, url: policy.feedUrl }
        : appUpdateYml?.provider === "github" && appUpdateYml.owner && appUpdateYml.repo
          ? { provider: "github" as const, owner: appUpdateYml.owner, repo: appUpdateYml.repo }
          : appUpdateYml?.provider === "generic" && appUpdateYml.url
            ? { provider: "generic" as const, url: appUpdateYml.url }
            : null;
    const reason =
      blocker ??
      (zip === null ? "The update feed listed no zip for this Mac." : null) ??
      (feed === null ? "The update feed has no download location." : null);
    if (reason !== null || zip === null || feed === null) {
      yield* Ref.set(unsignedZipRef, Option.some({ blocker: reason ?? "No update download." }));
      yield* logUpdaterInfo("unsigned macOS update cannot install in place", { reason });
      return;
    }
    yield* Ref.set(
      unsignedZipRef,
      Option.some({ version, url: macUpdateAssetUrl({ version, fileName: zip.url, feed }), zip }),
    );
  });

  const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          if (!(yield* offerable(info.version, state))) {
            yield* logUpdaterInfo("ignoring update outside the selected channel or its floor", {
              version: info.version,
              channel: state.channel,
            });
            const checkedAt = yield* currentIsoTimestamp;
            yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }
          if (
            unsignedMacInstall &&
            Option.contains(yield* Ref.get(bootCheckFailedVersionRef), info.version)
          ) {
            yield* logUpdaterInfo("ignoring update that failed its boot check", {
              version: info.version,
            });
            yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, yield* currentIsoTimestamp));
            return;
          }
          if (isOffered(state) && state.availableVersion === info.version) return;
          if (unsignedMacInstall) yield* planUnsignedMacUpdate(raw, info.version);

          const checkedAt = yield* currentIsoTimestamp;
          const { releaseNotes, omittedReleaseCount } = normalizeDesktopUpdateReleaseNotes(
            releaseNotesOfOfferedVersion(info),
            info.version,
            state.channel,
            info.releaseDate,
          );
          yield* setState(
            reduceDesktopUpdateStateOnUpdateAvailable(
              state,
              info.version,
              checkedAt,
              releaseNotes,
              omittedReleaseCount,
            ),
          );
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logUpdaterInfo("update available", {
            version: info.version,
            releaseNoteGroups: releaseNotes.length,
            omittedReleaseCount,
          });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-available", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    const checkedAt = yield* currentIsoTimestamp;
    const state = yield* Ref.get(updateStateRef);
    yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logUpdaterInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

  const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
    cause: unknown,
  ) {
    const activeAction = yield* activeUpdateAction;
    const error = new DesktopUpdaterReportedError({
      operation: Option.match(activeAction, {
        onNone: () => "background" as const,
        onSome: (action) => (action === "install-recovery" ? "install" : action),
      }),
      cause,
    });
    if (Option.isSome(activeAction) && activeAction.value === "install") {
      yield* recoverFailedInstall(error.message);
      yield* logUpdaterError(error.message, {
        errorTag: error._tag,
        cause: describeUpdateErrorCause(error.cause),
        operation: error.operation,
      });
      return;
    }

    if (Option.isNone(activeAction)) {
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((current) => ({
        ...current,
        status: "error",
        message: error.message,
        checkedAt,
        downloadPercent: null,
        errorContext: current.errorContext,
        canRetry: getCanRetryFromState(current),
      }));
    }

    yield* logUpdaterError(error.message, {
      errorTag: error._tag,
      cause: describeUpdateErrorCause(error.cause),
      operation: error.operation,
    });
  });

  const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
          const state = yield* Ref.get(updateStateRef);
          const percent = Math.floor(progress.percent);
          if (shouldBroadcastDownloadProgress(state, progress.percent) || state.message !== null) {
            yield* setState(reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent));
          }
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logUpdaterInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "download-progress", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          // A download can finish after its track switch moved on; never offer that build.
          if (!(yield* offerable(info.version, state))) {
            yield* logUpdaterInfo("ignoring download outside the selected channel or its floor", {
              version: info.version,
              channel: state.channel,
            });
            // Its progress events left the updater "downloading", which would block every check.
            if (state.status === "downloading") {
              yield* setState(
                reduceDesktopUpdateStateOnNoUpdate(state, yield* currentIsoTimestamp),
              );
            }
            return;
          }
          yield* setState(reduceDesktopUpdateStateOnDownloadComplete(state, info.version));
          yield* logUpdaterInfo("update downloaded", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-downloaded", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        });
      }),
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    isActionActive: activeUpdateAction.pipe(Effect.map(Option.isSome)),
    isInstallActive: activeUpdateAction.pipe(
      Effect.map((action) => Option.isSome(action) && action.value === "install"),
    ),
    subscribe: stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(stateChanges);
        const latest = yield* Ref.get(updateStateRef);
        return { latest, changes: Stream.fromSubscription(subscription) };
      }),
    ),
    emitState,
    disabledReason: Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => resolveStateDisabledReason(state.channel)),
    ),
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      // Runs synchronously up to the first await, so a check's outcome is applied before the
      // check's promise resolves and wakes the actions waiting on it.
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);
      if (unsignedMacInstall && environment.isPackaged) yield* writeLaunchedMarker;

      const notAppliedVersion = yield* readNotAppliedInstallVersion;
      yield* Ref.set(notAppliedVersionRef, notAppliedVersion);
      if (Option.isSome(notAppliedVersion)) {
        yield* logUpdaterWarning("the last update install did not apply", {
          version: environment.appVersion,
          targetVersion: notAppliedVersion.value,
        });
      }

      if (mockUpdates) {
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: `http://localhost:${config.mockUpdateServerPort}`,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      } else if (policy.feedUrl !== undefined) {
        // The administrator's mirror replaces the GitHub feed baked into app-update.yml.
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: policy.feedUrl,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      }

      const storedSettings = yield* desktopSettings.get;
      // Fork builds have one feed, the fork's own releases, on its stable channel.
      const settings = unsignedMacInstall
        ? { ...storedSettings, updateChannel: "latest" as const }
        : storedSettings;
      const disabledReason = yield* resolveDisabledReason;
      // A blocked nightly channel still lets the user switch back to stable, so it stays updatable.
      yield* Ref.set(desktopState.canInstallUpdates, Option.isNone(disabledReason));
      yield* setState(
        yield* baseUpdateState(
          settings.updateChannel,
          Option.orElse(disabledReason, () => channelBlockedReason(settings.updateChannel)),
        ),
      );
      if (Option.isSome(disabledReason)) {
        return;
      }
      yield* Ref.set(updaterConfiguredRef, true);

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(settings.updateChannel);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
      options?: { readonly minimumVersion?: string | undefined },
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      if (unsignedMacInstall && nextChannel !== "latest") {
        return yield* new DesktopUpdateChannelManagedError({
          channel: nextChannel,
          policyMessage: "This build updates only from the alexandros-lekkas/t3code releases.",
        });
      }
      if (Option.isSome(channelBlockedReason(nextChannel))) {
        return yield* new DesktopUpdateChannelManagedError({
          channel: nextChannel,
          policyMessage: policy.message ?? "Your administrator manages T3 Code updates.",
        });
      }
      // A background check holds the updater only briefly, so wait it out instead of refusing.
      const activeAction = yield* tryStartChannelChange.pipe(
        Effect.repeat({
          while: (active) => Option.isSome(active) && active.value === "check",
          schedule: Schedule.spaced(CHANNEL_CHANGE_RETRY_DELAY),
          times: CHANNEL_CHANGE_RETRIES,
        }),
      );
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value === "install-recovery" ? "install" : activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      return yield* Effect.gen(function* () {
        const previousFloor = yield* Ref.getAndSet(
          releaseFloorRef,
          Option.fromNullishOr(options?.minimumVersion),
        );
        const state = yield* Ref.get(updateStateRef);
        const retained = state.downloadedVersion ?? state.availableVersion;
        // A build from another track re-checks, so retrying a track switch finds an older release.
        // So does a retained offer below the new floor, which must not install.
        if (
          nextChannel === state.channel &&
          nextChannel === desktopUpdateChannelOf(environment.appVersion) &&
          (retained === null || (yield* offerable(retained, state)))
        ) {
          return state;
        }

        yield* desktopSettings.setUpdateChannel(nextChannel).pipe(
          Effect.onError(() => Ref.set(releaseFloorRef, previousFloor)),
          Effect.mapError(
            (cause) => new DesktopUpdateChannelPersistenceError({ channel: nextChannel, cause }),
          ),
        );

        const disabledReason = yield* resolveDisabledReason;
        yield* setState(yield* baseUpdateState(nextChannel, disabledReason));

        if (Option.isSome(disabledReason) || !(yield* Ref.get(updaterConfiguredRef))) {
          return yield* Ref.get(updateStateRef);
        }

        yield* applyAutoUpdaterChannel(nextChannel);
        // Only leaving the running build's track can need an older release.
        yield* checkForUpdates(
          "channel-change",
          "held",
          nextChannel !== desktopUpdateChannelOf(environment.appVersion),
        );
        return yield* Ref.get(updateStateRef);
      }).pipe(Effect.ensuring(finishUpdateAction("channel")));
    }),
    check: Effect.fn("desktop.updates.check")(function* (
      reason: string,
      options?: { readonly allowDowngrade?: boolean },
    ) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason, "acquire", options?.allowDowngrade === true);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate(true);
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: installWithExpectedVersion().pipe(
      Effect.map(({ accepted, completed, state }) => ({ accepted, completed, state })),
    ),
    installPrepared: Effect.fn("DesktopUpdates.installPrepared")(function (expectedVersion) {
      return installWithExpectedVersion(expectedVersion);
    }),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
