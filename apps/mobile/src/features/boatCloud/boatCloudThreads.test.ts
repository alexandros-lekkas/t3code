import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";

const vm = EnvironmentId.make("vm");
const mac = EnvironmentId.make("mac");

const fixtures = vi.hoisted(() => ({ managed: null as unknown }));

vi.mock("../../connection/catalog", async () => {
  const { Atom: A } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: A.make({
        entries: new Map([
          [
            "vm",
            {
              target: {
                _tag: "PrimaryConnectionTarget",
                httpBaseUrl: "https://vm-3773.on.boat.dev",
              },
            },
          ],
          [
            "mac",
            { target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://mac.local:3773" } },
          ],
        ]),
      }),
    },
  };
});
vi.mock("../../state/preferences", async () => {
  const { AsyncResult: R, Atom: A } = await import("effect/reactivity");
  return {
    mobilePreferencesAtom: A.make(
      R.success({ boatCloudOpenedThreads: [{ environmentId: "vm", threadId: "opened" }] }),
    ),
    updateMobilePreferencesAtom: A.make(0),
  };
});
vi.mock("./boatCloudManagedEnvironments", async () => {
  const { Atom: A } = await import("effect/reactivity");
  const atom = A.make(new Set<string>());
  fixtures.managed = atom;
  return { managedBoatCloudEnvironmentIdsAtom: atom };
});

const { boatCloudThreadList } = await import("./boatCloudThreads");
const managedAtom = () => fixtures.managed as Atom.Writable<ReadonlySet<EnvironmentId>>;

describe("boatCloudThreadList.listedThreadIdsAtom", () => {
  it("lists only the opened threads of a VM no connected machine manages", () => {
    expect(appAtomRegistry.get(boatCloudThreadList.listedThreadIdsAtom(vm))).toEqual(
      new Set([ThreadId.make("opened")]),
    );
  });

  it("lists every thread of a VM a connected machine handed out, so agents' threads show", () => {
    appAtomRegistry.set(managedAtom(), new Set([vm]));
    expect(appAtomRegistry.get(boatCloudThreadList.listedThreadIdsAtom(vm))).toBeNull();
    appAtomRegistry.set(managedAtom(), new Set());
  });

  it("does not filter a machine that is not a VM", () => {
    expect(appAtomRegistry.get(boatCloudThreadList.listedThreadIdsAtom(mac))).toBeNull();
  });
});
