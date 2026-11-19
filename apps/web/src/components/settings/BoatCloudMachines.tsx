import type { BoatCloudMachine, BoatCloudStatus, EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useQuietThreadShells } from "../../state/entities";
import { useOpenedBoatCloudThreadRefs } from "../../state/boatCloudThreads";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { formatBoatCloudCost, useBoatCloudSizeLine } from "../BoatCloudSizeSelector";
import { BoatIcon } from "../Icons";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsRow } from "./settingsLayout";

const MACHINE_STATE: Record<
  BoatCloudMachine["state"],
  { readonly label: string; readonly variant: "success" | "info" | "secondary" | "warning" }
> = {
  running: { label: msg("Running", { $context: "VM state" }), variant: "success" },
  starting: { label: msg("Waking", { $context: "VM state" }), variant: "info" },
  stopped: { label: msg("Sleeping", { $context: "VM state" }), variant: "secondary" },
  gone: { label: msg("Saved copy", { $context: "VM state" }), variant: "warning" },
};

/** Stop, wake, delete and refresh for the VMs; null while the holder's server has none. */
export interface BoatCloudMachineActions {
  readonly stop: (sandboxId: string) => Promise<unknown>;
  readonly wake: (sandboxId: string) => Promise<unknown>;
  readonly remove: (sandboxId: string) => Promise<unknown>;
  readonly refresh: () => Promise<unknown>;
}

const repositoryName = (repository: string) => repository.split("/").slice(1).join("/");

/** The cloud threads this browser opened on each VM's environment. */
function useThreadsByEnvironment() {
  const opened = useOpenedBoatCloudThreadRefs();
  const shells = useQuietThreadShells();
  const openedKeys = new Set(opened.map((ref) => `${ref.environmentId}:${ref.threadId}`));
  const byEnvironment = new Map<EnvironmentId, Array<(typeof shells)[number]>>();
  for (const shell of shells) {
    if (!openedKeys.has(`${shell.environmentId}:${shell.id}`)) continue;
    if (shell.lineage.relationshipToParent === "subagent") continue;
    const list = byEnvironment.get(shell.environmentId) ?? [];
    list.push(shell);
    byEnvironment.set(shell.environmentId, list);
  }
  return byEnvironment;
}

function MachineRow({
  machine,
  threads,
  onDelete,
  actions,
}: {
  readonly machine: BoatCloudMachine;
  readonly threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly title: string;
  }>;
  readonly onDelete: ((machine: BoatCloudMachine, name: string) => void) | null;
  readonly actions: BoatCloudMachineActions | null;
}) {
  const gt = useGT();
  const m = useMessages();
  const sizeLine = useBoatCloudSizeLine();
  const [busy, setBusy] = useState(false);
  const state = MACHINE_STATE[machine.state];
  const repositories = machine.repositories.map(repositoryName).join(", ");
  const spare = threads.length === 0 && machine.repositories.length === 0;
  const name = threads[0]?.title ?? (repositories || gt("Ready spare"));
  const description = [
    threads.length > 0 ? repositories : null,
    sizeLine(machine) || null,
    machine.usage === null
      ? null
      : formatBoatCloudCost(machine.usage.seconds, machine.usage.dollars),
  ]
    .filter(Boolean)
    .join(" · ");
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <BoatIcon aria-hidden className="size-3.5" />
          {threads.length > 0 ? (
            <span className="flex min-w-0 items-center gap-1">
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: threads[0]!.environmentId, threadId: threads[0]!.id }}
                className="truncate hover:underline"
              >
                {threads[0]!.title}
              </Link>
              {threads.length > 1 ? (
                <span className="shrink-0 text-muted-foreground">
                  {gt("+{count}", { count: threads.length - 1 })}
                </span>
              ) : null}
            </span>
          ) : (
            <span className={spare ? "truncate text-muted-foreground" : "truncate"}>{name}</span>
          )}
        </span>
      }
      description={description || undefined}
      control={
        <span className="flex items-center gap-2">
          <Badge variant={state.variant}>{m(state.label)}</Badge>
          {actions && machine.state === "running" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => actions.stop(machine.sandboxId))}
            >
              {busy ? <Spinner aria-hidden size="xs" /> : null}
              <T>Stop</T>
            </Button>
          ) : null}
          {actions && (machine.state === "stopped" || machine.state === "gone") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => actions.wake(machine.sandboxId))}
            >
              {busy ? <Spinner aria-hidden size="xs" /> : null}
              <T>Wake</T>
            </Button>
          ) : null}
          {onDelete ? (
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() => onDelete(machine, name)}
            >
              <T>Delete</T>
            </Button>
          ) : null}
        </span>
      }
    />
  );
}

function DeleteMachineDialog({
  request,
  onClose,
  onConfirm,
}: {
  readonly request: { readonly machine: BoatCloudMachine; readonly name: string } | null;
  readonly onClose: () => void;
  readonly onConfirm: (sandboxId: string) => Promise<unknown>;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      {request ? (
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Delete {name}?", { name: request.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                The VM and everything on it go away: uncommitted and unpushed work, provider
                sessions, and its saved copy. Its threads cannot wake it again.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" disabled={busy} />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onConfirm(request.machine.sandboxId).finally(() => {
                  setBusy(false);
                  onClose();
                });
              }}
            >
              {busy ? <Spinner aria-hidden size="sm" /> : null}
              <T>Delete</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      ) : null}
    </AlertDialog>
  );
}

/** Every Boat VM this machine handed out, named after the threads on it, inside the Boat cloud section. */
export function BoatCloudMachineRows({
  status,
  actions,
}: {
  readonly status: BoatCloudStatus;
  readonly actions: BoatCloudMachineActions | null;
}) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const threadsByEnvironment = useThreadsByEnvironment();
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState<{
    readonly machine: BoatCloudMachine;
    readonly name: string;
  } | null>(null);
  const updatedAt = status.machines
    .flatMap((machine) => (machine.usage ? [machine.usage.updatedAt] : []))
    .toSorted()
    .at(0);
  return (
    <>
      <SettingsRow
        title={gt("Machines")}
        description={
          status.machines.length === 0
            ? gt("None yet. A cloud thread starts one when it sends.")
            : updatedAt
              ? gt("Updated {time}", {
                  time: formatRelativeTimeLabel(updatedAt, Date.parse(`${nowMinute}:00Z`)),
                })
              : undefined
        }
        control={
          actions && status.machines.length > 0 ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={gt("Refresh costs")}
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                void actions.refresh().finally(() => setRefreshing(false));
              }}
            >
              {refreshing ? <Spinner aria-hidden size="xs" /> : <RefreshCwIcon aria-hidden />}
            </Button>
          ) : null
        }
      />
      {status.machines.map((machine) => (
        <MachineRow
          key={machine.sandboxId}
          machine={machine}
          threads={
            machine.environmentId === null
              ? []
              : (threadsByEnvironment.get(machine.environmentId) ?? [])
          }
          onDelete={actions ? (target, name) => setDeleting({ machine: target, name }) : null}
          actions={actions}
        />
      ))}
      {actions ? (
        <DeleteMachineDialog
          request={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={actions.remove}
        />
      ) : null}
    </>
  );
}
