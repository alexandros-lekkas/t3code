// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { BOAT_CLOUD_NO_LOCAL_SIGN_INS, type BoatCloudStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  ADD_PROJECT_SCRIPT,
  VM_BACKUP_ARCHIVE,
  agentSignInsScript,
  backupScript,
  baseBranchCheckScript,
  boatCloudBlocker,
  boatCloudProviderDrivers,
  cloneRepositoriesScript,
  idleScript,
  parkCheckoutFunction,
  parseIdleProbe,
  parseMeasure,
  parseStats,
  parseRepository,
  pickMachine,
  prepareSnapshotScript,
  snapshotBuildOf,
  snapshotNameOf,
  prepareWorktreeScript,
  subdomainOfHttpBaseUrl,
  syncCheckoutScript,
  syncSignInsScript,
} from "./boatCloudVm.ts";

describe("parseRepository", () => {
  it("gives every remote form of one repository the same key and an HTTPS clone URL", () => {
    const forms = [
      "git@github.com:PingDotGG/t3code.git",
      "ssh://git@github.com/pingdotgg/t3code.git",
      "https://github.com/pingdotgg/t3code",
      "https://user@github.com/pingdotgg/t3code.git/",
    ];
    for (const form of forms) {
      const parsed = parseRepository(form);
      assert.strictEqual(parsed?.key, "github.com/pingdotgg/t3code", form);
    }
    assert.deepStrictEqual(parseRepository("git@github.com:pingdotgg/t3code.git"), {
      key: "github.com/pingdotgg/t3code",
      name: "pingdotgg/t3code",
      cloneUrl: "https://github.com/pingdotgg/t3code.git",
      workspaceRoot: "/home/user/projects/github.com/pingdotgg/t3code",
    });
  });

  it("gives repositories on other hosts or namespaces their own checkout, and rejects what cannot be cloned", () => {
    const roots = [
      "https://github.com/acme/app.git",
      "https://gitlab.com/acme/app.git",
      "https://gitlab.com/acme/tools/app.git",
      "https://gitlab.com/acme-tools/app.git",
    ].map((remote) => parseRepository(remote)?.workspaceRoot);
    assert.deepStrictEqual(roots, [
      "/home/user/projects/github.com/acme/app",
      "/home/user/projects/gitlab.com/acme/app",
      "/home/user/projects/gitlab.com/acme/tools/app",
      "/home/user/projects/gitlab.com/acme-tools/app",
    ]);
    assert.isNull(parseRepository("/home/me/local-repo"));
    assert.isNull(parseRepository("file:///home/me/repo"));
    assert.isNull(parseRepository("https://github.com/only-owner"));
  });
});

describe("snapshotBuildOf", () => {
  it("reads back the build a snapshot name records, and nothing from an unnamed one", () => {
    assert.deepStrictEqual(snapshotBuildOf(snapshotNameOf("0.1.9", true)), {
      version: "0.1.9",
      withSkills: true,
    });
    assert.deepStrictEqual(snapshotBuildOf(snapshotNameOf("10.2.0", false)), {
      version: "10.2.0",
      withSkills: false,
    });
    assert.isNull(snapshotBuildOf("t3-code"));
  });
});

describe("parseMeasure", () => {
  it("takes the larger of CPU waiting and memory use and lists the VM's checkouts", () => {
    assert.deepStrictEqual(
      parseMeasure("0.25 1000 900\n/home/user/projects/acme/app\n/home/user/projects/a/b\n"),
      {
        usage: 0.25,
        workspaceRoots: ["/home/user/projects/acme/app", "/home/user/projects/a/b"],
      },
    );
    assert.strictEqual(parseMeasure("0.025 1000 300")?.usage, 0.7);
    assert.isNull(parseMeasure("garbage"));
    assert.isNull(parseMeasure("0.1 0 900"));
  });
});

