import { type BoatCloudMachineType, type BoatCloudMachineTypeOption } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { memo } from "react";

import { ComposerContextLabel } from "./ComposerContextLabel";
import { type ComposerControlSize, ComposerSelectControl } from "./chat/ComposerControl";
import { cn } from "../lib/utils";
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
  default: msg("Medium", { $context: "VM size" }),
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

/** `$0.048/h`. */
export function formatHourlyPrice(option: Pick<BoatCloudMachineTypeOption, "hourlyDollars">) {
  if (option.hourlyDollars === null) return null;
  const dollars = option.hourlyDollars;
  // Sub-dollar prices keep a third place, as in $0.018, but drop a trailing zero: $0.20.
  return `$${dollars < 1 ? dollars.toFixed(3).replace(/(\.\d\d)0$/u, "$1") : dollars.toFixed(2)}/h`;
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

const SIZE_LETTERS: Record<BoatCloudMachineType, string> = {
  small: "S",
  default: "M",
  large: "L",
  xlarge: "XL",
};

/** A size as its clothing-size letter in a small muted square tile, sized like the icons beside it. */
function BoatCloudSizeBadge({
  machineType,
  size,
}: {
  readonly machineType: string;
  readonly size: ComposerControlSize;
}) {
  if (!isMachineType(machineType)) return null;
  const letters = SIZE_LETTERS[machineType];
  // A square the size of the icons beside it; two letters shrink to fit rather than widen it.
  const wide = letters.length > 1;
  return (
    <span
      aria-hidden
      data-composer-control-icon
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-xs border border-muted-foreground/45 font-semibold text-muted-foreground tabular-nums leading-none tracking-tighter",
        size === "xs" ? "size-3 text-5xs" : cn("size-4", wide ? "text-5xs" : "text-4xs"),
      )}
    >
      {letters}
    </span>
  );
}

/** Only the sizes the plan can start: Boat refuses the rest, so they are left out. */
export function availableBoatCloudMachineTypes(options: ReadonlyArray<BoatCloudMachineTypeOption>) {
  return options.filter((option) => option.available);
}

/** One size in a list: its name, then its detail. */
export function BoatCloudMachineTypeItemLabel({
  option,
}: {
  readonly option: BoatCloudMachineTypeOption;
}) {
  const label = useBoatCloudMachineTypeLabel();
  const detail = useBoatCloudMachineTypeDetail();
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex items-center gap-2">
        <BoatCloudSizeBadge machineType={option.id} size="sm" />
        {label(option.id)}
      </span>
      <span className="text-muted-foreground text-xs">{detail(option)}</span>
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
  const sizeLine = useBoatCloudSizeLine();
  const composerFloatingLayerProps = useComposerMenuProps();
  const options = availableBoatCloudMachineTypes(machineTypes);
  if (options.length === 0) return null;
  // A saved default the plan no longer allows reads as the first size it does.
  const value = options.some((option) => option.id === machineType) ? machineType : options[0]!.id;
  return (
    <Select
      modal={false}
      value={value}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.id === next);
        if (option) onMachineTypeChange(option.id);
      }}
      items={options.map((option) => ({
        value: option.id,
        label: sizeLine({ machineType: option.id, vcpu: option.vcpu, memoryGB: option.memoryGB }),
      }))}
    >
      <ComposerSelectControl
        size="xs"
        className="min-w-0 shrink"
        aria-label={gt("Size", { $context: "VM size menu" })}
        data-composer-context-control
      >
        <BoatCloudSizeBadge machineType={value} size="xs" />
        <ComposerContextLabel>
          <SelectValue />
        </ComposerContextLabel>
      </ComposerSelectControl>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>{gt("Size", { $context: "VM size menu" })}</SelectGroupLabel>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id} indicator="check">
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
