// @effect-diagnostics nodeBuiltinImport:off -- The swap helper and the boot check spawn detached processes, and the zip is hashed while it streams to disk.
// @effect-diagnostics globalTimers:off -- The boot check waits between probes of the trial server.
// @effect-diagnostics globalFetch:off -- One streamed release download that follows GitHub's asset redirects, and the boot check's local probe.
// Fork (alexandros-lekkas/t3code): in-app updates for unsigned (ad-hoc) macOS builds, which
// Squirrel.Mac refuses to install. The app downloads the release zip named by the fork's feed,
// checks its size and sha512, extracts it, boots the new build's server against a copy of the
// user's state, and hands the bundle swap to a detached shell helper that outlives the app.
// Ported from alexandros-lekkas/cogenly. See the fork section of AGENTS.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Written by every unsigned macOS start; the swap helper waits for it to call an update healthy. */
export const DESKTOP_UPDATE_LAUNCHED_MARKER_FILE = "desktop-update-launched";

/** Set in the staged package.json of fork builds that install updates themselves. */
export const UNSIGNED_UPDATES_PACKAGE_KEY = "t3codeUnsignedUpdates";

export class UnsignedMacUpdateError extends Schema.TaggedError<UnsignedMacUpdateError>()(
  "UnsignedMacUpdateError",
  {
    step: Schema.Literals(["download", "verify", "extract", "boot-check", "install"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unsigned macOS update ${this.step} failed: ${this.detail}`;
  }
}

export interface MacUpdateZip {
  readonly url: string;
  readonly sha512: string;
  readonly size: number | undefined;
}

export interface PreparedMacUpdate {
  readonly version: string;
  /** Extracted bundle, ready to move into the install location. */
  readonly stagedBundlePath: string;
  /** Executable path relative to the bundle, from the update's Info.plist. */
  readonly executable: string;
}

/** `.../Name.app/Contents/Resources` → `.../Name.app`, or null outside a bundle. */
export function resolveMacAppBundlePath(resourcesPath: string): string | null {
  const contents = NodePath.dirname(resourcesPath);
  const bundle = NodePath.dirname(contents);
  if (NodePath.basename(resourcesPath) !== "Resources") return null;
  if (NodePath.basename(contents) !== "Contents") return null;
  return bundle.endsWith(".app") ? bundle : null;
}

/** Why this app cannot replace itself where it runs, or null when it can. */
export function unsignedMacInstallBlocker(input: {
  readonly bundlePath: string | null;
  readonly writable: boolean;
}): string | null {
  const { bundlePath, writable } = input;
  if (bundlePath === null) return "T3 Code could not find its app bundle.";
  if (bundlePath.includes("/AppTranslocation/")) {
    return "macOS is running T3 Code from a temporary copy. Move it to Applications and open it from there to update in place.";
  }
  if (writable) return null;
  if (bundlePath.startsWith("/Volumes/")) {
    return "T3 Code is running from its disk image. Drag it to Applications and open it from there to update in place.";
  }
  return `T3 Code cannot replace itself in ${NodePath.dirname(bundlePath)}. Move it to a folder you can write to, or install the update by hand.`;
}

const UpdateInfoFiles = Schema.Struct({
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        url: Schema.String,
        sha512: Schema.String,
        size: Schema.optional(Schema.Number),
      }),
    ),
  ),
});
const decodeUpdateInfoFiles = Schema.decodeUnknownOption(UpdateInfoFiles);

/** Picks the zip for this architecture from electron-updater's update info. */
export function selectMacUpdateZip(info: unknown, arch: string): MacUpdateZip | null {
  const decoded = decodeUpdateInfoFiles(info);
  const files = Option.isSome(decoded) ? (decoded.value.files ?? []) : [];
  const zips = files.filter((file) => file.url.endsWith(".zip"));
  const match = zips.find((file) => file.url.endsWith(`-${arch}.zip`)) ?? zips[0];
  return match ? { url: match.url, sha512: match.sha512, size: match.size } : null;
}

/**
 * Where a release asset downloads from: the GitHub release `v<version>` of the feed's repository,
 * or the root of a generic (mock or mirror) feed. An absolute asset URL is used as is.
 */
export function macUpdateAssetUrl(input: {
  readonly version: string;
  readonly fileName: string;
  readonly feed:
    | { readonly provider: "github"; readonly owner: string; readonly repo: string }
    | { readonly provider: "generic"; readonly url: string };
}): string {
  if (/^https?:\/\//.test(input.fileName)) return input.fileName;
  const base =
    input.feed.provider === "generic"
      ? input.feed.url.replace(/\/+$/, "")
      : `https://github.com/${input.feed.owner}/${input.feed.repo}/releases/download/v${encodeURIComponent(input.version)}`;
  return `${base}/${encodeURIComponent(input.fileName)}`;
}

/** Drops variables that would change how the relaunched app starts. */
export function unsignedMacHelperEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "ELECTRON_RUN_AS_NODE" || key === "ELECTRON_NO_ATTACH_CONSOLE") continue;
    result[key] = value;
  }
  return result;
}