describe("parseStats", () => {
  it("reads CPU busy share over the sample, memory in use and the root disk", () => {
    const stats = parseStats(
      [
        "cpu  100 0 100 800 0 0 0 0 0 0",
        "cpu  130 0 120 850 0 0 0 0 0 0",
        "4",
        "8000000 6000000",
        "100000000000 25000000000",
      ].join("\n"),
    );
    assert.deepStrictEqual(stats, {
      cpuPercent: 50,
      cpus: 4,
      memoryUsedBytes: 2_000_000 * 1024,
      memoryTotalBytes: 8_000_000 * 1024,
      diskUsedBytes: 25_000_000_000,
      diskTotalBytes: 100_000_000_000,
    });
  });

  it("keeps CPU and memory when df did not answer, and refuses garbage", () => {
    const stats = parseStats("cpu 1 0 1 8\ncpu 1 0 1 18\n2\n1000 500\n");
    assert.strictEqual(stats?.cpuPercent, 0);
    assert.isNull(stats?.diskTotalBytes);
    assert.isNull(parseStats("garbage"));
    assert.isNull(parseStats("cpu 1 0 1 8\ncpu 1 0 1 18\n2\n0 0"));
  });
});

describe("pickMachine", () => {
  const root = "/home/user/projects/acme/app";
  const vm = (
    sandboxId: string,
    running: boolean,
    usage: number | null,
    workspaceRoots: ReadonlyArray<string> = [],
    environment: string | null = "base",
    spare = false,
  ) => ({ sandboxId, environment, running, usage, workspaceRoots, spare });

  it("reuses a running VM under half load, preferring one that has the checkout", () => {
    assert.deepStrictEqual(
      pickMachine([vm("idle", true, 0.1), vm("has-repo", true, 0.4, [root])], root, "base"),
      { kind: "use", sandboxId: "has-repo" },
    );
    assert.deepStrictEqual(pickMachine([vm("b", true, 0.3), vm("a", true, 0.1)], root, null), {
      kind: "use",
      sandboxId: "a",
    });
  });

  it("resumes before creating, and never shares a busy or silent VM", () => {
    assert.deepStrictEqual(
      pickMachine(
        [vm("busy", true, 0.5, [root]), vm("silent", true, null), vm("off", false, null)],
        root,
        "base",
      ),
      { kind: "resume", sandboxId: "off" },
    );
    assert.deepStrictEqual(
      pickMachine([vm("off-with-repo", false, null, [root]), vm("off", false, null)], root, "base"),
      { kind: "resume", sandboxId: "off-with-repo" },
    );
    assert.deepStrictEqual(pickMachine([vm("busy", true, 0.9)], root, "base"), {
      kind: "create",
    });
  });

  it("uses a running VM before waking a stopped one that has the checkout", () => {
    assert.deepStrictEqual(
      pickMachine([vm("off-with-repo", false, null, [root]), vm("free", true, 0.2)], root, "base"),
      { kind: "use", sandboxId: "free" },
    );
    const spare = vm("spare", true, 0, [], "base", true);
    assert.deepStrictEqual(
      pickMachine([vm("off-with-repo", false, null, [root]), spare], root, "base"),
      {
        kind: "use",
        sandboxId: "spare",
      },
    );
  });

  it("without sharing, reuses only the spare and otherwise creates a VM", () => {
    const free = vm("free", true, 0.1, [root]);
    const off = vm("off", false, null, [root]);
    assert.deepStrictEqual(pickMachine([free, off], root, "base", false), { kind: "create" });
    assert.deepStrictEqual(
      pickMachine([free, off, vm("spare", false, null, [], "base", true)], root, "base", false),
      { kind: "resume", sandboxId: "spare" },
    );
    assert.deepStrictEqual(
      pickMachine([free, vm("spare", true, 0, [], "base", true)], root, "base", false),
      { kind: "use", sandboxId: "spare" },
    );
  });

  it("takes the spare only after the VMs of its kind", () => {
    const spare = vm("spare", true, 0, [root], "base", true);
    assert.deepStrictEqual(pickMachine([spare, vm("free", true, 0.3, [root])], root, "base"), {
      kind: "use",
      sandboxId: "free",
    });
    assert.deepStrictEqual(pickMachine([spare, vm("off", false, null, [root])], root, "base"), {
      kind: "use",
      sandboxId: "spare",
    });
    assert.deepStrictEqual(pickMachine([spare, vm("free", true, 0.1)], root, "base"), {
      kind: "use",
      sandboxId: "spare",
    });
  });

  it("only joins a VM on the chosen environment", () => {
    const others = [
      vm("other-free", true, 0.1, [root], "staging"),
      vm("other-off", false, null, [root], "staging"),
      vm("unattached", true, 0.1, [root], null),
    ];
    assert.deepStrictEqual(pickMachine(others, root, "base"), { kind: "create" });
    assert.deepStrictEqual(pickMachine([...others, vm("mine", false, null)], root, "base"), {
      kind: "resume",
      sandboxId: "mine",
    });
  });
});

