import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { mostWorkedRepositories } from "@t3tools/client-runtime/state/threads";
import {
  BOAT_CLOUD_SNAPSHOT_REPOSITORIES,
  type BoatCloudConfigureMachinesInput,
  type BoatCloudEnvironmentAccess,
  BoatCloudMachineType,
  type BoatCloudSession,
  type BoatCloudStatus,
  BOAT_CLOUD_NO_LOCAL_SIGN_INS,
} from "@t3tools/contracts";
import {
  BOAT_MACHINE_SPECS,
  type BoatApi,
  BoatApiError,
  cloudEnvironments,
  machineTypeOptions,
  makeBoatApi,
} from "@t3tools/shared/boatCloudApi";
import {
  type PairedEnvironment,
  type ReportStep,
  buildSnapshot,
  findSandboxByHttpBaseUrl,
  latestCliRelease,
  makeSpareKeeper,
  snapshotToBuild,
  startMachine,
  startingSnapshot,
  wakeMachine,
} from "@t3tools/shared/boatCloudStart";
import {
  MACHINE_LABEL_FILTER,
  SPARE_NAME,
  VM_T3_PORT,
  machineLabelOf,
  machineStateOf,
  parseRepository,
} from "@t3tools/shared/boatCloudVm";
import * as Effect from "effect/Effect";
import { msg } from "gt-react-native";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import * as Runtime from "../../lib/runtime";
import { MobileSecureStorage } from "../../persistence/mobile-secure-storage";
import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadEnvironment } from "../../state/threads";

/**
 * The phone as a Boat cloud holder: with the key in its own keychain it starts
 * and wakes VMs without any machine connected. A machine holding the key does
 * more (session backups, an idle sweep), so a connected one is used first.
 */

const API_KEY_STORAGE_KEY = "t3code.boat-cloud.api-key";
/** The Boat environment new VMs start on, by name, as a machine holder keeps it. */
const ENVIRONMENT_STORAGE_KEY = "t3code.boat-cloud.environment";
/** How the phone hands out VMs, as a machine holder keeps it: `true` or `false`. */
const SHARE_MACHINES_STORAGE_KEY = "t3code.boat-cloud.share-machines";
/** The size the phone's new VMs start on when a start names none. */
const MACHINE_TYPE_STORAGE_KEY = "t3code.boat-cloud.default-machine-type";

const isMachineType = Schema.is(BoatCloudMachineType);

const DISCONNECTED: BoatCloudStatus = {
  connected: false,
  account: null,
  setup: { status: "idle", step: null, error: null },
  snapshotReady: false,
  machines: [],
  starts: [],
  environment: null,
  environments: [],
  environmentsError: null,
  githubConnected: null,
  shareMachines: false,
  // The phone keeps no ready machine: it is opt-in, and only a machine holder offers it.
  keepReadyMachine: false,
  defaultMachineType: "small",
  machineTypes: machineTypeOptions(null),
  environmentUsage: [],
  // A phone has no Claude or Codex sign-in of its own to pass on.
  localSignIns: BOAT_CLOUD_NO_LOCAL_SIGN_INS,
};

export const phoneBoatCloudAtom = Atom.make<BoatCloudStatus>(DISCONNECTED).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-boat-cloud:phone"),
);

const setStatus = (update: (status: BoatCloudStatus) => BoatCloudStatus) =>
  appAtomRegistry.update(phoneBoatCloudAtom, update);

const notConnected = new BoatApiError({
  status: 0,
  code: "not_connected",
  message: "Connect Boat in Settings, Environments first.",
  retryable: false,
});

const phoneApi = Effect.gen(function* () {
  const key = yield* MobileSecureStorage.use((storage) => storage.getItem(API_KEY_STORAGE_KEY));
  if (key === null) return yield* notConnected;
  return makeBoatApi(yield* HttpClient.HttpClient, key);
});

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient | MobileSecureStorage>) =>
  Runtime.runtime.runPromise(effect);

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Boat could not be reached.";

// Bumped once the key is stored or removed, so a refresh that read the old key drops its result.
let keyGeneration = 0;
/** The saved snapshot new VMs start from, or null before setup. */
let snapshotName: string | null = null;

/**
 * Reads the key, the snapshot and the VMs from Boat. Leaves a setup in progress alone,
 * and saves the latest t3 build when Boat has no snapshot of it.
 */
