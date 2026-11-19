import { assert, describe, it } from "@effect/vitest";

import {
  claudeKeychainService,
  claudeSetupTokenOutput,
  discoverLocalSignIns,
} from "./BoatLocalSignIns.ts";

const NOW = Date.UTC(2026, 10, 19, 12);
const HOUR = 60 * 60 * 1000;

const jwt = (expMs: number) =>
  `header.${Buffer.from(JSON.stringify({ exp: expMs / 1000 })).toString("base64url")}.signature`;

const claudeLogin = (expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "dummy-access",
      refreshToken: "dummy-refresh",
      expiresAt,
    },
  });

const codexLogin = (expMs: number) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "dummy-id",
      access_token: jwt(expMs),
      refresh_token: "dummy-codex-refresh",
      account_id: "dummy-account",
    },
    last_refresh: "2026-11-16T00:00:00Z",
  });

const discover = (sources: Partial<Parameters<typeof discoverLocalSignIns>[0]>) =>
  discoverLocalSignIns({
    environment: {},
    storedClaudeToken: null,
    claudeLogin: null,
    codexAuth: null,
    nowMs: NOW,
    ...sources,
  });

describe("discoverLocalSignIns", () => {
  it("prefers the long-lived token, then the environment, then the login", () => {
    const all = {
      environment: { CLAUDE_CODE_OAUTH_TOKEN: "dummy-env-token", ANTHROPIC_API_KEY: "dummy-key" },
      claudeLogin: claudeLogin(NOW + 8 * HOUR),
    };
    assert.deepStrictEqual(discover({ ...all, storedClaudeToken: "dummy-stored" }).vm.claude, {
      CLAUDE_CODE_OAUTH_TOKEN: "dummy-stored",
    });
    assert.deepStrictEqual(discover(all).vm.claude, { CLAUDE_CODE_OAUTH_TOKEN: "dummy-env-token" });
    assert.deepStrictEqual(
      discover({ ...all, environment: { ANTHROPIC_API_KEY: "dummy-key" } }).vm.claude,
      { ANTHROPIC_API_KEY: "dummy-key" },
    );
    const login = discover({ claudeLogin: all.claudeLogin });
    assert.deepStrictEqual(login.vm.claude, { CLAUDE_CODE_OAUTH_TOKEN: "dummy-access" });
    assert.deepStrictEqual(login.summary, [
      { driver: "claudeAgent", source: "login", expiresAt: "2026-11-19T20:00:00.000Z" },
    ]);
  });

  it("never passes a refresh token, nor a login about to expire", () => {
    const codex = discover({ codexAuth: codexLogin(NOW + 48 * HOUR) });
    assert.ok(codex.vm.codex !== null && "authFile" in codex.vm.codex);
    const file = JSON.parse(codex.vm.codex.authFile);
    assert.strictEqual(file.tokens.refresh_token, "");
    assert.strictEqual(file.tokens.access_token, jwt(NOW + 48 * HOUR));
    assert.notInclude(codex.vm.codex.authFile, "dummy-codex-refresh");
    assert.notInclude(
      JSON.stringify(discover({ claudeLogin: claudeLogin(NOW + HOUR) })),
      "refresh",
    );

    const expiring = discover({
      claudeLogin: claudeLogin(NOW + 5 * 60 * 1000),
      codexAuth: codexLogin(NOW - HOUR),
    });
    assert.deepStrictEqual(expiring.summary, []);
    assert.deepStrictEqual(expiring.vm, { claude: null, codex: null });
  });

  it("passes an OpenAI key as a variable and lists no values", () => {
    const keyed = discover({
      codexAuth: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "dummy-openai" }),
    });
    assert.deepStrictEqual(keyed.vm.codex, { environment: { OPENAI_API_KEY: "dummy-openai" } });
    assert.notInclude(JSON.stringify(keyed.summary), "dummy");
    assert.deepStrictEqual(discover({ codexAuth: "not json" }).vm.codex, null);
  });
});

describe("claudeKeychainService", () => {
  it("names Claude Code's Keychain item, hashed per config directory", () => {
    assert.strictEqual(claudeKeychainService(null), "Claude Code-credentials");
    assert.strictEqual(claudeKeychainService("cf3106f3abcdef"), "Claude Code-credentials-cf3106f3");
  });
});

describe("claudeSetupTokenOutput", () => {
  it("finds the sign-in page and a whole token through terminal escapes", () => {
    const url = "https://claude.ai/oauth/authorize?code=true&client_id=dummy";
    const token = `sk-ant-oat01-${"a".repeat(40)}`;
    assert.deepStrictEqual(
      claudeSetupTokenOutput(`\u001b[2K\u001b[1mVisit:\u001b[22m ${url}\r\n`),
      {
        token: null,
        url,
      },
    );
    // Output arrives in chunks: a token not yet followed by anything may be cut off.
    assert.isNull(claudeSetupTokenOutput(token.slice(0, 45)).token);
    assert.strictEqual(claudeSetupTokenOutput(`\u001b[32m${token}\u001b[39m\r\n`).token, token);
  });
});