describe("parseIdleProbe", () => {
  it("counts from the later of the last activity and the hand-out, and never while busy", () => {
    const open = { threads: 2, settledSeconds: null };
    assert.deepStrictEqual(parseIdleProbe("0 2 700 -\n", 900), { idleSeconds: 700, ...open });
    assert.deepStrictEqual(parseIdleProbe("0 2 700 -", 120), { idleSeconds: 120, ...open });
    assert.deepStrictEqual(parseIdleProbe("0 - - -\n", 300), {
      idleSeconds: 300,
      threads: null,
      settledSeconds: null,
    });
    assert.deepStrictEqual(parseIdleProbe("1 0 0 -", 900), {
      idleSeconds: null,
      threads: 0,
      settledSeconds: null,
    });
    assert.isNull(parseIdleProbe("", 900));
    assert.isNull(parseIdleProbe("2 0 - -", 900));
    assert.isNull(parseIdleProbe("0 1", 900));
  });

  it("reads how long ago the last thread was settled", () => {
    assert.deepStrictEqual(parseIdleProbe("0 2 700 45", 900), {
      idleSeconds: 700,
      threads: 2,
      settledSeconds: 45,
    });
  });
});

const hasSqlite = NodeChildProcess.spawnSync("sqlite3", ["-version"]).status === 0;

