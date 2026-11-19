import { useAtomValue } from "@effect/atom-react";
import type { BoatCloudMachineState, EnvironmentId } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";

import {
  formatBoatCloudBytes,
  formatBoatCloudCost,
  useBoatCloudSizeLine,
} from "../BoatCloudSizeSelector";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
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
export function ThreadDetailsSandbox({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const sizeLine = useBoatCloudSizeLine();
  // The machine holding the Boat key handed the VM out and reports on it.
  const holderEnvironmentId = usePrimaryEnvironmentId() ?? environmentId;
  const usage = useAtomValue(
    serverEnvironment.boatCloudEnvironmentUsage({ holderEnvironmentId, environmentId }),
  );
  if (usage === null) return null;
  const size = sizeLine(usage);
  const state = m(STATE_LABELS[usage.state]);
  const cost = formatBoatCloudCost(usage.seconds, usage.dollars);
  const { stats } = usage;
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
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label={gt("Sandbox")}
          fill={null}
          tone={null}
          value={size === "" ? state : `${size} · ${state}`}
          tooltip={<span className="text-foreground">{gt("Boat cloud VM")}</span>}
        />
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
        <UsageRow
          label={
            usage.shared
              ? gt("Cost, shared machine", { $context: "VM cost row label" })
              : gt("Cost", { $context: "VM cost row label" })
          }
          fill={null}
          tone={null}
          value={cost}
          tooltip={
            <span className="text-foreground">
              {usage.shared
                ? gt("What the VM has cost in all, shared by the threads on it.")
                : gt("What this thread's VM has cost, from Boat's usage figures.")}
            </span>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}
