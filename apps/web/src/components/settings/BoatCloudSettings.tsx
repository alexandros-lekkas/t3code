import {
  BOAT_CLOUD_REQUIRED_SCOPES,
  BOAT_CLOUD_SETUP_STEPS,
  type BoatCloudEnvironmentAccess,
  type BoatCloudMachineType,
  type BoatCloudSetupStep,
  type BoatCloudStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { CheckIcon, CircleIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

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
  boatCloudEnvironmentDrivers,
} from "@t3tools/shared/boatCloudVm";
import { BoatIcon } from "../Icons";
import { Badge } from "../ui/badge";
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

/**
 * The Boat environment new VMs start on, and whether a thread can start on it. Agent sign-ins
 * and GitHub are requirements, not choices. Every key holder gets the same choice.
 */
function EnvironmentRows({
  status,
  holders,
}: {
  readonly status: BoatCloudStatus;
  readonly holders: ReadonlyArray<EnvironmentPresentation>;
}) {
  const gt = useGT();
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
  if (status.environmentsError !== null) {
    return <SettingsRow title={gt("Boat environment")} description={status.environmentsError} />;
  }
  const blocker = boatCloudBlocker(status);
  const drivers = boatCloudEnvironmentDrivers(selected);
  const turnOn = (access: Partial<BoatCloudEnvironmentAccess>) => (
    <Button
      variant="outline"
      size="xs"
      disabled={busy}
      onClick={() => void apply(selected!.id, access)}
    >
      {gt("Turn on")}
    </Button>
  );
  const github =
    selected === undefined || status.githubConnected === null
      ? null
      : selected.passGithub && status.githubConnected;
  return (
    <>
      <SettingsRow
        title={gt("Boat environment")}
        description={
          blocker === null
            ? gt("Ready to start.")
            : blocker === "no-snapshot"
              ? gt("Not ready: the snapshot is still being built.")
              : gt("Not ready: add an agent sign-in.")
        }
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
      {selected ? (
        <>
          <SettingsRow
            title={
              <StatusTitle
                state={drivers === null ? "pending" : drivers.size > 0 ? "done" : "failed"}
              >
                {gt("Agents")}
              </StatusTitle>
            }
            description={
              !selected.passAgentsCredentials ? (
                gt("This Boat environment withholds agent sign-ins.")
              ) : drivers === null ? (
                gt("Boat did not say which sign-ins it has.")
              ) : drivers.size === 0 ? (
                gt("Add a Claude or ChatGPT sign-in to this Boat environment.")
              ) : (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {AGENT_PROVIDERS.map(({ driver, label }) => (
                    <span key={driver} className="flex items-center gap-1">
                      {drivers.has(driver) ? (
                        <CheckIcon
                          aria-label={gt("Signed in")}
                          className="size-3.5 text-success-foreground"
                        />
                      ) : (
                        <XIcon
                          aria-label={gt("No sign-in")}
                          className="size-3.5 text-muted-foreground"
                        />
                      )}
                      {label}
                    </span>
                  ))}
                </span>
              )
            }
            control={
              !selected.passAgentsCredentials ? (
                turnOn({ passAgentsCredentials: true })
              ) : (
                <ExternalLinkButton href={BOAT_AGENTS_DASHBOARD_URL}>
                  {drivers?.size === 0 ? gt("Add sign-in") : gt("Manage")}
                </ExternalLinkButton>
              )
            }
          />
          <SettingsRow
            title={
              <StatusTitle state={github === null ? "pending" : github ? "done" : "failed"}>
                {gt("GitHub")}
              </StatusTitle>
            }
            description={github ? gt("Connected.") : gt("Private repositories and pushes need it.")}
            control={
              !selected.passGithub ? (
                turnOn({ passGithub: true })
              ) : status.githubConnected === false ? (
                <ExternalLinkButton href={BOAT_ENVIRONMENT_DASHBOARD_URL}>
                  {gt("Connect")}
                </ExternalLinkButton>
              ) : null
            }
          />
          <SettingsRow
            title={gt("Secrets")}
            description={gt("Gives VMs this environment's variables and secret files.")}
            control={
              <Switch
                aria-label={gt("Secrets")}
                checked={selected.passSecrets}
                disabled={busy}
                onCheckedChange={(checked) =>
                  void apply(selected.id, { passSecrets: Boolean(checked) })
                }
              />
            }
          />
          <SettingsRow
            title={gt("Boat key on VMs")}
            description={gt(
              "Lets agents on a VM start, stop and delete VMs billed to your account. T3 Code does not need it.",
            )}
            control={
              <Switch
                aria-label={gt("Boat key on VMs")}
                checked={selected.passSandboxCredentials}
                disabled={busy}
                onCheckedChange={(checked) =>
                  void apply(selected.id, { passSandboxCredentials: Boolean(checked) })
                }
              />
            }
          />
        </>
      ) : null}
    </>
  );
}

/** Boat cloud's section of Settings, Environments. */
/** How new cloud threads get VMs. Every key holder gets the same choice. */
function MachineRows({
  status,
  holders,
}: {
  readonly status: BoatCloudStatus;
  readonly holders: ReadonlyArray<EnvironmentPresentation>;
}) {
  const gt = useGT();
  const label = useBoatCloudMachineTypeLabel();
  const configure = useAtomCommand(serverEnvironment.configureBoatCloudMachines);
  const [busy, setBusy] = useState(false);
  const apply = async (input: {
    readonly shareMachines?: boolean;
    readonly defaultMachineType?: BoatCloudMachineType;
    readonly keepReadyMachine?: boolean;
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
  return (
    <>
      {sizes.length > 0 ? (
        <SettingsRow
          title={gt("Default size")}
          description={gt("New Boat threads start on it unless they pick another.")}
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
          "Lets a new thread join a running VM that has room. Off, each thread gets a VM of its own.",
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
            ? gt("Faster starts. An idle VM stays on and is billed.")
            : gt("Faster starts. An idle VM stays on at {price}.", { price: sparePrice })
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
    </>
  );
}

export function BoatCloudSettings() {
  const gt = useGT();
  const m = useMessages();
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
  const runSetup = useAtomCommand(serverEnvironment.runBoatCloudSetup);
  const disconnect = useAtomCommand(serverEnvironment.disconnectBoatCloud);
  const connected = status?.connected === true;
  const setup = status?.setup;
  const rebuild = () => {
    if (holderEnvironmentId === null) return;
    void runSetup({
      environmentId: holderEnvironmentId,
      input: { repositories: boatCloudSnapshotRepositories() },
    });
  };
  const setupStepIndex = setup?.step ? BOAT_CLOUD_SETUP_STEPS.indexOf(setup.step) : -1;
  // Hidden while this machine's status loads, and on a T3 Code without Boat cloud.
  if (status === null) return null;

  return (
    <>
      <SettingsSection
        {...searchableSetting("boat-cloud")}
        icon={<BoatIcon aria-hidden className="size-5" />}
      >
        <SettingsRow
          title={
            connected ? (
              <span className="wrap-anywhere">{status.account ?? gt("Boat API key")}</span>
            ) : (
              gt("Boat API key")
            )
          }
          description={
            connected
              ? gt("Connected")
              : gt("Run threads on boat.dev VMs. The key needs these scopes: {scopes}.", {
                  scopes: BOAT_CLOUD_REQUIRED_SCOPES.join(", "),
                })
          }
          control={
            connected && holderEnvironmentId !== null ? (
              <Button
                size="xs"
                variant="destructive-outline"
                onClick={() => {
                  for (const holder of holders) {
                    void disconnect({ environmentId: holder.environmentId, input: {} });
                  }
                }}
              >
                {gt("Disconnect")}
              </Button>
            ) : (
              <ApiKeyForm holders={holders} setupEnvironmentId={holderEnvironmentId} />
            )
          }
        />
        {connected && setup ? (
          <SettingsRow
            title={
              <span className="flex items-center gap-2">
                <StepIcon
                  state={
                    setup.status === "ready"
                      ? "done"
                      : setup.status === "failed"
                        ? "failed"
                        : setup.status === "running"
                          ? "active"
                          : "pending"
                  }
                />
                {gt("Snapshot")}
              </span>
            }
            description={
              setup.status === "ready"
                ? gt("New VMs start from it.")
                : setup.status === "failed"
                  ? (setup.error ?? gt("Setup failed."))
                  : setup.status === "running" && setup.step !== null
                    ? gt("Step {step} of {total}: {label}", {
                        step: setupStepIndex + 1,
                        total: BOAT_CLOUD_SETUP_STEPS.length,
                        label: m(STEP_LABELS[setup.step]),
                      })
                    : gt("Builds the image new VMs start from.")
            }
            control={
              setup.status === "running" ? (
                <span className="text-xs text-muted-foreground">{gt("Setting up")}</span>
              ) : (
                <Button variant="outline" size="xs" onClick={rebuild}>
                  {setup.status === "ready"
                    ? gt("Rebuild snapshot")
                    : setup.status === "failed"
                      ? gt("Retry")
                      : gt("Set up")}
                </Button>
              )
            }
          />
        ) : null}
        {connected ? <EnvironmentRows status={status} holders={holders} /> : null}
        {connected ? <MachineRows status={status} holders={holders} /> : null}
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
        <BoatCloudMachinesSection status={status} holderEnvironmentId={holderEnvironmentId} />
      ) : null}
    </>
  );
}
