import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ROLE_LABEL, SPARE_NAME as SPARE } from "@t3tools/shared/boatCloudVm";
import * as BoatCloud from "./BoatCloudService.ts";
import * as BoatLocalSignIns from "./BoatLocalSignIns.ts";

const ACCOUNT = "me@example.com";

// Boat knows the account and nothing else, so every refresh after the key check fails.
const boatHttp = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      request.url.endsWith("/me")
        ? Response.json({ user: { login: ACCOUNT, email: ACCOUNT } })
        : Response.json({ code: "not_found" }, { status: 404 }),
    ),
  ),
);

const dependencies = Layer.mergeAll(
  ServerSecretStore.layer,
  Layer.succeed(HttpClient.HttpClient, boatHttp),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-boat-cloud-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

interface FakeSandbox {
  state: string;
  environment: string;
  name: string;
}

/**
 * Boat with the given VMs and one ready snapshot. Calls are recorded as `METHOD path`, a
 * command as `exec <sandbox>`, and every body in `bodies`. `onExec` answers commands and
 * `onCall` sees every other call; `answer` replies to one first when it returns a body. A
 * created VM is `vm-new`, and uploads to the signed URL fail.
 */
const fakeBoat = (
  sandboxes: Record<string, FakeSandbox>,
  onExec: (sandboxId: string, script: string) => Effect.Effect<string> = () => Effect.succeed(""),
  onCall: (call: string) => Effect.Effect<void> = () => Effect.void,
  answer: (call: string) => unknown = () => undefined,
) => {
  const calls: Array<string> = [];
  const bodies: Array<unknown> = [];
  const listed = (id: string) => ({
    id,
    subdomain: `box-${id}`,
    labels: { t3code: "cloud", [ROLE_LABEL]: sandboxes[id]!.name === SPARE ? "spare" : "thread" },
    ...sandboxes[id]!,
  });
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      const reply = (json: unknown, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(json, { status }));
      if (url.host !== "boat.dev") {
        calls.push(`${request.method} ${url.href}`);
        return reply({ code: "storage_failed" }, 500);
      }
      const path = url.pathname.replace("/api/v1", "");
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
          : {};
      const id = /^\/sandboxes\/([^/]+)/u.exec(path)?.[1] ?? "";
      if (path.endsWith("/commands")) {
        calls.push(`exec ${id}`);
        const stdout = yield* onExec(id, String(body.command));
        return reply({ exitCode: 0, stdout });
      }
      const query = UrlParams.toString(request.urlParams);
      calls.push(`${request.method} ${path}${query === "" ? "" : `?${query}`}`);
      if (request.body._tag === "Uint8Array") bodies.push(body);
      yield* onCall(`${request.method} ${path}`);
      const answered = answer(`${request.method} ${path}`);
      if (answered !== undefined) return reply(answered);
      if (path === "/me") return reply({ user: { email: ACCOUNT } });
      if (path === "/saved-snapshots") {
        return reply({
          snapshots: [{ name: "t3-code-0-1-9", status: "ready", createdAt: "2026-11-01" }],
        });
      }
      if (path === "/environments") return reply({ environments: [] });
      if (path === "/limits") {
        return reply({
          machineTypes: [
            { type: "small", available: true, reason: null },
            { type: "xlarge", available: false, reason: "needs the $100/month plan or higher" },
          ],
          overagePrices: { vmHourDollars: 0.036 },
          creditSecondsPerDollar: 100000,
        });
      }
      if (path.endsWith("/usage")) {
        return reply({
          ok: true,
          sandboxId: id,
          sandboxType: "default",
          billingMultiplier: 1,
          since: "2026-11-18T00:00:00.000Z",
          until: "2026-11-18T01:00:00.000Z",
          seconds: 3600,
          dollars: 0.036,
          running: true,
        });
      }
      if (path === "/credential-profiles") return reply({ profiles: [] });
      if (path === "/sandboxes" && request.method === "POST") {
        sandboxes["vm-new"] = {
          state: "ready",
          environment: String(body.environment ?? "base"),
          name: String(body.name),
        };
        return reply({ sandbox: listed("vm-new") });
      }
      if (path === "/sandboxes") return reply({ sandboxes: Object.keys(sandboxes).map(listed) });
      if (path.endsWith("/upload-url")) return reply({ url: "https://files.example/upload" });
      if (path.endsWith("/stop")) sandboxes[id]!.state = "stopped";
      if (request.method === "DELETE") delete sandboxes[id];
      if (path === `/sandboxes/${id}` && request.method === "GET") {
        return sandboxes[id] ? reply({ sandbox: listed(id) }) : reply({ code: "not_found" }, 404);
      }
      return reply({});
    }),
  );
  return { http, calls, bodies };
};

