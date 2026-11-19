import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as BoatCloud from "./BoatCloudService.ts";

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
 * command as `exec <sandbox>`. `onExec` answers commands and `onCall` sees every other call;
 * a created VM is `vm-new`, and uploads to the signed URL fail.
 */
const fakeBoat = (
  sandboxes: Record<string, FakeSandbox>,
  onExec: (sandboxId: string, script: string) => Effect.Effect<string> = () => Effect.succeed(""),
  onCall: (call: string) => Effect.Effect<void> = () => Effect.void,
) => {
  const calls: Array<string> = [];
  const listed = (id: string) => ({ id, subdomain: `box-${id}`, ...sandboxes[id]! });
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
      calls.push(`${request.method} ${path}`);
      yield* onCall(`${request.method} ${path}`);
      if (path === "/me") return reply({ user: { email: ACCOUNT } });
      if (path === "/saved-snapshots") {
        return reply({
          snapshots: [{ name: "t3-code-0-1-9", status: "ready", createdAt: "2026-11-01" }],
        });
      }
      if (path === "/environments") return reply({ environments: [] });
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
  return { http, calls };
};

const OLD_HAND_OUT = "1960-01-01T00:00:00.000Z";
const storedMachine = (sandboxId: string, environmentId: string | null, environment: string) => ({
  sandboxId,
  environmentId,
  label: sandboxId,
  httpBaseUrl: null,
  state: "running",
  repositories: [],
  backedUpAt: null,
  acquiredAt: OLD_HAND_OUT,
  environment,
});

/** Writes the registry and the key a holder had before this server started. */
const seed = (machines: ReadonlyArray<ReturnType<typeof storedMachine>>) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(config.stateDir, "boat-cloud");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, "state.json"),
      JSON.stringify({ account: ACCOUNT, machines, environment: "base" }),
    );
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set("boat-cloud-api-key", new TextEncoder().encode("boat_test"));
    return directory;
  });

const withService = <A, E, R>(
  http: HttpClient.HttpClient,
  use: (service: BoatCloud.BoatCloudService["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(Effect.service(BoatCloud.BoatCloudService), use).pipe(
    Effect.provide(BoatCloud.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))),
  );

it.layer(dependencies)("BoatCloudService", (it) => {
  it.effect("never stops a VM a start picked while the idle sweep probed it", () =>
    Effect.gen(function* () {
      yield* seed([storedMachine("vm-1", null, "base"), storedMachine("vm-2", null, "other")]);
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
          if (script.includes("${active:-0}")) return Effect.succeed("0\n");
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
      }).pipe(Effect.provide(BoatCloud.layer));

      assert.isTrue(status.connected);
      assert.strictEqual(status.account, ACCOUNT);
    }),
  );
});