describe.skipIf(!hasSqlite)("idleScript", () => {
  const runIdle = (setup: (home: string, db: string) => void) => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-idle-"));
    const db = NodePath.join(home, ".t3/userdata/statev2.sqlite");
    NodeFS.mkdirSync(NodePath.dirname(db), { recursive: true });
    const sql = (statement: string) =>
      NodeChildProcess.spawnSync("sqlite3", [db, statement], { encoding: "utf8" });
    sql(
      "CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT, requested_at TEXT); CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, deleted_at TEXT, payload_json TEXT DEFAULT '{}')",
    );
    setup(home, db);
    const result = NodeChildProcess.spawnSync(
      "bash",
      ["-c", idleScript.replaceAll("/home/user", home)],
      { encoding: "utf8" },
    );
    NodeFS.rmSync(home, { recursive: true, force: true });
    return result.stdout.trim();
  };
  const at = (secondsAgo: number) =>
    DateTime.formatIso(DateTime.subtract(DateTime.nowUnsafe(), { seconds: secondsAgo }));
  const insert = (db: string, statement: string) =>
    NodeChildProcess.spawnSync("sqlite3", [db, statement]);

  it("is busy while a turn someone asked for lately runs, and counts live threads", () => {
    const output = runIdle((_home, db) =>
      insert(
        db,
        `INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 'running', '${at(60)}'); INSERT INTO orchestration_v2_projection_threads (thread_id, deleted_at) VALUES ('t1', NULL), ('t2', '${at(10)}')`,
      ),
    );
    assert.match(output, /^1 1 \d+ -$/u);
  });

  it("stops renewing a turn no one asked for within the unattended cap", () => {
    const output = runIdle((_home, db) =>
      insert(
        db,
        `INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 'running', '${at(7 * 3600)}')`,
      ),
    );
    assert.strictEqual(output, "0 0 - -");
  });

  const thread = (id: string, payload: object, deletedAt: string | null = null) =>
    `INSERT INTO orchestration_v2_projection_threads VALUES ('${id}', ${deletedAt === null ? "NULL" : `'${deletedAt}'`}, '${JSON.stringify(payload)}')`;
  const settled = (secondsAgo: number) => ({
    settledOverride: "settled",
    settledAt: at(secondsAgo),
    lineage: { relationshipToParent: null },
  });

  it("times the last settle once every thread but subagents and deleted ones is settled", () => {
    const output = runIdle((_home, db) => {
      insert(db, thread("t1", settled(600)));
      insert(db, thread("t2", settled(120)));
      insert(db, thread("sub", { lineage: { relationshipToParent: "subagent" } }));
      insert(db, thread("gone", { settledOverride: null }, at(10)));
    });
    const seconds = Number(/^0 3 - (\d+)$/u.exec(output)?.[1]);
    assert.isAtLeast(seconds, 119);
    assert.isAtMost(seconds, 125);
  });

  it("does not call a VM settled while one thread on it is open", () => {
    const output = runIdle((_home, db) => {
      insert(db, thread("t1", settled(600)));
      insert(db, thread("t2", { settledOverride: null, settledAt: null }));
    });
    assert.strictEqual(output, "0 2 - -");
  });

  it("counts a terminal that just wrote, and knows no threads without the table", () => {
    const output = runIdle((home, db) => {
      insert(db, "DROP TABLE orchestration_v2_projection_threads");
      NodeFS.writeFileSync(NodePath.join(home, ".t3-boat-handed-out"), "");
      const terminals = NodePath.join(home, ".t3/userdata/logs/terminals");
      NodeFS.mkdirSync(terminals, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(terminals, "thread-1.log"), "$ npm run dev");
    });
    assert.match(output, /^1 - \d+ -$/u);
  });
});

describe("boatCloudProviderDrivers", () => {
  it("offers each provider one of Boat's credentials signs in", () => {
    assert.deepStrictEqual(
      [...boatCloudProviderDrivers(["anthropic-api-key", "opencode-api-key"])].toSorted(),
      ["claudeAgent", "opencode", "pi"],
    );
    assert.deepStrictEqual([...boatCloudProviderDrivers(["chatgpt-subscription"])], ["codex"]);
    assert.strictEqual(boatCloudProviderDrivers([]).size, 0);
  });
});

