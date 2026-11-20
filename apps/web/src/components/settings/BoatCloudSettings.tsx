import {
  BOAT_CLOUD_DELETE_STOPPED_DAYS,
  BOAT_CLOUD_IDLE_STOP_MINUTES,
  BOAT_CLOUD_REQUIRED_SCOPES,
  BOAT_CLOUD_SETUP_STEPS,
  type BoatCloudEnvironmentAccess,
  type BoatCloudLocalSignIn,
  type BoatCloudMachineType,
  type BoatCloudSetupStep,
  type BoatCloudStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { CheckIcon, CircleIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import {
  boatCloudSnapshotRepositories,
  useBoatCloudKeyHolderStates,
  usePrimaryBoatCloudStatus,
} from "../../boatCloud";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  availableBoatCloudMachineTypes,
  BoatCloudMachineTypeItemLabel,
  formatHourlyPrice,
  useBoatCloudMachineTypeLabel,
} from "../BoatCloudSizeSelector";
import {
  BOAT_AGENTS_DASHBOARD_URL,
  BOAT_ENVIRONMENT_DASHBOARD_URL,
  boatCloudBlocker,
  boatCloudChosenEnvironment,
  boatCloudLocalDrivers,
  boatCloudProviderDrivers,
} from "@t3tools/shared/boatCloudVm";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { BoatCloudMachinesSection } from "./BoatCloudMachines";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const STEP_LABELS: Record<BoatCloudSetupStep, string> = {
  "create-vm": msg("Create a VM"),
  "install-server": msg("Install T3 Code and clone repositories"),
  "copy-skills": msg("Copy this machine's skills"),
  "save-snapshot": msg("Save the T3 Code snapshot"),
};

type StepState = "done" | "active" | "failed" | "pending";

function StepIcon({ state }: { readonly state: StepState }) {
  if (state === "done") return <CheckIcon aria-hidden className="size-4 text-success-foreground" />;
  if (state === "failed") return <XIcon aria-hidden className="size-4 text-error-foreground" />;
  if (state === "active") return <Spinner aria-hidden size="md" tone="muted" />;
  return <CircleIcon aria-hidden className="size-4 text-muted-foreground" />;
}

/** Machines that hand out VMs: every connected one except the VMs themselves. */
function useKeyHolders(vmEnvironmentIds: ReadonlySet<EnvironmentId>) {
  const { environments } = useEnvironments();
  return environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      !environment.boatCloud &&
      !vmEnvironmentIds.has(environment.environmentId),
  );
}

function KeyHolderRow({
  environment,
  state,
}: {
  readonly environment: EnvironmentPresentation;
  readonly state: BoatCloudStatus | "unsupported" | null | undefined;
}) {
  const gt = useGT();
  return (
    <SettingsRow
      title={environment.label}
      control={
        state === "unsupported" ? (
          <Badge variant="warning">{gt("Needs update")}</Badge>
        ) : state?.connected ? (
          <Badge variant="success">{gt("Enabled")}</Badge>
        ) : (
          <Badge variant="secondary">{gt("Not enabled")}</Badge>
        )
      }
    />
  );
}