/**
 * The detached swap helper. Arguments: app PID, install path, staged bundle, backup path, new and
 * old executables (bundle-relative), launch marker, log file, and the final path (the install path,
 * or a sibling named like the update's bundle when a release renames the app).
 */
export const UNSIGNED_MAC_UPDATE_HELPER_SCRIPT = `#!/bin/sh
set -u
app_pid=$1 target=$2 staged=$3 backup=$4 new_exe=$5 old_exe=$6 marker=$7 log=$8 final=\${9:-$2}
quit_timeout=\${T3CODE_UPDATE_QUIT_TIMEOUT:-120}
start_timeout=\${T3CODE_UPDATE_START_TIMEOUT:-90}
exec >>"$log" 2>&1
say() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*"; }
# Starts a bundle detached from this shell so it is not left as our zombie.
launch() { launched_pid=$( ( "$1/$2" </dev/null >/dev/null 2>&1 & echo $! ) ); say "started $1 as $launched_pid"; }
gone_within() {
  ticks=0
  while kill -0 "$1" 2>/dev/null; do
    ticks=$((ticks + 1)); [ "$ticks" -gt $(($2 * 5)) ] && return 1; sleep 0.2
  done
  return 0
}
say "waiting for $app_pid to quit"
if ! gone_within "$app_pid" "$quit_timeout"; then say "the app did not quit; update abandoned"; exit 1; fi
rm -rf "$backup" "$backup.failed"
if ! mv "$target" "$backup"; then
  say "could not move the current app aside; update abandoned"; launch "$target" "$old_exe"; exit 1
fi
if ! mv "$staged" "$final"; then
  say "could not move the update into place; restoring"
  mv "$backup" "$target" && launch "$target" "$old_exe"; exit 1
fi
rm -f "$marker"
launch "$final" "$new_exe"; new_pid=$launched_pid
ticks=0
while [ ! -f "$marker" ]; do
  if ! kill -0 "$new_pid" 2>/dev/null; then say "the update exited while starting"; break; fi
  ticks=$((ticks + 1))
  if [ "$ticks" -gt $((start_timeout * 5)) ]; then
    say "the update did not finish starting; stopping $new_pid"
    kill "$new_pid" 2>/dev/null; gone_within "$new_pid" 10 || kill -9 "$new_pid" 2>/dev/null
    break
  fi
  sleep 0.2
done
if [ -f "$marker" ]; then say "update started"; rm -rf "$backup"; exit 0; fi
say "rolling back"
if mv "$final" "$backup.failed" && mv "$backup" "$target"; then
  rm -rf "$backup.failed"; launch "$target" "$old_exe"; exit 2
fi
say "rollback failed; the previous app is at $backup"; exit 3
`;

const run = (file: string, args: ReadonlyArray<string>, step: UnsignedMacUpdateError["step"]) =>
  Effect.callback<string, UnsignedMacUpdateError>((resume) => {
    NodeChildProcess.execFile(file, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      resume(
        error
          ? Effect.fail(
              new UnsignedMacUpdateError({
                step,
                detail: `${NodePath.basename(file)} exited: ${stderr.trim().slice(0, 300)}`,
                cause: error,
              }),
            )
          : Effect.succeed(stdout),
      );
    });
  });

const fsStep = <A>(step: UnsignedMacUpdateError["step"], detail: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new UnsignedMacUpdateError({ step, detail, cause }),
  });

