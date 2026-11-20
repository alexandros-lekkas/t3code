// @effect-diagnostics nodeBuiltinImport:off -- Runs the real swap helper against fake bundles on disk.
// @effect-diagnostics globalTimers:off -- Waits briefly for detached fake bundles to record their launch.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  BOOT_CHECK_STATE_FILES,
  UNSIGNED_MAC_UPDATE_HELPER_SCRIPT,
  bootCheckAnswerMatches,
  bootCheckEnvironment,
  bootCheckUnsignedMacUpdate,
  macUpdateAssetUrl,
  prepareUnsignedMacUpdate,
  resolveMacAppBundlePath,
  selectMacUpdateZip,
  unsignedMacHelperEnvironment,
  unsignedMacInstallBlocker,
} from "./unsignedMacUpdate.ts";

describe("unsigned macOS install location", () => {
  it("finds the bundle from the resources path", () => {
    expect(resolveMacAppBundlePath("/Applications/T3 Code (Nightly).app/Contents/Resources")).toBe(
      "/Applications/T3 Code (Nightly).app",
    );
    expect(resolveMacAppBundlePath("/opt/t3code/resources")).toBeNull();
  });

  it("updates writable installs in place and explains every other location", () => {
    expect(
      unsignedMacInstallBlocker({
        bundlePath: "/Applications/T3 Code (Nightly).app",
        writable: true,
      }),
    ).toBeNull();
    expect(
      unsignedMacInstallBlocker({
        bundlePath: "/private/var/folders/x/AppTranslocation/ABC/d/T3 Code (Nightly).app",
        writable: true,
      }),
    ).toContain("temporary copy");
    expect(
      unsignedMacInstallBlocker({
        bundlePath: "/Volumes/T3 Code/T3 Code (Nightly).app",
        writable: false,
      }),
    ).toContain("disk image");
    expect(
      unsignedMacInstallBlocker({
        bundlePath: "/Applications/T3 Code (Nightly).app",
        writable: false,
      }),
    ).toContain("cannot replace itself in /Applications");
  });

  it("picks this architecture's zip from the feed", () => {
    const info = {
      files: [
        { url: "T3-Code-1.0.0-x64.zip", sha512: "x", size: 1 },
        { url: "T3-Code-1.0.0-arm64.zip", sha512: "a", size: 2 },
        { url: "T3-Code-1.0.0-arm64.dmg", sha512: "d", size: 3 },
      ],
    };
    expect(selectMacUpdateZip(info, "arm64")).toEqual({
      url: "T3-Code-1.0.0-arm64.zip",
      sha512: "a",
      size: 2,
    });
    expect(selectMacUpdateZip({ files: [] }, "arm64")).toBeNull();
    expect(selectMacUpdateZip("garbage", "arm64")).toBeNull();
  });
});