function ApiKeyForm({
  holders,
  setupEnvironmentId,
}: {
  readonly holders: ReadonlyArray<EnvironmentPresentation>;
  readonly setupEnvironmentId: EnvironmentId | null;
}) {
  const gt = useGT();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const connect = useAtomCommand(serverEnvironment.connectBoatCloud);
  const runSetup = useAtomCommand(serverEnvironment.runBoatCloudSetup);
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key || busy) return;
    setBusy(true);
    // Every machine gets the key, so a thread started on any of them can use Boat cloud.
    const results = await Promise.all(
      holders.map(async (holder) => ({
        environmentId: holder.environmentId,
        result: await connect({ environmentId: holder.environmentId, input: { apiKey: key } }),
      })),
    );
    setBusy(false);
    if (results.some(({ result }) => result._tag === "Success")) setApiKey("");
    // Only this machine builds the snapshot, so connected machines never race to save it.
    const own = results.find(({ environmentId }) => environmentId === setupEnvironmentId);
    if (own?.result._tag === "Success" && own.result.value.setup.status === "idle") {
      void runSetup({
        environmentId: own.environmentId,
        input: { repositories: boatCloudSnapshotRepositories() },
      });
    }
  };
  return (
    <form className="flex w-full min-w-0 gap-2 sm:w-80" onSubmit={onSubmit}>
      <SecretInput
        size="sm"
        aria-label={gt("Boat API key")}
        placeholder={gt("Boat API key")}
        value={apiKey}
        disabled={busy}
        maxLength={512}
        onChange={(event) => setApiKey(event.target.value)}
      />
      <Button
        type="submit"
        size="sm"
        disabled={busy || apiKey.trim() === "" || holders.length === 0}
      >
        {busy ? gt("Connecting") : gt("Connect")}
      </Button>
    </form>
  );
}

const AGENT_PROVIDERS = [
  { driver: "claudeAgent", label: "Claude" },
  { driver: "codex", label: "Codex" },
] as const;

function ExternalLinkButton({
  href,
  children,
}: {
  readonly href: string;
  readonly children: string;
}) {
  return (
    <Button variant="outline" size="xs" render={<a href={href} target="_blank" rel="noreferrer" />}>
      {children}
      <ExternalLinkIcon aria-hidden />
    </Button>
  );
}

function StatusTitle({
  state,
  children,
}: {
  readonly state: StepState;
  readonly children: string;
}) {
  return (
    <span className="flex items-center gap-2">
      <StepIcon state={state} />
      {children}
    </span>
  );
}

/** A switch and the buttons beside it, in one row's control slot. */
function Controls({ children }: { readonly children: ReactNode }) {
  return <span className="flex items-center gap-2">{children}</span>;
}

/**
 * The chosen Boat environment and a way to change it or what it passes to VMs. Every key holder
 * gets the same choice.
 */
function useBoatEnvironment(
  status: BoatCloudStatus,
  holders: ReadonlyArray<EnvironmentPresentation>,
) {
  const configure = useAtomCommand(serverEnvironment.configureBoatCloudEnvironment);
  const [busy, setBusy] = useState(false);
  const selected = boatCloudChosenEnvironment(status);
  const apply = async (environmentId: string, access?: Partial<BoatCloudEnvironmentAccess>) => {
    setBusy(true);
    await Promise.all(
      holders.map((holder) =>
        configure({
          environmentId: holder.environmentId,
          input: {
            environmentId,
            ...(access && selected
              ? {
                  access: {
                    passGithub: selected.passGithub,
                    passSandboxCredentials: selected.passSandboxCredentials,
                    passSecrets: selected.passSecrets,
                    passAgentsCredentials: selected.passAgentsCredentials,
                    ...access,
                  },
                }
              : {}),
          },
        }),
      ),
    );
    setBusy(false);
  };
  const setAccess = (access: Partial<BoatCloudEnvironmentAccess>) => {
    if (selected) void apply(selected.id, access);
  };
  return { selected, busy, apply, setAccess };
}