describe("boatCloudBlocker", () => {
  const environment = (agentCredentials: ReadonlyArray<string> | null) => ({
    id: "env-base",
    name: "base",
    isDefault: true,
    passGithub: true,
    passSandboxCredentials: false,
    passSecrets: false,
    passAgentsCredentials: true,
    agentCredentials,
  });
  const status = (overrides: Partial<BoatCloudStatus> = {}): BoatCloudStatus => ({
    connected: true,
    account: "me",
    setup: { status: "ready", step: null, error: null },
    snapshotReady: true,
    machines: [],
    starts: [],
    environment: "base",
    environments: [environment(["claude-subscription"])],
    environmentsError: null,
    githubConnected: false,
    shareMachines: false,
    keepReadyMachine: false,
    idleStopMinutes: 15,
    deleteStoppedAfterDays: 7,
    defaultMachineType: "small",
    machineTypes: [],
    environmentUsage: [],
    localSignIns: BOAT_CLOUD_NO_LOCAL_SIGN_INS,
    ...overrides,
  });

  it("names the first thing a start is missing, and never GitHub", () => {
    assert.strictEqual(boatCloudBlocker(null), "not-connected");
    assert.strictEqual(boatCloudBlocker(status({ connected: false })), "not-connected");
    assert.strictEqual(
      boatCloudBlocker(
        status({
          snapshotReady: false,
          setup: { status: "running", step: "create-vm", error: null },
        }),
      ),
      "no-snapshot",
    );
    assert.strictEqual(boatCloudBlocker(status({ environments: [environment([])] })), "no-agents");
    assert.isNull(boatCloudBlocker(status()));
    // Unknown sign-ins leave the VM's own server to decide.
    assert.isNull(boatCloudBlocker(status({ environments: [environment(null)] })));
  });

  it("counts this machine's sign-ins only while they are passed", () => {
    const local = (enabled: boolean) => ({
      ...BOAT_CLOUD_NO_LOCAL_SIGN_INS,
      enabled,
      available: [{ driver: "codex" as const, source: "login" as const, expiresAt: null }],
    });
    const withoutBoat = { environments: [environment([])] };
    assert.isNull(boatCloudBlocker(status({ ...withoutBoat, localSignIns: local(true) })));
    assert.strictEqual(
      boatCloudBlocker(status({ ...withoutBoat, localSignIns: local(false) })),
      "no-agents",
    );
  });
});

describe("agentSignInsScript", () => {
  const run = (script: string, env: Record<string, string>) =>
    NodeChildProcess.spawnSync(
      "bash",
      ["-c", `${script}printf '%s|%s' "\${CLAUDE_CODE_OAUTH_TOKEN-}" "\${OPENAI_API_KEY-}"`],
      { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" },
    ).stdout;
  const signIns = {
    claude: { CLAUDE_CODE_OAUTH_TOKEN: "dummy-claude-'token" },
    codex: { environment: { OPENAI_API_KEY: "dummy-openai-key" } },
  };

  it("fills each provider the Boat profile left unsigned, and keeps the profile's own", () => {
    const script = agentSignInsScript(signIns);
    assert.strictEqual(run(script, {}), "dummy-claude-'token|dummy-openai-key");
    // A Boat API key signs Claude in, so the holder's token stays out; Codex still gets its.
    assert.strictEqual(run(script, { ANTHROPIC_API_KEY: "boat" }), "|dummy-openai-key");
    assert.strictEqual(run(script, { CHATGPT_ACCOUNT_ID: "boat" }), "dummy-claude-'token|");
    assert.strictEqual(agentSignInsScript(null), "");
  });

  it("leaves no sign-in in the snapshot", () => {
    const unset =
      prepareSnapshotScript
        .split("\n")
        .find((line) => line.startsWith("systemctl --user unset-environment"))
        ?.split(" ") ?? [];
    for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "T3_BOAT_CODEX_AUTH_DIGEST"]) {
      assert.include(unset, name);
    }
    // The Codex file a holder wrote, told apart by its empty refresh token, goes too.
    assert.include(prepareSnapshotScript, `"refresh_token":""`);
    assert.include(
      agentSignInsScript({ claude: null, codex: { authFile: "{}" } }),
      "/home/user/.codex/auth.json",
    );
  });
});

describe("subdomainOfHttpBaseUrl", () => {
  it("finds the VM behind its hosted T3 URL and ignores other hosts", () => {
    assert.strictEqual(
      subdomainOfHttpBaseUrl("https://box-node-1dca660d802d15b6-3773.on.boat.dev"),
      "box-node-1dca660d802d15b6",
    );
    assert.isNull(subdomainOfHttpBaseUrl("https://box-node-1dca-8080.on.boat.dev"));
    assert.isNull(subdomainOfHttpBaseUrl("https://example.com"));
  });
});

