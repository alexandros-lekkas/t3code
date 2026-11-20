import type { EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentUsageStatus } from "../../state/usage";

/** One entry of the environment filter: a machine, or every Boat VM together as "Boat". */
export interface UsageEnvironmentRow {
  readonly key: string;
  readonly label: string;
  readonly environmentIds: readonly EnvironmentId[];
  /** The machine's own status; null for the Boat entry, which is never unavailable. */
  readonly environment: EnvironmentUsageStatus | null;
  readonly isPending: boolean;
}

export function usageEnvironmentRows(
  environments: readonly EnvironmentUsageStatus[],
): readonly UsageEnvironmentRow[] {
  const rows: UsageEnvironmentRow[] = [];
  const boatCloud = environments.filter((environment) => environment.boatCloud);
  for (const environment of environments) {
    if (environment.boatCloud) continue;
    rows.push({
      key: environment.environmentId,
      label: environment.label,
      environmentIds: [environment.environmentId],
      environment,
      isPending: environment.isPending,
    });
  }
  if (boatCloud.length > 0) {
    rows.push({
      key: "boat-cloud",
      label: boatCloud[0]!.label,
      environmentIds: boatCloud.map((environment) => environment.environmentId),
      environment: null,
      isPending: boatCloud.some((environment) => environment.isPending),
    });
  }
  return rows;
}
