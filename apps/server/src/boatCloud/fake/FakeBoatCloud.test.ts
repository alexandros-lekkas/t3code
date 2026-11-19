import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as BoatCloud from "../BoatCloudService.ts";
import { FAKE_ACCOUNT, FAKE_RUNNING_VM, FAKE_STOPPED_VM } from "./FakeBoat.ts";
import * as FakeBoatCloud from "./FakeBoatCloud.ts";

const LOCAL_URL = "http://localhost:5733";
const LOCAL_ROOT = "/local/checkouts/t3code";

const layerLocal = Layer.succeed(
  FakeBoatCloud.FakeBoatLocal,
  FakeBoatCloud.FakeBoatLocal.of({
    target: {
      environmentId: Effect.succeed("env-local"),
      httpBaseUrl: LOCAL_URL,
      issuePairing: Effect.succeed({
        credential: "LOCALPAIRCODE",
        expiresAt: "2999-01-01T00:00:00.000Z",
      }),
    },
    workspaceRootOf: (key) =>
      Effect.succeed(key === "github.com/pingdotgg/t3code" ? LOCAL_ROOT : null),
  }),
);

/** A dev server's config: only one with a dev URL takes the fake. */
const layerDevConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, devUrl: new URL(LOCAL_URL) })),
).pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-boat-fake-test-" })));

// The real service must never reach Boat in these tests.
const unreachableHttp = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(request, Response.json({ code: "offline" }, { status: 503 })),
  ),
);

