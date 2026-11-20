import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MACHINE_LABELS,
  machineNameOf,
  ROLE_LABEL,
  SETUP_LABELS,
  SPARE_NAME,
} from "@t3tools/shared/boatCloudVm";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as BoatCloud from "./BoatCloudService.ts";
import * as BoatLocalSignIns from "./BoatLocalSignIns.ts";
import { FAKE_ACCOUNT, makeFakeBoat } from "./fake/FakeBoat.ts";

/**
 * The lease every VM gets on Boat, its renewal, and the reaping of VMs nothing needs, run
 * against the in-memory Boat on the test clock, which the tests here share.
 */

const offline = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(request, Response.json({ code: "offline" }, { status: 503 })),
  ),
);

const dependencies = Layer.mergeAll(
  ServerSecretStore.layer,
  Layer.succeed(HttpClient.HttpClient, offline),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-boat-lease-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const fakeBoat = makeFakeBoat({
  version: "0.1.11",
  delayScale: 0,
  target: {
    environmentId: Effect.succeed("env-vm"),
    httpBaseUrl: "http://vm.invalid",
    issuePairing: Effect.succeed({ credential: "CODE", expiresAt: "2999-01-01T00:00:00.000Z" }),
  },
});

type Fake = Effect.Success<typeof fakeBoat>;

/** Writes the registry and key a holder had before this server started. */
const seed = (state: Record<string, unknown> = {}, backups: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(config.stateDir, "boat-cloud");
    yield* fs.makeDirectory(path.join(directory, "backups"), { recursive: true });
    for (const environmentId of backups) {
      yield* fs.writeFileString(path.join(directory, "backups", `${environmentId}.tar.gz`), "x");
    }
    yield* fs.writeFileString(
      path.join(directory, "state.json"),
      JSON.stringify({ account: FAKE_ACCOUNT, machines: [], environment: "default", ...state }),
    );
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set("boat-cloud-api-key", new TextEncoder().encode("boat_test"));
  });

const withService = <A, E, R>(
  fake: Fake,
  use: (service: BoatCloud.BoatCloudService["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(Effect.service(BoatCloud.BoatCloudService), use).pipe(
    Effect.provide(
      BoatCloud.layer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, fake.http)),
        Layer.provide(BoatLocalSignIns.layerStatic(false)),
      ),
    ),
  );

/** Lets the sweeps' file and HTTP work, which runs off the test clock, finish. */
const settle = TestClock.withLive(Effect.sleep(Duration.millis(40)));

/** Moves the test clock a minute at a time, so each minute's sweep runs to its end. */
const advanceMinutes = (minutes: number) =>
  Effect.forEach(
    Array.from({ length: minutes }),
    () => TestClock.adjust(Duration.minutes(1)).pipe(Effect.andThen(settle)),
    { discard: true },
  );

const start = (service: BoatCloud.BoatCloudService["Service"], requestId: string) =>
  service.acquire({ requestId, repositoryUrl: "https://github.com/pingdotgg/t3code" });

/** A VM Boat holds that the test made by hand, as Boat's fake keeps it. */
const addSandbox = (
  fake: Fake,
  id: string,
  fields: {
    readonly name: string;
    readonly labels: Record<string, string>;
    readonly stoppedAt?: number;
    readonly createdAt?: number;
    readonly dataExpiredAt?: string;
  },
) =>
  fake.sandboxes.set(id, {
    id,
    name: fields.name,
    state: fields.stoppedAt === undefined ? "running" : "stopped",
    readyAt: 0,
    type: "small",
    labels: fields.labels,
    environment: "default",
    createdAt: iso(fields.createdAt ?? -30 * DAY_MS),
    billedSeconds: 0,
    runningSince: fields.stoppedAt === undefined ? 0 : null,
    lastActive: 0,
    diskUsedBytes: 0,
    stoppedAt: fields.stoppedAt === undefined ? null : iso(fields.stoppedAt),
    dataExpiredAt: fields.dataExpiredAt ?? null,
  });

const handedOut = (sandboxId: string, environmentId: string, backedUpAt: string | null) => ({
  sandboxId,
  environmentId,
  label: sandboxId,
  httpBaseUrl: null,
  state: "stopped",
  repositories: [],
  backedUpAt,
  acquiredAt: iso(-20 * DAY_MS),
  environment: "default",
  handOuts: 1,
});

