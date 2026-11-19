import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import { makeBoatApi } from "./boatCloudApi.ts";
import {
  latestCliRelease,
  makeSpareKeeper,
  needsSnapshot,
  type ReadySpare,
  startingSnapshot,
  startMachine,
} from "./boatCloudStart.ts";
import {
  NOT_HOSTED_MARKER,
  PAIRING_MARKER,
  SNAPSHOT_LABEL,
  SPARE_NAME,
  parseRepository,
} from "./boatCloudVm.ts";

const repository = parseRepository("https://github.com/acme/app")!;
const SNAPSHOT = "t3-code-0-1-8";
const SUBDOMAIN = "box-node-1";
const VM_URL = `https://${SUBDOMAIN}-3773.on.boat.dev`;

/**
 * Boat with one running, lightly loaded VM whose server answers as `serverEnvironmentId`.
 * Calls are recorded as `METHOD path`, a PATCH with its fields, a command by what it runs.
 * A created VM is `vm-2`, on the environment it was made on, and a renamed one is listed
 * under its new name. `states` sets what Boat lists a VM as.
 */
const runningVm = (
  serverEnvironmentId: string,
  vm: {
    spare?: boolean;
    hostsItself?: boolean;
    /** vm-1 is too loaded to share. */
    busy?: boolean;
    renameFails?: boolean;
    /** The server does not start on this VM. */
    serverFailsOn?: string;
  } = {},
) => {
  const calls: Array<string> = [];
  const commands: Array<string> = [];
  const names = new Map([["vm-1", vm.spare ? SPARE_NAME : "Boat cloud"]]);
  const environments = new Map([["vm-1", "base"]]);
  const states = new Map<string, string>();
  const listed = (id: string) => ({
    id,
    state: states.get(id) ?? "ready",
    subdomain: id === "vm-1" ? SUBDOMAIN : `box-${id}`,
    environment: environments.get(id) ?? "base",
    name: names.get(id),
    labels: { [SNAPSHOT_LABEL]: SNAPSHOT },
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname.replace("/api/v1", "");
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
          : {};
      const reply = (json: unknown) => HttpClientResponse.fromWeb(request, Response.json(json));
      const command = /^\/sandboxes\/([^/]+)\/commands$/u.exec(path);
      if (!command) {
        calls.push(
          request.method === "PATCH"
            ? `PATCH ${path} ${Object.keys(body).join(",")}`
            : `${request.method} ${path}`,
        );
      }
      if (path === "/sandboxes" && request.method === "POST") {
        names.set("vm-2", String(body.name));
        environments.set("vm-2", String(body.environment ?? "base"));
        return reply({ sandbox: listed("vm-2") });
      }
      if (path === "/sandboxes") return reply({ sandboxes: [...names.keys()].map(listed) });
      const id = /^\/sandboxes\/([^/]+)/u.exec(path)?.[1] ?? "";
      if (request.method === "PATCH" && typeof body.name === "string") {
        if (vm.renameFails) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ code: "internal" }, { status: 500 }),
          );
        }
        names.set(id, body.name);
      }
      if (request.method === "DELETE") {
        names.delete(id);
        return reply({});
      }
      if (path === `/sandboxes/${id}` && request.method === "GET") {
        return reply({ sandbox: listed(id) });
      }
      if (path.endsWith("/host")) return reply({ url: `${VM_URL}/` });
      if (!command) return reply({});
      const script = typeof body.command === "string" ? body.command : "";
      commands.push(script);
      const descriptor = JSON.stringify({ environmentId: serverEnvironmentId });
      const pairing = JSON.stringify({
        credential: "fresh-code",
        expiresAt: "2999-01-01T00:00:00.000Z",
      });
      let stdout = "";
      if (script.includes("/proc/loadavg")) {
        calls.push("exec measure");
        stdout = vm.busy && id === "vm-1" ? "0.9 1000 100\n" : "0.1 1000 900\n";
      } else if (script.includes("systemctl --user start t3code.service")) {
        calls.push("exec server");
        if (vm.serverFailsOn === id) return reply({ exitCode: 1, stdout: "" });
        const head = vm.hostsItself === false ? `${NOT_HOSTED_MARKER}\n${descriptor}` : descriptor;
        stdout = script.includes(PAIRING_MARKER) ? `${head}\n${PAIRING_MARKER}\n${pairing}` : head;
      } else if (script.includes("auth pairing create")) stdout = pairing;
      return reply({ exitCode: 0, stdout });
    }),
  );
  return { api: makeBoatApi(http, "key"), calls, commands, states };
};

const start = (
  vm: ReturnType<typeof runningVm>,
  pairedEnvironmentId: string | null,
  readySpare: ReadySpare | null = null,
  onDeleted?: (sandboxId: string) => Effect.Effect<void>,
  shareMachines?: boolean,
) =>
  startMachine({
    ...(onDeleted ? { onDeleted } : {}),
    ...(shareMachines === undefined ? {} : { shareMachines }),
    api: vm.api,
    repository,
    baseBranch: null,
    environment: "base",
    snapshot: SNAPSHOT,
    readySpare,
    knownWorkspaceRoots: () => [],
    paired:
      pairedEnvironmentId === null
        ? []
        : [{ environmentId: EnvironmentId.make(pairedEnvironmentId), httpBaseUrl: VM_URL }],
    report: () => Effect.void,
  });