export const isWritableMacInstall = (bundlePath: string) =>
  Effect.promise(async () => {
    try {
      await NodeFSP.access(bundlePath, NodeFSP.constants.W_OK);
      await NodeFSP.access(NodePath.dirname(bundlePath), NodeFSP.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });

const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/** An abort signal that fires once `ms` pass without a `touch`. */
function idleWatchdog(ms: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };
  touch();
  return { signal: controller.signal, touch, stop: () => clearTimeout(timer) };
}

/** Streams the zip to disk, checking size and sha512 against the feed. */
const downloadZip = Effect.fn("desktop.updates.unsignedMac.download")(function* (input: {
  readonly url: string;
  readonly zip: MacUpdateZip;
  readonly destination: string;
  readonly onProgress: (percent: number) => Effect.Effect<void>;
  readonly idleTimeoutMs?: number;
}) {
  // A connection that stops sending (sleep, a network switch) never errors on its own; without
  // this the download, and every later attempt the app refuses while it runs, would hang.
  const idleTimeoutMs = input.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  const watchdog = idleWatchdog(idleTimeoutMs);
  const networkStep = <A>(detail: string, f: () => Promise<A>) =>
    Effect.tryPromise({
      try: f,
      catch: (cause) => {
        watchdog.stop();
        return new UnsignedMacUpdateError({
          step: "download",
          detail: watchdog.signal.aborted ? `no data for ${idleTimeoutMs / 1000}s` : detail,
          cause,
        });
      },
    });
  const response = yield* networkStep("request failed", () =>
    fetch(input.url, { signal: watchdog.signal }),
  );
  if (!response.ok || response.body === null) {
    watchdog.stop();
    return yield* new UnsignedMacUpdateError({
      step: "download",
      detail: `server answered ${response.status}`,
    });
  }
  const total = input.zip.size ?? Number(response.headers.get("content-length") ?? 0);
  const hash = NodeCrypto.createHash("sha512");
  let received = 0;
  yield* Effect.acquireUseRelease(
    fsStep("download", "could not create the download file", () =>
      NodeFSP.open(input.destination, "w"),
    ),
    (handle) =>
      Effect.gen(function* () {
        const reader = response.body!.getReader();
        while (true) {
          const chunk = yield* networkStep("connection lost", () => reader.read());
          if (chunk.done) break;
          watchdog.touch();
          hash.update(chunk.value);
          received += chunk.value.byteLength;
          yield* fsStep("download", "could not write the download", () =>
            handle.write(chunk.value),
          );
          if (total > 0) yield* input.onProgress(Math.min(100, (received / total) * 100));
        }
      }),
    (handle) =>
      Effect.sync(watchdog.stop).pipe(Effect.andThen(Effect.promise(() => handle.close()))),
  );
  if (input.zip.size !== undefined && received !== input.zip.size) {
    return yield* new UnsignedMacUpdateError({
      step: "verify",
      detail: `expected ${input.zip.size} bytes, received ${received}`,
    });
  }
  if (hash.digest("base64") !== input.zip.sha512) {
    return yield* new UnsignedMacUpdateError({
      step: "verify",
      detail: "sha512 does not match the update feed",
    });
  }
});

const readPlistValue = (plistPath: string, key: string) =>
  run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath], "extract").pipe(
    Effect.map((value) => value.trim()),
  );

/**
 * Downloads, verifies, and extracts an update into `workDir` (recreated).
 * The extracted bundle must carry the expected version and the running bundle's identifier.
 */