describe("baseBranchCheckScript", () => {
  it("passes for a pushed branch, local or remote-named, and names an unpushed one", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-base-branch-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    const git = (...args: string[]) =>
      NodeChildProcess.spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd: root });
    git("init", "--quiet", "source");
    git(
      "-C",
      "source",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "base",
    );
    git("-C", "source", "branch", "feat/pushed");
    git("clone", "--quiet", "source", "clone");
    const check = (branch: string) =>
      NodeChildProcess.spawnSync("bash", [
        "-c",
        `dir=${NodePath.join(root, "clone")}\n${baseBranchCheckScript(branch, "me/repo")}`,
      ]);

    assert.strictEqual(check("feat/pushed").status, 0);
    assert.strictEqual(check("origin/main").status, 0);
    const missing = check("feat/local-only");
    assert.strictEqual(missing.status, 3);
    assert.include(missing.stderr.toString(), "feat/local-only is not on me/repo.");
  });
});

describe("syncCheckoutScript", () => {
  it("clones once, then fetches only for a base branch the checkout does not know", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-checkout-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    const git = (...args: string[]) =>
      NodeChildProcess.spawnSync(
        "git",
        ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        { cwd: root },
      );
    git("init", "--quiet", "source");
    git("-C", "source", "commit", "--quiet", "--allow-empty", "-m", "base");
    const sync = (baseBranch: string | null) =>
      NodeChildProcess.spawnSync("bash", [
        "-c",
        syncCheckoutScript(
          {
            key: "local/me/repo",
            name: "me/repo",
            cloneUrl: NodePath.join(root, "source"),
            workspaceRoot: NodePath.join(root, "projects", "repo"),
          },
          baseBranch,
        ),
      ]);

    assert.strictEqual(sync("main").status, 0);
    git("-C", "source", "branch", "feat/later");
    assert.strictEqual(sync("feat/later").status, 0);
    // A fetch would fail now, so a known base must not reach the remote.
    git("-C", "projects/repo", "remote", "set-url", "origin", NodePath.join(root, "gone"));
    assert.strictEqual(sync("feat/later").status, 0);
    assert.strictEqual(sync(null).status, 0);
    assert.notStrictEqual(sync("feat/never").status, 0);
  });
});

describe("syncSignInsScript", () => {
  const signIns = { claude: { CLAUDE_CODE_OAUTH_TOKEN: "dummy-claude-token" }, codex: null };
  const withStubs = (systemctl: string) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-sync-sign-ins-"));
    const stub = (name: string, body: string) =>
      NodeFS.writeFileSync(NodePath.join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("systemctl", systemctl);
    stub("sha256sum", "echo 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    stub("grep", "exit 1");
    return {
      root,
      run: (env: Record<string, string>) =>
        NodeChildProcess.spawnSync("sh", ["-c", syncSignInsScript(signIns)], {
          env: { PATH: `${root}:${process.env.PATH ?? ""}`, ...env },
          encoding: "utf8",
        }),
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
  };

  it("reaches the user manager when the command carries no XDG_RUNTIME_DIR", () => {
    using stubs = withStubs(
      `echo "$XDG_RUNTIME_DIR $*" >> "${"$"}{0%/*}/calls"; [ -n "$XDG_RUNTIME_DIR" ] || { echo "Failed to connect to bus: No medium found" >&2; exit 1; }; exit 1`,
    );
    stubs.run({});
    const calls = NodeFS.readFileSync(NodePath.join(stubs.root, "calls"), "utf8");
    assert.match(
      calls,
      new RegExp(`^/run/user/${process.getuid?.() ?? ""} --user unset-environment`),
    );
  });

  it("imports the token for the server, and retries a failed import on the next sync", () => {
    using stubs = withStubs(
      `[ -e "${"$"}{0%/*}/fail" ] && exit 1; [ "$2" = import-environment ] && printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > "${"$"}{0%/*}/imported"; exit 0`,
    );
    const runtime = NodePath.join(stubs.root, "runtime");
    NodeFS.mkdirSync(runtime);
    const stamp = NodePath.join(runtime, "t3-boat-credentials");

    NodeFS.writeFileSync(NodePath.join(stubs.root, "fail"), "");
    stubs.run({ XDG_RUNTIME_DIR: runtime });
    // The manager never took the values, so nothing marks them as delivered.
    assert.isFalse(NodeFS.existsSync(stamp));

    NodeFS.rmSync(NodePath.join(stubs.root, "fail"));
    stubs.run({ XDG_RUNTIME_DIR: runtime });
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(stubs.root, "imported"), "utf8"),
      "dummy-claude-token",
    );
    assert.isTrue(NodeFS.existsSync(stamp));
  });
});