describe("startMachine on a running VM", () => {
  it.effect("reconnects a paired client without waiting on Boat, hosting or pairing", () =>
    Effect.gen(function* () {
      const vm = runningVm("env-1");
      const started = yield* start(vm, "env-1");
      yield* started.checkout;
      assert.isNull(started.pairingCode);
      assert.strictEqual(started.httpBaseUrl, VM_URL);
      assert.deepStrictEqual(
        vm.calls.filter((call) => !call.startsWith("exec ")),
        ["GET /sandboxes", "PATCH /sandboxes/vm-1 ttlSeconds"],
      );
      assert.isFalse(vm.commands.some((command) => command.includes("auth pairing create")));
    }),
  );

  it.effect("mints a code in the server command for a new client, or after the VM was reset", () =>
    Effect.gen(function* () {
      const fresh = runningVm("env-1");
      assert.strictEqual((yield* start(fresh, null)).pairingCode, "fresh-code");
      assert.strictEqual(
        fresh.commands.filter((command) => command.includes("auth pairing create")).length,
        1,
      );

      const reset = runningVm("env-2");
      assert.strictEqual((yield* start(reset, "env-1")).pairingCode, "fresh-code");
    }),
  );

  it.effect("asks Boat to host the port only after the server started, when the VM could not", () =>
    Effect.gen(function* () {
      const vm = runningVm("env-1", { spare: true, hostsItself: false });
      assert.strictEqual((yield* start(vm, null)).httpBaseUrl, VM_URL);
      assert.include(vm.calls, "PATCH /sandboxes/vm-1 name");
      const hosts = vm.calls.flatMap((call, index) =>
        call === "POST /sandboxes/vm-1/host" ? [index] : [],
      );
      assert.strictEqual(hosts.length, 1);
      assert.isAbove(hosts[0]!, vm.calls.indexOf("exec server"));
    }),
  );
});

describe("startMachine with one job per VM", () => {
  it.effect(
    "creates a VM instead of joining a free one that serves a thread, without probing it",
    () =>
      Effect.gen(function* () {
        const vm = runningVm("env-1");
        const started = yield* start(vm, null, null, undefined, false);
        yield* started.checkout;
        assert.strictEqual(started.sandboxId, "vm-2");
        assert.include(vm.calls, "POST /sandboxes");
        assert.notInclude(vm.calls, "exec measure");
      }),
  );

  it.effect("still takes a free spare", () =>
    Effect.gen(function* () {
      const vm = runningVm("env-1", { spare: true });
      const started = yield* start(vm, null, null, undefined, false);
      assert.strictEqual(started.sandboxId, "vm-1");
      assert.notInclude(vm.calls, "POST /sandboxes");
    }),
  );
});

describe("startMachine on a new VM", () => {
  it.effect("deletes the VM it created when the start then fails, and says so", () =>
    Effect.gen(function* () {
      const vm = runningVm("env-1", { busy: true, serverFailsOn: "vm-2" });
      const deleted: Array<string> = [];
      const error = yield* Effect.flip(
        start(vm, null, null, (sandboxId) => Effect.sync(() => void deleted.push(sandboxId))),
      );
      assert.strictEqual(error.message, "T3 Code did not start on the VM.");
      assert.include(vm.calls, "POST /sandboxes");
      assert.include(vm.calls, "DELETE /sandboxes/vm-2");
      assert.deepStrictEqual(deleted, ["vm-2"]);
    }),
  );
});

