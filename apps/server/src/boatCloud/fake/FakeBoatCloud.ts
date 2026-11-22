import { BoatCloudError } from "@t3tools/contracts";
import { machineLabelOf, machineNameOf, parseRepository } from "@t3tools/shared/boatCloudVm";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import packageJson from "../../../package.json" with { type: "json" };
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as BoatCloud from "../BoatCloudService.ts";
import * as BoatLocalSignIns from "../BoatLocalSignIns.ts";
import {
  FAKE_ACCOUNT,
  FAKE_RUNNING_VM,
  FAKE_STOPPED_VM,
  type FakeBoatTarget,
  makeFakeBoat,
} from "./FakeBoat.ts";

/**
 * Dev-only: `T3CODE_BOAT_CLOUD_FAKE=1` on a dev server (one with a Vite dev URL) runs Boat
 * cloud against the in-memory Boat in `FakeBoat.ts`, so the whole flow can be clicked through
 * with no Boat account and no spend. It keeps its state in its own directory and its key in
 * memory, so it never touches the real Boat cloud state or key. Unset, nothing changes.
 */
export const FAKE_ENV_VAR = "T3CODE_BOAT_CLOUD_FAKE";
/** Overrides the URL fake VMs hand out, which is the dev server's own. */
const FAKE_URL_ENV_VAR = "T3CODE_BOAT_CLOUD_FAKE_URL";
/** Starts the fake with a running and a sleeping VM instead of none. */
export const FAKE_SEED_ENV_VAR = "T3CODE_BOAT_CLOUD_FAKE_SEED";
/** Simulates a Boat environment whose profile has no AI sign-in. */
const FAKE_NO_AGENTS_ENV_VAR = "T3CODE_BOAT_CLOUD_FAKE_NO_AGENTS";
/** Simulates an account without Boat's GitHub app. */
const FAKE_NO_GITHUB_ENV_VAR = "T3CODE_BOAT_CLOUD_FAKE_NO_GITHUB";
/** A JSON file, such as `boat limits --json` saved from a real account, answered for `/limits`. */
const FAKE_LIMITS_ENV_VAR = "T3CODE_BOAT_CLOUD_FAKE_LIMITS";
/** Simulates this machine signed in to Claude and Codex, with dummy values; unset, it has none. */
const FAKE_LOCAL_SIGN_INS_ENV_VAR = "T3CODE_BOAT_CLOUD_FAKE_LOCAL_SIGNINS";

interface FakeLayerOptions {
  readonly delayScale?: number;
  readonly seed?: boolean;
  readonly noAgents?: boolean;
  readonly noGithub?: boolean;
  readonly localSignIns?: boolean;
  readonly limits?: unknown;
}

const FAKE_API_KEY = "fake-boat-key";
const API_KEY_SECRET = "boat-cloud-api-key";

/** Only a dev server takes the fake: a packaged build has no dev URL. */
export const fakeBoatCloudEnabled = (value: string, devUrl: URL | undefined) =>
  devUrl !== undefined && (value === "1" || value === "true");

/** What the fake needs from this server: it stands in for every VM's T3 server. */
export class FakeBoatLocal extends Context.Service<
  FakeBoatLocal,
  {
    readonly target: FakeBoatTarget;
    /** The local checkout of a repository, by `parseRepository` key, or null without one. */
    readonly workspaceRootOf: (repositoryKey: string) => Effect.Effect<string | null>;
  }
>()("t3/boatCloud/fake/FakeBoatCloud/FakeBoatLocal") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The registry a fresh fake starts with, in BoatCloudService's `state.json` shape. */
const seedState = (now: string, seed: boolean) => ({
  account: FAKE_ACCOUNT,
  environment: "default",
  snapshotRepositories: [],
  machines: !seed
    ? []
    : [
        {
          sandboxId: FAKE_RUNNING_VM,
          environmentId: "fake-boat-env-run1",
          label: machineLabelOf(FAKE_RUNNING_VM),
          httpBaseUrl: null,
          state: "running",
          repositories: ["github.com/pingdotgg/t3code"],
          backedUpAt: null,
          acquiredAt: now,
          environment: "default",
        },
        {
          sandboxId: FAKE_STOPPED_VM,
          environmentId: "fake-boat-env-stop",
          label: machineLabelOf(FAKE_STOPPED_VM),
          httpBaseUrl: null,
          state: "stopped",
          repositories: ["github.com/pingdotgg/t3code", "github.com/effect-ts/effect"],
          backedUpAt: now,
          acquiredAt: null,
          environment: "default",
        },
      ],
});