describe("unsigned macOS swap helper", () => {
  const roots: Array<string> = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
  });

  const writeBundle = async (bundle: string, body: string) => {
    const macos = NodePath.join(bundle, "Contents", "MacOS");
    await NodeFSP.mkdir(macos, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(macos, "T3 Code (Nightly)"), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  };

  const setup = async (newBundleBody: string) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-swap-"));
    roots.push(root);
    const paths = {
      target: NodePath.join(root, "Applications", "T3 Code (Nightly).app"),
      staged: NodePath.join(root, "work", "extracted", "T3 Code (Nightly).app"),
      backup: NodePath.join(root, "work", "T3 Code (Nightly).app"),
      marker: NodePath.join(root, "launched"),
      record: NodePath.join(root, "launches"),
      log: NodePath.join(root, "helper.log"),
      script: NodePath.join(root, "helper.sh"),
    };
    await writeBundle(
      paths.target,
      `echo "old home=$T3CODE_HOME node=\${ELECTRON_RUN_AS_NODE:-unset}" >> "$RECORD"`,
    );
    await writeBundle(paths.staged, newBundleBody);
    await NodeFSP.writeFile(paths.script, UNSIGNED_MAC_UPDATE_HELPER_SCRIPT, { mode: 0o755 });
    return paths;
  };

  // The quitting app: a process that exits shortly after the helper starts.
  const runHelper = async (paths: Awaited<ReturnType<typeof setup>>, final?: string) => {
    const app = NodeChildProcess.spawn("/bin/sh", ["-c", "sleep 0.3"]);
    const env = unsignedMacHelperEnvironment({
      PATH: process.env.PATH,
      T3CODE_HOME: "/users/me/.t3",
      ELECTRON_RUN_AS_NODE: "1",
      RECORD: paths.record,
      MARKER: paths.marker,
      T3CODE_UPDATE_START_TIMEOUT: "5",
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      NodeChildProcess.execFile(
        "/bin/sh",
        [
          paths.script,
          String(app.pid),
          paths.target,
          paths.staged,
          paths.backup,
          "Contents/MacOS/T3 Code (Nightly)",
          "Contents/MacOS/T3 Code (Nightly)",
          paths.marker,
          paths.log,
          ...(final === undefined ? [] : [final]),
        ],
        { env },
        (error) => resolve(error === null ? 0 : (error.code as number)),
      );
    });
    return exitCode;
  };

  // Launched bundles run detached from the helper, so their record can land
  // just after it exits.
  const readLaunches = async (record: string, count: number) => {
    const read = () =>
      NodeFSP.readFile(record, "utf8").then(
        (text) => text.trim().split("\n"),
        (): Array<string> => [],
      );
    await expect
      .poll(async () => (await read()).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(count);
    return read();
  };

  it("swaps in the update and starts it with the app's environment", async () => {
    const paths = await setup(
      `echo "new home=$T3CODE_HOME node=\${ELECTRON_RUN_AS_NODE:-unset}" >> "$RECORD"; echo 1.0.1 > "$MARKER"`,
    );
    expect(await runHelper(paths)).toBe(0);
    expect(await readLaunches(paths.record, 1)).toEqual(["new home=/users/me/.t3 node=unset"]);
    const installed = await NodeFSP.readFile(
      NodePath.join(paths.target, "Contents", "MacOS", "T3 Code (Nightly)"),
      "utf8",
    );
    expect(installed).toContain("new");
    await expect(NodeFSP.access(paths.backup)).rejects.toThrow();
  });

  it("restores the old bundle and starts it the same way when the update fails to start", async () => {
    const paths = await setup(
      `echo "new home=$T3CODE_HOME node=\${ELECTRON_RUN_AS_NODE:-unset}" >> "$RECORD"; exit 1`,
    );
    // A marker left by an earlier start must not count for this launch.
    await NodeFSP.writeFile(paths.marker, "stale");
    expect(await runHelper(paths)).toBe(2);
    expect(await readLaunches(paths.record, 2)).toEqual([
      "new home=/users/me/.t3 node=unset",
      "old home=/users/me/.t3 node=unset",
    ]);
    const installed = await NodeFSP.readFile(
      NodePath.join(paths.target, "Contents", "MacOS", "T3 Code (Nightly)"),
      "utf8",
    );
    expect(installed).toContain("old");
    expect(await NodeFSP.readFile(paths.log, "utf8")).toContain("rolling back");
  });

  it("installs a renamed bundle beside the old one and removes the old one", async () => {
    const paths = await setup(
      `echo "new home=$T3CODE_HOME node=\${ELECTRON_RUN_AS_NODE:-unset}" >> "$RECORD"; echo 1.0.1 > "$MARKER"`,
    );
    const renamed = NodePath.join(NodePath.dirname(paths.target), "T3 Code (Nightly) Renamed.app");
    expect(await runHelper(paths, renamed)).toBe(0);
    expect(await readLaunches(paths.record, 1)).toEqual(["new home=/users/me/.t3 node=unset"]);
    expect(
      await NodeFSP.readFile(
        NodePath.join(renamed, "Contents", "MacOS", "T3 Code (Nightly)"),
        "utf8",
      ),
    ).toContain("new");
    await expect(NodeFSP.access(paths.target)).rejects.toThrow();
    await expect(NodeFSP.access(paths.backup)).rejects.toThrow();
  });

  it("restores the old bundle at its own path when a renamed update fails to start", async () => {
    const paths = await setup(`echo "new" >> "$RECORD"; exit 1`);
    const renamed = NodePath.join(NodePath.dirname(paths.target), "T3 Code (Nightly) Renamed.app");
    expect(await runHelper(paths, renamed)).toBe(2);
    expect(
      await NodeFSP.readFile(
        NodePath.join(paths.target, "Contents", "MacOS", "T3 Code (Nightly)"),
        "utf8",
      ),
    ).toContain("old");
    await expect(NodeFSP.access(renamed)).rejects.toThrow();
  });
});

describe("unsigned macOS update feed", () => {
  it("downloads from the fork's GitHub release, a generic feed, or an absolute URL", () => {
    const github = { provider: "github" as const, owner: "alexandros-lekkas", repo: "t3code" };
    expect(
      macUpdateAssetUrl({
        version: "0.1.11-boat.7",
        fileName: "T3-Code-0.1.11-boat.7-arm64.zip",
        feed: github,
      }),
    ).toBe(
      "https://github.com/alexandros-lekkas/t3code/releases/download/v0.1.11-boat.7/T3-Code-0.1.11-boat.7-arm64.zip",
    );
    expect(
      macUpdateAssetUrl({
        version: "1.0.0",
        fileName: "T3-Code-1.0.0-arm64.zip",
        feed: { provider: "generic", url: "http://localhost:3000/" },
      }),
    ).toBe("http://localhost:3000/T3-Code-1.0.0-arm64.zip");
    expect(
      macUpdateAssetUrl({ version: "1.0.0", fileName: "https://cdn.example/x.zip", feed: github }),
    ).toBe("https://cdn.example/x.zip");
  });
});

