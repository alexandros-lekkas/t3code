import type { ScopedThreadRef } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import {
  availableBoatCloudMachineTypes,
  formatBoatCloudBytes,
  formatBoatCloudCost,
  formatHourlyPrice,
  useBoatCloudMachineTypeLabel,
} from "../BoatCloudSizeSelector";
import { usePrimaryBoatCloudStatus } from "../../boatCloud";
import {
  BOAT_CLOUD_LOAD_ERROR_PERCENT,
  type BoatCloudMachineStateLabel,
  boatCloudLowOnMemory,
  boatCloudMachineStateLabel,
  boatCloudResizeBlocked,
} from "../../boatCloudMachines.logic";
import {
  BoatCloudResizeItems,
  readBoatCloudMachineThreads,
  useBoatCloudResize,
} from "../BoatCloudResize";
import { useBoatCloudThreadMachine } from "../../state/boatCloudThreads";
import { cn } from "../../lib/utils";
import { BoatIcon } from "../Icons";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";
import { UsageRow } from "./ThreadDetailsUsage";

const STATE_LABELS: Record<BoatCloudMachineStateLabel, string> = {
  running: msg("Running", { $context: "VM state" }),
  starting: msg("Waking", { $context: "VM state" }),
  stopped: msg("Sleeping", { $context: "VM state" }),
  gone: msg("Saved copy", { $context: "VM state" }),
  resizing: msg("Resizing", { $context: "VM state" }),
};

const percentOf = (used: number, total: number) =>
  total > 0 ? Math.round(Math.max(0, Math.min(100, (used / total) * 100))) : 0;

const loadTone = (percent: number) =>
  percent >= BOAT_CLOUD_LOAD_ERROR_PERCENT ? "error" : percent >= 75 ? "warning" : null;