/** A Boat environment whose credential profile signs no agent in. */
const noSignInEnvironment = {
  id: "env-base",
  name: "base",
  isDefault: true,
  passGithub: true,
  passSandboxCredentials: false,
  passSecrets: false,
  passAgentsCredentials: true,
  credentialProfileId: null,
};
const noSignInProfile = { id: "p1", name: "default", isDefault: true, connected: [] };

const OLD_HAND_OUT = "1960-01-01T00:00:00.000Z";
const storedMachine = (sandboxId: string, environmentId: string | null, environment: string) => ({
  sandboxId,
  environmentId,
  label: sandboxId,
  httpBaseUrl: null,
  state: "running",
  repositories: [],
  backedUpAt: null,
  acquiredAt: OLD_HAND_OUT as string | null,
  environment,
});

/** Writes the registry and the key a holder had before this server started. */
const seed = (
  machines: ReadonlyArray<ReturnType<typeof storedMachine>>,
  extra: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(config.stateDir, "boat-cloud");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, "state.json"),
      JSON.stringify({ account: ACCOUNT, machines, environment: "base", ...extra }),
    );
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set("boat-cloud-api-key", new TextEncoder().encode("boat_test"));
    return directory;
  });

const withService = <A, E, R>(
  http: HttpClient.HttpClient,
  use: (service: BoatCloud.BoatCloudService["Service"]) => Effect.Effect<A, E, R>,
  signIns: Layer.Layer<BoatLocalSignIns.BoatLocalSignIns> = BoatLocalSignIns.layerStatic(false),
) =>
  Effect.flatMap(Effect.service(BoatCloud.BoatCloudService), use).pipe(
    Effect.provide(
      BoatCloud.layer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Layer.provide(signIns),
      ),
    ),
  );

