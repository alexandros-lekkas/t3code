import { T, useGT, Var } from "gt-react-native";
import { Pressable } from "react-native";
import type { BoatCloudMachineType, EnvironmentMachineKind } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { BoatIcon } from "../../components/BoatIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import {
  BoatCloudSizeBadge,
  useBoatCloudMachineTypeLabel,
} from "../boatCloud/BoatCloudMachineTypes";

export function DraftEnvironmentControl(props: {
  readonly label: string;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly machineKind: EnvironmentMachineKind;
  readonly boatCloud: boolean;
  /** The size a Boat start will ask for, shown while the VM is still to start. */
  readonly boatCloudMachineType?: BoatCloudMachineType | null;
  readonly disabled: boolean;
  readonly onChooseEnvironment: () => void;
}) {
  const gt = useGT();
  const sizeLabel = useBoatCloudMachineTypeLabel();
  const machineType = props.boatCloud ? (props.boatCloudMachineType ?? null) : null;
  const disconnected = props.connectionState !== "connected";
  const label = props.boatCloud ? "Boat" : props.label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        disconnected
          ? gt("Choose environment, {label}, Offline", { label })
          : machineType
            ? gt("Choose environment, {label}, {size}", { label, size: sizeLabel(machineType) })
            : gt("Choose environment, {label}, Connected", { label })
      }
      disabled={props.disabled}
      onPress={props.onChooseEnvironment}
      className="flex-row items-center gap-1.5 rounded-xl px-3 py-2 active:opacity-65"
    >
      {props.boatCloud ? (
        <BoatIcon size={13} />
      ) : (
        <EnvironmentMachineSymbol
          kind={props.machineKind}
          size={13}
          tintColorClassName="accent-icon-muted"
        />
      )}
      <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
        <T>
          on <Var>{label}</Var>
        </T>
      </Text>
      {machineType ? (
        <>
          <BoatCloudSizeBadge machineType={machineType} size={15} />
          <Text className="shrink-0 text-sm text-foreground-muted" numberOfLines={1}>
            {sizeLabel(machineType)}
          </Text>
        </>
      ) : null}
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
      {disconnected ? <ConnectionStatusDot state="error" pulse={false} size={6} /> : null}
    </Pressable>
  );
}