export const prepareUnsignedMacUpdate = Effect.fn("desktop.updates.unsignedMac.prepare")(
  function* (input: {
    readonly version: string;
    readonly url: string;
    readonly zip: MacUpdateZip;
    readonly workDir: string;
    readonly currentBundlePath: string;
    readonly onProgress: (percent: number) => Effect.Effect<void>;
    /** How long the download may go without data before it fails. */
    readonly idleTimeoutMs?: number;
  }) {
    const expectedIdentifier = yield* readPlistValue(
      NodePath.join(input.currentBundlePath, "Contents", "Info.plist"),
      "CFBundleIdentifier",
    );
    const zipPath = NodePath.join(input.workDir, "update.zip");
    const extractDir = NodePath.join(input.workDir, "extracted");
    // Electron's fs treats `app.asar` as a directory it cannot empty, so a leftover
    // extracted bundle makes `fs.rm` fail with ENOTEMPTY. `rm` sees a plain file.
    yield* run("/bin/rm", ["-rf", input.workDir], "download");
    yield* fsStep("download", "could not prepare the update folder", () =>
      NodeFSP.mkdir(extractDir, { recursive: true }),
    );
    yield* downloadZip({
      url: input.url,
      zip: input.zip,
      destination: zipPath,
      onProgress: input.onProgress,
      ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
    });
    yield* run("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir], "extract");
    yield* fsStep("extract", "could not remove the downloaded zip", () => NodeFSP.rm(zipPath));
    const bundles = (yield* fsStep("extract", "could not read the update", () =>
      NodeFSP.readdir(extractDir),
    )).filter((name) => name.endsWith(".app"));
    if (bundles.length !== 1) {
      return yield* new UnsignedMacUpdateError({
        step: "extract",
        detail: `expected one app bundle, found ${bundles.length}`,
      });
    }
    const stagedBundlePath = NodePath.join(extractDir, bundles[0]!);
    const plist = NodePath.join(stagedBundlePath, "Contents", "Info.plist");
    const version = yield* readPlistValue(plist, "CFBundleShortVersionString");
    const identifier = yield* readPlistValue(plist, "CFBundleIdentifier");
    const executableName = yield* readPlistValue(plist, "CFBundleExecutable");
    if (version !== input.version || identifier !== expectedIdentifier) {
      return yield* new UnsignedMacUpdateError({
        step: "verify",
        detail: `the update is ${identifier} ${version}, expected ${expectedIdentifier} ${input.version}`,
      });
    }
    // Downloads through fetch carry no quarantine; clear any a proxy or tool added.
    yield* run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", stagedBundlePath], "extract").pipe(
      Effect.ignore,
    );
    return {
      version,
      stagedBundlePath,
      executable: NodePath.join("Contents", "MacOS", executableName),
    } satisfies PreparedMacUpdate;
  },
);

/**
 * The state files the boot check copies. Only what the server needs to open and migrate the
 * user's data: never secrets, sign-ins, relay clients or the server-ownership lock, so the trial
 * server cannot reach any account or collide with the running one.
 */
export const BOOT_CHECK_STATE_FILES: ReadonlyArray<string> = [
  "statev2.sqlite",
  "statev2.sqlite-wal",
  "settings.json",
  "keybindings.json",
  "environment-id",
];

const BOOT_CHECK_DATABASE = "statev2.sqlite";
const BOOT_CHECK_COPY_ATTEMPTS = 5;

const cloneFile = (source: string, destination: string) =>
  // A clone on APFS: instant and no extra space, even for a multi-gigabyte database.
  NodeFSP.copyFile(source, destination, NodeFS.constants.COPYFILE_FICLONE);

