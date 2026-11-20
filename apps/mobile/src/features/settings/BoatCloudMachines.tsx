import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type BoatCloudMachine,
  type BoatCloudMachineTypeOption,
  boatCloudUsageReadAt,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "./appearance/AppearancePreferencesProvider";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useVisibleSecondClock } from "../threads/use-visible-second-clock";
import {
  boatCloudHoldersAtom,
  boatCloudMachinesAtom,
  noteBoatCloudHolders,
} from "../boatCloud/boatCloudManaged";
import {
  BOAT_CLOUD_MACHINE_STATE_LABELS,
  type BoatCloudManagedMachine,
  boatCloudMachineEnvironments,
  boatCloudThreadsByMachine,
  formatBoatCloudCost,
  formatBoatCloudHourly,
  isBoatCloudMachineType,
  mergeBoatCloudMachines,
} from "../boatCloud/boatCloudMachineModel";
import { useBoatCloudMachineTypeLabel } from "../boatCloud/BoatCloudMachineTypes";
import {
  deletePhoneBoatCloudMachine,
  phoneBoatCloudAtom,
  refreshPhoneBoatCloud,
  stopPhoneBoatCloudMachine,
  wakePhoneBoatCloudMachine,
} from "../boatCloud/phoneBoatCloud";
import { SettingsSection } from "./components/SettingsSection";

const repositoryName = (repository: string) => repository.split("/").slice(1).join("/");

function UpdatedLabel(props: { readonly updatedAt: string }) {
  const gt = useGT();
  const now = useVisibleSecondClock(true);
  const seconds = Math.max(0, Math.round((now - Date.parse(props.updatedAt)) / 1000));
  if (seconds < 60) return <>{gt("Updated {seconds}s ago", { seconds })}</>;
  if (seconds < 3600) {
    return <>{gt("Updated {minutes} min ago", { minutes: Math.floor(seconds / 60) })}</>;
  }
  return <>{gt("Updated {hours} h ago", { hours: Math.floor(seconds / 3600) })}</>;
}

/** Green while the VM runs and bills, amber while it wakes, muted while it sleeps. */
function MachineStateDot(props: { readonly state: BoatCloudMachine["state"] }) {
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  const backgroundColor =
    props.state === "running"
      ? themeAppearance === "dark"
        ? "#34d399"
        : "#059669"
      : props.state === "starting"
        ? themeVariables["--color-warning-foreground"]
        : themeVariables["--color-icon-muted"];
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor }} />;
}