describe("unsigned macOS update boot check", () => {
  const roots: Array<string> = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
    );
  });

  it("accepts only the expected version's environment descriptor", () => {
    const body = JSON.stringify({ environmentId: "e", serverVersion: "0.1.11-boat.7" });
    expect(bootCheckAnswerMatches(body, "0.1.11-boat.7")).toBe(true);
    expect(bootCheckAnswerMatches(body, "0.1.11-boat.8")).toBe(false);
    expect(bootCheckAnswerMatches("<html>ok</html>", "0.1.11-boat.7")).toBe(false);
  });

  it("gives the trial server no credentials and keeps its background work parked", () => {
    const env = bootCheckEnvironment({ home: "/tmp/trial-home", tmpDir: "/tmp/", lang: undefined });
    expect(env).toMatchObject({
      HOME: "/tmp/trial-home",
      ELECTRON_RUN_AS_NODE: "1",
      T3CODE_BOOT_CHECK: "1",
    });
    expect(
      Object.keys(env)
        .filter((key) => key !== "T3CODE_BOOT_CHECK")
        .sort(),
    ).toEqual([
      "ELECTRON_RUN_AS_NODE",
      "HOME",
      "PATH",
      "T3CODE_DISABLE_AUTO_UPDATE",
      "T3CODE_NO_BROWSER",
      "TMPDIR",
    ]);
  });

  // A fake bundle whose executable is a tiny server standing in for the update's backend.
  const setup = async (behaviour: "serve" | "wrong-version" | "crash") => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-boot-check-"));
    roots.push(root);
    const live = NodePath.join(root, "live", "userdata");
    await NodeFSP.mkdir(NodePath.join(live, "secrets"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(live, "statev2.sqlite"), "live database");
    await NodeFSP.writeFile(NodePath.join(live, "settings.json"), "{}");
    await NodeFSP.writeFile(NodePath.join(live, "secrets", "server-signing-key.bin"), "secret");
    await NodeFSP.writeFile(NodePath.join(live, "server-runtime.json"), "{}");
    const bundle = NodePath.join(root, "extracted", "T3 Code (Nightly).app");
    const macos = NodePath.join(bundle, "Contents", "MacOS");
    await NodeFSP.mkdir(macos, { recursive: true });
    const report = NodePath.join(root, "report.json");
    const version = behaviour === "wrong-version" ? "0.0.1" : "0.1.11-boat.7";
    await NodeFSP.writeFile(
      NodePath.join(macos, "T3 Code (Nightly)"),
      `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const state = path.join(flag("--base-dir"), "userdata");
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
  home: process.env.HOME,
  bootCheck: process.env.T3CODE_BOOT_CHECK,
  files: fs.readdirSync(state).sort(),
  database: fs.readFileSync(path.join(state, "statev2.sqlite"), "utf8"),
}));
fs.writeFileSync(path.join(state, "statev2.sqlite"), "migrated");
if (${JSON.stringify(behaviour)} === "crash") { console.error("migration 101 failed"); process.exit(3); }
http.createServer((request, response) => {
  if (request.url !== "/.well-known/t3/environment") { response.statusCode = 404; return response.end(); }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ environmentId: "trial", serverVersion: ${JSON.stringify(version)} }));
}).listen(Number(flag("--port")), "127.0.0.1");
`,
      { mode: 0o755 },
    );
    return {
      live,
      report,
      workDir: NodePath.join(root, "work", "boot-check"),
      prepared: {
        version: "0.1.11-boat.7",
        stagedBundlePath: bundle,
        executable: "Contents/MacOS/T3 Code (Nightly)",
      },
    };
  };

  // Each case starts a real subprocess, so it runs on the live clock.
  const runCheck = (behaviour: Parameters<typeof setup>[0]) =>
    Effect.gen(function* () {
      const paths = yield* Effect.promise(() => setup(behaviour));
      const exit = yield* Effect.exit(
        bootCheckUnsignedMacUpdate({
          prepared: paths.prepared,
          liveStateDir: paths.live,
          workDir: paths.workDir,
          env: { TMPDIR: NodeOS.tmpdir(), LANG: "en_US.UTF-8", GH_TOKEN: "never-passed" },
          timeoutMs: 15_000,
        }),
      );
      return { paths, exit };
    });

  effectIt.live("boots the update against a copy of the state, never the live files", () =>
    Effect.gen(function* () {
      const { paths, exit } = yield* runCheck("serve");
      expect(Exit.isSuccess(exit)).toBe(true);
      const report = JSON.parse(NodeFS.readFileSync(paths.report, "utf8"));
      expect(report.bootCheck).toBe("1");
      expect(report.home.startsWith(paths.workDir)).toBe(true);
      expect(report.files).toEqual(["settings.json", "statev2.sqlite"]);
      expect(report.database).toBe("live database");
      expect(BOOT_CHECK_STATE_FILES).not.toContain("secrets");
      // The trial's migration wrote to its copy only, and the copy is gone afterwards.
      expect(NodeFS.readFileSync(NodePath.join(paths.live, "statev2.sqlite"), "utf8")).toBe(
        "live database",
      );
      expect(NodeFS.existsSync(paths.workDir)).toBe(false);
    }),
  );

  effectIt.live("fails when the update's server exits during startup, with its output", () =>
    Effect.gen(function* () {
      const { paths, exit } = yield* runCheck("crash");
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("migration 101 failed");
      expect(NodeFS.existsSync(paths.workDir)).toBe(false);
    }),
  );

  effectIt.live("fails when something other than the update answers", () =>
    Effect.gen(function* () {
      const { exit } = yield* runCheck("wrong-version");
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("unexpected body");
    }),
  );
});