const databaseStamp = async (path: string) => {
  try {
    const stat = await NodeFSP.stat(path, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}`;
  } catch (cause) {
    if ((cause as { code?: unknown }).code !== "ENOENT") throw cause;
    return null;
  }
};

/**
 * Copies the state the trial server boots on while the live server keeps writing. A checkpoint
 * between the database and WAL copies leaves pages from two moments, which reads as corrupt
 * rows. The database file changes only at a checkpoint, so a pair is good when it did not
 * change while both were copied; otherwise the copy is taken again.
 */
export async function copyBootCheckState(input: {
  readonly liveStateDir: string;
  readonly stateDir: string;
  readonly copyFile?: (source: string, destination: string) => Promise<void>;
}): Promise<void> {
  const copyFile = input.copyFile ?? cloneFile;
  const database = NodePath.join(input.liveStateDir, BOOT_CHECK_DATABASE);
  for (let attempt = 1; ; attempt += 1) {
    const before = await databaseStamp(database);
    for (const name of BOOT_CHECK_STATE_FILES) {
      const destination = NodePath.join(input.stateDir, name);
      await NodeFSP.rm(destination, { force: true });
      try {
        await copyFile(NodePath.join(input.liveStateDir, name), destination);
      } catch (cause) {
        if ((cause as { code?: unknown }).code !== "ENOENT") throw cause;
      }
    }
    if (attempt === BOOT_CHECK_COPY_ATTEMPTS || (await databaseStamp(database)) === before) return;
  }
}

const BOOT_CHECK_TIMEOUT_MS = 180_000;
const BOOT_CHECK_POLL_MS = 500;
const BOOT_CHECK_OUTPUT_LIMIT = 4_000;

const EnvironmentDescriptor = Schema.Struct({
  environmentId: Schema.String,
  serverVersion: Schema.String,
});
const decodeEnvironmentDescriptor = Schema.decodeUnknownOption(
  Schema.fromJsonString(EnvironmentDescriptor),
);

/** Whether a `/.well-known/t3/environment` body proves the expected server answered. */
export function bootCheckAnswerMatches(body: string, expectedVersion: string): boolean {
  const descriptor = decodeEnvironmentDescriptor(body);
  return Option.isSome(descriptor) && descriptor.value.serverVersion === expectedVersion;
}

/** The trial server's environment: no credentials, no T3 settings from this process. */
export function bootCheckEnvironment(input: {
  readonly home: string;
  readonly tmpDir: string | undefined;
  readonly lang: string | undefined;
}): Record<string, string> {
  return {
    HOME: input.home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    ...(input.tmpDir ? { TMPDIR: input.tmpDir } : {}),
    ...(input.lang ? { LANG: input.lang } : {}),
    ELECTRON_RUN_AS_NODE: "1",
    // Keeps the server's parked work (effects, schedules, tunnels) from ever starting.
    T3CODE_BOOT_CHECK: "1",
    T3CODE_NO_BROWSER: "1",
    T3CODE_DISABLE_AUTO_UPDATE: "1",
  };
}

/**
 * Polls the trial server until it answers with the expected version, exits, or runs out of time.
 * Plain async code: it only waits on a local socket.
 */
async function awaitBootCheckAnswer(input: {
  readonly url: string;
  readonly expectedVersion: string;
  readonly timeoutMs: number;
  readonly exited: () => boolean;
  readonly note: (line: string) => void;
}): Promise<boolean> {
  // Each attempt waits at most the poll interval plus a short request timeout.
  const attempts = Math.max(1, Math.ceil(input.timeoutMs / BOOT_CHECK_POLL_MS));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (input.exited()) return false;
    try {
      const response = await fetch(input.url, { signal: AbortSignal.timeout(BOOT_CHECK_POLL_MS) });
      if (response.ok) {
        const body = await response.text();
        if (bootCheckAnswerMatches(body, input.expectedVersion)) return true;
        input.note(`answered with an unexpected body: ${body.slice(0, 300)}`);
        return false;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, BOOT_CHECK_POLL_MS));
  }
  return false;
}

const freeLoopbackPort = Effect.callback<number, UnsignedMacUpdateError>((resume) => {
  const server = NodeNet.createServer();
  server.once("error", (cause) =>
    resume(
      Effect.fail(
        new UnsignedMacUpdateError({ step: "boot-check", detail: "no free local port", cause }),
      ),
    ),
  );
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

/**
 * Starts the downloaded build's server against a fresh copy of the user's state and waits for
 * `/.well-known/t3/environment` to answer with the update's version. The live state is only
 * read (cloned); the trial server runs with its own home, no credentials, and never activates
 * its background work. It is killed as soon as it answers.
 */
export const bootCheckUnsignedMacUpdate = Effect.fn("desktop.updates.unsignedMac.bootCheck")(
  function* (input: {
    readonly prepared: PreparedMacUpdate;
    readonly liveStateDir: string;
    readonly workDir: string;
    /** This app's environment; only TMPDIR and LANG reach the trial server. */
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
    /** Where the server entry lives inside the bundle; packaged builds use app.asar. */
    readonly serverEntry?: string;
  }) {
    const serverEntry = NodePath.join(
      input.prepared.stagedBundlePath,
      input.serverEntry ?? "Contents/Resources/app.asar/apps/server/dist/bin.mjs",
    );
    const baseDir = NodePath.join(input.workDir, "t3");
    const stateDir = NodePath.join(baseDir, "userdata");
    const home = NodePath.join(input.workDir, "home");
    yield* fsStep("boot-check", "could not prepare the trial state", async () => {
      await NodeFSP.rm(input.workDir, { recursive: true, force: true });
      await NodeFSP.mkdir(stateDir, { recursive: true });
      await NodeFSP.mkdir(home, { recursive: true });
      await copyBootCheckState({ liveStateDir: input.liveStateDir, stateDir });
    });

    return yield* Effect.gen(function* () {
      const port = yield* freeLoopbackPort;
      let output = "";
      let exited: string | null = null;
      const child = yield* Effect.try({
        try: () =>
          NodeChildProcess.spawn(
            NodePath.join(input.prepared.stagedBundlePath, input.prepared.executable),
            [
              serverEntry,
              "--base-dir",
              baseDir,
              "--host",
              "127.0.0.1",
              "--port",
              String(port),
              "--no-browser",
            ],
            {
              cwd: home,
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
              env: bootCheckEnvironment({
                home,
                tmpDir: input.env.TMPDIR,
                lang: input.env.LANG,
              }),
            },
          ),
        catch: (cause) =>
          new UnsignedMacUpdateError({
            step: "boot-check",
            detail: "could not start the update's server",
            cause,
          }),
      });
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-BOOT_CHECK_OUTPUT_LIMIT);
      };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      child.once("error", (error) => {
        exited = `could not start: ${error.message}`;
      });
      child.once("exit", (code, signal) => {
        exited = `exited (${signal ?? code})`;
      });
      const kill = Effect.sync(() => {
        if (child.pid === undefined) return;
        try {
          // The server's own children share its process group.
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      });

      const answered = yield* Effect.promise(() =>
        awaitBootCheckAnswer({
          url: `http://127.0.0.1:${port}/.well-known/t3/environment`,
          expectedVersion: input.prepared.version,
          timeoutMs: input.timeoutMs ?? BOOT_CHECK_TIMEOUT_MS,
          exited: () => exited !== null,
          note: (line) => {
            output = `${output}\n${line}`;
          },
        }),
      ).pipe(Effect.ensuring(kill));
      if (!answered) {
        const reason = exited ?? "did not answer /.well-known/t3/environment in time";
        return yield* new UnsignedMacUpdateError({
          step: "boot-check",
          detail: `the update's server ${reason}. Last output: ${output.trim().slice(-1_500)}`,
        });
      }
    }).pipe(
      Effect.ensuring(
        Effect.promise(() =>
          NodeFSP.rm(input.workDir, { recursive: true, force: true }).catch(() => undefined),
        ),
      ),
    );
  },
);