const dependencies = (env: Record<string, string>) =>
  Layer.mergeAll(
    ServerSecretStore.layer,
    Layer.succeed(HttpClient.HttpClient, unreachableHttp),
  ).pipe(
    Layer.provideMerge(layerDevConfig),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

const firstStatus = Effect.gen(function* () {
  const boat = yield* BoatCloud.BoatCloudService;
  const statuses = yield* boat.subscribe.pipe(Stream.take(1), Stream.runCollect);
  return [...statuses][0]!;
});

it("takes the fake only on a dev server with the env var set", () => {
  const devUrl = new URL(LOCAL_URL);
  assert.isTrue(FakeBoatCloud.fakeBoatCloudEnabled("1", devUrl));
  assert.isTrue(FakeBoatCloud.fakeBoatCloudEnabled("true", devUrl));
  assert.isFalse(FakeBoatCloud.fakeBoatCloudEnabled("1", undefined));
  assert.isFalse(FakeBoatCloud.fakeBoatCloudEnabled("0", devUrl));
});

it.live("uses the real service when the env var is unset", () =>
  firstStatus.pipe(
    Effect.map((status) => {
      assert.isFalse(status.connected);
      assert.isNull(status.account);
    }),
    Effect.provide(FakeBoatCloud.layerWith(layerLocal).pipe(Layer.provide(dependencies({})))),
  ),
);

it.live.each([
  { seed: undefined, states: [] },
  { seed: "1", states: ["running", "stopped"] },
])(
  "uses the fake, connected to a demo account, when the env var is set (seed $seed)",
  ({ seed, states }) =>
    firstStatus.pipe(
      Effect.map((status) => {
        assert.isTrue(status.connected);
        assert.strictEqual(status.account, FAKE_ACCOUNT);
        assert.deepStrictEqual(
          status.machines.map((machine) => machine.state),
          states,
        );
      }),
      Effect.provide(
        FakeBoatCloud.layerWith(layerLocal).pipe(
          Layer.provide(
            dependencies({
              [FakeBoatCloud.FAKE_ENV_VAR]: "1",
              ...(seed ? { [FakeBoatCloud.FAKE_SEED_ENV_VAR]: seed } : {}),
            }),
          ),
        ),
      ),
    ),
);

it.live("acquires a fake VM through its steps and hands out this server", () =>
  Effect.gen(function* () {
    const boat = yield* BoatCloud.BoatCloudService;
    const session = yield* boat.acquire({
      requestId: "fake-start",
      repositoryUrl: "https://github.com/pingdotgg/t3code.git",
    });
    assert.strictEqual(session.environmentId, "env-local");
    assert.strictEqual(session.httpBaseUrl, LOCAL_URL);
    assert.strictEqual(session.pairingCode, "LOCALPAIRCODE");
    assert.strictEqual(session.workspaceRoot, LOCAL_ROOT);
    assert.isNull(session.worktree ?? null);

    // The start stays listed a while, and watching the status reads each VM's cost and load.
    const watched = yield* boat.subscribe.pipe(
      Stream.filter((status) =>
        status.machines.some(
          (machine) =>
            machine.sandboxId === FAKE_RUNNING_VM &&
            machine.usage !== null &&
            machine.stats !== null,
        ),
      ),
      Stream.take(1),
      Stream.runCollect,
    );
    const status = [...watched][0]!;
    const steps = status.starts
      .filter((start) => start.requestId === "fake-start")
      .flatMap((start) => start.steps)
      .filter((step) => step.state === "done")
      .map((step) => step.step);
    assert.include(steps, "machine");
    assert.include(steps, "server");
    const running = status.machines.find((machine) => machine.sandboxId === FAKE_RUNNING_VM);
    assert.isAbove(running?.usage?.dollars ?? 0, 0);
    assert.isAbove(running?.stats?.cpuPercent ?? 0, 0);

    // A repository with no local checkout has nowhere to run here.
    const missing = yield* boat
      .acquire({ requestId: "fake-missing", repositoryUrl: "https://github.com/acme/elsewhere" })
      .pipe(Effect.flip);
    assert.include(missing.message, "Fake Boat");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      FakeBoatCloud.layerFake({ delayScale: 0, seed: true }).pipe(
        Layer.provide(layerLocal),
        Layer.provide(dependencies({})),
      ),
    ),
  ),
);

it.live("rebuilds the snapshot and wakes the stopped VM", () =>
  Effect.gen(function* () {
    const boat = yield* BoatCloud.BoatCloudService;
    yield* boat.runSetup({});
    const setup = yield* boat.subscribe.pipe(
      Stream.filter((status) => status.setup.status !== "running"),
      Stream.take(1),
      Stream.runCollect,
    );
    assert.strictEqual([...setup][0]!.setup.status, "ready");

    const woken = yield* boat.wake({ environmentId: EnvironmentId.make("fake-boat-env-stop") });
    assert.strictEqual(woken.sandboxId, FAKE_STOPPED_VM);
    assert.strictEqual(woken.environmentId, "env-local");
    assert.strictEqual(woken.httpBaseUrl, LOCAL_URL);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      FakeBoatCloud.layerFake({ delayScale: 0, seed: true }).pipe(
        Layer.provide(layerLocal),
        Layer.provide(dependencies({})),
        // Setup copies the home's skills; this home has none.
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/nonexistent-home")),
      ),
    ),
  ),
);

it.live("edits the root environment, then stops, wakes and deletes a VM", () =>
  Effect.gen(function* () {
    const boat = yield* BoatCloud.BoatCloudService;
    const updated = yield* boat.updateRootEnvironment({
      setVariables: [{ key: "API_KEY", value: "sk_fake_secret" }],
      setSecretFiles: [{ path: ".env", contents: "A=sk_fake_file" }],
      addRepositories: [{ repository: "demo/app" }],
    });
    assert.deepStrictEqual(updated.rootEnvironment.variables, ["API_KEY"]);
    assert.deepStrictEqual(updated.rootEnvironment.secretFiles, [".env"]);
    assert.deepStrictEqual(updated.rootEnvironment.repositories, [
      { repository: "demo/app", baseBranch: "main" },
    ]);
    assert.notInclude(JSON.stringify(yield* boat.inspect), "sk_fake");

    const stopped = yield* boat.stopMachine(FAKE_RUNNING_VM);
    assert.strictEqual(stopped.state, "stopped");
    const woken = yield* boat.wakeMachine(FAKE_RUNNING_VM);
    assert.strictEqual(woken.state, "running");
    yield* boat.deleteMachine({ sandboxId: FAKE_STOPPED_VM, force: false });
    const status = yield* boat.refreshUsage;
    assert.notInclude(
      status.machines.filter((machine) => machine.state !== "gone").map((m) => m.sandboxId),
      FAKE_STOPPED_VM,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      FakeBoatCloud.layerFake({ delayScale: 0, seed: true }).pipe(
        Layer.provide(layerLocal),
        Layer.provide(dependencies({})),
      ),
    ),
  ),
);
