import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { makeBoatApi } from "./boatCloudApi.ts";

const commandResult = { exitCode: 0, stdout: "ok" };

describe("BoatApi.exec", () => {
  it.effect("does not resend a command after the connection drops", () =>
    Effect.gen(function* () {
      let requests = 0;
      const http = HttpClient.make((request) =>
        Effect.suspend(() => {
          requests += 1;
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: new Error("reset") }),
            }),
          );
        }),
      );
      const error = yield* Effect.flip(makeBoatApi(http, "key").exec("box", "echo hi"));
      assert.strictEqual(error.code, "network");
      assert.strictEqual(requests, 1);
    }),
  );

  it.effect("retries a command Boat refused because the VM was still starting", () =>
    Effect.gen(function* () {
      let requests = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests += 1;
          return HttpClientResponse.fromWeb(
            request,
            requests === 1
              ? Response.json({ code: "sandbox_starting", message: "starting" }, { status: 409 })
              : Response.json(commandResult),
          );
        }),
      );
      const fiber = yield* Effect.forkChild(makeBoatApi(http, "key").exec("box", "echo hi"));
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.stdout, "ok");
      assert.strictEqual(requests, 2);
    }),
  );
});

describe("BoatApi.usage", () => {
  it.effect("reads Boat's billed seconds and dollars for one VM", () =>
    Effect.gen(function* () {
      let requested = "";
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requested = request.url + (request.urlParams.params.length > 0 ? "?" : "");
          requested += request.urlParams.params.map(([key, value]) => `${key}=${value}`).join("&");
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              ok: true,
              type: "sandbox.usage",
              sandboxId: "bx_1",
              sandboxType: "default",
              billingMultiplier: 1,
              since: "2026-11-18T03:14:44.234Z",
              until: "2026-11-19T18:04:13.959Z",
              seconds: 102596,
              dollars: 1.02596,
              secondsPerDollar: 100000,
              running: true,
            }),
          );
        }),
      );
      const usage = yield* makeBoatApi(http, "key").usage("bx_1", {
        since: "2026-11-18T00:00:00Z",
      });
      assert.strictEqual(
        requested,
        "https://boat.dev/api/v1/sandboxes/bx_1/usage?since=2026-11-18T00:00:00Z",
      );
      assert.strictEqual(usage?.seconds, 102596);
      assert.strictEqual(usage?.dollars, 1.02596);
      assert.strictEqual(usage?.sandboxType, "default");
    }),
  );

  it.effect("is null for a VM Boat no longer has", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ code: "not_found", message: "not_found" }, { status: 404 }),
          ),
        ),
      );
      assert.strictEqual(yield* makeBoatApi(http, "key").usage("bx_gone"), null);
    }),
  );
});
