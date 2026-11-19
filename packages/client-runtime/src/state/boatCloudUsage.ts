import type { BoatCloudEnvironmentUsage, BoatCloudStatus, EnvironmentId } from "@t3tools/contracts";

/**
 * A cloud thread's VM and cost, from its key holder's status. Subagents run in their
 * parent's VM: look up the parent's environment.
 * @public
 */
export function boatCloudEnvironmentUsageOf(
  status: BoatCloudStatus | null | undefined,
  environmentId: EnvironmentId,
): BoatCloudEnvironmentUsage | null {
  return status?.environmentUsage.find((entry) => entry.environmentId === environmentId) ?? null;
}