export function refreshPhoneBoatCloud(): Promise<void> {
  const generation = keyGeneration;
  const stale = () => generation !== keyGeneration;
  return run(
    Effect.gen(function* () {
      const api = yield* phoneApi;
      const [account, snapshots, sandboxes, environments, profiles, limits, stored, share, size] =
        yield* Effect.all(
          [
            api.me(),
            api.listSnapshots(),
            api.listSandboxes(MACHINE_LABEL_FILTER),
            api.listEnvironments().pipe(Effect.result),
            // Without it the sign-ins are unknown, and every provider stays offered.
            api.listCredentialProfiles().pipe(Effect.option),
            // Without it the sizes show Boat's documented specs, with no price.
            api.limits().pipe(Effect.option),
            MobileSecureStorage.use((storage) => storage.getItem(ENVIRONMENT_STORAGE_KEY)),
            MobileSecureStorage.use((storage) => storage.getItem(SHARE_MACHINES_STORAGE_KEY)),
            MobileSecureStorage.use((storage) => storage.getItem(MACHINE_TYPE_STORAGE_KEY)),
          ],
          { concurrency: "unbounded" },
        );
      if (stale()) return;
      spares.reconcile(sandboxes);
      const listed = Result.isSuccess(environments)
        ? cloudEnvironments(environments.success, Option.getOrNull(profiles))
        : [];
      // With none chosen yet, Boat's default becomes the choice, so later VMs stay on it.
      const environment = stored ?? listed.find((candidate) => candidate.isDefault)?.name ?? null;
      if (stored === null && environment !== null) {
        yield* MobileSecureStorage.use((storage) =>
          storage.setItem(ENVIRONMENT_STORAGE_KEY, environment),
        );
        if (stale()) return;
      }
      snapshotName = startingSnapshot(snapshots);
      const ready = snapshotName !== null;
      setStatus((status) => ({
        ...status,
        connected: true,
        account,
        setup:
          status.setup.status === "running"
            ? status.setup
            : ready
              ? { status: "ready", step: null, error: null }
              : status.setup.status === "failed"
                ? status.setup
                : { status: "idle", step: null, error: null },
        snapshotReady: ready,
        // The spare is no one's machine until a start takes it.
        machines: sandboxes
          .filter((sandbox) => sandbox.name !== SPARE_NAME)
          .map((sandbox) => ({
            sandboxId: sandbox.id,
            environmentId: null,
            label: machineLabelOf(sandbox.id),
            httpBaseUrl: sandbox.subdomain
              ? `https://${sandbox.subdomain}-${VM_T3_PORT}.on.boat.dev`
              : null,
            state: machineStateOf(sandbox.state),
            repositories: [],
            backedUpAt: null,
            environment: sandbox.environment ?? null,
            machineType: sandbox.type ?? null,
            vcpu: sandbox.vcpu ?? specOf(sandbox.type)?.vcpu ?? null,
            memoryGB: sandbox.memoryGB ?? specOf(sandbox.type)?.memoryGB ?? null,
            // The phone keeps no usage reads or stats; a machine holding the key does.
            usage: null,
            stats: null,
          })),
        environment,
        environments: listed,
        environmentsError: Result.isFailure(environments) ? environments.failure.message : null,
        shareMachines: share === "true",
        defaultMachineType: size !== null && isMachineType(size) ? size : "small",
        machineTypes: machineTypeOptions(Option.getOrNull(limits)),
      }));
      // Before the first setup, Settings offers it; a failed one waits for the button.
      if (!ready || appAtomRegistry.get(phoneBoatCloudAtom).setup.status !== "ready") return;
      yield* keepSpare(api, environment).pipe(Effect.forkDetach);
      const version = yield* snapshotToBuild(api, yield* HttpClient.HttpClient, false).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (version !== null && !stale()) void runPhoneBoatCloudSetup(version);
    }).pipe(
      Effect.catchTags({
        BoatApiError: (error) =>
          Effect.sync(() => {
            if (error.code === "not_connected" && !stale()) setStatus(() => DISCONNECTED);
          }),
      }),
    ),
  ).catch(() => undefined);
}

const spares = makeSpareKeeper();
/** Keeps one spare VM ready for this phone's next start, when a ready machine is wanted. */
const keepSpare = (api: BoatApi, environment: string | null) =>
  Effect.suspend(() =>
    snapshotName === null || !appAtomRegistry.get(phoneBoatCloudAtom).keepReadyMachine
      ? Effect.void
      : spares.keep(
          api,
          snapshotName,
          environment,
          appAtomRegistry.get(phoneBoatCloudAtom).defaultMachineType,
        ),
  );

const specOf = (type: string | null | undefined) =>
  type !== null && type !== undefined && isMachineType(type) ? BOAT_MACHINE_SPECS[type] : null;

let loaded: Promise<void> | null = null;

