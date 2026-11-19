import {
  CLI_RELEASE_REPOSITORY,
  MACHINE_LABELS,
  MACHINE_NAME,
  NOT_HOSTED_MARKER,
  PAIRING_MARKER,
  backupScript,
  extractSkillsScript,
  idleScript,
  prepareSnapshotScript,
  restoreScript,
  snapshotNameOf,
  startServerScript,
  statsScript,
} from "@t3tools/shared/boatCloudVm";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

/**
 * A dev-only Boat, in memory, answering the HTTP calls Boat cloud makes: Boat's v1 API, the
 * signed file URLs it hands out, and GitHub's latest-release lookup. Nothing leaves this
 * process. VMs have no machine behind them: commands get canned output after a short delay,
 * and the T3 server a VM "runs" is the local one, so a thread opened on it runs here.
 */

export const FAKE_ACCOUNT = "demo@example.com";
export const FAKE_RUNNING_VM = "fakevm-run1";
export const FAKE_STOPPED_VM = "fakevm-stop";
const FAKE_FILES_HOST = "files.fake-boat.invalid";

/** The local T3 server the fake VMs stand in for. */
export interface FakeBoatTarget {
  readonly environmentId: Effect.Effect<string>;
  /** Where clients reach the local server, returned as every VM's hosted port. */
  readonly httpBaseUrl: string;
  /** A fresh pairing code for the local server, as `t3 auth pairing create --json` prints it. */
  readonly issuePairing: Effect.Effect<{ readonly credential: string; readonly expiresAt: string }>;
}

export interface FakeBoatOptions {
  /** The t3 build the fake GitHub calls latest, and the ready snapshot carries. */
  readonly version: string;
  readonly target: FakeBoatTarget;
  /** Multiplies every simulated delay; 0 makes the fake answer at once, as tests want. */
  readonly delayScale?: number;
}

type MachineType = "small" | "default" | "large" | "xlarge";
const MACHINE_SPECS: Record<MachineType, { vcpu: number; memoryGB: number; multiplier: number }> = {
  small: { vcpu: 2, memoryGB: 4, multiplier: 0.5 },
  default: { vcpu: 4, memoryGB: 8, multiplier: 1 },
  large: { vcpu: 8, memoryGB: 16, multiplier: 2 },
  xlarge: { vcpu: 16, memoryGB: 32, multiplier: 4 },
};
/** Dollars per billed second; a default VM is $0.09 an hour. */
const DOLLARS_PER_SECOND = 0.000025;
const DISK_TOTAL_BYTES = 40 * 1024 ** 3;

interface FakeSandbox {
  readonly id: string;
  name: string;
  /** Boat's raw state; `provisioning` and `resuming` become `running` at `readyAt`. */
  state: string;
  readyAt: number;
  type: MachineType;
  labels: Record<string, string>;
  environment: string | null;
  readonly createdAt: string;
  /** Billed seconds before the current run. */
  billedSeconds: number;
  /** When the current run started, null while stopped. */
  runningSince: number | null;
  /** Epoch ms of the last hand-out or checkout, which the idle check counts from. */
  lastActive: number;
  diskUsedBytes: number;
}

interface FakeSnapshot {
  readonly name: string;
  status: string;
  sourceSandboxId: string | null;
  readonly createdAt: string;
  readyAt: number;
}

const machineTypeOf = (value: unknown): MachineType =>
  value === "small" || value === "default" || value === "large" || value === "xlarge"
    ? value
    : "default";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

