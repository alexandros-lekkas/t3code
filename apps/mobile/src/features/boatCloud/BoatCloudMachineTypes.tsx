import type { BoatCloudMachineType, BoatCloudMachineTypeOption } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react-native";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { availableMachineTypes, startableMachineType } from "./machineTypeChoice";

const MACHINE_TYPE_LABELS: Record<BoatCloudMachineType, string> = {
  small: msg("Small", { $context: "VM size" }),
  default: msg("Medium", { $context: "VM size" }),
  large: msg("Large", { $context: "VM size" }),
  xlarge: msg("Extra large", { $context: "VM size" }),
};

/** Clothing sizes, which read as size rather than signal strength. */
const MACHINE_TYPE_BADGES: Record<BoatCloudMachineType, string> = {
  small: "S",
  default: "M",
  large: "L",
  xlarge: "XL",
};

/** A size's name. */
export function useBoatCloudMachineTypeLabel() {
  const resolve = useMessages();
  return (id: BoatCloudMachineType) => resolve(MACHINE_TYPE_LABELS[id]);
}

/** `$0.048/h`, with `~` when the price is worked out from Boat's base rate rather than quoted. */
function formatHourlyPrice(option: BoatCloudMachineTypeOption): string | null {
  if (option.hourlyDollars === null) return null;
  const price = `$${option.hourlyDollars.toFixed(option.hourlyDollars < 1 ? 3 : 2)}/h`;
  return option.priceSource === "derived" ? `~${price}` : price;
}

/** The size as a letter in a small rounded square, muted like the app's other row icons. */
export function BoatCloudSizeBadge(props: {
  readonly machineType: BoatCloudMachineType;
  readonly size?: number;
}) {
  const size = props.size ?? 22;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center rounded-[5px] border border-foreground-muted"
      style={{ height: size, minWidth: size, paddingHorizontal: size > 16 ? 2 : 1 }}
    >
      <AppText
        className="font-t3-medium text-foreground-muted"
        style={{ fontSize: Math.round(size * 0.48), lineHeight: Math.round(size * 0.6) }}
        allowFontScaling={false}
      >
        {MACHINE_TYPE_BADGES[props.machineType]}
      </AppText>
    </View>
  );
}

/** One radio row per size the plan can start: name, specs and price. */
export function BoatCloudMachineTypeRows(props: {
  readonly machineTypes: ReadonlyArray<BoatCloudMachineTypeOption>;
  readonly selected: BoatCloudMachineType;
  readonly disabled?: boolean;
  readonly onSelect: (machineType: BoatCloudMachineType) => void;
}) {
  const gt = useGT();
  const label = useBoatCloudMachineTypeLabel();
  const selected = startableMachineType(props.machineTypes, props.selected);
  return availableMachineTypes(props.machineTypes).map((option, index) => {
    const specs = gt("{vcpu} vCPU · {memory} GB", {
      vcpu: option.vcpu,
      memory: option.memoryGB,
    });
    const price = formatHourlyPrice(option);
    return (
      <ListChoiceRow
        key={option.id}
        label={label(option.id)}
        leading={<BoatCloudSizeBadge machineType={option.id} />}
        description={price === null ? specs : `${specs} · ${price}`}
        selected={option.id === selected}
        separated={index > 0}
        disabled={props.disabled}
        onPress={() => {
          if (option.id !== props.selected) props.onSelect(option.id);
        }}
      />
    );
  });
}
