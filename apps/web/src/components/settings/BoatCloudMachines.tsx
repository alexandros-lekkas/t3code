import {
  type BoatCloudMachine,
  type BoatCloudStatus,
  type EnvironmentId,
  boatCloudUsageReadAt,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { MoreVertical, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useVisibleThreadShells } from "../../state/entities";
import { boatCloudMachineOfThread } from "../../boatCloudMachines.logic";
import { useBoatCloudThreadMachines } from "../../state/boatCloudThreads";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  formatBoatCloudCost,
  formatHourlyPrice,
  useBoatCloudSizeLine,
} from "../BoatCloudSizeSelector";
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
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const MACHINE_STATE: Record<BoatCloudMachine["state"], string> = {
  running: msg("Running", { $context: "VM state" }),
  starting: msg("Waking", { $context: "VM state" }),
  stopped: msg("Sleeping", { $context: "VM state" }),
  gone: msg("Saved copy", { $context: "VM state" }),
};

/** Green while the VM runs and bills, amber while it wakes, muted while it sleeps. */
const MACHINE_STATE_DOT: Record<BoatCloudMachine["state"], string> = {
  running: "bg-success",
  starting: "bg-warning",
  stopped: "bg-muted-foreground/40",
  gone: "bg-muted-foreground/40",
};

const repositoryName = (repository: string) => repository.split("/").slice(1).join("/");

interface MachineThread {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly title: string;
}

/** The listed cloud threads on each VM, by sandbox. */
function useThreadsByMachine(status: BoatCloudStatus) {
  const shells = useVisibleThreadShells();
  const threadMachines = useBoatCloudThreadMachines();
  const { environments } = useEnvironments();
  const boatCloudEnvironments = new Set(
    environments.flatMap((environment) =>
      environment.boatCloud ? [environment.environmentId] : [],
    ),
  );
  const byMachine = new Map<string, Array<MachineThread>>();
  for (const shell of shells) {
    if (shell.lineage.relationshipToParent === "subagent") continue;
    const machine = boatCloudMachineOfThread({
      status,
      threadMachines,
      ref: { environmentId: shell.environmentId, threadId: shell.id },
      onBoatCloud: boatCloudEnvironments.has(shell.environmentId),
    });
    if (machine === null) continue;
    const list = byMachine.get(machine.sandboxId) ?? [];
    list.push(shell);
    byMachine.set(machine.sandboxId, list);
  }
  return byMachine;
}

function MachineRow({
  machine,
  threads,
  machineTypes,
  environmentUsage,
  holderEnvironmentId,
  onDelete,
}: {
  readonly machine: BoatCloudMachine;
  readonly threads: ReadonlyArray<MachineThread>;
  readonly machineTypes: BoatCloudStatus["machineTypes"];
  readonly environmentUsage: BoatCloudStatus["environmentUsage"];
  readonly holderEnvironmentId: EnvironmentId;
  readonly onDelete: (machine: BoatCloudMachine, name: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const sizeLine = useBoatCloudSizeLine();
  const stop = useAtomCommand(serverEnvironment.boatCloudStopMachine);
  const wake = useAtomCommand(serverEnvironment.boatCloudWakeMachine);
  const [busy, setBusy] = useState(false);
  const state = MACHINE_STATE[machine.state];
  const repositories = machine.repositories.map(repositoryName).join(", ");
  const first = threads[0];
  const name = first?.title ?? (repositories || gt("Ready spare"));
  const option = machineTypes.find((candidate) => candidate.id === machine.machineType);
  // The environment's figure is read with the usage refresh; the VM's own only after a reconcile.
  const usage =
    environmentUsage.find((entry) => entry.sandboxId === machine.sandboxId) ?? machine.usage;
  const details = [
    sizeLine(machine) || null,
    option === undefined ? null : formatHourlyPrice(option),
    usage === null ? null : formatBoatCloudCost(usage.seconds, usage.dollars),
  ]
    .filter(Boolean)
    .join(" · ");
  const run = async (command: typeof stop) => {
    setBusy(true);
    await command({ environmentId: holderEnvironmentId, input: { sandboxId: machine.sandboxId } });
    setBusy(false);
  };
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <BoatIcon aria-hidden className="size-3.5" />
          {first ? (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: first.environmentId, threadId: first.id }}
              className="truncate hover:underline"
            >
              {first.title}
            </Link>
          ) : (
            // No thread here is listed on this client, so the VM reads by what it holds.
            <span className="truncate font-normal text-muted-foreground">{name}</span>
          )}
          {threads.length > 1 ? (
            <span className="shrink-0 font-normal text-muted-foreground">
              {gt("+{count}", { count: threads.length - 1 })}
            </span>
          ) : null}
        </span>
      }
      description={
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", MACHINE_STATE_DOT[machine.state])}
          />
          {[m(state), details].filter(Boolean).join(" · ")}
        </span>
      }
      control={
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                disabled={busy}
                aria-label={gt("Machine actions")}
              />
            }
          >
            {busy ? <Spinner aria-hidden size="xs" /> : <MoreVertical aria-hidden />}
          </MenuTrigger>
          <MenuPopup align="end">
            {machine.state === "running" ? (
              <MenuItem onClick={() => void run(stop)}>
                <T>Stop</T>
              </MenuItem>
            ) : machine.state === "stopped" || machine.state === "gone" ? (
              <MenuItem onClick={() => void run(wake)}>
                <T>Wake</T>
              </MenuItem>
            ) : null}
            <MenuItem variant="destructive" onClick={() => onDelete(machine, name)}>
              <T>Delete</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
    />
  );
}