export const makeFakeBoat = Effect.fn("FakeBoat.make")(function* (options: FakeBoatOptions) {
  const scale = options.delayScale ?? 1;
  const delay = (millis: number) =>
    scale === 0 ? Effect.void : Effect.sleep(Duration.millis(millis * scale));
  /** 1 to 3 seconds by default, as a step on a real VM takes. */
  const stepDelay = (min = 1000, max = 3000) => Effect.flatMap(Random.nextBetween(min, max), delay);

  const startedAt = yield* Clock.currentTimeMillis;
  let nextId = 1;
  const newId = () => `fakevm-${(nextId++).toString(36).padStart(4, "0")}`;

  const sandboxes = new Map<string, FakeSandbox>();
  const addSandbox = (sandbox: FakeSandbox) => sandboxes.set(sandbox.id, sandbox);
  addSandbox({
    id: FAKE_RUNNING_VM,
    name: MACHINE_NAME,
    state: "running",
    readyAt: 0,
    type: "small",
    labels: { ...MACHINE_LABELS },
    environment: "default",
    createdAt: iso(startedAt - 3 * 24 * 3600 * 1000),
    billedSeconds: 2.3 * 3600 * 0.5,
    runningSince: startedAt - 25 * 60 * 1000,
    lastActive: startedAt,
    diskUsedBytes: 9.4 * 1024 ** 3,
  });
  addSandbox({
    id: FAKE_STOPPED_VM,
    name: MACHINE_NAME,
    state: "stopped",
    readyAt: 0,
    type: "default",
    labels: { ...MACHINE_LABELS },
    environment: "default",
    createdAt: iso(startedAt - 9 * 24 * 3600 * 1000),
    billedSeconds: 5.1 * 3600,
    runningSince: null,
    lastActive: startedAt - 2 * 3600 * 1000,
    diskUsedBytes: 14.2 * 1024 ** 3,
  });

  const snapshots = new Map<string, FakeSnapshot>();
  const readySnapshot = snapshotNameOf(options.version, true);
  snapshots.set(readySnapshot, {
    name: readySnapshot,
    status: "ready",
    sourceSandboxId: "fakevm-setup",
    createdAt: iso(startedAt - 24 * 3600 * 1000),
    readyAt: 0,
  });

  const environments = [
    {
      id: "fakeenv-default",
      name: "default",
      isDefault: true,
      passGithub: true,
      passSandboxCredentials: true,
      passSecrets: false,
      passAgentsCredentials: true,
      credentialProfileId: null as string | null,
    },
    {
      id: "fakeenv-codex",
      name: "codex-only",
      isDefault: false,
      passGithub: true,
      passSandboxCredentials: false,
      passSecrets: false,
      passAgentsCredentials: true,
      credentialProfileId: "fakeprofile-codex" as string | null,
    },
  ];
  const profiles = [
    {
      id: "fakeprofile-personal",
      name: "Personal",
      isDefault: true,
      connected: ["claude-subscription", "chatgpt-subscription"],
    },
    { id: "fakeprofile-codex", name: "Codex", isDefault: false, connected: ["openai-api-key"] },
  ];
  /** Bytes put to signed URLs, so a backup downloaded later is what was uploaded. */
  const files = new Map<string, Uint8Array>();

  /** Moves a starting VM to running once its start delay passed. */
  const settle = (sandbox: FakeSandbox, now: number) => {
    if (
      (sandbox.state === "provisioning" || sandbox.state === "resuming") &&
      now >= sandbox.readyAt
    ) {
      sandbox.state = "running";
      sandbox.runningSince = now;
    }
    return sandbox;
  };
  const billedSecondsOf = (sandbox: FakeSandbox, now: number) =>
    sandbox.billedSeconds +
    (sandbox.runningSince === null
      ? 0
      : ((now - sandbox.runningSince) / 1000) * MACHINE_SPECS[sandbox.type].multiplier);
  const stop = (sandbox: FakeSandbox, now: number) => {
    sandbox.billedSeconds = billedSecondsOf(sandbox, now);
    sandbox.runningSince = null;
    sandbox.state = "stopped";
  };
  const listed = (sandbox: FakeSandbox) => ({
    id: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    subdomain: `fake-${sandbox.id}`,
    labels: sandbox.labels,
    environment: sandbox.environment,
    type: sandbox.type,
    vcpu: MACHINE_SPECS[sandbox.type].vcpu,
    memoryGB: MACHINE_SPECS[sandbox.type].memoryGB,
  });

  const pairingJson = options.target.issuePairing.pipe(Effect.map(encodeJson));

  /** A plausible `statsScript` answer that moves between samples. */
  const statsOutput = Effect.fnUntraced(function* (sandbox: FakeSandbox) {
    const { vcpu, memoryGB } = MACHINE_SPECS[sandbox.type];
    const ticks = 100 * vcpu;
    const busyShare = yield* Random.nextBetween(0.04, 0.34);
    const user = Math.round(ticks * busyShare * 0.7);
    const system = Math.round(ticks * busyShare * 0.3);
    const idle = ticks - user - system;
    const base = 1_000_000;
    const memTotalKb = memoryGB * 1024 * 1024;
    const memAvailableKb = Math.round(memTotalKb * (yield* Random.nextBetween(0.45, 0.7)));
    sandbox.diskUsedBytes += Math.round(yield* Random.nextBetween(0, 4 * 1024 * 1024));
    return [
      `cpu  ${base} 0 ${base / 2} ${base * 4} 100 0 50 0`,
      `cpu  ${base + user} 0 ${base / 2 + system} ${base * 4 + idle} 100 0 50 0`,
      String(vcpu),
      `${memTotalKb} ${memAvailableKb}`,
      `${DISK_TOTAL_BYTES} ${Math.round(sandbox.diskUsedBytes)}`,
    ].join("\n");
  });

  /** Canned output for the scripts Boat cloud runs, told apart by what they contain. */
  const runCommand = Effect.fnUntraced(function* (sandbox: FakeSandbox, command: string) {
    const now = yield* Clock.currentTimeMillis;
    if (command.startsWith(startServerScript(null))) {
      yield* stepDelay(1500, 3000);
      sandbox.lastActive = now;
      const descriptor = encodeJson({ environmentId: yield* options.target.environmentId });
      // Not hosted: the holder then asks Boat to host the port, and the fake hands back the local URL.
      const head = `${NOT_HOSTED_MARKER}\n${descriptor}`;
      return command.includes(PAIRING_MARKER)
        ? `${head}\n${PAIRING_MARKER}\n${yield* pairingJson}\n`
        : `${head}\n`;
    }
    // The spare's warm-up stocks a code and parks worktrees in the background on a real VM.
    if (command.includes("flock -n 9")) return "";
    if (command.includes("auth pairing create")) {
      yield* stepDelay(500, 1200);
      return `${yield* pairingJson}\n`;
    }
    if (command.includes("/proc/pressure/cpu")) {
      yield* delay(200);
      const { memoryGB } = MACHINE_SPECS[sandbox.type];
      const memTotalKb = memoryGB * 1024 * 1024;
      const cpu = yield* Random.nextBetween(0.02, 0.12);
      return `${cpu.toFixed(2)} ${memTotalKb} ${Math.round(memTotalKb * 0.7)}\n`;
    }
    if (command === statsScript) {
      yield* delay(1000);
      return `${yield* statsOutput(sandbox)}\n`;
    }
    if (command === idleScript) {
      // No turn runs on a fake VM; it idles from its last hand-out.
      return `0 ${Math.max(0, Math.round((now - sandbox.lastActive) / 1000))}\n`;
    }
    if (command.includes("projection_projects")) {
      // The checkout: fetch, worktree, project.
      yield* stepDelay(1500, 3000);
      sandbox.lastActive = now;
      return "";
    }
    if (command === backupScript || command === restoreScript) {
      yield* stepDelay(1500, 3000);
      return "";
    }
    if (command === extractSkillsScript || command === prepareSnapshotScript) {
      yield* stepDelay(1000, 2000);
      return "";
    }
    // The CLI install and the snapshot's clones.
    yield* stepDelay(2000, 3000);
    return "";
  });

  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const reply = (json: unknown, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(json, { status }));
      const notFound = () => reply({ code: "not_found" }, 404);
      const now = yield* Clock.currentTimeMillis;

      if (url.hostname === "api.github.com") {
        return url.pathname === `/repos/${CLI_RELEASE_REPOSITORY}/releases/latest`
          ? reply({ tag_name: `v${options.version}` })
          : notFound();
      }
      if (url.hostname === FAKE_FILES_HOST) {
        yield* stepDelay(500, 1500);
        if (request.method === "PUT") {
          // Upload bodies are files or streams; their bytes do not matter to a fake VM.
          files.set(url.pathname, new Uint8Array());
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(files.get(url.pathname) ?? new Uint8Array(), { status: 200 }),
        );
      }
      if (url.hostname !== "boat.dev" || !url.pathname.startsWith("/api/v1")) return notFound();

      const path = url.pathname.slice("/api/v1".length);
      const body: Readonly<Record<string, unknown>> =
        request.body._tag === "Uint8Array"
          ? Option.getOrElse(decodeBody(new TextDecoder().decode(request.body.body)), () => ({}))
          : {};
      const method = request.method;

      if (path === "/me") return reply({ user: { login: "demo", email: FAKE_ACCOUNT } });
      if (path === "/limits") {
        return reply({
          machineTypes: [
            { type: "small", available: true },
            { type: "default", available: true },
            { type: "large", available: true },
            { type: "xlarge", available: false, reason: "Not on the demo plan." },
          ],
          overagePrices: { vmHourDollars: DOLLARS_PER_SECOND * 3600 },
          creditSecondsPerDollar: 1 / DOLLARS_PER_SECOND,
        });
      }

      if (path === "/environments") return reply({ environments });
      const environmentMatch = /^\/environments\/([^/]+)$/u.exec(path);
      if (environmentMatch && method === "PUT") {
        const environment = environments.find((candidate) => candidate.id === environmentMatch[1]);
        if (!environment) return notFound();
        for (const key of [
          "passGithub",
          "passSandboxCredentials",
          "passSecrets",
          "passAgentsCredentials",
        ] as const) {
          if (typeof body[key] === "boolean") environment[key] = body[key];
        }
        return reply({ environment });
      }
      if (path === "/credential-profiles") return reply({ profiles });

      if (path === "/saved-snapshots" && method === "GET") {
        return reply({
          snapshots: [...snapshots.values()].map((snapshot) => {
            if (snapshot.status === "saving" && now >= snapshot.readyAt) snapshot.status = "ready";
            return {
              name: snapshot.name,
              status: snapshot.status,
              sourceSandboxId: snapshot.sourceSandboxId,
              createdAt: snapshot.createdAt,
            };
          }),
        });
      }
      if (path === "/saved-snapshots" && method === "POST") {
        const name = String(body.name);
        const existing = snapshots.get(name);
        snapshots.set(name, {
          name,
          status: "saving",
          sourceSandboxId: String(body.sandboxId),
          createdAt: existing?.createdAt ?? iso(now),
          readyAt: now + 3000 * scale,
        });
        return reply({ ok: true });
      }
      const snapshotMatch = /^\/saved-snapshots\/([^/]+)$/u.exec(path);
      if (snapshotMatch && method === "DELETE") {
        return snapshots.delete(decodeURIComponent(snapshotMatch[1]!)) ? reply({}) : notFound();
      }

      if (path === "/sandboxes" && method === "GET") {
        const [labelKey, labelValue] = (url.searchParams.get("label") ?? "").split("=");
        return reply({
          sandboxes: [...sandboxes.values()]
            .filter((sandbox) => !labelKey || sandbox.labels[labelKey] === labelValue)
            .map((sandbox) => listed(settle(sandbox, now))),
        });
      }
      if (path === "/sandboxes" && method === "POST") {
        yield* stepDelay(800, 1500);
        const from = typeof body.from === "string" ? body.from : null;
        if (from !== null && snapshots.get(from)?.status !== "ready") {
          return reply({ code: "snapshot_not_found" }, 404);
        }
        const sandbox: FakeSandbox = {
          id: newId(),
          name: String(body.name ?? "sandbox"),
          state: "provisioning",
          readyAt: now + (yield* Random.nextBetween(1500, 3000)) * scale,
          type: machineTypeOf(body.type),
          labels: (body.labels as Record<string, string> | undefined) ?? {},
          environment: typeof body.environment === "string" ? body.environment : "default",
          createdAt: iso(now),
          billedSeconds: 0,
          runningSince: null,
          lastActive: now,
          diskUsedBytes: 6.1 * 1024 ** 3,
        };
        addSandbox(settle(sandbox, now));
        return reply({ sandbox: listed(sandbox) });
      }

      const sandboxMatch = /^\/sandboxes\/([^/]+)(\/.*)?$/u.exec(path);
      if (!sandboxMatch) return notFound();
      const sandbox = sandboxes.get(sandboxMatch[1]!);
      if (!sandbox) return notFound();
      settle(sandbox, now);
      const action = sandboxMatch[2] ?? "";

      if (action === "" && method === "GET") return reply({ sandbox: listed(sandbox) });
      if (action === "" && method === "PATCH") {
        if (typeof body.name === "string") sandbox.name = body.name;
        return reply({ sandbox: listed(sandbox) });
      }
      if (action === "" && method === "DELETE") {
        sandboxes.delete(sandbox.id);
        return reply({});
      }
      if (action === "/usage") {
        const seconds = billedSecondsOf(sandbox, now);
        return reply({
          sandboxId: sandbox.id,
          sandboxType: sandbox.type,
          billingMultiplier: MACHINE_SPECS[sandbox.type].multiplier,
          since: sandbox.createdAt,
          until: iso(now),
          seconds: Math.round(seconds),
          dollars: Math.round(seconds * DOLLARS_PER_SECOND * 10_000) / 10_000,
          secondsPerDollar: 1 / DOLLARS_PER_SECOND,
          running: sandbox.state === "running",
        });
      }
      if (action === "/resume") {
        if (sandbox.state === "stopped") {
          sandbox.state = "resuming";
          sandbox.readyAt = now + (yield* Random.nextBetween(2000, 3000)) * scale;
          if (body.type !== undefined) sandbox.type = machineTypeOf(body.type);
          settle(sandbox, now);
        }
        return reply({ sandbox: listed(sandbox) });
      }
      if (action === "/stop") {
        yield* stepDelay(500, 1000);
        stop(sandbox, now);
        return reply({});
      }
      if (action === "/host") return reply({ url: options.target.httpBaseUrl });
      if (action === "/files" && method === "PUT") return reply({});
      if (action === "/files/upload-url" || action === "/files/download-url") {
        const filePath = encodeURIComponent(String(body.path));
        return reply({ url: `https://${FAKE_FILES_HOST}/${sandbox.id}/${filePath}` });
      }
      if (action === "/commands") {
        if (sandbox.state !== "running") {
          return reply(
            { code: sandbox.state === "stopped" ? "sandbox_stopped" : "sandbox_starting" },
            409,
          );
        }
        const stdout = yield* runCommand(sandbox, String(body.command));
        return reply({ exitCode: 0, stdout, stderr: "", timedOut: false });
      }
      return notFound();
    }),
  );

  return { http, sandboxes };
});