describe("ADD_PROJECT_SCRIPT", () => {
  it("adds the checkout once the server answers, on a VM with no database yet", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-add-project-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    const stub = (name: string, body: string) =>
      NodeFS.writeFileSync(NodePath.join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("sqlite3", "exit 1");
    stub("curl", "echo '{}'");
    stub("t3", `echo "$@" > ${NodePath.join(root, "added")}`);
    const result = NodeChildProcess.spawnSync(
      "bash",
      ["-c", `set -e\ndir=/repo\nT3=${NodePath.join(root, "t3")}\n${ADD_PROJECT_SCRIPT}`],
      { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } },
    );

    assert.strictEqual(result.status, 0, result.stderr.toString());
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(root, "added"), "utf8").trim(),
      "project add /repo",
    );
  });
});

describe("prepareWorktreeScript", () => {
  it("cuts the branch from the remote's latest base and records that base", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-worktree-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    const git = (...args: string[]) =>
      NodeChildProcess.spawnSync(
        "git",
        ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        { cwd: root },
      )
        .stdout.toString()
        .trim();
    git("init", "--quiet", "source");
    git("-C", "source", "commit", "--quiet", "--allow-empty", "-m", "base");
    git("clone", "--quiet", "source", "clone");
    // The snapshot's checkout is older than the remote.
    git("-C", "source", "commit", "--quiet", "--allow-empty", "-m", "later");
    const path = NodePath.join(root, "worktrees", "t3-0a1b2c3d");
    const parked = NodePath.join(root, "parked", "repo");
    const result = NodeChildProcess.spawnSync("bash", [
      "-c",
      `set -e\ndir=${NodePath.join(root, "clone")}\n${prepareWorktreeScript({ path, branch: "t3/0a1b2c3d", baseBranch: "main" }, parked)}`,
    ]);

    assert.strictEqual(result.status, 0, result.stderr.toString());
    assert.strictEqual(
      git("-C", path, "rev-parse", "HEAD"),
      git("-C", "source", "rev-parse", "main"),
    );
    assert.strictEqual(git("-C", path, "branch", "--show-current"), "t3/0a1b2c3d");
    assert.strictEqual(git("-C", "clone", "config", "branch.t3/0a1b2c3d.t3-merge-base"), "main");
  });

  it("moves a worktree parked on the base into place and brings it to the latest base", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-parked-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    const git = (...args: string[]) =>
      NodeChildProcess.spawnSync(
        "git",
        ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        { cwd: root },
      )
        .stdout.toString()
        .trim();
    git("init", "--quiet", "source");
    NodeFS.writeFileSync(NodePath.join(root, "source", "file"), "base\n");
    git("-C", "source", "add", "file");
    git("-C", "source", "commit", "--quiet", "-m", "base");
    git("clone", "--quiet", "source", "clone");
    const dir = NodePath.join(root, "clone");
    const parked = NodePath.join(root, "parked", "repo");
    const bash = (script: string) => NodeChildProcess.spawnSync("bash", ["-c", script]);
    const park = bash(`${parkCheckoutFunction}\npark_checkout ${dir} ${parked}`);
    assert.strictEqual(park.status, 0, park.stderr.toString());
    assert.isTrue(NodeFS.existsSync(NodePath.join(parked, "file")));

    // The remote moved on after the VM parked its worktree.
    NodeFS.writeFileSync(NodePath.join(root, "source", "file"), "later\n");
    git("-C", "source", "commit", "--quiet", "-am", "later");
    const path = NodePath.join(root, "worktrees", "t3-0a1b2c3d");
    const result = bash(
      `set -e\ndir=${dir}\n${prepareWorktreeScript({ path, branch: "t3/0a1b2c3d", baseBranch: "main" }, parked)}`,
    );

    assert.strictEqual(result.status, 0, result.stderr.toString());
    assert.isFalse(NodeFS.existsSync(parked));
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(path, "file"), "utf8"), "later\n");
    assert.strictEqual(git("-C", path, "branch", "--show-current"), "t3/0a1b2c3d");
    assert.strictEqual(git("-C", "clone", "config", "branch.t3/0a1b2c3d.t3-merge-base"), "main");
    assert.strictEqual(git("-C", "clone", "config", "branch.t3/0a1b2c3d.t3-boat-parked-base"), "");
    // A second thread finds nothing parked and checks out its own worktree.
    const second = NodePath.join(root, "worktrees", "t3-0b1b2c3d");
    const next = bash(
      `set -e\ndir=${dir}\n${prepareWorktreeScript({ path: second, branch: "t3/0b1b2c3d", baseBranch: "main" }, parked)}`,
    );
    assert.strictEqual(next.status, 0, next.stderr.toString());
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(second, "file"), "utf8"), "later\n");
  });
});

