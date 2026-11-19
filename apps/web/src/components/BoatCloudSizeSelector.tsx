import type { BoatCloudMachineType, BoatCloudMachineTypeOption } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { memo } from "react";

import { ComposerContextLabel } from "./ComposerContextLabel";
import { ComposerSelectControl } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

const MACHINE_TYPE_LABELS: Record<BoatCloudMachineType, string> = {
  small: msg("Small", { $context: "VM size" }),
  default: msg("Default", { $context: "VM size" }),
  large: msg("Large", { $context: "VM size" }),
  xlarge: msg("Extra large", { $context: "VM size" }),
};

function isMachineType(id: string): id is BoatCloudMachineType {
  return Object.hasOwn(MACHINE_TYPE_LABELS, id);
}

/** A size's name, or Boat's own id for one this client does not know. */
export function useBoatCloudMachineTypeLabel() {
  const m = useMessages();
  return (id: string) => (isMachineType(id) ? m(MACHINE_TYPE_LABELS[id]) : id);
}

/** `$0.048/h`, with `~` when the price is worked out from Boat's base rate rather than quoted. */
function formatHourlyPrice(option: BoatCloudMachineTypeOption): string | null {
  if (option.hourlyDollars === null) return null;
  const price = `$${option.hourlyDollars.toFixed(option.hourlyDollars < 1 ? 3 : 2)}/h`;
  return option.priceSource === "derived" ? `~${price}` : price;
}

/** `2 vCPU · 4 GB · $0.048/h`. */
function useBoatCloudMachineTypeDetail() {
  const gt = useGT();
  return (option: BoatCloudMachineTypeOption) => {
    const size = gt("{vcpu} vCPU · {memory} GB", { vcpu: option.vcpu, memory: option.memoryGB });
    const price = formatHourlyPrice(option);
    return price === null ? size : `${size} · ${price}`;
  };
}

/** One size in a list: name, then its detail, or why the plan cannot start it. */
export function BoatCloudMachineTypeItemLabel({
  option,
}: {
  readonly option: BoatCloudMachineTypeOption;
}) {
  const label = useBoatCloudMachineTypeLabel();
  const detail = useBoatCloudMachineTypeDetail();
  return (
    <span className="flex min-w-0 flex-col">
      <span>{label(option.id)}</span>
      <span className="text-muted-foreground text-xs">
        {option.available ? detail(option) : (option.reason ?? detail(option))}
      </span>
    </span>
  );
}

/** The VM size a new Boat cloud thread starts on, next to the Run on picker. */
export const BoatCloudSizeSelector = memo(function BoatCloudSizeSelector({
  machineType,
  machineTypes,
  onMachineTypeChange,
}: {
  readonly machineType: BoatCloudMachineType;
  readonly machineTypes: ReadonlyArray<BoatCloudMachineTypeOption>;
  readonly onMachineTypeChange: (machineType: BoatCloudMachineType) => void;
}) {
  const gt = useGT();
  const label = useBoatCloudMachineTypeLabel();
  const composerFloatingLayerProps = useComposerMenuProps();
  if (machineTypes.length === 0) return null;
  return (
    <Select
      modal={false}
      value={machineType}
      onValueChange={(value) => {
        const option = machineTypes.find((candidate) => candidate.id === value);
        if (option?.available) onMachineTypeChange(option.id);
      }}
      items={machineTypes.map((option) => ({ value: option.id, label: label(option.id) }))}
    >
      <ComposerSelectControl
        size="xs"
        className="min-w-0 shrink-0"
        aria-label={gt("VM size")}
        data-composer-context-control
      >
        <ComposerContextLabel>
          <SelectValue />
        </ComposerContextLabel>
      </ComposerSelectControl>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>{gt("VM size")}</SelectGroupLabel>
          {machineTypes.map((option) => (
            <SelectItem key={option.id} value={option.id} disabled={!option.available}>
              <BoatCloudMachineTypeItemLabel option={option} />
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});

/** `Small · 2 vCPU · 4 GB`, leaving out what Boat has not reported. */
export function useBoatCloudSizeLine() {
  const gt = useGT();
  const label = useBoatCloudMachineTypeLabel();
  return (input: {
    readonly machineType: string | null;
    readonly vcpu: number | null;
    readonly memoryGB: number | null;
  }) =>
    [
      input.machineType === null ? null : label(input.machineType),
      input.vcpu === null ? null : gt("{vcpu} vCPU", { vcpu: input.vcpu }),
      input.memoryGB === null ? null : gt("{memory} GB", { memory: input.memoryGB }),
    ]
      .filter((part) => part !== null)
      .join(" · ");
}

function formatDollars(dollars: number): string {
  return dollars > 0 && dollars < 0.01 ? "<$0.01" : `$${dollars.toFixed(2)}`;
}

/** `1.3 h · $0.02`. */
export function formatBoatCloudCost(seconds: number, dollars: number): string {
  return `${(seconds / 3600).toFixed(1)} h · ${formatDollars(dollars)}`;
}

/** Bytes as `1.2 / 4.0 GB`. */
export function formatBoatCloudBytes(used: number, total: number): string {
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return `${gb(used)} / ${gb(total)} GB`;
}
