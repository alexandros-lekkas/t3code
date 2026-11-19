import type { BoatCloudMachineState, ScopedThreadRef } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";

import {
  formatBoatCloudBytes,
  formatBoatCloudCost,
  formatHourlyPrice,
  useBoatCloudMachineTypeLabel,
} from "../BoatCloudSizeSelector";
import { usePrimaryBoatCloudStatus } from "../../boatCloud";
import { useBoatCloudThreadMachine } from "../../state/boatCloudThreads";
import { cn } from "../../lib/utils";
import { BoatIcon } from "../Icons";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";
import { UsageRow } from "./ThreadDetailsUsage";

const STATE_LABELS: Record<BoatCloudMachineState, string> = {
  running: msg("Running", { $context: "VM state" }),
  starting: msg("Waking", { $context: "VM state" }),
  stopped: msg("Sleeping", { $context: "VM state" }),
  gone: msg("Saved copy", { $context: "VM state" }),
};

const percentOf = (used: number, total: number) =>
  total > 0 ? Math.round(Math.max(0, Math.min(100, (used / total) * 100))) : 0;

const loadTone = (percent: number) => (percent >= 90 ? "error" : percent >= 75 ? "warning" : null);

/** A Boat cloud thread's VM: its size, state, live load and what it has cost. */
export function ThreadDetailsSandbox({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const m = useMessages();
  const typeLabel = useBoatCloudMachineTypeLabel();
  const machine = useBoatCloudThreadMachine(threadRef);
  const { status } = usePrimaryBoatCloudStatus();
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
  const state = m(STATE_LABELS[machine.state]);
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
  return (
    <ThreadDetailsSection
      headingId="thread-details-sandbox-heading"
      title={gt("Sandbox")}
      showHeading={false}
    >
      <div
        className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}
        aria-label={gt("Boat VM")}
      >
        <BoatIcon aria-hidden className="size-4" />
        <span className={cn("min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          {machineType === null ? gt("Boat VM") : typeLabel(machineType)}
        </span>
        <span className="ms-auto shrink-0 text-xs font-normal text-muted-foreground">{state}</span>
      </div>
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
    </ThreadDetailsSection>
  );
}
