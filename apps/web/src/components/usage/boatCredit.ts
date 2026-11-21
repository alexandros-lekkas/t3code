import type { BoatCloudCredit, ServerProviderUsageWindow } from "@t3tools/contracts";

/** Below this many days at the last day's rate, or this share of the month's grant, Boat warns. */
const LOW_DAYS = 3;
const LOW_SHARE = 0.1;

export interface BoatCreditView {
  /**
   * The bar: the plan's monthly grant, which resets at the period end, or without a plan all
   * credit Boat counted, which never resets.
   */
  readonly window: ServerProviderUsageWindow;
  readonly windowSeconds: number;
  /** Bought credit Boat spends after the month's grant; 0 when the bar is all credit. */
  readonly afterSeconds: number;
  /** How long the bar's balance lasts at the last 24 hours' rate; null while nothing ran. */
  readonly daysLeft: number | null;
  readonly tone: "ok" | "low" | "blocked";
  readonly overage: {
    readonly window: ServerProviderUsageWindow;
    readonly usedDollars: number;
    readonly capDollars: number;
  } | null;
}

const usedPercentOf = (left: number, total: number) =>
  total <= 0 ? 100 : Math.min(100, Math.max(0, (1 - left / total) * 100));

/** Boat names only the period's end; the month before it is its length, for the pace mark. */
function monthMinutesBefore(periodEnd: string): number | undefined {
  const end = Date.parse(periodEnd);
  if (!Number.isFinite(end)) return undefined;
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return Math.round((end - start.getTime()) / 60_000);
}

function periodOf(periodEnd: string | null) {
  if (periodEnd === null) return {};
  const minutes = monthMinutesBefore(periodEnd);
  return minutes === undefined
    ? { resetsAt: periodEnd }
    : { resetsAt: periodEnd, windowDurationMins: minutes };
}

export function boatCreditView(credit: BoatCloudCredit): BoatCreditView {
  const hasPlan =
    credit.planSeconds !== null && credit.planSeconds > 0 && credit.planRemainingSeconds !== null;
  const window: ServerProviderUsageWindow = hasPlan
    ? {
        id: "boat-monthly",
        kind: "monthly",
        // The rows name themselves; the window label only keys it.
        label: "boat-monthly",
        usedPercent: usedPercentOf(credit.planRemainingSeconds ?? 0, credit.planSeconds ?? 0),
        ...periodOf(credit.periodEnd),
      }
    : {
        id: "boat-credit",
        kind: "other",
        label: "boat-credit",
        usedPercent: usedPercentOf(
          credit.balanceSeconds,
          credit.balanceSeconds + credit.usedSeconds,
        ),
      };
  const windowSeconds = hasPlan ? (credit.planRemainingSeconds ?? 0) : credit.balanceSeconds;
  const daysLeft = credit.last24hSeconds > 0 ? windowSeconds / credit.last24hSeconds : null;
  // Low means everything left runs short, the wallet included, not just this month's grant.
  const allDaysLeft =
    credit.last24hSeconds > 0 ? credit.balanceSeconds / credit.last24hSeconds : null;
  const low =
    credit.balanceSeconds <
      (hasPlan ? (credit.planSeconds ?? 0) : credit.balanceSeconds + credit.usedSeconds) *
        LOW_SHARE ||
    (allDaysLeft !== null && allDaysLeft < LOW_DAYS);
  const overage =
    credit.overage !== null && credit.overage.enabled && credit.overage.capDollars > 0
      ? {
          window: {
            id: "boat-overage",
            kind: "monthly" as const,
            label: "boat-overage",
            // Overage reads as money spent, so its bar fills with what was spent.
            usedPercent: usedPercentOf(credit.overage.usedDollars, credit.overage.capDollars),
            ...(credit.periodEnd === null ? {} : { resetsAt: credit.periodEnd }),
          },
          usedDollars: credit.overage.usedDollars,
          capDollars: credit.overage.capDollars,
        }
      : null;
  return {
    window,
    windowSeconds,
    afterSeconds: hasPlan ? credit.purchasedRemainingSeconds : 0,
    daysLeft,
    tone: !credit.canStart ? "blocked" : low ? "low" : "ok",
    overage,
  };
}