/**
 * A VM Boat already deleted, so only this machine's usage record knows it: a large VM on for a
 * few hours on each of three days last week.
 */
const seedUsageHistory = (nowMillis: number) => {
  const dayStart = Math.floor(nowMillis / 86_400_000) * 86_400_000;
  const hours = [
    [6, 15, 3],
    [5, 16, 2],
    [4, 14, 4],
  ].flatMap(([daysAgo = 0, hourOfDay = 0, count = 0]) =>
    Array.from({ length: count }, (_, index) => ({
      start: dayStart - daysAgo * 86_400_000 + (hourOfDay + index) * 3_600_000,
      seconds: 7200,
      dollars: 0.072,
    })),
  );
  return {
    machines: {
      "fakevm-gone": {
        machineType: "large",
        environmentId: null,
        settledUntil: dayStart - 3 * 86_400_000,
        hours,
        open: null,
        gone: true,
      },
    },
  };
};

/** The key lives in memory and starts set, so the fake is connected from the start. */
const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const values = new Map<string, Uint8Array>([
    [API_KEY_SECRET, new TextEncoder().encode(FAKE_API_KEY)],
  ]);
  const put = Effect.fnUntraced(function* (name: string, value: Uint8Array) {
    yield* Effect.sync(() => values.set(name, value));
  });
  return ServerSecretStore.ServerSecretStore.of({
    get: Effect.fnUntraced(function* (name) {
      return yield* Effect.sync(() => Option.fromUndefinedOr(values.get(name)));
    }),
    set: put,
    create: put,
    getOrCreateRandom: Effect.fnUntraced(function* (name, bytes) {
      const existing = values.get(name);
      if (existing) return existing;
      const created = new Uint8Array(bytes);
      for (let index = 0; index < bytes; index++) {
        created[index] = yield* Random.nextIntBetween(0, 255);
      }
      values.set(name, created);
      return created;
    }),
    remove: Effect.fnUntraced(function* (name) {
      yield* Effect.sync(() => values.delete(name));
    }),
  });
});

/** Its own state directory, reset on every start since the fake Boat lives in memory. */
const layerFakeConfig = (seed: boolean) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = path.join(config.stateDir, "boat-cloud-fake");
      const directory = path.join(stateDir, "boat-cloud");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "state.json"),
        encodeJson(seedState(DateTime.formatIso(yield* DateTime.now), seed)),
      );
      yield* fs.writeFileString(
        path.join(directory, "usage-history.json"),
        encodeJson(
          seed ? seedUsageHistory(DateTime.toEpochMillis(yield* DateTime.now)) : { machines: {} },
        ),
      );
      return { ...config, stateDir };
    }).pipe(Effect.orDie),
  );

const layerFakeHttp = (options: FakeLayerOptions) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.flatMap(FakeBoatLocal, (local) =>
      makeFakeBoat({
        version: packageJson.version,
        target: local.target,
        delayScale: options.delayScale ?? 1,
        seed: options.seed ?? false,
        noAgents: options.noAgents ?? false,
        noGithub: options.noGithub ?? false,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      }),
    ).pipe(Effect.map((fake) => fake.http)),
  );

/**
 * BoatCloudService on the fake Boat. A start's session points at the local checkout of the
 * repository, since the thread runs on this machine: the VM's path does not exist here.
 */
export const layerFake = (options: FakeLayerOptions = {}) =>
  Layer.effect(
    BoatCloud.BoatCloudService,
    Effect.gen(function* () {
      const inner = yield* BoatCloud.BoatCloudService;
      const local = yield* FakeBoatLocal;
      return BoatCloud.BoatCloudService.of({
        ...inner,
        acquire: Effect.fn("FakeBoatCloud.acquire")(function* (input) {
          const repository =
            input.repositoryUrl === undefined ? null : parseRepository(input.repositoryUrl);
          const workspaceRoot =
            repository === null ? null : yield* local.workspaceRootOf(repository.key);
          if (repository !== null && workspaceRoot === null) {
            return yield* new BoatCloudError({
              message: `Fake Boat runs threads on this machine, so it needs a local project cloned from ${repository.name}.`,
            });
          }
          const session = yield* inner.acquire(input);
          // The VM's worktree exists only on the VM; the thread takes the local checkout.
          return workspaceRoot === null ? session : { ...session, workspaceRoot, worktree: null };
        }),
      });
    }),
  ).pipe(
    Layer.provide(
      BoatCloud.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerFakeHttp(options),
            layerMemorySecretStore,
            layerFakeConfig(options.seed ?? false),
            BoatLocalSignIns.layerStatic(options.localSignIns ?? false),
          ),
        ),
      ),
    ),
  );