it.layer(dependencies)("BoatCloudService", (it) => {
  it.effect("never stops a VM a start picked while the idle sweep probed it", () =>
    Effect.gen(function* () {
      yield* seed([storedMachine("vm-1", null, "base"), storedMachine("vm-2", null, "other")], {
        shareMachines: true,
      });
      const measured = yield* Deferred.make<void>();
      const measureAnswers = yield* Deferred.make<void>();
      const otherStopped = yield* Deferred.make<void>();
      const boat = fakeBoat(
        {
          "vm-1": { state: "ready", environment: "base", name: "Boat cloud" },
          "vm-2": { state: "ready", environment: "other", name: "Boat cloud" },
        },
        (_sandboxId, script) => {
          if (script.includes("/proc/loadavg")) {
            return Deferred.succeed(measured, undefined).pipe(
              Effect.andThen(Deferred.await(measureAnswers)),
              Effect.as("0.1 1000 900\n"),
            );
          }
          if (script.includes("systemctl --user start t3code.service")) {
            return Effect.succeed(
              `${JSON.stringify({ environmentId: "env-1" })}\n--- t3 pairing ---\n${JSON.stringify({ credential: "code", expiresAt: "2999-01-01T00:00:00.000Z" })}`,
            );
          }
          // Both VMs are idle, so the sweep stops each one no start holds.
          if (script.includes("deleted_at IS NULL")) return Effect.succeed("0 1\n");
          return Effect.succeed("");
        },
        (call) =>
          call === "POST /sandboxes/vm-2/stop"
            ? Deferred.succeed(otherStopped, undefined).pipe(Effect.asVoid)
            : Effect.void,
      );

      const session = yield* withService(boat.http, (service) =>
        Effect.gen(function* () {
          // Requests time out on the test clock too, so the start begins halfway to the sweep.
          yield* TestClock.adjust(Duration.seconds(30));
          const acquiring = yield* Effect.forkChild(
            service.acquire({ requestId: "start-1", repositoryUrl: "https://github.com/acme/app" }),
          );
          yield* Deferred.await(measured);
          yield* TestClock.adjust(Duration.seconds(30));
          // The sweep takes vm-1 before vm-2, so this stop means it is past vm-1.
          yield* Deferred.await(otherStopped);
          yield* Deferred.succeed(measureAnswers, undefined);
          return yield* Fiber.join(acquiring);
        }),
      );

      assert.strictEqual(session.sandboxId, "vm-1");
      assert.notInclude(boat.calls, "POST /sandboxes/vm-1/stop");
    }),
  );

  it.effect(
    "deletes a VM it rebuilt when the backup does not reach it, and keeps the old one",
    () =>
      Effect.gen(function* () {
        const directory = yield* seed([storedMachine("vm-old", "env-restore", "base")]);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(directory, "backups"), { recursive: true });
        yield* fs.writeFileString(path.join(directory, "backups", "env-restore.tar.gz"), "backup");
        const boat = fakeBoat({});

        const error = yield* withService(boat.http, (service) =>
          Effect.flip(service.wake({ environmentId: EnvironmentId.make("env-restore") })),
        );

        assert.strictEqual(error._tag, "BoatCloudError");
        assert.include(boat.calls, "POST /sandboxes");
        assert.include(boat.calls, "PUT https://files.example/upload");
        assert.include(boat.calls, "DELETE /sandboxes/vm-new");
        const stored = JSON.parse(yield* fs.readFileString(path.join(directory, "state.json")));
        assert.deepStrictEqual(
          stored.machines.map((machine: { sandboxId: string; state: string }) => [
            machine.sandboxId,
            machine.state,
          ]),
          [["vm-old", "gone"]],
        );
      }),
  );

  it.effect("edits the root environment one item at a time and never reads a secret back", () =>
    Effect.gen(function* () {
      yield* seed([]);
      const environment = {
        id: "env-base",
        name: "base",
        isDefault: true,
        safeForThirdParties: false,
        passGithub: true,
        passSandboxCredentials: true,
        passSecrets: true,
        passAgentsCredentials: true,
        latestVersionNumber: 4,
        envContents: "OLD_TOKEN=sk_old_secret\nexport REGION=eu\n",
        secretFiles: [{ path: ".env", contents: "DATABASE_URL=postgres://secret" }],
        selectedRepositories: [{ databaseId: "repo_9", fullName: "acme/old", baseBranch: "main" }],
        versions: [{ versionNumber: 4, sandboxCount: 2, createdAt: "2026-11-01T00:00:00Z" }],
      };
      const boat = fakeBoat({}, undefined, undefined, (call) => {
        if (call === "GET /environments") return { environments: [environment] };
        if (call === "GET /repos") {
          return {
            installations: [{ repositories: [{ databaseId: "repo_1", fullName: "Acme/App" }] }],
          };
        }
        if (call === "POST /environments/env-base/upgrade") return { upgraded: 2, failed: 0 };
        return undefined;
      });

      const updated = yield* withService(boat.http, (service) =>
        service.updateRootEnvironment({
          passSecrets: false,
          setVariables: [{ key: "API_KEY", value: "sk_live_new_secret" }],
          removeVariables: ["OLD_TOKEN"],
          setSecretFiles: [{ path: "app/.env", contents: "STRIPE=sk_file_secret" }],
          removeSecretFiles: [".env"],
          addRepositories: [{ repository: "acme/app", baseBranch: "dev" }],
          removeRepositories: ["acme/old"],
          upgradeMachines: true,
        }),
      );

      const edits = boat.calls.filter(
        (call) =>
          call.includes("/environments/") ||
          (call.startsWith("GET /repos") && !call.endsWith("limit=1")),
      );
      assert.deepStrictEqual(edits, [
        "PUT /environments/env-base",
        "PUT /environments/env-base/vars/API_KEY",
        "DELETE /environments/env-base/vars/OLD_TOKEN",
        "PUT /environments/env-base/secret-files",
        "DELETE /environments/env-base/secret-files?path=.env",
        "GET /repos?sync=true&q=app&limit=200",
        "POST /environments/env-base/repos",
        "DELETE /environments/env-base/repos/repo_9",
        "POST /environments/env-base/upgrade",
      ]);
      assert.deepInclude(boat.bodies, { passSecrets: false });
      assert.deepInclude(boat.bodies, { value: "sk_live_new_secret" });
      assert.deepInclude(boat.bodies, { repositoryId: "repo_1", baseBranch: "dev" });
      assert.deepStrictEqual(updated.upgraded, { machines: 2, failed: 0 });
      assert.deepStrictEqual(updated.rootEnvironment.variables, ["OLD_TOKEN", "REGION"]);
      assert.deepStrictEqual(updated.rootEnvironment.secretFiles, [".env"]);
      const shown = JSON.stringify(updated);
      for (const secret of ["sk_old_secret", "postgres://secret", "sk_live_new_secret"]) {
        assert.notInclude(shown, secret);
      }
    }),
  );

  it.effect("deletes a running VM it manages only with force, keeping it restorable", () =>
    Effect.gen(function* () {
      const directory = yield* seed([storedMachine("vm-1", "env-1", "base")]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const backup = path.join(directory, "backups", "env-1.tar.gz");
      yield* fs.makeDirectory(path.join(directory, "backups"), { recursive: true });
      yield* fs.writeFileString(backup, "backup");
      const boat = fakeBoat({
        "vm-1": { state: "ready", environment: "base", name: "Boat cloud" },
        "vm-other": { state: "ready", environment: "base", name: SPARE },
      });

      const { unforced, unmanaged, status } = yield* withService(boat.http, (service) =>
        Effect.gen(function* () {
          const unforced = yield* Effect.flip(
            service.deleteMachine({ sandboxId: "vm-1", force: false }),
          );
          const unmanaged = yield* Effect.flip(
            service.deleteMachine({ sandboxId: "vm-other", force: true }),
          );
          yield* service.deleteMachine({ sandboxId: "vm-1", force: true });
          return { unforced, unmanaged, status: (yield* service.inspect).status };
        }),
      );

      assert.include(unforced.message, "force: true");
      assert.include(unmanaged.message, "does not manage");
      assert.deepStrictEqual(
        boat.calls.filter((call) => call.startsWith("DELETE")),
        ["DELETE /sandboxes/vm-1"],
      );
      assert.deepStrictEqual(
        status.machines.map((machine) => [machine.sandboxId, machine.state]),
        [["vm-1", "gone"]],
      );
      assert.isTrue(yield* fs.exists(backup));
    }),
  );

  it.effect("reports connected when the key belongs to the account it already knows", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(config.stateDir, "boat-cloud");
      yield* fs.makeDirectory(directory, { recursive: true });
      // A disconnect keeps the account, so a reconnect finds it already recorded.
      yield* fs.writeFileString(
        path.join(directory, "state.json"),
        JSON.stringify({ account: ACCOUNT, machines: [], environment: "base" }),
      );

      const status = yield* Effect.gen(function* () {
        const boatCloud = yield* BoatCloud.BoatCloudService;
        return yield* boatCloud.connect({ apiKey: "boat_test" });
      }).pipe(
        Effect.provide(BoatCloud.layer.pipe(Layer.provide(BoatLocalSignIns.layerStatic(false)))),
      );

      assert.isTrue(status.connected);
      assert.strictEqual(status.account, ACCOUNT);
    }),
  );

  it.effect("with one job per VM, gives a new thread its own VM at the asked size", () =>
    Effect.gen(function* () {
      const directory = yield* seed([storedMachine("vm-1", "env-1", "base")]);
      const created: Array<unknown> = [];
      const boat = fakeBoat(
        { "vm-1": { state: "ready", environment: "base", name: "Boat cloud" } },
        (_sandboxId, script) =>
          script.includes("systemctl --user start t3code.service")
            ? Effect.succeed(
                `${JSON.stringify({ environmentId: "env-new" })}\n--- t3 pairing ---\n${JSON.stringify({ credential: "code", expiresAt: "2999-01-01T00:00:00.000Z" })}`,
              )
            : Effect.succeed(""),
      );
      const wrapped = HttpClient.make((request) => {
        if (request.method === "POST" && new URL(request.url).pathname === "/api/v1/sandboxes") {
          const body = request.body;
          if (body._tag === "Uint8Array")
            created.push(JSON.parse(new TextDecoder().decode(body.body)));
        }
        return boat.http.execute(request);
      });

      const session = yield* withService(wrapped, (service) =>
        service.acquire({
          requestId: "start-1",
          repositoryUrl: "https://github.com/acme/app",
          machineType: "large",
        }),
      );

      assert.strictEqual(session.sandboxId, "vm-new");
      assert.notInclude(boat.calls, "exec vm-1");
      assert.strictEqual((created[0] as { type: string }).type, "large");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stored = JSON.parse(yield* fs.readFileString(path.join(directory, "state.json")));
      const vm = stored.machines.find(
        (machine: { sandboxId: string }) => machine.sandboxId === "vm-new",
      );
      assert.strictEqual(vm.handOuts, 1);
    }),
  );

  it.effect("keeps the machine settings and publishes them", () =>
    Effect.gen(function* () {
      const directory = yield* seed([]);
      const boat = fakeBoat({});
      const status = yield* withService(boat.http, (service) =>
        service.configureMachines({ shareMachines: true, defaultMachineType: "default" }),
      );
      assert.isTrue(status.shareMachines);
      assert.strictEqual(status.defaultMachineType, "default");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stored = JSON.parse(yield* fs.readFileString(path.join(directory, "state.json")));
      assert.isTrue(stored.shareMachines);
      assert.strictEqual(stored.defaultMachineType, "default");
    }),
  );

  it.effect("refuses a start before making a VM when no sign-in reaches it", () =>
    Effect.gen(function* () {
      yield* seed([]);
      const boat = fakeBoat({}, undefined, undefined, (call) => {
        if (call === "GET /environments") return { environments: [noSignInEnvironment] };
        if (call === "GET /credential-profiles") return { profiles: [noSignInProfile] };
        return undefined;
      });
      const error = yield* withService(boat.http, (service) =>
        Effect.flip(
          service.acquire({ requestId: "start-1", repositoryUrl: "https://github.com/acme/app" }),
        ),
      );
      assert.include(error.message, "has a Claude or ChatGPT sign-in");
      assert.notInclude(boat.calls, "POST /sandboxes");

      // This machine's own sign-ins count, but not once they are turned off.
      const commands: Array<string> = [];
      const signedIn = fakeBoat(
        {},
        (_sandboxId, script) => {
          commands.push(script);
          return Effect.succeed(
            script.includes("systemctl --user start t3code.service")
              ? `${JSON.stringify({ environmentId: "env-new" })}\n--- t3 pairing ---\n${JSON.stringify({ credential: "code", expiresAt: "2999-01-01T00:00:00.000Z" })}`
              : "",
          );
        },
        undefined,
        (call) => {
          if (call === "GET /environments") return { environments: [noSignInEnvironment] };
          if (call === "GET /credential-profiles") return { profiles: [noSignInProfile] };
          return undefined;
        },
      );
      const { session, refused } = yield* withService(
        signedIn.http,
        (service) =>
          Effect.gen(function* () {
            const session = yield* service.acquire({
              requestId: "start-2",
              repositoryUrl: "https://github.com/acme/app",
            });
            yield* service.configureMachines({ useLocalSignIns: false });
            const refused = yield* Effect.flip(
              service.acquire({
                requestId: "start-3",
                repositoryUrl: "https://github.com/acme/app",
              }),
            );
            return { session, refused };
          }),
        BoatLocalSignIns.layerStatic(true),
      );
      assert.strictEqual(session.sandboxId, "vm-new");
      assert.isTrue(commands.some((command) => command.includes("fake-claude-token")));
      assert.include(refused.message, "has a Claude or ChatGPT sign-in");
    }),
  );

  it.effect("deletes the ready spare once keeping one is turned off", () =>
    Effect.gen(function* () {
      yield* seed([], { keepReadyMachine: true });
      const boat = fakeBoat({
        "vm-spare": { state: "ready", environment: "base", name: SPARE },
      });
      const status = yield* withService(boat.http, (service) =>
        service.configureMachines({ keepReadyMachine: false }),
      );
      assert.isFalse(status.keepReadyMachine);
      assert.include(boat.calls, "DELETE /sandboxes/vm-spare");
    }),
  );

  it.effect("deletes a spare left from before when no ready machine is kept", () =>
    Effect.gen(function* () {
      yield* seed([]);
      const deleted = yield* Deferred.make<void>();
      const boat = fakeBoat(
        { "vm-spare": { state: "ready", environment: "base", name: SPARE } },
        undefined,
        (call) =>
          call === "DELETE /sandboxes/vm-spare"
            ? Deferred.succeed(deleted, undefined)
            : Effect.void,
      );
      yield* withService(boat.http, (service) =>
        Effect.raceFirst(Stream.runDrain(service.subscribe), Deferred.await(deleted)),
      );
      assert.include(boat.calls, "DELETE /sandboxes/vm-spare");
    }),
  );

  it.effect("reads Boat's cost and the VM's load once a client watches", () =>
    Effect.gen(function* () {
      yield* seed([{ ...storedMachine("vm-1", "env-1", "base"), acquiredAt: null }], {
        shareMachines: false,
      });
      const boat = fakeBoat(
        { "vm-1": { state: "ready", environment: "base", name: "Boat cloud" } },
        (_sandboxId, script) =>
          Effect.succeed(
            script.includes("/proc/stat")
              ? "cpu 100 0 100 800 0 0 0 0\ncpu 130 0 120 850 0 0 0 0\n4\n8000000 6000000\n1000 250\n"
              : "",
          ),
      );
      const status = yield* withService(boat.http, (service) =>
        service.subscribe.pipe(
          Stream.filter(
            (status) =>
              status.environmentUsage[0]?.usageUpdatedAt !== null &&
              status.environmentUsage[0]?.stats !== null &&
              status.machineTypes[0]?.hourlyDollars !== null,
          ),
          Stream.take(1),
          Stream.runHead,
        ),
      );
      const usage = Option.getOrThrow(status).environmentUsage[0]!;
      assert.strictEqual(usage.environmentId, "env-1");
      assert.strictEqual(usage.dollars, 0.036);
      assert.strictEqual(usage.hours, 1);
      assert.strictEqual(usage.machineType, "default");
      assert.strictEqual(usage.vcpu, 4);
      // Recorded before hand-outs were counted, so its figure may be shared.
      assert.isTrue(usage.shared);
      assert.strictEqual(usage.stats?.cpuPercent, 50);
      assert.strictEqual(usage.stats?.diskUsedBytes, 250);
      const types = Option.getOrThrow(status).machineTypes;
      assert.deepStrictEqual(
        types.map((type) => [type.id, type.hourlyDollars, type.priceSource, type.available]),
        [
          ["small", 0.018, "derived", true],
          ["default", 0.036, "boat", true],
          ["large", 0.072, "derived", true],
          ["xlarge", 0.036 * (0.2 / 0.036), "derived", false],
        ],
      );
    }),
  );
});