function MachineRow(props: {
  readonly managed: BoatCloudManagedMachine;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly option: BoatCloudMachineTypeOption | undefined;
  readonly separated: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const machineTypeLabel = useBoatCloudMachineTypeLabel();
  const selectDetail = useSelectWorkspaceDetail();
  const { machine, holderEnvironmentId } = props.managed;
  const [busy, setBusy] = useState(false);
  const stop = useAtomCommand(serverEnvironment.boatCloudStopMachine, gt("Stop the VM"));
  const wake = useAtomCommand(serverEnvironment.boatCloudWakeMachine, gt("Wake the VM"));
  const remove = useAtomCommand(serverEnvironment.boatCloudDeleteMachine, gt("Delete the VM"));

  const thread = props.threads[0];
  const repositories = machine.repositories.map(repositoryName).join(", ");
  const name = thread
    ? props.threads.length > 1
      ? gt("{title} +{count}", { title: thread.title, count: props.threads.length - 1 })
      : thread.title
    : repositories || gt("Ready spare");
  const spare = !thread && !repositories;
  const type = machine.machineType;
  const meta = [
    type === null ? null : isBoatCloudMachineType(type) ? machineTypeLabel(type) : type,
    machine.vcpu === null ? null : gt("{vcpu} vCPU", { vcpu: machine.vcpu }),
    machine.memoryGB === null ? null : gt("{memory} GB", { memory: machine.memoryGB }),
    formatBoatCloudHourly(props.option),
    machine.usage === null
      ? null
      : formatBoatCloudCost(machine.usage.seconds, machine.usage.dollars),
  ]
    .filter(Boolean)
    .join(" · ");
  const running = machine.state === "running" || machine.state === "starting";

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  const stopMachine = () =>
    run(() =>
      holderEnvironmentId === null
        ? stopPhoneBoatCloudMachine(machine.sandboxId)
        : stop({ environmentId: holderEnvironmentId, input: { sandboxId: machine.sandboxId } }),
    );
  const wakeMachine = () =>
    run(() =>
      holderEnvironmentId === null
        ? wakePhoneBoatCloudMachine(machine.sandboxId)
        : wake({ environmentId: holderEnvironmentId, input: { sandboxId: machine.sandboxId } }),
    );
  const deleteMachine = () =>
    Dialog.alert(
      gt("Delete {name}?", { name }),
      running
        ? gt(
            "It is running and may have live threads. The VM and everything on it go away, including uncommitted and unpushed work.",
          )
        : gt(
            "The VM and everything on it go away, including uncommitted and unpushed work. Its threads cannot wake it again.",
          ),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Delete"),
          style: "destructive",
          onPress: () =>
            void run(() =>
              holderEnvironmentId === null
                ? deletePhoneBoatCloudMachine(machine.sandboxId)
                : remove({
                    environmentId: holderEnvironmentId,
                    input: { sandboxId: machine.sandboxId, ...(running ? { force: true } : {}) },
                  }),
            ),
        },
      ],
    );

  const actions: MenuAction[] = [
    ...(machine.state === "running"
      ? [{ id: "stop", title: gt("Stop", { $context: "verb, stop a VM" }), image: "stop.circle" }]
      : []),
    ...(machine.state === "stopped" || machine.state === "gone"
      ? [{ id: "wake", title: gt("Wake", { $context: "verb, wake a VM" }), image: "power" }]
      : []),
    {
      id: "delete",
      title: gt("Delete"),
      image: "trash",
      attributes: { destructive: true },
    } satisfies MenuAction,
  ];

  const content = (
    <View className="min-h-16 flex-row items-center gap-3 px-4 py-3">
      <View className="min-w-0 shrink grow gap-0.5">
        <Text
          textRole="body"
          className={spare ? "text-foreground-muted" : "text-foreground"}
          numberOfLines={1}
        >
          {name}
        </Text>
        {meta ? (
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      <View className="shrink-0 flex-row items-center gap-1.5">
        <MachineStateDot state={machine.state} />
        <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
          {m(BOAT_CLOUD_MACHINE_STATE_LABELS[machine.state])}
        </Text>
      </View>
      <Menu
        accessible
        accessibilityRole="button"
        accessibilityLabel={gt("{name} options", { name })}
        title={name}
        actions={actions}
        onPressAction={({ nativeEvent }) => {
          if (busy) return;
          if (nativeEvent.event === "stop") void stopMachine();
          else if (nativeEvent.event === "wake") void wakeMachine();
          else if (nativeEvent.event === "delete") deleteMachine();
        }}
      >
        <ControlPill
          icon="ellipsis"
          accessibilityLabel={gt("{name} options", { name })}
          disabled={busy}
        />
      </Menu>
    </View>
  );

  return (
    <View className={cn(props.separated && "border-t border-border-subtle")}>
      {thread ? (
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel={name}
          onPress={() =>
            selectDetail({
              name: "Thread",
              params: { environmentId: String(thread.environmentId), threadId: String(thread.id) },
            })
          }
        >
          {content}
        </RowPressable>
      ) : (
        content
      )}
    </View>
  );
}

/** Every Boat VM, named after the threads on it, in the Boat settings. */
export function BoatCloudMachinesSection() {
  const gt = useGT();
  const holders = useAtomValue(boatCloudHoldersAtom);
  const phone = useAtomValue(phoneBoatCloudAtom);
  const paired = useAtomValue(boatCloudMachinesAtom);
  const shells = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const refreshUsage = useAtomCommand(serverEnvironment.boatCloudRefreshUsage, gt("Refresh costs"));
  const [refreshing, setRefreshing] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers the VMs the machines manage, so the thread lists include all their threads
  useEffect(() => {
    noteBoatCloudHolders(holders);
  }, [holders]);

  const machines = mergeBoatCloudMachines(holders, phone);
  if (machines.length === 0) return null;
  const environments = boatCloudMachineEnvironments({
    machines: machines.map((entry) => entry.machine),
    environmentUsage: holders.flatMap((holder) => holder.status.environmentUsage),
    pairedUrls: paired,
  });
  const threads = boatCloudThreadsByMachine(environments, shells);
  const optionOf = (managed: BoatCloudManagedMachine) => {
    const status =
      holders.find((holder) => holder.environmentId === managed.holderEnvironmentId)?.status ??
      holders[0]?.status;
    return status?.machineTypes.find((option) => option.id === managed.machine.machineType);
  };
  const updatedAt = boatCloudUsageReadAt(machines.map((entry) => entry.machine));

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([
      refreshPhoneBoatCloud(),
      ...holders
        .filter((holder) => holder.status.connected)
        .map((holder) => refreshUsage({ environmentId: holder.environmentId, input: {} })),
    ]);
    setRefreshing(false);
  };

  return (
    <View>
      <SettingsSection
        title={gt("Machines")}
        trailing={
          <Button
            label={gt("Refresh")}
            tone="text"
            size="compact"
            disabled={refreshing}
            onPress={() => void refresh()}
          />
        }
      >
        {machines.map((managed, index) => (
          <MachineRow
            key={managed.machine.sandboxId}
            managed={managed}
            threads={threads.get(managed.machine.sandboxId) ?? []}
            option={optionOf(managed)}
            separated={index > 0}
          />
        ))}
      </SettingsSection>
      {updatedAt ? (
        <Text textRole="footnote" className="mt-2 px-4 text-foreground-muted">
          <UpdatedLabel updatedAt={updatedAt} />
        </Text>
      ) : null}
    </View>
  );
}
