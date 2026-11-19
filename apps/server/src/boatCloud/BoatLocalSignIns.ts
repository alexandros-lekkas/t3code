import {
  BoatCloudError,
  type BoatCloudClaudeTokenFlow,
  type BoatCloudClaudeTokenInput,
  type BoatCloudLocalSignIn,
} from "@t3tools/contracts";
import type { VmAgentSignIns } from "@t3tools/shared/boatCloudVm";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProcessRunner from "../processRunner.ts";

/**
 * The holder machine's own Claude and Codex sign-ins, which the Boat VMs it starts get when
 * the Boat profile has none for that provider. Values stay in this server: clients see only
 * which providers and where from, and the VM gets them inside the command that starts it.
 */

const CLAUDE_TOKEN_SECRET = "boat-cloud-claude-token";
/** A login's access token is passed only while it has this long left. */
const LOGIN_MARGIN_MS = 15 * 60 * 1000;
const TOKEN_FLOW_TIMEOUT = Duration.minutes(10);
// Only a token followed by another character is whole: output arrives in chunks.
const CLAUDE_TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/u;
const SIGN_IN_URL = /https:\/\/\S+oauth\S*/u;
// CSI, OSC (hyperlinks) and single-character escapes, which Ink's output is full of.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;

const ClaudeCredentials = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      accessToken: Schema.optional(Schema.String),
      expiresAt: Schema.optional(Schema.Number),
    }),
  ),
});
const decodeClaudeCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeCredentials),
);

const CodexAuth = Schema.Struct({
  auth_mode: Schema.optional(Schema.NullOr(Schema.String)),
  OPENAI_API_KEY: Schema.optional(Schema.NullOr(Schema.String)),
  tokens: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id_token: Schema.String,
        access_token: Schema.String,
        account_id: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const decodeCodexAuth = Schema.decodeUnknownOption(Schema.fromJsonString(CodexAuth));
const decodeJwtPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ exp: Schema.optional(Schema.Number) })),
);

/** What this machine has, as read. Every value is a secret. */
export interface LocalSignInSources {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The long-lived token `claude setup-token` made, which T3 Code keeps. */
  readonly storedClaudeToken: string | null;
  /** Claude Code's credentials JSON, from the macOS Keychain or `.credentials.json`. */
  readonly claudeLogin: string | null;
  /** Codex's `auth.json`. */
  readonly codexAuth: string | null;
  readonly nowMs: number;
}

export interface DiscoveredSignIns {
  readonly summary: ReadonlyArray<BoatCloudLocalSignIn>;
  readonly vm: VmAgentSignIns;
}

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const nonEmpty = (value: string | null | undefined) =>
  value === null || value === undefined || value.trim() === "" ? null : value.trim();

const jwtExpiresAtMs = (token: string): number | null => {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  const exp = Option.getOrUndefined(
    decodeJwtPayload(Buffer.from(payload, "base64url").toString("utf8")),
  )?.exp;
  return exp === undefined ? null : exp * 1000;
};

/**
 * Picks each provider's sign-in, longest-lived first. A login is passed without its refresh
 * token, so the VM never refreshes it and this machine's own session is never signed out.
 */