/** Writes the helper and starts it detached; the caller then quits the app. */
export const startUnsignedMacSwap = Effect.fn("desktop.updates.unsignedMac.startSwap")(
  function* (input: {
    readonly prepared: PreparedMacUpdate;
    readonly appPid: number;
    readonly bundlePath: string;
    readonly currentExecutable: string;
    readonly workDir: string;
    readonly launchedMarkerPath: string;
    readonly logPath: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  }) {
    const scriptPath = NodePath.join(input.workDir, "swap-helper.sh");
    yield* fsStep("install", "could not write the update helper", async () => {
      await NodeFSP.mkdir(NodePath.dirname(input.logPath), { recursive: true });
      await NodeFSP.writeFile(scriptPath, UNSIGNED_MAC_UPDATE_HELPER_SCRIPT, { mode: 0o755 });
    });
    // A release that renames the app installs under the new name beside the old
    // bundle, which the swap removes. If that name is taken, update in place.
    const stagedName = NodePath.basename(input.prepared.stagedBundlePath);
    const renamedPath = NodePath.join(NodePath.dirname(input.bundlePath), stagedName);
    const finalPath =
      renamedPath === input.bundlePath ||
      (yield* Effect.promise(() =>
        NodeFSP.access(renamedPath).then(
          () => true,
          () => false,
        ),
      ))
        ? input.bundlePath
        : renamedPath;
    const args = [
      scriptPath,
      String(input.appPid),
      input.bundlePath,
      input.prepared.stagedBundlePath,
      NodePath.join(input.workDir, NodePath.basename(input.bundlePath)),
      input.prepared.executable,
      input.currentExecutable,
      input.launchedMarkerPath,
      input.logPath,
      finalPath,
    ];
    yield* Effect.callback<void, UnsignedMacUpdateError>((resume) => {
      const child = NodeChildProcess.spawn("/bin/sh", args, {
        detached: true,
        stdio: "ignore",
        env: unsignedMacHelperEnvironment(input.env),
      });
      child.once("error", (cause) =>
        resume(
          Effect.fail(
            new UnsignedMacUpdateError({
              step: "install",
              detail: "could not start the update helper",
              cause,
            }),
          ),
        ),
      );
      child.once("spawn", () => {
        child.unref();
        resume(Effect.void);
      });
    });
  },
);
