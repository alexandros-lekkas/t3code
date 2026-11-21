import { useAtomValue } from "@effect/atom-react";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import type {
  BoatCloudMachine,
  BoatCloudMachineType,
  BoatCloudMachineTypeOption,
  BoatCloudStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { reportBoatCloudFailure } from "../boatCloud";
import { boatCloudResizeInterrupts, boatCloudThreadsByMachine } from "../boatCloudMachines.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { boatCloudThreadList, readBoatCloudThreadMachines } from "../state/boatCloudThreads";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  availableBoatCloudMachineTypes,
  BoatCloudMachineTypeItemLabel,
} from "./BoatCloudSizeSelector";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
} from "./ui/menu";

/** Whether each listed thread on a VM is running a turn, read once when a resize asks. */
export function readBoatCloudMachineThreads(
  status: BoatCloudStatus,
  sandboxId: string,
): ReadonlyArray<{ readonly running: boolean }> {
  const shells = boatCloudThreadsByMachine({
    status,
    threadMachines: readBoatCloudThreadMachines(),
    shells: appAtomRegistry.get(environmentThreadShells.visibleThreadShellsAtom),
    onBoatCloud: (environmentId) =>
      appAtomRegistry.get(boatCloudThreadList.onBoatCloudAtom(environmentId)),
  }).get(sandboxId);
  return (shells ?? []).map((shell) => ({ running: threadRuntimeIsActive(shell.runtime) }));
}

interface ResizeRequest {
  readonly machine: BoatCloudMachine;
  readonly machineType: BoatCloudMachineType;
}

/**
 * Resizes VMs through the machine holding the Boat key, asking first when the restart would
 * interrupt a turn or other threads on the VM.
 */
export function useBoatCloudResize(holderEnvironmentId: EnvironmentId | null) {
  const gt = useGT();
  const allowed = useAtomValue(
    serverEnvironment.boatCloudResizeMachine.permissionAtom(holderEnvironmentId),
  );
  const resize = useAtomCommand(serverEnvironment.boatCloudResizeMachine);
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState<
    (ResizeRequest & { readonly shared: boolean }) | null
  >(null);

  const send = async ({ machine, machineType }: ResizeRequest) => {
    if (holderEnvironmentId === null) return;
    const { sandboxId } = machine;
    setSent((current) => new Set(current).add(sandboxId));
    const result = await resize({
      environmentId: holderEnvironmentId,
      input: { sandboxId, machineType },
    });
    setSent((current) => {
      const next = new Set(current);
      next.delete(sandboxId);
      return next;
    });
    reportBoatCloudFailure(gt("Could not resize the Boat machine"), result);
  };

  const choose = (
    request: ResizeRequest & {
      readonly threads: ReadonlyArray<{ readonly running: boolean }>;
      readonly shared: boolean;
    },
  ) => {
    if (request.machineType === request.machine.machineType) return;
    const interrupts = boatCloudResizeInterrupts(request);
    if (interrupts === null) void send(request);
    else setConfirming({ ...request, shared: interrupts.shared });
  };

  const dialog = (
    <AlertDialog
      open={confirming !== null}
      onOpenChange={(open) => {
        if (!open) setConfirming(null);
      }}
    >
      {confirming ? (
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Resize the machine?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming.shared
                ? gt(
                    "Resizing restarts the machine. Running turns are interrupted and continue once it is back. Other threads share this machine, so they are interrupted too.",
                  )
                : gt(
                    "Resizing restarts the machine. Running turns are interrupted and continue once it is back.",
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              onClick={() => {
                void send(confirming);
                setConfirming(null);
              }}
            >
              <T>Resize</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      ) : null}
    </AlertDialog>
  );

  return {
    allowed,
    resizeSent: (sandboxId: string) => sent.has(sandboxId),
    choose,
    dialog,
  };
}

/** The sizes the plan can start, as menu items with the VM's own one checked. */
export function BoatCloudResizeItems({
  machine,
  machineTypes,
  onChoose,
}: {
  readonly machine: BoatCloudMachine;
  readonly machineTypes: ReadonlyArray<BoatCloudMachineTypeOption>;
  readonly onChoose: (machineType: BoatCloudMachineType) => void;
}) {
  const gt = useGT();
  const options = availableBoatCloudMachineTypes(machineTypes);
  return (
    <MenuGroup>
      <MenuGroupLabel>{gt("Resize to", { $context: "VM size menu" })}</MenuGroupLabel>
      <MenuRadioGroup
        value={machine.machineType}
        onValueChange={(value) => {
          const option = options.find((candidate) => candidate.id === value);
          if (option) onChoose(option.id);
        }}
      >
        {options.map((option) => (
          <MenuRadioItem key={option.id} value={option.id} closeOnClick>
            <span className="flex items-center justify-between gap-3">
              <BoatCloudMachineTypeItemLabel option={option} />
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuGroup>
  );
}
