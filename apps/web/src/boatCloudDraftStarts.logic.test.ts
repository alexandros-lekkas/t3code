import { describe, expect, it } from "vite-plus/test";

import { type DraftStart, makeDraftStarts } from "./boatCloudDraftStarts.logic";

/** Starts that each wait for the test to hand out a VM and then finish them. */
function setup() {
  const runs: Array<{
    readonly start: DraftStart<string>;
    readonly finish: (target: string | null) => void;
  }> = [];
  const released: Array<string> = [];
  const held: Array<string> = [];
  const starts = makeDraftStarts<null, string>({
    run: (_input, start) =>
      new Promise((resolve) => {
        runs.push({ start, finish: resolve });
      }),
    release: (sandboxId) => released.push(sandboxId),
    hold: (sandboxId) => held.push(sandboxId),
  });
  return { starts, runs, released, held };
}

describe("Boat cloud draft starts", () => {
  it("shares one start between a draft's pre-warms and its send", async () => {
    const { starts, runs } = setup();
    starts.begin("draft-1", "acme/app small", null);
    starts.begin("draft-1", "acme/app small", null);
    const sent = starts.prepare("draft-1", "acme/app small", null);
    expect(runs).toHaveLength(1);
    runs[0]!.start.handedOut("bx_1");
    runs[0]!.finish("target-1");
    expect(await sent).toBe("target-1");
    expect(runs).toHaveLength(1);
  });

  it("releases the VM of a start replaced by another size, once the holder hands it out", async () => {
    const { starts, runs, released } = setup();
    starts.begin("draft-1", "acme/app small", null);
    const sent = starts.prepare("draft-1", "acme/app default", null);
    expect(runs).toHaveLength(2);
    // The first start was given up before its VM was known, so the VM goes once it is.
    expect(runs[0]!.start.handedOut("bx_small")).toBe(false);
    runs[0]!.finish(null);
    runs[1]!.start.handedOut("bx_default");
    runs[1]!.finish("target-default");
    expect(await sent).toBe("target-default");
    expect(released).toEqual(["bx_small"]);
  });

  it("releases the VM of a start that failed after its hand-out, and starts again on send", async () => {
    const { starts, runs, released } = setup();
    starts.begin("draft-1", "acme/app small", null);
    runs[0]!.start.handedOut("bx_1");
    const sent = starts.prepare("draft-1", "acme/app small", null);
    runs[0]!.finish(null);
    // The send waited on this start first, so it has begun the next one by now.
    await runs[0]!.start.target;
    expect(released).toEqual(["bx_1"]);
    expect(runs).toHaveLength(2);
    runs[1]!.start.handedOut("bx_2");
    runs[1]!.finish("target-2");
    expect(await sent).toBe("target-2");
  });

  it("holds the VMs drafts still want, and releases the ones whose draft left Boat", async () => {
    const { starts, runs, released, held } = setup();
    starts.begin("waiting", "acme/app small", null);
    starts.begin("left", "acme/app small", null);
    starts.begin("sent", "acme/app small", null);
    runs.forEach((run, index) => run.start.handedOut(`bx_${index}`));
    const want = { waiting: "wanted", left: "gone", sent: "done" } as const;
    starts.hold((draftId) => want[draftId as keyof typeof want]);
    expect(held).toEqual(["bx_0"]);
    expect(released).toEqual(["bx_1"]);
    expect(starts.size()).toBe(1);
    // The sent draft's thread keeps its VM; giving up the last one releases it.
    starts.abandon("waiting");
    expect(released).toEqual(["bx_1", "bx_0"]);
    expect(starts.size()).toBe(0);
  });
});