function DeleteMachineDialog({
  request,
  holderEnvironmentId,
  onClose,
}: {
  readonly request: { readonly machine: BoatCloudMachine; readonly name: string } | null;
  readonly holderEnvironmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const remove = useAtomCommand(serverEnvironment.boatCloudDeleteMachine);
  const [busy, setBusy] = useState(false);
  const machine = request?.machine;
  const running = machine?.state === "running" || machine?.state === "starting";
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      {request && machine ? (
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Delete {name}?", { name: request.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {running
                ? gt(
                    "It is running. Work since its last saved copy is lost; its threads can wake it from that copy.",
                  )
                : machine.backedUpAt !== null
                  ? gt(
                      "Boat deletes the VM. Its threads can wake it from this machine's saved copy.",
                    )
                  : gt("Boat deletes the VM and everything on it.")}
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
                void remove({
                  environmentId: holderEnvironmentId,
                  input: { sandboxId: machine.sandboxId, ...(running ? { force: true } : {}) },
                }).finally(() => {
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

/** Every Boat VM this machine handed out, named after the threads on it. */
export function BoatCloudMachinesSection({
  status,
  holderEnvironmentId,
}: {
  readonly status: BoatCloudStatus;
  readonly holderEnvironmentId: EnvironmentId;
}) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const refresh = useAtomCommand(serverEnvironment.boatCloudRefreshUsage);
  const threadsByMachine = useThreadsByMachine(status);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState<{
    readonly machine: BoatCloudMachine;
    readonly name: string;
  } | null>(null);
  const updatedAt = boatCloudUsageReadAt(status.machines);
  return (
    <SettingsSection
      id="boat-cloud-machines"
      title={gt("Machines")}
      headerAction={
        status.machines.length > 0 ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {updatedAt
              ? gt("Updated {time}", {
                  time: formatRelativeTimeLabel(updatedAt, Date.parse(`${nowMinute}:00Z`)),
                })
              : null}
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={gt("Refresh costs")}
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                void refresh({ environmentId: holderEnvironmentId, input: {} }).finally(() =>
                  setRefreshing(false),
                );
              }}
            >
              {refreshing ? <Spinner aria-hidden size="xs" /> : <RefreshCwIcon aria-hidden />}
            </Button>
          </span>
        ) : null
      }
    >
      {status.machines.length === 0 ? (
        <SettingsRow title={gt("None yet. A Boat thread starts one when it sends.")} />
      ) : (
        status.machines.map((machine) => (
          <MachineRow
            key={machine.sandboxId}
            machine={machine}
            threads={threadsByMachine.get(machine.sandboxId) ?? []}
            machineTypes={status.machineTypes}
            environmentUsage={status.environmentUsage}
            holderEnvironmentId={holderEnvironmentId}
            onDelete={(target, name) => setDeleting({ machine: target, name })}
          />
        ))
      )}
      <DeleteMachineDialog
        request={deleting}
        holderEnvironmentId={holderEnvironmentId}
        onClose={() => setDeleting(null)}
      />
    </SettingsSection>
  );
}