export function discoverLocalSignIns(sources: LocalSignInSources): DiscoveredSignIns {
  const summary: Array<BoatCloudLocalSignIn> = [];
  const usable = (expiresAtMs: number | null) =>
    expiresAtMs === null || expiresAtMs - sources.nowMs > LOGIN_MARGIN_MS;

  let claude: Record<string, string> | null = null;
  const storedToken = nonEmpty(sources.storedClaudeToken);
  const environmentToken = nonEmpty(sources.environment.CLAUDE_CODE_OAUTH_TOKEN);
  const environmentKey = nonEmpty(sources.environment.ANTHROPIC_API_KEY);
  if (storedToken !== null) {
    claude = { CLAUDE_CODE_OAUTH_TOKEN: storedToken };
    summary.push({ driver: "claudeAgent", source: "token", expiresAt: null });
  } else if (environmentToken !== null || environmentKey !== null) {
    claude =
      environmentToken !== null
        ? { CLAUDE_CODE_OAUTH_TOKEN: environmentToken }
        : { ANTHROPIC_API_KEY: environmentKey! };
    summary.push({ driver: "claudeAgent", source: "environment", expiresAt: null });
  } else if (sources.claudeLogin !== null) {
    const oauth = Option.getOrUndefined(
      decodeClaudeCredentials(sources.claudeLogin),
    )?.claudeAiOauth;
    const accessToken = nonEmpty(oauth?.accessToken);
    const expiresAtMs = oauth?.expiresAt ?? null;
    if (accessToken !== null && expiresAtMs !== null && usable(expiresAtMs)) {
      claude = { CLAUDE_CODE_OAUTH_TOKEN: accessToken };
      summary.push({ driver: "claudeAgent", source: "login", expiresAt: isoOf(expiresAtMs) });
    }
  }

  let codex: VmAgentSignIns["codex"] = null;
  const environmentOpenAi = nonEmpty(sources.environment.OPENAI_API_KEY);
  if (environmentOpenAi !== null) {
    codex = { environment: { OPENAI_API_KEY: environmentOpenAi } };
    summary.push({ driver: "codex", source: "environment", expiresAt: null });
  } else if (sources.codexAuth !== null) {
    const auth = Option.getOrUndefined(decodeCodexAuth(sources.codexAuth));
    const apiKey = nonEmpty(auth?.OPENAI_API_KEY);
    const tokens = auth?.tokens;
    if (apiKey !== null) {
      codex = { environment: { OPENAI_API_KEY: apiKey } };
      summary.push({ driver: "codex", source: "login", expiresAt: null });
    } else if (tokens) {
      const expiresAtMs = jwtExpiresAtMs(tokens.access_token);
      if (expiresAtMs !== null && usable(expiresAtMs)) {
        codex = {
          // Codex needs the field; empty, a refresh on the VM fails instead of rotating this machine's token.
          authFile: JSON.stringify({
            auth_mode: auth?.auth_mode ?? "chatgpt",
            OPENAI_API_KEY: null,
            tokens: {
              id_token: tokens.id_token,
              access_token: tokens.access_token,
              refresh_token: "",
              account_id: tokens.account_id ?? null,
            },
            last_refresh: isoOf(sources.nowMs),
          }),
        };
        summary.push({ driver: "codex", source: "login", expiresAt: isoOf(expiresAtMs) });
      }
    }
  }
  return { summary, vm: { claude, codex } };
}

/** Claude Code's Keychain item: a config directory set in its environment is hashed into the name. */
export const claudeKeychainService = (configDirectorySha256Hex: string | null) =>
  configDirectorySha256Hex === null
    ? "Claude Code-credentials"
    : `Claude Code-credentials-${configDirectorySha256Hex.slice(0, 8)}`;

/** The token `claude setup-token` printed, once its output holds it. */
export function claudeSetupTokenOutput(output: string) {
  const text = output.replace(ANSI, "");
  return {
    token: CLAUDE_TOKEN.exec(text)?.[0] ?? null,
    url: SIGN_IN_URL.exec(text)?.[0] ?? null,
  };
}

export interface LocalSignInsState {
  readonly available: ReadonlyArray<BoatCloudLocalSignIn>;
  readonly claudeTokenStored: boolean;
  readonly claudeTokenFlow: BoatCloudClaudeTokenFlow | null;
}

export class BoatLocalSignIns extends Context.Service<
  BoatLocalSignIns,
  {
    /** What this machine has, without values. */
    readonly state: Stream.Stream<LocalSignInsState>;
    readonly current: Effect.Effect<LocalSignInsState>;
    /** Reads this machine's sign-ins again. */
    readonly refresh: Effect.Effect<void>;
    /** The values for a VM, read now. */
    readonly forVm: Effect.Effect<VmAgentSignIns>;
    readonly claudeToken: (input: BoatCloudClaudeTokenInput) => Effect.Effect<void, BoatCloudError>;
  }
>()("t3/boatCloud/BoatLocalSignIns") {}