/** A Boat cloud thread's VM: its size, state, live load and what it has cost. */
export function ThreadDetailsSandbox({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const m = useMessages();
  const typeLabel = useBoatCloudMachineTypeLabel();
  const machine = useBoatCloudThreadMachine(threadRef);
  const { status, holderEnvironmentId } = usePrimaryBoatCloudStatus();
  const resize = useBoatCloudResize(holderEnvironmentId);
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  if (machine === null) return null;
  // The environment's figure sums every VM that served it, after a restore moved it.
  const usage = status?.environmentUsage.find((entry) => entry.sandboxId === machine.sandboxId);
  const machineType = machine.machineType ?? usage?.machineType ?? null;
  const option = status?.machineTypes.find((candidate) => candidate.id === machineType);
  const vcpu = machine.vcpu ?? usage?.vcpu ?? option?.vcpu ?? null;
  const memoryGB = machine.memoryGB ?? usage?.memoryGB ?? option?.memoryGB ?? null;
  const specs = [
    vcpu === null ? null : gt("{vcpu} vCPU", { vcpu }),
    memoryGB === null ? null : gt("{memory} GB", { memory: memoryGB }),
    option === undefined ? null : formatHourlyPrice(option),
  ]
    .filter(Boolean)
    .join(" · ");
  const resizeSent = resize.resizeSent(machine.sandboxId);
  const state = m(STATE_LABELS[boatCloudMachineStateLabel(machine, resizeSent)]);
  const cost =
    usage !== undefined
      ? formatBoatCloudCost(usage.seconds, usage.dollars)
      : machine.usage === null
        ? null
        : formatBoatCloudCost(machine.usage.seconds, machine.usage.dollars);
  const shared = usage?.shared === true;
  const { stats } = machine;
  const cpu = stats === null ? null : Math.round(stats.cpuPercent);
  const memory = stats === null ? null : percentOf(stats.memoryUsedBytes, stats.memoryTotalBytes);
  const disk =
    stats === null || stats.diskUsedBytes === null || stats.diskTotalBytes === null
      ? null
      : {
          percent: percentOf(stats.diskUsedBytes, stats.diskTotalBytes),
          value: formatBoatCloudBytes(stats.diskUsedBytes, stats.diskTotalBytes),
        };
  const resizable =
    status !== null &&
    resize.allowed &&
    availableBoatCloudMachineTypes(status.machineTypes).length > 0;
  const resizeDisabled = resizeSent || boatCloudResizeBlocked(machine);
  const lowOnMemory =
    resizable &&
    !resizeDisabled &&
    boatCloudLowOnMemory({ memoryPercent: memory, memoryGB, machineTypes: status.machineTypes });
  const sizeRow = (
    <>
      <BoatIcon aria-hidden className="size-4" />
      <span className={cn("min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        {machineType === null ? gt("Boat VM") : typeLabel(machineType)}
      </span>
      <span className="ms-auto shrink-0 text-xs font-normal text-muted-foreground">{state}</span>
    </>
  );
  return (
    <ThreadDetailsSection
      headingId="thread-details-sandbox-heading"
      title={gt("Sandbox")}
      showHeading={false}
    >
      {resizable ? (
        <Menu open={sizeMenuOpen} onOpenChange={setSizeMenuOpen}>
          <MenuTrigger
            render={<ThreadDetailsControl part="select" />}
            disabled={resizeDisabled}
            aria-label={gt("Boat VM size")}
          >
            {sizeRow}
          </MenuTrigger>
          <MenuPopup align="start" className="w-(--anchor-width)">
            <BoatCloudResizeItems
              machine={machine}
              machineTypes={status.machineTypes}
              onChoose={(next) =>
                resize.choose({
                  machine,
                  machineType: next,
                  threads: readBoatCloudMachineThreads(status, machine.sandboxId),
                  shared,
                })
              }
            />
          </MenuPopup>
        </Menu>
      ) : (
        <div
          className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}
          aria-label={gt("Boat VM")}
        >
          {sizeRow}
        </div>
      )}
      {resize.dialog}
      {specs ? (
        <div className="truncate px-2.5 pb-1 text-xs text-muted-foreground tabular-nums">
          {specs}
        </div>
      ) : null}
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {cpu !== null && stats !== null ? (
          <UsageRow
            label={gt("CPU", { $context: "VM load row label" })}
            fill={cpu}
            tone={loadTone(cpu)}
            muted
            value={`${cpu}%`}
            tooltip={
              <span className="text-foreground">
                {gt("{percent}% of {cpus} vCPU", { percent: cpu, cpus: stats.cpus })}
              </span>
            }
          />
        ) : null}
        {memory !== null && stats !== null ? (
          <UsageRow
            label={gt("Memory", { $context: "VM load row label" })}
            fill={memory}
            tone={loadTone(memory)}
            muted
            value={formatBoatCloudBytes(stats.memoryUsedBytes, stats.memoryTotalBytes)}
            tooltip={
              <span className="text-foreground">{gt("{percent}% used", { percent: memory })}</span>
            }
          />
        ) : null}
        {disk !== null ? (
          <UsageRow
            label={gt("Disk", { $context: "VM load row label" })}
            fill={disk.percent}
            tone={loadTone(disk.percent)}
            muted
            value={disk.value}
            tooltip={
              <span className="text-foreground">
                {gt("{percent}% used", { percent: disk.percent })}
              </span>
            }
          />
        ) : null}
        {cost !== null ? (
          <UsageRow
            label={
              shared
                ? gt("Cost, shared machine", { $context: "VM cost row label" })
                : gt("Cost", { $context: "VM cost row label" })
            }
            fill={null}
            tone={null}
            value={cost}
            tooltip={
              <span className="text-foreground">
                {shared
                  ? gt("What the VM has cost in all, shared by the threads on it.")
                  : gt("What this thread's VM has cost, from Boat's usage figures.")}
              </span>
            }
          />
        ) : null}
      </div>
      {lowOnMemory ? (
        <div className="flex h-7 items-center gap-2 ps-2.5 pe-1 text-xs text-error-foreground">
          <span className="min-w-0 truncate">{gt("Low on memory")}</span>
          <ThreadDetailsControl
            part="meta"
            tone="primary"
            className="ms-auto"
            onClick={() => setSizeMenuOpen(true)}
          >
            <T>Resize</T>
          </ThreadDetailsControl>
        </div>
      ) : null}
    </ThreadDetailsSection>
  );
}
