import { useAtomValue } from "@effect/atom-react";
import type { BoatCloudStartStep, BoatCloudStepProgress } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { CircleCheckIcon, CircleDotIcon, CircleIcon, CircleXIcon } from "lucide-react";

import { boatCloudStartProgressAtom, clearBoatCloudStartProgress } from "../../boatCloud";
import type { DraftId, DraftSessionState } from "../../composerDraftStore";
import { cn } from "../../lib/utils";
import { BoatIcon } from "../Icons";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const STEP_LABELS: Record<BoatCloudStartStep, string> = {
  machine: msg("Finding a VM"),
  server: msg("Starting T3 Code"),
  repository: msg("Cloning or updating the repository"),
  connect: msg("Connecting"),
  project: msg("Opening the project"),
  thread: msg("Starting the thread"),
};

const WAKING_MACHINE_LABEL = msg("Waking the VM");

const STEP_STATE_LABELS: Record<BoatCloudStepProgress["state"], string> = {
  pending: msg("Pending"),
  active: msg("In progress"),
  done: msg("Done"),
  failed: msg("Failed"),
};

// Static on purpose: a start can take a minute, and a spinner repaints the whole time.
function StepIcon({ state }: { readonly state: BoatCloudStepProgress["state"] }) {
  switch (state) {
    case "done":
      return <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />;
    case "failed":
      return <CircleXIcon aria-hidden className="size-3.5 shrink-0 text-destructive-foreground" />;
    case "active":
      return <CircleDotIcon aria-hidden className="size-3.5 shrink-0 text-foreground" />;
    case "pending":
      return <CircleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

/** The checklist of a Boat cloud start or wake. */
export function BoatCloudSteps({
  steps,
  waking = false,
}: {
  readonly steps: ReadonlyArray<BoatCloudStepProgress>;
  readonly waking?: boolean;
}) {
  const m = useMessages();
  return (
    <ol className="grid gap-1 py-0.5">
      {steps.map((entry) => (
        <li
          key={entry.step}
          data-boat-cloud-step={entry.step}
          data-state={entry.state}
          className="flex min-w-0 items-center gap-2 text-xs"
        >
          <StepIcon state={entry.state} />
          <span className="sr-only">{m(STEP_STATE_LABELS[entry.state])}:</span>
          <span
            className={cn(
              "truncate",
              entry.state === "pending" ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {m(waking && entry.step === "machine" ? WAKING_MACHINE_LABEL : STEP_LABELS[entry.step])}
          </span>
          {entry.detail ? (
            <span className="truncate text-muted-foreground">{entry.detail}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * A Boat cloud start runs quietly behind the composer from the moment Boat cloud is picked.
 * Once a message waits on it, its checklist shows above the composer; a failure stays until dismissed.
 */
export function useBoatCloudStartBanner(
  draftId: DraftId | null,
  draftThread: DraftSessionState | null,
): ComposerBannerStackItem | null {
  const gt = useGT();
  const progress = useAtomValue(boatCloudStartProgressAtom(draftId ?? ""));
  if (
    draftId === null ||
    progress === null ||
    draftThread?.environmentSelection !== "cloud" ||
    draftThread.promotedTo
  ) {
    return null;
  }
  const failed = progress.error !== null;
  if (!failed && progress.sent === null) return null;
  return {
    id: `boat-cloud-start:${draftId}`,
    group: "environment",
    variant: failed ? "error" : "info",
    icon: <BoatIcon aria-hidden />,
    title: failed ? gt("Could not start on Boat cloud") : gt("Starting on Boat cloud"),
    ...(failed
      ? {
          description: progress.error,
          dismissLabel: gt("Dismiss"),
          onDismiss: () => clearBoatCloudStartProgress(draftId),
        }
      : {}),
    children: <BoatCloudSteps steps={progress.steps} />,
  };
}