const textDecoder = new TextDecoder();

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const pty = yield* PtyAdapter.PtyAdapter;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const digest = yield* Digest.Digest;
  const scope = yield* Effect.scope;

  const configuredClaudeDirectory = nonEmpty(environment.CLAUDE_CONFIG_DIR);
  const claudeDirectory =
    configuredClaudeDirectory === null
      ? path.join(home, ".claude")
      : path.resolve(configuredClaudeDirectory);
  const codexDirectory = path.resolve(
    nonEmpty(environment.CODEX_HOME) ?? path.join(home, ".codex"),
  );
  const keychainService =
    configuredClaudeDirectory === null
      ? claudeKeychainService(null)
      : claudeKeychainService(
          yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(claudeDirectory)),
        );
  const readText = (filePath: string) =>
    fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));

  const readStoredToken = secrets.get(CLAUDE_TOKEN_SECRET).pipe(
    Effect.map((value) => (Option.isSome(value) ? textDecoder.decode(value.value) : null)),
    Effect.orElseSucceed(() => null),
  );
  // Claude Code reads the Keychain item with this same command, so no access prompt shows.
  const readClaudeKeychain =
    platform === "darwin"
      ? runner
          .run({
            command: "security",
            args: ["find-generic-password", "-s", keychainService, "-w"],
            timeout: Duration.seconds(5),
          })
          .pipe(
            Effect.map((output) => (output.code === 0 ? nonEmpty(output.stdout) : null)),
            Effect.orElseSucceed(() => null),
          )
      : Effect.succeed(null);
  const readClaudeLogin = readClaudeKeychain.pipe(
    Effect.filterOrElse(
      (fromKeychain): fromKeychain is string => fromKeychain !== null,
      () => readText(path.join(claudeDirectory, ".credentials.json")),
    ),
  );

  const discover = Effect.fn("BoatLocalSignIns.discover")(function* () {
    const [storedClaudeToken, claudeLogin, codexAuth, nowMs] = yield* Effect.all(
      [
        readStoredToken,
        readClaudeLogin,
        readText(path.join(codexDirectory, "auth.json")),
        Effect.clockWith((clock) => clock.currentTimeMillis),
      ],
      { concurrency: "unbounded" },
    );
    return {
      discovered: discoverLocalSignIns({
        environment,
        storedClaudeToken,
        claudeLogin,
        codexAuth,
        nowMs,
      }),
      claudeTokenStored: storedClaudeToken !== null,
    };
  });

  const stateRef = yield* SubscriptionRef.make<LocalSignInsState>({
    available: [],
    claudeTokenStored: false,
    claudeTokenFlow: null,
  });
  const refresh = discover().pipe(
    Effect.flatMap(({ discovered, claudeTokenStored }) =>
      SubscriptionRef.update(stateRef, (current) => ({
        ...current,
        available: discovered.summary,
        claudeTokenStored,
      })),
    ),
  );
  const setFlow = (flow: BoatCloudClaudeTokenFlow | null) =>
    SubscriptionRef.update(stateRef, (current) => ({ ...current, claudeTokenFlow: flow }));

  // A Claude Code session that launched T3 exports these, and a claude started with them joins it.
  const flowEnvironment = Object.fromEntries(
    Object.entries({ ...environment, TERM: "xterm-256color" }).filter(
      ([name]) => name !== "CLAUDECODE" && !name.startsWith("CLAUDE_CODE_"),
    ),
  );

  let flowFiber: Fiber.Fiber<void> | null = null;
  let flowProcess: PtyAdapter.PtyProcess | null = null;

  /** Runs `claude setup-token` in a terminal until it prints the token, which only this server reads. */
  const runTokenFlow = Effect.gen(function* () {
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const process = yield* pty.spawn({
      shell: "claude",
      args: ["setup-token"],
      cwd: home,
      // Wide enough that Ink never wraps the URL or the token.
      cols: 1000,
      rows: 50,
      env: flowEnvironment,
    });
    flowProcess = process;
    const token = yield* Effect.callback<string, BoatCloudError>((resume) => {
      let output = "";
      let shownUrl: string | null = null;
      const offData = process.onData((data) => {
        output = (output + data).slice(-65_536);
        const parsed = claudeSetupTokenOutput(output);
        if (parsed.token !== null) {
          resume(Effect.succeed(parsed.token));
        } else if (parsed.url !== null && parsed.url !== shownUrl) {
          shownUrl = parsed.url;
          runFork(setFlow({ state: "running", url: parsed.url, error: null }));
        }
      });
      const offExit = process.onExit(() =>
        resume(Effect.fail(new BoatCloudError({ message: "Claude did not create a token." }))),
      );
      return Effect.sync(() => {
        offData();
        offExit();
        process.kill();
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: TOKEN_FLOW_TIMEOUT,
        orElse: () =>
          Effect.fail(new BoatCloudError({ message: "The Claude sign-in took too long." })),
      }),
    );
    yield* secrets
      .set(CLAUDE_TOKEN_SECRET, new TextEncoder().encode(token))
      .pipe(
        Effect.mapError(() => new BoatCloudError({ message: "Could not save the Claude token." })),
      );
    yield* setFlow(null);
  }).pipe(
    Effect.catch((error) =>
      setFlow({
        state: "failed",
        url: null,
        error:
          error._tag === "BoatCloudError" ? error.message : "Could not run `claude setup-token`.",
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        flowProcess = null;
      }).pipe(Effect.andThen(refresh)),
    ),
  );

  const cancelFlow = Effect.suspend(() => {
    const fiber = flowFiber;
    flowFiber = null;
    return fiber === null ? Effect.void : Fiber.interrupt(fiber);
  });

  const claudeToken = Effect.fn("BoatLocalSignIns.claudeToken")(function* (
    input: BoatCloudClaudeTokenInput,
  ) {
    switch (input.action) {
      case "create":
        yield* cancelFlow;
        yield* setFlow({ state: "running", url: null, error: null });
        flowFiber = yield* runTokenFlow.pipe(Effect.forkIn(scope));
        return;
      case "code": {
        const process = flowProcess;
        if (process === null) {
          return yield* new BoatCloudError({ message: "No Claude sign-in is waiting for a code." });
        }
        process.write(`${input.code}\r`);
        return;
      }
      case "cancel":
        yield* cancelFlow;
        yield* setFlow(null);
        return;
      case "remove":
        yield* secrets
          .remove(CLAUDE_TOKEN_SECRET)
          .pipe(
            Effect.mapError(
              () => new BoatCloudError({ message: "Could not remove the Claude token." }),
            ),
          );
        yield* refresh;
        return;
    }
  });

  yield* refresh.pipe(Effect.forkIn(scope));

  return BoatLocalSignIns.of({
    state: SubscriptionRef.changes(stateRef),
    current: SubscriptionRef.get(stateRef),
    refresh,
    forVm: discover().pipe(Effect.map(({ discovered }) => discovered.vm)),
    claudeToken,
  });
});

export const layer = Layer.effect(BoatLocalSignIns, make).pipe(Layer.provide(ProcessRunner.layer));

/** Fixed sign-ins with dummy values, for tests and the fake Boat. */
export const layerStatic = (present: boolean) =>
  Layer.effect(
    BoatLocalSignIns,
    Effect.gen(function* () {
      const discovered = discoverLocalSignIns({
        environment: present
          ? { CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-token", OPENAI_API_KEY: "fake-openai-key" }
          : {},
        storedClaudeToken: null,
        claudeLogin: null,
        codexAuth: null,
        nowMs: 0,
      });
      const stateRef = yield* SubscriptionRef.make<LocalSignInsState>({
        available: discovered.summary,
        claudeTokenStored: false,
        claudeTokenFlow: null,
      });
      return BoatLocalSignIns.of({
        state: SubscriptionRef.changes(stateRef),
        current: SubscriptionRef.get(stateRef),
        refresh: Effect.void,
        forVm: Effect.succeed(discovered.vm),
        claudeToken: Effect.fn("BoatLocalSignIns.claudeToken")(function* () {
          return yield* new BoatCloudError({ message: "This machine cannot make a Claude token." });
        }),
      });
    }),
  );