describe("the ready spare", () => {
  const keep = (vm: ReturnType<typeof runningVm>, keeper: ReturnType<typeof makeSpareKeeper>) =>
    keeper.keep(vm.api, SNAPSHOT, "base");

  it.effect(
    "is handed out before Boat hears of the start, and claimed alongside the checkout",
    () =>
      Effect.gen(function* () {
        const vm = runningVm("env-1", { spare: true });
        const keeper = makeSpareKeeper();
        yield* keep(vm, keeper);
        const spare = yield* keeper.take(SNAPSHOT, "base");
        assert.strictEqual(spare?.sandboxId, "vm-1");
        vm.calls.length = 0;

        const started = yield* start(vm, null, spare);
        assert.strictEqual(started.pairingCode, "fresh-code");
        assert.strictEqual(started.httpBaseUrl, VM_URL);
        assert.deepStrictEqual(
          vm.calls.filter((call) => call !== "exec server" && call.startsWith("exec ")),
          [],
        );
        yield* started.checkout;
        assert.includeMembers(vm.calls, [
          "PATCH /sandboxes/vm-1 name",
          "PATCH /sandboxes/vm-1 ttlSeconds",
        ]);
        assert.notInclude(vm.calls, "GET /sandboxes");
      }),
  );

  it.effect("goes to one start only, even while Boat still lists it as the spare", () =>
    Effect.gen(function* () {
      const vm = runningVm("env-1", { spare: true });
      const keeper = makeSpareKeeper();
      yield* keep(vm, keeper);
      assert.strictEqual((yield* keeper.take(SNAPSHOT, "base"))?.sandboxId, "vm-1");
      assert.isNull(yield* keeper.take(SNAPSHOT, "base"));

      // The refill reads Boat's list before the start's rename lands.
      yield* keep(vm, keeper);
      assert.notInclude(vm.calls, "DELETE /sandboxes/vm-1");
      assert.strictEqual((yield* keeper.take(SNAPSHOT, "base"))?.sandboxId, "vm-2");
    }),
  );

  it.effect(
    "is never deleted by another holder while it runs, and fails its start when the rename never lands",
    () =>
      Effect.gen(function* () {
        const vm = runningVm("env-1", { spare: true, renameFails: true });
        const mac = makeSpareKeeper();
        yield* keep(vm, mac);
        const spare = yield* mac.take(SNAPSHOT, "base");
        const started = yield* start(vm, null, spare);
        const checkout = yield* Effect.forkChild(Effect.flip(started.checkout));
        yield* TestClock.adjust(Duration.minutes(1));
        yield* Fiber.join(checkout);
        assert.strictEqual(
          vm.calls.filter((call) => call === "PATCH /sandboxes/vm-1 name").length,
          5,
        );

        // Another holder on another environment still sees vm-1 as a spare that is not its own.
        const vps = makeSpareKeeper();
        yield* vps.keep(vm.api, SNAPSHOT, "other");
        assert.notInclude(vm.calls, "DELETE /sandboxes/vm-1");
        assert.strictEqual((yield* vps.take(SNAPSHOT, "other"))?.sandboxId, "vm-2");

        // Once Boat stopped it, a whole TTL went by with no thread keeping it on.
        vm.states.set("vm-1", "stopped");
        yield* vps.keep(vm.api, SNAPSHOT, "other");
        assert.include(vm.calls, "DELETE /sandboxes/vm-1");
      }),
  );

  it.effect("deletes a spare it made that no longer fits", () =>
    Effect.gen(function* () {
      const vm = runningVm("env-1");
      const keeper = makeSpareKeeper();
      yield* keeper.keep(vm.api, SNAPSHOT, "other");
      assert.include(vm.calls, "POST /sandboxes");
      yield* keeper.keep(vm.api, SNAPSHOT, "base");
      assert.include(vm.calls, "DELETE /sandboxes/vm-2");
    }),
  );

  it.effect("is forgotten once Boat lists it taken by another holder", () =>
    Effect.gen(function* () {
      const vm = runningVm("env-1", { spare: true });
      const keeper = makeSpareKeeper();
      yield* keep(vm, keeper);
      yield* vm.api.rename("vm-1", "Boat cloud");
      keeper.reconcile(yield* vm.api.listSandboxes("t3code=cloud"));
      assert.isNull(yield* keeper.take(SNAPSHOT, "base"));
    }),
  );
});

describe("latestCliRelease", () => {
  const github = (tag: string) =>
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ tag_name: tag }))),
    );

  it.effect("finds the stable release and refuses a latest release that is not one", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* latestCliRelease(github("v0.1.9")), "0.1.9");
      for (const tag of ["v0.2.0-nightly.1", "v0.1.9;reboot", "v1.2", "0.1.9"]) {
        const error = yield* Effect.flip(latestCliRelease(github(tag)));
        assert.strictEqual(error.code, "cli_release");
      }
    }),
  );
});

describe("snapshot choice", () => {
  const saved = (name: string, status: string, createdAt: string) => ({ name, status, createdAt });
  const old = saved("t3-code-0-1-8-skills", "ready", "2026-11-01T00:00:00Z");

  it("starts VMs from the newest ready snapshot, the previous one while the next saves", () => {
    const next = saved("t3-code-0-1-9", "ready", "2026-11-02T00:00:00Z");
    assert.strictEqual(startingSnapshot([old, next]), next.name);
    assert.strictEqual(startingSnapshot([old, { ...next, status: "saving" }]), old.name);
    assert.isNull(startingSnapshot([saved("other", "ready", "2026-11-03T00:00:00Z")]));
  });

  it("saves each build once, and only a holder with skills replaces one saved without", () => {
    const plain = saved("t3-code-0-1-9", "ready", "2026-11-02T00:00:00Z");
    const skills = saved("t3-code-0-1-9-skills", "saving", "2026-11-02T00:00:00Z");
    for (const withSkills of [true, false]) {
      assert.isTrue(needsSnapshot([old], "0.1.9", withSkills));
      assert.isFalse(needsSnapshot([skills], "0.1.9", withSkills));
      assert.isTrue(needsSnapshot([{ ...skills, status: "failed" }], "0.1.9", withSkills));
    }
    assert.isTrue(needsSnapshot([plain], "0.1.9", true));
    assert.isFalse(needsSnapshot([plain], "0.1.9", false));
  });
});
