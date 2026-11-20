import type { BoatCloudCredit, ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { paceOf, paceRemainingPercent, remainingPercent } from "@t3tools/shared/usageLimits";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { AlertTriangleIcon, ExternalLinkIcon } from "lucide-react";
import { useGT, useLocale, useMessages } from "gt-react";

import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { BoatIcon } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { boatCreditView } from "./boatCredit";
import { PaceIcon, usePaceMark } from "./UsageLimits";
import { COMPUTE_PRESENTATION } from "./usageProviders";

/** Boat's dashboard, where the plan, wallet and billing live; the CLI links the same page. */
const BOAT_DASHBOARD_URL = "https://boat.dev/dashboard";

/** Boat's VM time left, in the same rows as the providers' limits: the month's grant and overage. */
export function BoatLimitsSection({
  credit,
  now,
  onOpenCost,
}: {
  readonly credit: BoatCloudCredit;
  readonly now: number;
  /** Opens the Cost view on Boat alone, as a provider's limit opens its usage. */
  readonly onOpenCost?: (() => void) | undefined;
}) {
  const gt = useGT();
  const locale = useLocale();
  const view = boatCreditView(credit);
  const amount = (seconds: number) =>
    gt("{dollars} · {hours} machine-hours", {
      dollars: formatUsd(seconds / credit.secondsPerDollar, locale),
      hours: (seconds / 3600).toLocaleString(locale, { maximumFractionDigits: 1 }),
    });
  const monthly = view.window.kind === "monthly";
  const hours = (seconds: number) =>
    (seconds / 3600).toLocaleString(locale, { maximumFractionDigits: 1 });
  const details = [
    monthly
      ? [
          credit.planDollars === null
            ? null
            : gt("{price}/month plan", { price: formatUsd(credit.planDollars, locale) }),
          gt("{left} of {grant} machine-hours left", {
            left: hours(view.windowSeconds),
            grant: hours(credit.planSeconds ?? 0),
          }),
          credit.periodEnd === null
            ? null
            : gt("renews {date}", {
                date: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
                  Date.parse(credit.periodEnd),
                ),
              }),
        ]
          .filter((part): part is string => part !== null)
          .join(" · ")
      : gt("{amount} left", { amount: amount(view.windowSeconds) }),
    view.daysLeft === null
      ? null
      : gt("At this rate, lasts ~{days} days", {
          days: Math.max(1, Math.round(view.daysLeft)).toLocaleString(locale),
        }),
  ].filter((line): line is string => line !== null);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span className="flex size-5 items-center justify-center">
            <BoatIcon aria-hidden className="size-4 text-foreground/80" />
          </span>
          {COMPUTE_PRESENTATION.label}
        </h2>
        <Button
          variant="ghost-muted"
          size="xs"
          onClick={() => void ensureLocalApi().shell.openExternal(BOAT_DASHBOARD_URL)}
        >
          {gt("Manage on Boat")}
          <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      {view.tone === "blocked" ? (
        <Alert variant="error" controlAlignment="first-line">
          <AlertTriangleIcon />
          <AlertTitle className="break-words">
            {credit.blockedReason ?? gt("Boat cannot start machines right now.")}
          </AlertTitle>
        </Alert>
      ) : null}
      <BoatLimitCard
        label={view.window.kind === "monthly" ? gt("Monthly") : gt("Credit")}
        // Without a plan's month, credit reads in money: there is no window to be a share of.
        figure={
          view.window.kind === "monthly"
            ? null
            : {
                value: formatUsd(view.windowSeconds / credit.secondsPerDollar, locale),
                unit: gt("{hours} machine-hours", {
                  hours: (view.windowSeconds / 3600).toLocaleString(locale, {
                    maximumFractionDigits: 0,
                  }),
                }),
              }
        }
        window={view.window}
        details={details}
        low={view.tone !== "ok"}
        now={now}
        onClick={onOpenCost}
      />
      {view.afterSeconds > 0 ? (
        <BoatFigureCard
          label={gt("Wallet")}
          figure={{
            value: formatUsd(view.afterSeconds / credit.secondsPerDollar, locale),
            unit: gt("{hours} machine-hours", {
              hours: (view.afterSeconds / 3600).toLocaleString(locale, {
                maximumFractionDigits: 0,
              }),
            }),
          }}
        />
      ) : null}
      {view.overage !== null ? (
        <BoatLimitCard
          label={gt("Overage")}
          figure={{
            value: formatUsd(view.overage.usedDollars, locale),
            unit: gt("of {cap}", { cap: formatUsd(view.overage.capDollars, locale) }),
          }}
          window={view.overage.window}
          details={[
            gt("Starts past your plan limit, billed to your card. Capped at {cap} this month.", {
              cap: formatUsd(view.overage.capDollars, locale),
            }),
          ]}
          low={false}
          now={now}
          onClick={onOpenCost}
        />
      ) : null}
    </section>
  );
}