describe("cloneRepositoriesScript", () => {
  it("prints the clones that finished and leaves nothing of one that failed", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-snapshot-clone-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    NodeChildProcess.spawnSync(
      "git",
      ["-c", "init.defaultBranch=main", "init", "--quiet", "source"],
      {
        cwd: root,
      },
    );
    const repository = (name: string, source: string) => ({
      key: `local/me/${name}`,
      name: `me/${name}`,
      cloneUrl: NodePath.join(root, source),
      workspaceRoot: NodePath.join(root, "projects", "me", name),
    });
    const cloned = NodeChildProcess.spawnSync("bash", [
      "-c",
      cloneRepositoriesScript([repository("app", "source"), repository("gone", "missing")]),
    ]);

    assert.strictEqual(cloned.status, 0);
    assert.strictEqual(
      cloned.stdout.toString(),
      `${NodePath.join(root, "projects", "me", "app")}\n`,
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(root, "projects", "me", "app", ".git")));
    assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(root, "projects", "me")), ["app"]);
  });
});

describe("backupScript", () => {
  it("archives the VM's state and workspaces but not its secrets, readable by its owner only", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-backup-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    const home = NodePath.join(root, "home");
    const put = (file: string) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(home, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(home, file), "x");
    };
    put(".t3/userdata/statev2.sqlite");
    put(".t3/userdata/secrets/server-signing-key.bin");
    put(".t3/userdata/logs/server.log");
    put("projects/acme/app/README.md");
    NodeFS.mkdirSync(NodePath.join(root, "bin"));
    NodeFS.writeFileSync(NodePath.join(root, "bin", "systemctl"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const archive = NodePath.join(root, "backup.tar.gz");
    const result = NodeChildProcess.spawnSync(
      "bash",
      ["-c", backupScript.replaceAll(VM_BACKUP_ARCHIVE, archive).replaceAll("/home/user", home)],
      { env: { ...process.env, PATH: `${NodePath.join(root, "bin")}:${process.env.PATH}` } },
    );

    assert.strictEqual(result.status, 0, result.stderr.toString());
    const members = NodeChildProcess.spawnSync("tar", ["-tzf", archive])
      .stdout.toString()
      .split("\n")
      .filter((member) => !member.endsWith("/") && member.length > 0)
      .toSorted();
    assert.deepStrictEqual(members, [".t3/userdata/statev2.sqlite", "projects/acme/app/README.md"]);
    assert.strictEqual(NodeFS.statSync(archive).mode & 0o777, 0o600);
  });
});
