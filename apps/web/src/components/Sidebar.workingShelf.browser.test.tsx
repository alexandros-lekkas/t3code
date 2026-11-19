// Fork: the Working shelf is a Labs setting, off by default.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useQuietThreadShells } from "../state/entities";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const environmentId = EnvironmentId.make("local");
const project: Project = {
  id: ProjectId.make("active"),
  environmentId,
  title: "active",
  workspaceRoot: "/projects/active",
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
};

function thread(id: string, running: boolean): EnvironmentThreadShell {
  const shell = makeThreadFixture({
    environmentId,
    projectId: project.id,
    id: ThreadId.make(id),
    title: id,
  });
  if (!running) return shell;
  return {
    ...shell,
    runtime: {
      status: "running",
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("sidebar Working shelf (Labs)", () => {
  it("is off by default", () => {
    expect(DEFAULT_CLIENT_SETTINGS.sidebarWorkingShelfEnabled).toBe(false);
  });

  it.each([false, true])("shelf enabled=%s", async (enabled) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarWorkingShelfEnabled: enabled,
    });
    const threads = [thread("idle-thread", false), thread("running-thread", true)];
    vi.mocked(useProjects).mockReturnValue([project]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue(null);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId, projectId: project.id },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: null,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("idle-thread").first()).toBeInTheDocument();
    const shelf = () =>
      screen.container.querySelector<HTMLElement>('[data-sidebar-row="shelf:working"]');

    if (enabled) {
      expect(shelf()).not.toBeNull();
      // The collapsed shelf hides its rows unless one is the route thread.
      expect(screen.container.textContent).not.toContain("running-thread");
    } else {
      expect(shelf()).toBeNull();
      // The running thread keeps its place in the active list.
      await expect.element(screen.getByText("running-thread").first()).toBeInTheDocument();
    }
  });
});
