import { useAtomValue } from "@effect/atom-react";
import { isBoatCloudConnectionEntry } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { usePrimaryBoatCloudStatus } from "./boatCloud";
import { boatCloudEnvironmentsToForget } from "./boatCloudMachines.logic";
import { environmentCatalog } from "./connection/catalog";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { forgetBoatCloudEnvironmentThreads } from "./state/boatCloudThreads";
import { captureBoatCloudUsage } from "./state/boatCloudUsageLedger";
import { environmentSummaries } from "./state/presentation";

/**
 * Often enough that a VM's last turn is read before the holder stops it, which takes at
 * least twelve idle minutes.
 */
const USAGE_CAPTURE_INTERVAL_MS = 5 * 60_000;

const forgetAttempted = new Set<EnvironmentId>();

/**
 * Keeps Boat VMs from piling up in this client: it reads each live VM's model usage while it
 * can, and drops the pairing, credentials and cached data of a VM the holder no longer holds.
 */
export function useBoatCloudHousekeeping() {
  const { status } = usePrimaryBoatCloudStatus();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const connected = new Set(useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom));
  const boatCloudEnvironmentIds = [...catalog.entries].flatMap(([environmentId, entry]) =>
    entry.target._tag !== "PrimaryConnectionTarget" && isBoatCloudConnectionEntry(entry)
      ? [environmentId]
      : [],
  );
  // Environment ids hold no spaces, so one string carries each list into its effect.
  const forgetKey = boatCloudEnvironmentsToForget({
    status,
    boatCloudEnvironmentIds,
    connectedEnvironmentIds: connected,
  }).join(" ");
  const liveKey = boatCloudEnvironmentIds.filter((id) => connected.has(id)).join(" ");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes saved connections and browser storage, outside React
  useEffect(() => {
    if (forgetKey === "") return;
    for (const environmentId of forgetKey.split(" ") as EnvironmentId[]) {
      if (forgetAttempted.has(environmentId)) continue;
      forgetAttempted.add(environmentId);
      forgetBoatCloudEnvironmentThreads(environmentId);
      void runAtomCommand(appAtomRegistry, environmentCatalog.remove, environmentId, {
        label: environmentCatalog.remove.label,
        reportFailure: false,
        reportDefect: false,
      });
    }
  }, [forgetKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls live VMs over the network for usage
  useEffect(() => {
    if (liveKey === "") return;
    const controller = new AbortController();
    const capture = () => {
      for (const environmentId of liveKey.split(" ") as EnvironmentId[]) {
        void captureBoatCloudUsage(environmentId, controller.signal);
      }
    };
    capture();
    const interval = setInterval(capture, USAGE_CAPTURE_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [liveKey]);
}