describe("environmentUsageOf", () => {
  const usage = (seconds: number, dollars: number, updatedAt: string) => ({
    seconds,
    dollars,
    updatedAt,
  });
  const machine = {
    ...storedMachine("vm-2", "env-1", "base"),
    state: "running" as const,
    environmentId: EnvironmentId.make("env-1"),
    machineType: "small",
    vcpu: 2,
    memoryGB: 4,
    usage: usage(1800, 0.009, "2026-11-19T00:01:00.000Z"),
    handOuts: 1,
  };

  it("sums every VM an environment was restored onto, and marks a VM two starts shared", () => {
    const [entry] = BoatCloud.environmentUsageOf(
      [machine],
      [
        {
          sandboxId: "vm-1",
          environmentId: EnvironmentId.make("env-1"),
          machineType: "small",
          usage: usage(3600, 0.018, "2026-11-19T00:00:00.000Z"),
        },
      ],
      new Map(),
    );
    assert.strictEqual(entry?.seconds, 5400);
    assert.strictEqual(entry?.dollars, 0.027);
    assert.strictEqual(entry?.machines, 2);
    assert.strictEqual(entry?.usageUpdatedAt, "2026-11-19T00:00:00.000Z");
    assert.isFalse(entry?.shared);
    assert.isTrue(
      BoatCloud.environmentUsageOf([{ ...machine, handOuts: 2 }], [], new Map())[0]?.shared,
    );
  });

  it("lists no environment for a VM no thread was handed", () => {
    assert.deepStrictEqual(
      BoatCloud.environmentUsageOf([{ ...machine, environmentId: null }], [], new Map()),
      [],
    );
  });
});