/** Loads the phone's Boat state once per launch; the Boat cloud settings refresh it on open. */
export function ensurePhoneBoatCloudLoaded(): Promise<void> {
  loaded ??= refreshPhoneBoatCloud();
  return loaded;
}

/** Checks the key with Boat, then keeps it in this phone's keychain. Null on success. */
export async function connectPhoneBoatCloud(apiKey: string): Promise<string | null> {
  try {
    await run(
      Effect.gen(function* () {
        yield* makeBoatApi(yield* HttpClient.HttpClient, apiKey).me();
        yield* MobileSecureStorage.use((storage) => storage.setItem(API_KEY_STORAGE_KEY, apiKey));
      }),
    );
  } catch (error) {
    return errorMessage(error);
  }
  keyGeneration += 1;
  await refreshPhoneBoatCloud();
  return null;
}

/** The key this phone keeps, so it can hand it to machines that lack it. */
export function readPhoneBoatCloudKey(): Promise<string | null> {
  return run(MobileSecureStorage.use((storage) => storage.getItem(API_KEY_STORAGE_KEY))).catch(
    () => null,
  );
}

export async function disconnectPhoneBoatCloud(): Promise<void> {
  keyGeneration += 1;
  await run(
    MobileSecureStorage.use((storage) =>
      Effect.all([
        storage.removeItem(API_KEY_STORAGE_KEY),
        storage.removeItem(ENVIRONMENT_STORAGE_KEY),
        storage.removeItem(SHARE_MACHINES_STORAGE_KEY),
        storage.removeItem(MACHINE_TYPE_STORAGE_KEY),
      ]),
    ),
  ).catch(() => undefined);
  setStatus(() => DISCONNECTED);
}

/** Picks the environment for the phone's new VMs, and optionally changes what it passes. Null on success. */
export async function configurePhoneBoatCloudEnvironment(
  environmentId: string,
  access?: BoatCloudEnvironmentAccess,
): Promise<string | null> {
  const chosen = appAtomRegistry
    .get(phoneBoatCloudAtom)
    .environments.find((environment) => environment.id === environmentId);
  if (!chosen) return m(msg("{product} has no such environment.", { product: "Boat" }));
  try {
    await run(
      Effect.gen(function* () {
        const api = yield* phoneApi;
        if (access) yield* api.updateEnvironment(environmentId, access);
        yield* MobileSecureStorage.use((storage) =>
          storage.setItem(ENVIRONMENT_STORAGE_KEY, chosen.name),
        );
      }),
    );
  } catch (error) {
    return errorMessage(error);
  }
  await refreshPhoneBoatCloud();
  return null;
}

/** Changes how the phone hands out VMs to its new threads. Null on success. */
export async function configurePhoneBoatCloudMachines(
  input: BoatCloudConfigureMachinesInput,
): Promise<string | null> {
  try {
    await run(
      MobileSecureStorage.use((storage) =>
        Effect.all([
          input.shareMachines === undefined
            ? Effect.void
            : storage.setItem(SHARE_MACHINES_STORAGE_KEY, String(input.shareMachines)),
          input.defaultMachineType === undefined
            ? Effect.void
            : storage.setItem(MACHINE_TYPE_STORAGE_KEY, input.defaultMachineType),
        ]),
      ),
    );
  } catch (error) {
    return errorMessage(error);
  }
  setStatus((status) => ({
    ...status,
    ...(input.shareMachines === undefined ? {} : { shareMachines: input.shareMachines }),
    ...(input.defaultMachineType === undefined
      ? {}
      : { defaultMachineType: input.defaultMachineType }),
  }));
  return null;
}

/** What the Boat cloud snapshot checks out: the most worked repositories on every machine. */
export function boatCloudSnapshotRepositories(): Array<string> {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  return mostWorkedRepositories(
    [...enabledEnvironmentIds(catalog)].map((environmentId) =>
      appAtomRegistry.get(threadEnvironment.snapshotAtom(environmentId)),
    ),
    BOAT_CLOUD_SNAPSHOT_REPOSITORIES,
  );
}

/**
 * Builds the snapshot from the phone, with the latest Boat cloud build of t3. The phone
 * has no skills; a machine holding the key saves the build again with its own.
 */
