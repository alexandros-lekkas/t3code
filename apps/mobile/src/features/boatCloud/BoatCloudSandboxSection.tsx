import { useAtomValue } from "@effect/atom-react";
import type { BoatCloudEnvironmentUsage, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useGT, useMessages } from "gt-react-native";
import { View } from "react-native";

import { BoatIcon } from "../../components/BoatIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { ListSection } from "../../components/ui/ListSection";
import { serverEnvironment } from "../../state/server";
import { boatCloudHoldersAtom, boatCloudMachinesAtom } from "./boatCloudManaged";
import {
  BOAT_CLOUD_MACHINE_STATE_LABELS,
  boatCloudPercent,
  formatBoatCloudBytes,
  formatBoatCloudCost,
  formatBoatCloudHourly,
  isBoatCloudMachineType,
} from "./boatCloudMachineModel";
import { useBoatCloudMachineTypeLabel } from "./BoatCloudMachineTypes";

const NO_USAGE = Atom.make<BoatCloudEnvironmentUsage | null>(null);

function LoadRow(props: {
  readonly label: string;
  readonly percent: number | null;
  readonly value: string;
}) {
  const percent = props.percent;
  return (
    <View className="h-6 flex-row items-center gap-3">
      <Text textRole="footnote" className="w-16 text-foreground-muted" numberOfLines={1}>
        {props.label}
      </Text>
      <View className="h-1.5 min-w-8 flex-1 flex-row overflow-hidden rounded-full bg-subtle">
        {percent === null ? null : (
          <>
            <View
              className={
                percent >= 90
                  ? "h-full rounded-full bg-red-500"
                  : percent >= 75
                    ? "h-full rounded-full bg-amber-500"
                    : "h-full rounded-full bg-foreground-muted"
              }
              style={{ flex: percent }}
            />
            <View style={{ flex: 100 - percent }} />
          </>
        )}
      </View>
      <Text
        textRole="footnote"
        className="max-w-[45%] shrink text-right tabular-nums text-foreground-muted"
        numberOfLines={1}
      >
        {props.value}
      </Text>
    </View>
  );
}

/** A Boat VM thread's sandbox: its size and state, live load while shown, and its cost. */
export function BoatCloudSandboxSection(props: { readonly environmentId: EnvironmentId }) {
  const onBoatCloud = useAtomValue(boatCloudMachinesAtom).has(props.environmentId);
  return onBoatCloud ? <BoatCloudSandbox environmentId={props.environmentId} /> : null;
}

function BoatCloudSandbox(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const machineTypeLabel = useBoatCloudMachineTypeLabel();
  // Watching the machines' status is what makes them sample the VM's load.
  const holders = useAtomValue(boatCloudHoldersAtom);
  const holder = holders.find((candidate) =>
    candidate.status.environmentUsage.some((entry) => entry.environmentId === props.environmentId),
  );
  const usage = useAtomValue(
    holder
      ? serverEnvironment.boatCloudEnvironmentUsage({
          holderEnvironmentId: holder.environmentId,
          environmentId: props.environmentId,
        })
      : NO_USAGE,
  );
  if (!holder || usage === null) return null;

  const type = usage.machineType;
  const sizeName =
    type === null ? gt("VM") : isBoatCloudMachineType(type) ? machineTypeLabel(type) : type;
  const hourly = formatBoatCloudHourly(
    holder.status.machineTypes.find((option) => option.id === type),
  );
  const specs = [
    usage.vcpu === null ? null : gt("{vcpu} vCPU", { vcpu: usage.vcpu }),
    usage.memoryGB === null ? null : gt("{memory} GB", { memory: usage.memoryGB }),
    hourly,
  ]
    .filter(Boolean)
    .join(" · ");
  const { stats } = usage;
  const disk =
    stats === null || stats.diskUsedBytes === null || stats.diskTotalBytes === null
      ? null
      : { used: stats.diskUsedBytes, total: stats.diskTotalBytes };

  return (
    <ListSection>
      <View className="gap-1 px-4 py-3">
        <View className="flex-row items-center gap-2">
          <BoatIcon size={16} />
          <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
            {sizeName}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
            {m(BOAT_CLOUD_MACHINE_STATE_LABELS[usage.state])}
          </Text>
        </View>
        {specs ? (
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
            {specs}
          </Text>
        ) : null}
      </View>
      <View className="gap-1 border-t border-border-subtle px-4 py-3">
        {stats ? (
          <>
            <LoadRow
              label={gt("CPU", { $context: "VM load row label" })}
              percent={Math.round(stats.cpuPercent)}
              value={`${Math.round(stats.cpuPercent)}%`}
            />
            <LoadRow
              label={gt("Memory", { $context: "VM load row label" })}
              percent={boatCloudPercent(stats.memoryUsedBytes, stats.memoryTotalBytes)}
              value={formatBoatCloudBytes(stats.memoryUsedBytes, stats.memoryTotalBytes)}
            />
            {disk ? (
              <LoadRow
                label={gt("Disk", { $context: "VM load row label" })}
                percent={boatCloudPercent(disk.used, disk.total)}
                value={formatBoatCloudBytes(disk.used, disk.total)}
              />
            ) : null}
          </>
        ) : null}
        <View className="h-6 flex-row items-center gap-3">
          <Text textRole="footnote" className="flex-1 text-foreground-muted" numberOfLines={1}>
            {usage.shared
              ? gt("Cost, shared machine", { $context: "VM cost row label" })
              : gt("Cost", { $context: "VM cost row label" })}
          </Text>
          <Text
            textRole="footnote"
            className="shrink text-right tabular-nums text-foreground-muted"
            numberOfLines={1}
          >
            {formatBoatCloudCost(usage.seconds, usage.dollars)}
          </Text>
        </View>
      </View>
    </ListSection>
  );
}