const noLocalServer = (what: string) =>
  Effect.die(new Error(`Fake Boat could not reach this server's ${what}.`));

/**
 * This server as the fake VMs' T3 server: its id, its dev URL, its pairing codes, its projects.
 * Auth and projects are built above Boat cloud in the server's layers, so they are read from
 * the fiber that asks, which for a start or wake is the client's RPC with the full server.
 */
const layerFakeLocal = Layer.effect(
  FakeBoatLocal,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const override = yield* Config.String(FAKE_URL_ENV_VAR).pipe(Config.withDefault(""));
    const httpBaseUrl = override || config.devUrl?.origin || `http://localhost:${config.port}`;
    return FakeBoatLocal.of({
      target: {
        environmentId: fs.readFileString(config.environmentIdPath).pipe(
          Effect.map((text) => text.trim()),
          Effect.orDie,
        ),
        httpBaseUrl,
        issuePairing: Effect.gen(function* () {
          const auth = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
          if (Option.isNone(auth)) return yield* noLocalServer("auth");
          const pairing = yield* auth.value
            .issuePairingCredential({ label: machineNameOf("fake VM") })
            .pipe(Effect.orDie);
          return {
            credential: pairing.credential,
            expiresAt: DateTime.formatIso(pairing.expiresAt),
          };
        }),
      },
      workspaceRootOf: Effect.fn("FakeBoatLocal.workspaceRootOf")(function* (repositoryKey) {
        const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
        if (Option.isNone(projects)) return null;
        const snapshot = yield* projects.value.snapshot.pipe(Effect.option);
        if (Option.isNone(snapshot)) return null;
        const project = snapshot.value.projects.find((candidate) => {
          if (candidate.deletedAt !== null || candidate.archivedAt) return false;
          const identity = candidate.repositoryIdentity;
          if (!identity) return false;
          return [identity.locator.remoteUrl, identity.origin?.remoteUrl].some(
            (remoteUrl) =>
              remoteUrl !== undefined && parseRepository(remoteUrl)?.key === repositoryKey,
          );
        });
        return project?.workspaceRoot ?? null;
      }),
    });
  }),
);

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const fakeLimits = Effect.gen(function* () {
  const file = (yield* Config.String(FAKE_LIMITS_ENV_VAR).pipe(Config.withDefault(""))).trim();
  if (file === "") return {};
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const limits = Option.getOrUndefined(decodeJson(text));
  return limits === undefined ? {} : { limits };
});

/**
 * The real BoatCloudService, reading this machine's sign-ins with `realSignIns`, or the fake
 * one when the env var is set on a dev server.
 */
export const layerWith = <E, R, SE, SR>(
  fakeLocal: Layer.Layer<FakeBoatLocal, E, R>,
  realSignIns: Layer.Layer<BoatLocalSignIns.BoatLocalSignIns, SE, SR>,
) => {
  type Selected = Layer.Layer<
    BoatCloud.BoatCloudService,
    E | SE,
    | R
    | SR
    | Exclude<Layer.Services<typeof BoatCloud.layer>, BoatLocalSignIns.BoatLocalSignIns>
    | Exclude<Layer.Services<ReturnType<typeof layerFake>>, FakeBoatLocal>
  >;
  const real: Selected = BoatCloud.layer.pipe(Layer.provide(realSignIns));
  const fake = (options: FakeLayerOptions): Selected =>
    layerFake(options).pipe(Layer.provide(fakeLocal));
  return Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const flag = (yield* Config.String(FAKE_ENV_VAR).pipe(Config.withDefault(""))).trim();
      if (flag === "") return real;
      if (!fakeBoatCloudEnabled(flag, config.devUrl)) {
        yield* Effect.logWarning(`${FAKE_ENV_VAR} is ignored outside a dev server.`);
        return real;
      }
      yield* Effect.logWarning(
        `${FAKE_ENV_VAR} is set: Boat runs against a fake Boat, and its VMs are this server.`,
      );
      const on = (name: string) =>
        Config.String(name).pipe(
          Config.withDefault(""),
          Config.map((value) => value.trim() === "1" || value.trim() === "true"),
        );
      return fake({
        seed: yield* on(FAKE_SEED_ENV_VAR),
        noAgents: yield* on(FAKE_NO_AGENTS_ENV_VAR),
        noGithub: yield* on(FAKE_NO_GITHUB_ENV_VAR),
        localSignIns: yield* on(FAKE_LOCAL_SIGN_INS_ENV_VAR),
        ...(yield* fakeLimits),
      });
    }).pipe(Effect.orDie),
  );
};

export const layer = layerWith(layerFakeLocal, BoatLocalSignIns.layer);