export async function runPhoneBoatCloudSetup(knownVersion?: string): Promise<void> {
  if (appAtomRegistry.get(phoneBoatCloudAtom).setup.status === "running") return;
  setStatus((status) => ({ ...status, setup: { status: "running", step: null, error: null } }));
  try {
    await run(
      Effect.gen(function* () {
        const api = yield* phoneApi;
        const version = knownVersion ?? (yield* latestCliRelease(yield* HttpClient.HttpClient));
        snapshotName = yield* buildSnapshot({
          api,
          version,
          repositories: boatCloudSnapshotRepositories(),
          setStep: (step) =>
            Effect.sync(() =>
              setStatus((status) => ({
                ...status,
                setup: { status: "running", step, error: null },
              })),
            ),
        });
      }),
    );
    setStatus((status) => ({
      ...status,
      setup: { status: "ready", step: null, error: null },
      snapshotReady: true,
    }));
  } catch (error) {
    setStatus((status) => ({
      ...status,
      setup: { status: "failed", step: status.setup.step, error: errorMessage(error) },
    }));
  }
}

/**
 * Gets a VM ready for the repository from the phone, reporting each step as it
 * goes. Resolves once its server is up; the checkout reports its own step after.
 */
export function startOnPhone(input: {
  readonly repositoryUrl: string;
  readonly baseBranch: string | null;
  readonly paired?: ReadonlyArray<PairedEnvironment> | undefined;
  /** The phone's `defaultMachineType` when absent. */
  readonly machineType?: BoatCloudMachineType | undefined;
  readonly report: ReportStep;
}): Promise<BoatCloudSession> {
  const repository = parseRepository(input.repositoryUrl);
  if (repository === null) {
    return Promise.reject(new Error("Boat cannot clone this project's remote."));
  }
  return run(
    Effect.gen(function* () {
      const api = yield* phoneApi;
      if (snapshotName === null) {
        snapshotName = startingSnapshot(yield* api.listSnapshots());
      }
      if (snapshotName === null) {
        return yield* new BoatApiError({
          status: 0,
          code: "no_snapshot",
          message: "Finish Boat setup in Settings, Environments.",
          retryable: false,
        });
      }
      const { environment, shareMachines, defaultMachineType } =
        appAtomRegistry.get(phoneBoatCloudAtom);
      const machineType = input.machineType ?? defaultMachineType;
      const started = yield* startMachine({
        api,
        repository,
        baseBranch: input.baseBranch,
        environment,
        snapshot: snapshotName,
        readySpare: yield* spares.take(snapshotName, environment, machineType),
        // The phone keeps no record of stopped VMs, so it resumes them only for load.
        knownWorkspaceRoots: () => [],
        paired: input.paired ?? [],
        shareMachines,
        machineType,
        report: input.report,
      });
      // The start may have taken the spare, so the next one is readied while this one checks out.
      yield* keepSpare(api, environment).pipe(Effect.forkDetach);
      return {
        sandboxId: started.sandboxId,
        environmentId: started.environmentId,
        httpBaseUrl: started.httpBaseUrl,
        pairingCode: started.pairingCode,
        workspaceRoot: started.workspaceRoot,
        worktree: started.worktree,
      };
    }),
  ).finally(() => void refreshPhoneBoatCloud());
}

/**
 * Turns the VM behind a paired URL back on. Its identity lives on its disk, so
 * the saved pairing reconnects without a new code. Fails when Boat deleted it.
 */
export function wakeOnPhone(httpBaseUrl: string) {
  return run(
    Effect.gen(function* () {
      const api = yield* phoneApi;
      const sandbox = yield* findSandboxByHttpBaseUrl(api, httpBaseUrl);
      if (sandbox === null) {
        return yield* new BoatApiError({
          status: 0,
          code: "gone",
          message: "Boat deleted this VM, and this phone keeps no copy of it.",
          retryable: false,
        });
      }
      return yield* wakeMachine(api, sandbox.id);
    }),
  );
}

/** Runs a change to one of this phone's VMs, then re-reads them. Tells the user what failed. */
function changePhoneMachine(
  title: string,
  change: (api: BoatApi) => Effect.Effect<unknown, BoatApiError>,
): Promise<void> {
  return run(Effect.flatMap(phoneApi, change))
    .then(
      () => undefined,
      (error: unknown) => Dialog.alert(title, errorMessage(error)),
    )
    .finally(() => void refreshPhoneBoatCloud());
}

/** Stops a VM this phone sees. The phone keeps no backups; the VM's disk stays with Boat. */
export function stopPhoneBoatCloudMachine(sandboxId: string): Promise<void> {
  return changePhoneMachine(m(msg("Could not stop the VM")), (api) => api.stop(sandboxId));
}

export function wakePhoneBoatCloudMachine(sandboxId: string): Promise<void> {
  return changePhoneMachine(m(msg("Could not wake the VM")), (api) => wakeMachine(api, sandboxId));
}

export function deletePhoneBoatCloudMachine(sandboxId: string): Promise<void> {
  return changePhoneMachine(m(msg("Could not delete the VM")), (api) => api.delete(sandboxId));
}
