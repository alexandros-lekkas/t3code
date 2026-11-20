import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { Atom } from "effect/reactivity";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { BoatCloudUsageLedger, recordBoatCloudUsage } from "./boatCloudUsageLedger.logic";
import { serverEnvironment } from "./server";

const STORAGE_KEY = "t3code:boat-cloud-usage";

function readStored(): BoatCloudUsageLedger {
  try {
    return getLocalStorageItem(STORAGE_KEY, BoatCloudUsageLedger) ?? {};
  } catch {
    return {};
  }
}

/** Model usage this browser read from each Boat VM, which outlives the VM. */
export const boatCloudUsageLedgerAtom = Atom.make(readStored()).pipe(
  Atom.keepAlive,
  Atom.withLabel("boat-cloud-usage-ledger"),
);

/**
 * Reads a live VM's usage over the windows the Usage page shows and keeps it. The page's
 * longest window covers a VM's whole life, since a stopped VM is deleted within 14 days.
 */
export async function captureBoatCloudUsage(
  environmentId: EnvironmentId,
  signal: AbortSignal,
): Promise<void> {
  for (const input of [makeWindow(90), makeWindow(1, undefined, "hour")]) {
    const result = await executeAtomQuery(
      appAtomRegistry,
      serverEnvironment.usageSummary({ environmentId, input }),
      { label: "boat cloud usage", reportFailure: false, refresh: true, signal },
    );
    if (result._tag !== "Success" || signal.aborted) return;
    // Re-read storage so another tab's captures survive this write.
    const next = recordBoatCloudUsage(readStored(), environmentId, result.value);
    appAtomRegistry.set(boatCloudUsageLedgerAtom, next);
    try {
      setLocalStorageItem(STORAGE_KEY, next, BoatCloudUsageLedger);
    } catch {
      // The ledger still holds for this session.
    }
  }
}