/** A balance with no cap or period, such as the wallet: the same card, without a bar. */
function BoatFigureCard({
  label,
  figure,
}: {
  readonly label: string;
  readonly figure: { readonly value: string; readonly unit: string };
}) {
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {figure.value}
          </span>
          <span className="text-sm whitespace-nowrap text-muted-foreground">{figure.unit}</span>
        </span>
      </div>
    </div>
  );
}

/** The providers' limit card, with Boat's colour and its figures in the bar's tooltip. */
function BoatLimitCard({
  label,
  figure,
  window,
  details,
  low,
  now,
  onClick,
}: {
  readonly onClick?: (() => void) | undefined;
  readonly label: string;
  /** A money figure in place of the percentage; the bar stays as the visual. */
  readonly figure: { readonly value: string; readonly unit: string } | null;
  readonly window: ServerProviderUsageWindow;
  readonly details: readonly string[];
  readonly low: boolean;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const color = COMPUTE_PRESENTATION.color;
  const remaining = remainingPercent(window);
  const pace = paceOf(window, now);
  const [barRef, paceMark] = usePaceMark(paceRemainingPercent(window, now));
  const resetsIn = formatResetsIn(window, now, m);
  const refillIn = formatResetsIn(window, now, m, "refill");
  const headline = figure
    ? gt("{label}: {value} {unit}", { label, value: figure.value, unit: figure.unit })
    : gt("{label}: {remaining}% left", { label, remaining });
  const summary = [headline, resetsIn, ...details].filter(Boolean).join(", ");
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-3xl font-semibold tabular-nums",
              low ? "text-warning-foreground" : "text-foreground",
            )}
          >
            {figure?.value ?? `${remaining}%`}
          </span>
          <span className="inline-flex items-center gap-2 text-sm whitespace-nowrap text-muted-foreground">
            <span>{figure?.unit ?? gt("left", { $context: "remaining usage percentage" })}</span>
            {pace && figure === null ? <PaceIcon pace={pace} /> : null}
          </span>
        </span>
      </div>
      <div className="@container/pool min-w-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                ref={barRef}
                type="button"
                aria-label={summary}
                onClick={onClick}
                style={paceMark?.gappedTrack}
                className="relative block h-5 w-full min-w-0 cursor-pointer rounded-md bg-muted text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background @2xl/pool:h-8"
              />
            }
          >
            <div aria-hidden className="absolute inset-0 overflow-hidden rounded-md">
              <div className="absolute inset-0" style={paceMark?.gap}>
                <div
                  className="absolute inset-y-0 left-0 rounded-md opacity-35"
                  style={{ width: `${remaining}%`, backgroundColor: color }}
                />
                {figure === null && remaining < 100 && window.resetsAt !== undefined ? (
                  <div
                    className="absolute inset-y-0 right-0 opacity-20"
                    style={{
                      width: `${100 - remaining}%`,
                      backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1px, transparent 1px 5px)`,
                    }}
                  />
                ) : null}
              </div>
            </div>
            {paceMark ? (
              <span
                aria-hidden
                className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
                style={paceMark.tick}
              />
            ) : null}
            {refillIn ? (
              <div className="relative hidden h-full min-w-0 items-center overflow-hidden rounded-md px-2 text-xs @2xl/pool:flex">
                <span className="ms-auto shrink-0 rounded-sm bg-background/85 px-1.5 py-0.5 text-2xs whitespace-nowrap text-foreground tabular-nums">
                  {refillIn}
                </span>
              </div>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top">
            <div className="flex flex-col gap-0.5">
              <span className="text-foreground">
                {resetsIn
                  ? gt("{remaining}% left · {resetsIn}", { remaining, resetsIn })
                  : gt("{remaining}% left", { remaining })}
              </span>
              {details.map((line) => (
                <span key={line} className="text-muted-foreground">
                  {line}
                </span>
              ))}
            </div>
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
