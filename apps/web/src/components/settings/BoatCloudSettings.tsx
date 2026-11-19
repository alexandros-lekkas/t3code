import {
  BOAT_CLOUD_REQUIRED_SCOPES,
  BOAT_CLOUD_SETUP_STEPS,
  type BoatCloudEnvironmentAccess,
  type BoatCloudMachine,
  type BoatCloudSetupStep,
  type BoatCloudStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { CheckIcon, CircleDotIcon, CircleIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  boatCloudSnapshotRepositories,
  useBoatCloudKeyHolderStates,
  usePrimaryBoatCloudStatus,
} from "../../boatCloud";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { BoatIcon } from "../Icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const STEP_LABELS: Record<BoatCloudSetupStep, string> = {
  "create-vm": msg("Create a VM"),
  "install-server": msg("Install T3 Code and clone repositories"),
  "copy-skills": msg("Copy this machine's skills"),
  "save-snapshot": msg("Save the T3 Code snapshot"),
};

const MACHINE_STATE: Record<
  BoatCloudMachine["state"],
  { readonly label: string; readonly variant: "success" | "info" | "secondary" | "warning" }
> = {
  running: { label: msg("Running", { $context: "VM state" }), variant: "success" },
  starting: { label: msg("Starting", { $context: "VM state" }), variant: "info" },
  stopped: { label: msg("Sleeping", { $context: "VM state" }), variant: "secondary" },
  gone: { label: msg("Saved copy", { $context: "VM state" }), variant: "warning" },
};

const ACCESS_LABELS: Record<keyof BoatCloudEnvironmentAccess, string> = {
  passGithub: msg("GitHub access"),
  passSandboxCredentials: msg("Boat credentials"),
  passSecrets: msg("Secrets"),
  passAgentsCredentials: msg("Agent sign-ins"),
};
const ACCESS_KEYS = Object.keys(ACCESS_LABELS) as ReadonlyArray<keyof BoatCloudEnvironmentAccess>;

type StepState = "done" | "active" | "failed" | "pending";

// Static glyphs: setup takes minutes, and a spinner would repaint the whole time.
function StepIcon({ state }: { readonly state: StepState }) {
  if (state === "done") return <CheckIcon aria-hidden className="size-4 text-success-foreground" />;
  if (state === "failed") return <XIcon aria-hidden className="size-4 text-error-foreground" />;
  if (state === "active")
    return <CircleDotIcon aria-hidden className="size-4 text-info-foreground" />;
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

/** The Boat environment new VMs start on, and what it passes to them. Every key holder gets the same choice. */
function EnvironmentRows({
  status,
  holders,
}: {
  readonly status: BoatCloudStatus;
  readonly holders: ReadonlyArray<EnvironmentPresentation>;
}) {
  const gt = useGT();
  const m = useMessages();
  const configure = useAtomCommand(serverEnvironment.configureBoatCloudEnvironment);
  const [busy, setBusy] = useState(false);
  const selected = status.environments.find(
    (environment) => environment.name === status.environment,
  );
  const apply = async (environmentId: string, access?: BoatCloudEnvironmentAccess) => {
    setBusy(true);
    await Promise.all(
      holders.map((holder) =>
        configure({
          environmentId: holder.environmentId,
          input: { environmentId, ...(access ? { access } : {}) },
        }),
      ),
    );
    setBusy(false);
  };
  return (
    <>
      {status.environmentsError !== null ? (
        <SettingsRow title={gt("Boat environment")} description={status.environmentsError} />
      ) : (
        <>
          <SettingsRow
            title={gt("Boat environment")}
            description={gt("New VMs start on it. Running VMs keep theirs.")}
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
          {selected
            ? ACCESS_KEYS.map((key) => (
                <SettingsRow
                  key={key}
                  title={m(ACCESS_LABELS[key])}
                  control={
                    <Switch
                      aria-label={m(ACCESS_LABELS[key])}
                      checked={selected[key]}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        void apply(selected.id, {
                          passGithub: selected.passGithub,
                          passSandboxCredentials: selected.passSandboxCredentials,
                          passSecrets: selected.passSecrets,
                          passAgentsCredentials: selected.passAgentsCredentials,
                          [key]: Boolean(checked),
                        })
                      }
                    />
                  }
                />
              ))
            : null}
        </>
      )}
    </>
  );
}

/** Boat cloud's section of Settings, Environments. */
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
    <SettingsSection
      {...searchableSetting("boat-cloud")}
      icon={<BoatIcon aria-hidden className="size-4" />}
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
            <Button
              variant="outline"
              size="xs"
              disabled={setup.status === "running"}
              onClick={rebuild}
            >
              {setup.status === "running"
                ? gt("Setting up")
                : setup.status === "ready"
                  ? gt("Rebuild snapshot")
                  : setup.status === "failed"
                    ? gt("Retry")
                    : gt("Set up")}
            </Button>
          }
        />
      ) : null}
      {connected ? <EnvironmentRows status={status} holders={holders} /> : null}
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
      {connected
        ? status.machines.map((machine) => {
            const state = MACHINE_STATE[machine.state];
            return (
              <SettingsRow
                key={machine.sandboxId}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <BoatIcon aria-hidden className="size-3.5" />
                    <span className="truncate">{machine.label}</span>
                  </span>
                }
                description={
                  machine.repositories.length > 0
                    ? machine.repositories
                        .map((repository) => repository.split("/").slice(1).join("/"))
                        .join(", ")
                    : undefined
                }
                control={<Badge variant={state.variant}>{m(state.label)}</Badge>}
              />
            );
          })
        : null}
    </SettingsSection>
  );
}