function EnvironmentRow({
  status,
  holders,
}: {
  readonly status: BoatCloudStatus;
  readonly holders: ReadonlyArray<EnvironmentPresentation>;
}) {
  const gt = useGT();
  const { selected, busy, apply } = useBoatEnvironment(status, holders);
  if (status.environmentsError !== null) {
    return <SettingsRow title={gt("Boat environment")} description={status.environmentsError} />;
  }
  return (
    <SettingsRow
      title={gt("Boat environment")}
      description={gt("Machines start with its secrets, sign-ins and GitHub access.")}
      control={
        <Select
          value={selected?.id ?? null}
          onValueChange={(value) => {
            if (typeof value === "string" && value !== selected?.id) void apply(value);
          }}
        >
          <SelectTrigger size="sm" aria-label={gt("Boat environment")} disabled={busy}>
            <SelectValue>{selected?.name ?? gt("Choose")}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {status.environments.map((environment) => (
              <SelectItem key={environment.id} value={environment.id}>
                {environment.isDefault
                  ? gt("{name} (default)", { name: environment.name })
                  : environment.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

/**
 * Where VMs get each agent's sign-in: this computer (its login, an API key, or a long-lived
 * Claude token) and the Boat environment. One row per agent says which apply, then one switch per
 * source.
 */
function SignInRows({
  status,
  holders,
}: {
  readonly status: BoatCloudStatus;
  readonly holders: ReadonlyArray<EnvironmentPresentation>;
}) {
  const gt = useGT();
  const { holderEnvironmentId } = usePrimaryBoatCloudStatus();
  const configureMachines = useAtomCommand(serverEnvironment.configureBoatCloudMachines);
  const claudeToken = useAtomCommand(serverEnvironment.boatCloudClaudeToken);
  const { selected, busy: environmentBusy, setAccess } = useBoatEnvironment(status, holders);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const local = status.localSignIns;
  const localDrivers = boatCloudLocalDrivers(status);
  // Null when Boat did not say which sign-ins the environment holds.
  const boatDrivers =
    selected?.agentCredentials == null ? null : boatCloudProviderDrivers(selected.agentCredentials);
  const runToken = async (input: Parameters<typeof claudeToken>[0]["input"]) => {
    if (holderEnvironmentId === null) return;
    setBusy(true);
    await claudeToken({ environmentId: holderEnvironmentId, input });
    setBusy(false);
  };
  const flow = local.claudeTokenFlow;
  const localSource = (signIn: BoatCloudLocalSignIn) =>
    signIn.source === "token"
      ? gt("Long-lived token on this computer")
      : signIn.source === "environment"
        ? gt("API key on this computer")
        : signIn.expiresAt
          ? gt("This computer's login, until {time}", {
              time: new Date(signIn.expiresAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              }),
            })
          : gt("This computer's login");

  const tokenControl =
    holderEnvironmentId === null || !local.enabled ? null : flow?.state === "running" ? (
      <Controls>
        {flow.url ? (
          <ExternalLinkButton href={flow.url}>{gt("Open sign-in page")}</ExternalLinkButton>
        ) : null}
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => void runToken({ action: "cancel" })}
        >
          {gt("Cancel")}
        </Button>
      </Controls>
    ) : local.claudeTokenStored ? (
      <Button
        variant="destructive-outline"
        size="xs"
        disabled={busy}
        onClick={() => void runToken({ action: "remove" })}
      >
        {gt("Remove token")}
      </Button>
    ) : (
      <Button
        variant="outline"
        size="xs"
        disabled={busy}
        onClick={() => void runToken({ action: "create" })}
      >
        {gt("Create token")}
      </Button>
    );

  const tokenFlowDetail =
    flow?.state === "running" ? (
      <span className="flex flex-col gap-2">
        {gt("Finish signing in to Claude in the browser.")}
        {flow.url ? (
          <form
            className="flex w-full min-w-0 gap-2 sm:w-80"
            onSubmit={(event) => {
              event.preventDefault();
              const value = code.trim();
              if (value === "") return;
              setCode("");
              void runToken({ action: "code", code: value });
            }}
          >
            <Input
              size="sm"
              aria-label={gt("Code from the sign-in page")}
              placeholder={gt("Code from the sign-in page")}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
              {gt("Submit")}
            </Button>
          </form>
        ) : null}
      </span>
    ) : flow?.state === "failed" ? (
      (flow.error ?? gt("Could not create the token."))
    ) : null;

  return (
    <>
      {AGENT_PROVIDERS.map(({ driver, label }) => {
        const localSignIn = localDrivers.has(driver)
          ? local.available.find((signIn) => signIn.driver === driver)
          : undefined;
        const fromBoat = boatDrivers?.has(driver) === true;
        const sources = [
          ...(localSignIn ? [localSource(localSignIn)] : []),
          ...(fromBoat ? [gt("Boat environment")] : []),
        ];
        const state: StepState =
          sources.length > 0 ? "done" : boatDrivers === null ? "pending" : "failed";
        const isClaude = driver === "claudeAgent";
        return (
          <SettingsRow
            key={driver}
            title={<StatusTitle state={state}>{label}</StatusTitle>}
            description={
              isClaude && tokenFlowDetail !== null
                ? tokenFlowDetail
                : sources.length > 0
                  ? sources.join(" · ")
                  : boatDrivers === null
                    ? gt("Boat did not say whether it has a sign-in.")
                    : gt("No sign-in")
            }
            control={isClaude ? tokenControl : null}
          />
        );
      })}
      {holderEnvironmentId !== null ? (
        <SettingsRow
          title={gt("From this computer")}
          description={
            local.available.length === 0
              ? gt("Sign in to Claude Code or Codex on this computer first.")
              : gt("Machines get this computer's Claude and Codex sign-ins.")
          }
          control={
            <Switch
              aria-label={gt("From this computer")}
              checked={local.enabled}
              onCheckedChange={(checked) =>
                void configureMachines({
                  environmentId: holderEnvironmentId,
                  input: { useLocalSignIns: Boolean(checked) },
                })
              }
            />
          }
        />
      ) : null}
      {selected ? (
        <SettingsRow
          title={gt("From Boat")}
          description={gt("Machines get the sign-ins saved in this Boat environment.")}
          control={
            <Controls>
              <ExternalLinkButton href={BOAT_AGENTS_DASHBOARD_URL}>
                {boatDrivers?.size === 0 ? gt("Add") : gt("Manage")}
              </ExternalLinkButton>
              <Switch
                aria-label={gt("From Boat")}
                checked={selected.passAgentsCredentials}
                disabled={environmentBusy}
                onCheckedChange={(checked) =>
                  setAccess({ passAgentsCredentials: Boolean(checked) })
                }
              />
            </Controls>
          }
        />
      ) : null}
    </>
  );
}

/** What else the Boat environment hands each VM. */
function AccessRows({
  status,
  holders,
}: {
  readonly status: BoatCloudStatus;
  readonly holders: ReadonlyArray<EnvironmentPresentation>;
}) {
  const gt = useGT();
  const { selected, busy, setAccess } = useBoatEnvironment(status, holders);
  if (!selected) return null;
  const github =
    status.githubConnected === null ? null : selected.passGithub && status.githubConnected;
  return (
    <>
      <SettingsRow
        title={
          <StatusTitle state={github === null ? "pending" : github ? "done" : "failed"}>
            {gt("GitHub")}
          </StatusTitle>
        }
        description={
          !selected.passGithub
            ? gt("Off. Machines can clone public repositories only.")
            : status.githubConnected === false
              ? gt("Connect Boat's GitHub app to clone private repositories and push.")
              : gt("Machines can clone private repositories and push.")
        }
        control={
          <Controls>
            {selected.passGithub && status.githubConnected === false ? (
              <ExternalLinkButton href={BOAT_ENVIRONMENT_DASHBOARD_URL}>
                {gt("Connect")}
              </ExternalLinkButton>
            ) : null}
            <Switch
              aria-label={gt("GitHub")}
              checked={selected.passGithub}
              disabled={busy}
              onCheckedChange={(checked) => setAccess({ passGithub: Boolean(checked) })}
            />
          </Controls>
        }
      />
      <SettingsRow
        title={gt("Secrets")}
        description={gt("Machines get this environment's variables and secret files.")}
        control={
          <Switch
            aria-label={gt("Secrets")}
            checked={selected.passSecrets}
            disabled={busy}
            onCheckedChange={(checked) => setAccess({ passSecrets: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title={gt("Boat API key")}
        description={gt(
          "Agents on a machine can start, stop and delete machines on your bill. T3 Code does not need it.",
        )}
        control={
          <Switch
            aria-label={gt("Boat API key on machines")}
            checked={selected.passSandboxCredentials}
            disabled={busy}
            onCheckedChange={(checked) => setAccess({ passSandboxCredentials: Boolean(checked) })}
          />
        }
      />
    </>
  );
}

/** How new cloud threads get VMs, and the snapshot they start from. */
function NewMachineRows({
  status,
  holders,
  holderEnvironmentId,
}: {
  readonly status: BoatCloudStatus;
  readonly holders: ReadonlyArray<EnvironmentPresentation>;
  readonly holderEnvironmentId: EnvironmentId;
}) {
  const gt = useGT();
  const m = useMessages();
  const label = useBoatCloudMachineTypeLabel();
  const configure = useAtomCommand(serverEnvironment.configureBoatCloudMachines);
  const runSetup = useAtomCommand(serverEnvironment.runBoatCloudSetup);
  const [busy, setBusy] = useState(false);
  const apply = async (input: {
    readonly shareMachines?: boolean;
    readonly defaultMachineType?: BoatCloudMachineType;
    readonly keepReadyMachine?: boolean;
    readonly idleStopMinutes?: number;
    readonly deleteStoppedAfterDays?: number;
  }) => {
    setBusy(true);
    await Promise.all(
      holders.map((holder) => configure({ environmentId: holder.environmentId, input })),
    );
    setBusy(false);
  };
  const sizes = availableBoatCloudMachineTypes(status.machineTypes);
  // A saved default the plan no longer allows reads as the first size it does.
  const defaultSize = sizes.some((option) => option.id === status.defaultMachineType)
    ? status.defaultMachineType
    : (sizes[0]?.id ?? status.defaultMachineType);
  const defaultOption = sizes.find((option) => option.id === defaultSize);
  const sparePrice = defaultOption ? formatHourlyPrice(defaultOption) : null;
  const setup = status.setup;
  const setupStepIndex = setup.step ? BOAT_CLOUD_SETUP_STEPS.indexOf(setup.step) : -1;
  const rebuild = () =>
    void runSetup({
      environmentId: holderEnvironmentId,
      input: { repositories: boatCloudSnapshotRepositories() },
    });
  return (
    <>
      {sizes.length > 0 ? (
        <SettingsRow
          title={gt("Default size")}
          description={gt("New threads start on it unless they pick another.")}
          control={
            <Select
              value={defaultSize}
              onValueChange={(value) => {
                const option = sizes.find((candidate) => candidate.id === value);
                if (option && option.id !== status.defaultMachineType) {
                  void apply({ defaultMachineType: option.id });
                }
              }}
            >
              <SelectTrigger size="sm" aria-label={gt("Default size")} disabled={busy}>
                <SelectValue>{label(defaultSize)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {sizes.map((option) => (
                  <SelectItem key={option.id} value={option.id} indicator="check">
                    <BoatCloudMachineTypeItemLabel option={option} />
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      <SettingsRow
        title={gt("Share machines")}
        description={gt(
          "A new thread joins a running machine that has room. Off, each thread gets its own.",
        )}
        control={
          <Switch
            aria-label={gt("Share machines")}
            checked={status.shareMachines}
            disabled={busy}
            onCheckedChange={(checked) => void apply({ shareMachines: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title={gt("Keep a ready machine")}
        description={
          sparePrice === null
            ? gt("Faster starts. An idle machine stays on and is billed.")
            : gt("Faster starts. An idle machine stays on at {price}.", { price: sparePrice })
        }
        control={
          <Switch
            aria-label={gt("Keep a ready machine")}
            checked={status.keepReadyMachine}
            disabled={busy}
            onCheckedChange={(checked) => void apply({ keepReadyMachine: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title={gt("Stop when idle after")}
        description={gt("Minutes without a turn or a busy terminal before a machine stops.")}
        control={
          <BoundedNumberField
            value={status.idleStopMinutes}
            bounds={BOAT_CLOUD_IDLE_STOP_MINUTES}
            unit={gt("min", { $context: "minutes, after a number" })}
            label={gt("Stop when idle after")}
            disabled={busy}
            onCommit={(idleStopMinutes) => void apply({ idleStopMinutes })}
          />
        }
      />
      <SettingsRow
        title={gt("Delete stopped machines after")}
        description={gt(
          "Days a stopped machine stays on Boat. Its threads wake from this computer's saved copy.",
        )}
        control={
          <BoundedNumberField
            value={status.deleteStoppedAfterDays}
            bounds={BOAT_CLOUD_DELETE_STOPPED_DAYS}
            unit={gt("days", { $context: "after a number" })}
            label={gt("Delete stopped machines after")}
            disabled={busy}
            onCommit={(deleteStoppedAfterDays) => void apply({ deleteStoppedAfterDays })}
          />
        }
      />
      <SettingsRow
        title={
          <StatusTitle
            state={
              setup.status === "ready"
                ? "done"
                : setup.status === "failed"
                  ? "failed"
                  : setup.status === "running"
                    ? "active"
                    : "pending"
            }
          >
            {gt("Snapshot")}
          </StatusTitle>
        }
        description={
          setup.status === "ready"
            ? gt("New machines start from it.")
            : setup.status === "failed"
              ? (setup.error ?? gt("Setup failed."))
              : setup.status === "running" && setup.step !== null
                ? gt("Step {step} of {total}: {label}", {
                    step: setupStepIndex + 1,
                    total: BOAT_CLOUD_SETUP_STEPS.length,
                    label: m(STEP_LABELS[setup.step]),
                  })
                : gt("The image new machines start from.")
        }
        control={
          setup.status === "running" ? (
            <span className="text-xs text-muted-foreground">{gt("Building")}</span>
          ) : (
            <Button variant="outline" size="xs" onClick={rebuild}>
              {setup.status === "ready"
                ? gt("Rebuild")
                : setup.status === "failed"
                  ? gt("Retry")
                  : gt("Build")}
            </Button>
          )
        }
      />
    </>
  );
}

/** A whole number kept within `bounds`; an out-of-range entry snaps to the nearest bound. */
function BoundedNumberField({
  value,
  bounds,
  unit,
  label,
  disabled,
  onCommit,
}: {
  readonly value: number;
  readonly bounds: { readonly min: number; readonly max: number };
  readonly unit: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  const [saved, setSaved] = useState(value);
  if (saved !== value) {
    setSaved(value);
    setDraft(value);
  }
  return (
    <span className="flex items-center gap-2">
      <NumberField
        value={draft}
        min={bounds.min}
        max={bounds.max}
        step={1}
        size="sm"
        className="w-28"
        disabled={disabled}
        onValueChange={setDraft}
        onValueCommitted={(next) => {
          if (next === null) {
            setDraft(value);
            return;
          }
          const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.round(next)));
          setDraft(clamped);
          if (clamped !== value) onCommit(clamped);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`${label} −`} />
          <NumberFieldInput aria-label={label} />
          <NumberFieldIncrement aria-label={`${label} +`} />
        </NumberFieldGroup>
      </NumberField>
      <span className="w-8 text-xs text-muted-foreground">{unit}</span>
    </span>
  );
}

/**
 * Disconnecting removes the key, after which T3 can neither stop nor delete the machines it
 * made: a running one runs until its lease ends, a stopped one stays until Boat drops it. So
 * the confirmation counts them and offers to delete them first.
 */
function DisconnectDialog({
  open,
  status,
  holders,
  holderEnvironmentId,
  onClose,
}: {
  readonly open: boolean;
  readonly status: BoatCloudStatus;
  readonly holders: ReadonlyArray<EnvironmentPresentation>;
  readonly holderEnvironmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const disconnect = useAtomCommand(serverEnvironment.disconnectBoatCloud);
  const remove = useAtomCommand(serverEnvironment.boatCloudDeleteMachine);
  const [busy, setBusy] = useState<"delete" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A machine Boat already deleted ("Saved copy") is not on Boat any more.
  const onBoat = status.machines.filter((machine) => machine.state !== "gone");
  const running = onBoat.filter(
    (machine) => machine.state === "running" || machine.state === "starting",
  ).length;
  const saved = onBoat.filter((machine) => machine.backedUpAt !== null).length;
  // Every computer holding the key, this one always among them.
  const holderIds = new Set([
    holderEnvironmentId,
    ...holders.map((holder) => holder.environmentId),
  ]);
  const disconnectAll = () =>
    Promise.all([...holderIds].map((environmentId) => disconnect({ environmentId, input: {} })));
  const finish = async (deleteFirst: boolean) => {
    setBusy(deleteFirst ? "delete" : "disconnect");
    setError(null);
    if (deleteFirst) {
      const results = await Promise.all(
        onBoat.map((machine) =>
          remove({
            environmentId: holderEnvironmentId,
            input: {
              sandboxId: machine.sandboxId,
              ...(machine.state === "running" || machine.state === "starting"
                ? { force: true }
                : {}),
            },
          }),
        ),
      );
      const failed = results.filter((result) => result._tag !== "Success").length;
      if (failed > 0) {
        // Still connected, so the user can retry or delete the rest from the list.
        setBusy(null);
        setError(
          gt("Could not delete {count} of the machines. Nothing was disconnected.", {
            count: failed,
          }),
        );
        return;
      }
    }
    await disconnectAll();
    setBusy(null);
    onClose();
  };
  const computers = holderIds.size;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy === null) {
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {computers > 1
              ? gt("Disconnect Boat on {count} computers?", { count: computers })
              : gt("Disconnect Boat?")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {onBoat.length === 0
              ? gt("The Boat key is removed. You can connect again at any time.")
              : gt(
                  "{count, plural, one {1 machine will be left on Boat.} other {# machines will be left on Boat.}} T3 can't stop or delete them once disconnected.",
                  { count: onBoat.length },
                )}
            {running > 0
              ? ` ${gt(
                  "{count, plural, one {1 is running and stays on until it has been idle for {minutes} minutes.} other {# are running and stay on until they have been idle for {minutes} minutes.}}",
                  { count: running, minutes: status.idleStopMinutes },
                )}`
              : null}
          </AlertDialogDescription>
          {onBoat.length > 0 ? (
            <AlertDialogDescription>
              {saved === 0
                ? gt(
                    "Deleting them takes their threads' machines with them; none has a saved copy on this computer.",
                  )
                : saved === onBoat.length
                  ? gt(
                      "Deleting them takes their threads' machines with them. Each has a saved copy on this computer, so its threads come back if you reconnect, without work since that copy.",
                    )
                  : gt(
                      "Deleting them takes their threads' machines with them. {saved, plural, one {1 of them has a saved copy on this computer, so its threads come back if you reconnect.} other {# of them have a saved copy on this computer, so their threads come back if you reconnect.}}",
                      { saved },
                    )}
            </AlertDialogDescription>
          ) : null}
          {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            disabled={busy !== null}
            render={<Button variant="ghost" disabled={busy !== null} />}
          >
            {gt("Cancel")}
          </AlertDialogClose>
          {onBoat.length === 0 ? (
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void finish(false)}
            >
              {busy ? <Spinner aria-hidden size="sm" /> : null}
              {gt("Disconnect")}
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy !== null} onClick={() => void finish(false)}>
                {busy === "disconnect" ? <Spinner aria-hidden size="sm" /> : null}
                {gt("Disconnect only")}
              </Button>
              <Button
                variant="destructive"
                disabled={busy !== null}
                onClick={() => void finish(true)}
              >
                {busy === "delete" ? <Spinner aria-hidden size="sm" /> : null}
                {gt("Delete machines and disconnect")}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function BoatCloudSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { holderEnvironmentId, status } = usePrimaryBoatCloudStatus();
  const vmEnvironmentIds = new Set(
    (status?.machines ?? []).flatMap((machine) =>
      machine.environmentId === null ? [] : [machine.environmentId],
    ),
  );
  const holderStates = useBoatCloudKeyHolderStates();
  const machines = useKeyHolders(vmEnvironmentIds);
  // A machine whose T3 Code predates Boat cloud cannot take the key until it updates.
  const holders = machines.filter((machine) => {
    const state = holderStates.get(machine.environmentId);
    return state !== undefined && state !== "unsupported";
  });
  const missingKey = holders.filter((holder) => {
    const state = holderStates.get(holder.environmentId);
    return typeof state === "object" && state?.connected === false;
  });
  const [disconnecting, setDisconnecting] = useState(false);
  // Hidden while this machine's status loads, and on a T3 Code without Boat cloud.
  if (status === null) return null;
  const connected = status.connected;
  const blocker = boatCloudBlocker(status);

  return (
    <>
      <SettingsSection {...searchableSetting("boat-cloud")} title={gt("Account")}>
        <SettingsRow
          title={
            connected ? (
              <span className="wrap-anywhere">{status.account ?? gt("Boat API key")}</span>
            ) : (
              gt("Boat API key")
            )
          }
          description={
            !connected
              ? gt("Run threads on boat.dev VMs. The key needs these scopes: {scopes}.", {
                  scopes: BOAT_CLOUD_REQUIRED_SCOPES.join(", "),
                })
              : blocker === null
                ? gt("Connected. Ready for new threads.")
                : blocker === "no-snapshot"
                  ? gt("Connected. Not ready: the snapshot is still building.")
                  : gt("Connected. Not ready: no agent has a sign-in.")
          }
          control={
            connected && holderEnvironmentId !== null ? (
              <Button
                size="xs"
                variant="destructive-outline"
                onClick={() => setDisconnecting(true)}
              >
                {gt("Disconnect")}
              </Button>
            ) : (
              <ApiKeyForm holders={holders} setupEnvironmentId={holderEnvironmentId} />
            )
          }
        />
        {connected ? <EnvironmentRow status={status} holders={holders} /> : null}
        {connected && machines.length > 1
          ? machines.map((machine) => (
              <KeyHolderRow
                key={machine.environmentId}
                environment={machine}
                state={holderStates.get(machine.environmentId)}
              />
            ))
          : null}
        {connected && missingKey.length > 0 ? (
          <SettingsRow
            title={gt("Enable on the others")}
            control={<ApiKeyForm holders={missingKey} setupEnvironmentId={null} />}
          />
        ) : null}
      </SettingsSection>
      {connected && holderEnvironmentId !== null ? (
        <>
          <DisconnectDialog
            open={disconnecting}
            status={status}
            holders={holders}
            holderEnvironmentId={holderEnvironmentId}
            onClose={() => setDisconnecting(false)}
          />
          <BoatCloudMachinesSection status={status} holderEnvironmentId={holderEnvironmentId} />
          <SettingsSection id="boat-cloud-new-machines" title={gt("New machines")}>
            <NewMachineRows
              status={status}
              holders={holders}
              holderEnvironmentId={holderEnvironmentId}
            />
          </SettingsSection>
          <SettingsSection id="boat-cloud-sign-ins" title={gt("Agent sign-ins")}>
            <SignInRows status={status} holders={holders} />
          </SettingsSection>
          {boatCloudChosenEnvironment(status) ? (
            <SettingsSection id="boat-cloud-access" title={gt("Machine access")}>
              <AccessRows status={status} holders={holders} />
            </SettingsSection>
          ) : null}
        </>
      ) : null}
    </>
  );
}
