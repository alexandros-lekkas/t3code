import type { BoatCloudMachineType, BoatCloudMachineTypeOption } from "@t3tools/contracts";

/** The sizes this plan can start; the others are left out. */
export function availableMachineTypes(
  machineTypes: ReadonlyArray<BoatCloudMachineTypeOption>,
): ReadonlyArray<BoatCloudMachineTypeOption> {
  return machineTypes.filter((option) => option.available);
}

/** The preferred size when the plan can start it, else the first that it can. */
export function startableMachineType(
  machineTypes: ReadonlyArray<BoatCloudMachineTypeOption>,
  preferred: BoatCloudMachineType,
): BoatCloudMachineType {
  const available = availableMachineTypes(machineTypes);
  if (available.some((option) => option.id === preferred)) return preferred;
  return available[0]?.id ?? preferred;
}