it.layer(dependencies)("Boat cloud VM lease", (it) => {
  it.effect("gives every VM it makes a lease on Boat, which stops it with no holder alive", () =>
    Effect.gen(function* () {
      yield* seed({ idleStopMinutes: 5 });
      const fake = yield* fakeBoat;
      const session = yield* withService(fake, (service) => start(service, "start-1"));

      const vm = fake.sandboxes.get(session.sandboxId)!;
      assert.strictEqual(vm.ttlSeconds, 5 * 60);
      assert.strictEqual(vm.state, "running");

      // The service is gone; Boat alone stops the VM at its deadline.
      yield* TestClock.adjust(Duration.minutes(5));
      const listed = yield* fake.http.get("https://boat.dev/api/v1/sandboxes");
      const body = (yield* listed.json) as { sandboxes: Array<{ id: string; state: string }> };
      assert.strictEqual(
        body.sandboxes.find((sandbox) => sandbox.id === session.sandboxId)?.state,
        "stopped",
      );
    }),
  );

  it.effect("takes the lease length from the setting, and stops an idle VM before Boat does", () =>
    Effect.gen(function* () {
      yield* seed();
      const fake = yield* fakeBoat;
      yield* withService(fake, (service) =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          const status = yield* service.configureMachines({ idleStopMinutes: 20 });
          assert.strictEqual(status.idleStopMinutes, 20);
          const session = yield* start(service, "start-1");
          const vm = fake.sandboxes.get(session.sandboxId)!;
          assert.strictEqual(vm.ttlSeconds, 20 * 60);
          fake.sandboxes.get(session.sandboxId)!.threads = 1;
          yield* advanceMinutes(16);
          assert.strictEqual(vm.state, "running");
          yield* advanceMinutes(3);
          // The holder's sweep stops it after a backup, ahead of Boat's deadline at 20 minutes.
          assert.strictEqual(vm.state, "stopped");
          assert.isTrue((vm.stoppedAt ?? "") < iso(startedAt + 20 * 60 * 1000));
          const machine = (yield* service.refreshUsage).machines.find(
            (candidate) => candidate.sandboxId === session.sandboxId,
          );
          assert.isNotNull(machine?.backedUpAt ?? null);
        }),
      );
    }),
  );

  it.effect("keeps a busy VM on past its first deadline, and stops it once it goes quiet", () =>
    Effect.gen(function* () {
      yield* seed({ idleStopMinutes: 5 });
      const fake = yield* fakeBoat;
      yield* withService(fake, (service) =>
        Effect.gen(function* () {
          const session = yield* start(service, "start-1");
          const vm = fake.sandboxes.get(session.sandboxId)!;
          vm.threads = 1;
          vm.busy = true;
          yield* advanceMinutes(12);
          assert.strictEqual(vm.state, "running");
          vm.busy = false;
          yield* advanceMinutes(5);
          assert.strictEqual(vm.state, "stopped");
        }),
      );
    }),
  );

  it.effect("deletes a VM once every thread on it was deleted", () =>
    Effect.gen(function* () {
      yield* seed();
      const fake = yield* fakeBoat;
      yield* withService(fake, (service) =>
        Effect.gen(function* () {
          const session = yield* start(service, "start-1");
          fake.sandboxes.get(session.sandboxId)!.threads = 0;
          yield* advanceMinutes(15);
          assert.isFalse(fake.sandboxes.has(session.sandboxId));
          const status = yield* service.refreshUsage;
          assert.notInclude(
            status.machines.map((machine) => machine.sandboxId),
            session.sandboxId,
          );
        }),
      );
    }),
  );

  it.effect(
    "deletes stopped VMs past their retention and leftovers, and never one T3 did not make",
    () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* seed(
          {
            machines: [
              handedOut("vm-backed-up", "env-backed-up", iso(now - 8 * DAY_MS)),
              handedOut("vm-no-backup", "env-no-backup", null),
              handedOut("vm-recent", "env-recent", iso(now - 2 * DAY_MS)),
              handedOut("vm-expired", "env-expired", null),
            ],
          },
          ["env-backed-up", "env-recent"],
        );
        const fake = yield* fakeBoat;
        const t3 = { ...MACHINE_LABELS };
        addSandbox(fake, "vm-backed-up", {
          name: machineNameOf("pingdotgg/t3code"),
          labels: t3,
          stoppedAt: now - 8 * DAY_MS,
        });
        addSandbox(fake, "vm-no-backup", {
          name: machineNameOf("pingdotgg/t3code"),
          labels: t3,
          stoppedAt: now - 8 * DAY_MS,
        });
        addSandbox(fake, "vm-recent", {
          name: machineNameOf("pingdotgg/t3code"),
          labels: t3,
          stoppedAt: now - 2 * DAY_MS,
        });
        addSandbox(fake, "vm-expired", {
          name: machineNameOf("pingdotgg/t3code"),
          labels: t3,
          stoppedAt: now - 15 * DAY_MS,
          dataExpiredAt: iso(now - DAY_MS),
        });
        addSandbox(fake, "vm-spare", {
          name: SPARE_NAME,
          labels: { ...t3, [ROLE_LABEL]: "spare" },
          stoppedAt: now - DAY_MS,
        });
        addSandbox(fake, "vm-setup", { name: "t3 setup", labels: { ...SETUP_LABELS } });
        // Another holder's VM and the user's own sandboxes stay as they are.
        addSandbox(fake, "vm-foreign", {
          name: machineNameOf("pingdotgg/t3code"),
          labels: t3,
          stoppedAt: now - 10 * DAY_MS,
        });
        addSandbox(fake, "user-box", { name: "my box", labels: {}, stoppedAt: now - 30 * DAY_MS });
        addSandbox(fake, "user-expired", {
          name: "old box",
          labels: {},
          stoppedAt: now - 30 * DAY_MS,
          dataExpiredAt: iso(now - 10 * DAY_MS),
        });
        addSandbox(fake, "user-running", { name: "busy box", labels: {} });

        const status = yield* withService(fake, (service) =>
          Effect.gen(function* () {
            yield* advanceMinutes(1);
            return yield* service.refreshUsage;
          }),
        );

        assert.deepStrictEqual([...fake.sandboxes.keys()].toSorted(), [
          "user-box",
          "user-expired",
          "user-running",
          "vm-foreign",
          "vm-no-backup",
          "vm-recent",
        ]);
        const states = Object.fromEntries(
          status.machines.map((machine) => [machine.sandboxId, machine.state]),
        );
        // A VM with a backup here stays listed as gone, so waking its thread restores it.
        assert.strictEqual(states["vm-backed-up"], "gone");
        assert.isUndefined(states["vm-expired"]);
        assert.strictEqual(fake.sandboxes.get("user-running")?.state, "running");
      }),
  );
});
