import type { BoatCloudCredit } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boatCreditView } from "./boatCredit";

const credit = (overrides: Partial<BoatCloudCredit> = {}): BoatCloudCredit => ({
  balanceSeconds: 6_338_940,
  planSeconds: 2_000_000,
  planRemainingSeconds: 1_838_940,
  planDollars: 20,
  periodEnd: "2026-12-18T20:01:05.000Z",
  purchasedRemainingSeconds: 4_500_000,
  usedSeconds: 184_312,
  last24hSeconds: 78_761,
  secondsPerDollar: 100_000,
  canStart: true,
  blockedReason: null,
  overage: { enabled: false, usedDollars: 0, capDollars: 80 },
  ...overrides,
});

describe("boatCreditView", () => {
  it("measures the plan's month against its grant and resets at the period end", () => {
    const view = boatCreditView(credit());
    expect(view.window.kind).toBe("monthly");
    expect(view.window.usedPercent).toBeCloseTo(8.05, 1);
    expect(view.window.resetsAt).toBe("2026-12-18T20:01:05.000Z");
    // November 18 to December 18: thirty days, so the pace mark has a window.
    expect(view.window.windowDurationMins).toBe(30 * 24 * 60);
    expect(view.windowSeconds).toBe(1_838_940);
    expect(view.afterSeconds).toBe(4_500_000);
    expect(view.daysLeft).toBeCloseTo(23.3, 1);
    expect(view.tone).toBe("ok");
    expect(view.overage).toBeNull();
  });

  it("falls back to all credit without a plan, and warns when it runs short", () => {
    const view = boatCreditView(
      credit({
        planSeconds: null,
        planRemainingSeconds: null,
        periodEnd: null,
        balanceSeconds: 100_000,
        usedSeconds: 900_000,
        last24hSeconds: 50_000,
      }),
    );
    expect(view.window.kind).toBe("other");
    expect(view.window.usedPercent).toBeCloseTo(90);
    expect(view.window.resetsAt).toBeUndefined();
    expect(view.tone).toBe("low");
  });

  it("is blocked when Boat cannot start, and shows enabled extra starts against their cap", () => {
    const view = boatCreditView(
      credit({
        canStart: false,
        blockedReason: "Plan limit reached",
        overage: { enabled: true, usedDollars: 20, capDollars: 80 },
      }),
    );
    expect(view.tone).toBe("blocked");
    // The bar fills with the $20 spent of the $80 cap.
    expect(view.overage?.window.usedPercent).toBe(75);
  });
});