// Extracting and reading the bundle use macOS's own ditto and plutil.
const hasMacTools = NodeFS.existsSync("/usr/bin/ditto") && NodeFS.existsSync("/usr/bin/plutil");

describe.skipIf(!hasMacTools)("unsigned macOS update download", () => {
  const roots: Array<string> = [];
  const servers: Array<NodeHttp.Server> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) server.closeAllConnections();
    await Promise.all(
      roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
    );
  });

  const plist = (path: string, entries: Record<string, string>) => {
    NodeChildProcess.execFileSync("/usr/bin/plutil", ["-create", "xml1", path]);
    for (const [key, value] of Object.entries(entries)) {
      NodeChildProcess.execFileSync("/usr/bin/plutil", ["-insert", key, "-string", value, path]);
    }
  };

  // A release zip of a fake bundle, the running bundle it replaces, and a local feed serving it.
  const setup = async (serve: "all" | "stall") => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-download-"));
    roots.push(root);
    const current = NodePath.join(root, "current", "T3 Code (Nightly).app");
    await NodeFSP.mkdir(NodePath.join(current, "Contents"), { recursive: true });
    plist(NodePath.join(current, "Contents", "Info.plist"), {
      CFBundleIdentifier: "com.t3tools.t3code",
    });
    const release = NodePath.join(root, "release", "T3 Code (Nightly).app");
    await NodeFSP.mkdir(NodePath.join(release, "Contents", "MacOS"), { recursive: true });
    plist(NodePath.join(release, "Contents", "Info.plist"), {
      CFBundleIdentifier: "com.t3tools.t3code",
      CFBundleShortVersionString: "0.1.11-boat.9",
      CFBundleExecutable: "T3 Code (Nightly)",
    });
    const zipPath = NodePath.join(root, "update.zip");
    NodeChildProcess.execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", release, zipPath]);
    const bytes = await NodeFSP.readFile(zipPath);
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "content-length": String(bytes.byteLength) });
      if (serve === "all") response.end(bytes);
      // Sends the first bytes, then goes quiet without closing, like a connection lost in sleep.
      else response.write(bytes.subarray(0, 16));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    return {
      root,
      current,
      url: `http://127.0.0.1:${address.port}/update.zip`,
      zip: {
        url: "update.zip",
        sha512: NodeCrypto.createHash("sha512").update(bytes).digest("base64"),
        size: bytes.byteLength,
      },
    };
  };

  const prepare = (serve: "all" | "stall", idleTimeoutMs: number) =>
    Effect.gen(function* () {
      const { root, current, url, zip } = yield* Effect.promise(() => setup(serve));
      const exit = yield* Effect.exit(
        prepareUnsignedMacUpdate({
          version: "0.1.11-boat.9",
          url,
          zip,
          workDir: NodePath.join(root, "work"),
          currentBundlePath: current,
          onProgress: () => Effect.void,
          idleTimeoutMs,
        }),
      );
      return { root, exit };
    });

  effectIt.live("downloads, verifies and extracts the release bundle", () =>
    Effect.gen(function* () {
      const { root, exit } = yield* prepare("all", 1_000);
      expect(exit).toEqual(
        Exit.succeed({
          version: "0.1.11-boat.9",
          stagedBundlePath: NodePath.join(root, "work", "extracted", "T3 Code (Nightly).app"),
          executable: NodePath.join("Contents", "MacOS", "T3 Code (Nightly)"),
        }),
      );
    }),
  );

  // Without the idle timeout this hangs until the test times out.
  effectIt.live("fails a download that stops sending instead of waiting forever", () =>
    Effect.gen(function* () {
      const { exit } = yield* prepare("stall", 300);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("no data for 0.3s");
    }),
  );
});
