/**
 * One Boat start per draft, shared by its pre-warm and its send, so a draft never asks the
 * holder for a second VM while its first is still wanted. A start that is given up, replaced
 * or fails after its VM was handed out releases that VM, which the holder then deletes.
 */
export interface DraftStart<Target> {
  /** The repository and VM size the start is for. */
  readonly key: string;
  readonly target: Promise<Target | null>;
  /** Resolves once the start is given up, so a runner stops waiting. */
  readonly givenUp: Promise<void>;
  /** The VM the holder handed out, until it is released. */
  readonly sandboxId: () => string | null;
  readonly abandoned: () => boolean;
  /**
   * The runner reports the VM the holder handed out. False when the start was given up
   * meanwhile: the VM is released at once and the runner stops.
   */
  readonly handedOut: (sandboxId: string) => boolean;
}

/** What the draft wants of its start, on each hold: keep it, it made its thread, or let it go. */
export type DraftStartWant = "wanted" | "done" | "gone";

export function makeDraftStarts<Input, Target>(deps: {
  readonly run: (input: Input, start: DraftStart<Target>) => Promise<Target | null>;
  readonly release: (sandboxId: string, input: Input) => void;
  readonly hold: (sandboxId: string, input: Input) => void;
}) {
  interface Entry extends Omit<DraftStart<Target>, "target"> {
    target: Promise<Target | null>;
    failed: boolean;
    readonly input: Input;
    readonly abandon: () => void;
  }
  const starts = new Map<string, Entry>();

  const begin = (draftId: string, key: string, input: Input): DraftStart<Target> => {
    const current = starts.get(draftId);
    if (current !== undefined && current.key === key && !current.failed) return current;
    if (current !== undefined) abandon(draftId);
    let sandboxId: string | null = null;
    let abandoned = false;
    let giveUp = () => undefined as void;
    const releaseVm = () => {
      if (sandboxId === null) return;
      const released = sandboxId;
      sandboxId = null;
      deps.release(released, input);
    };
    const start: Entry = {
      key,
      input,
      failed: false,
      target: Promise.resolve(null),
      givenUp: new Promise<void>((resolve) => {
        giveUp = resolve;
      }),
      sandboxId: () => sandboxId,
      abandoned: () => abandoned,
      handedOut: (id: string) => {
        sandboxId = id;
        if (!abandoned) return true;
        releaseVm();
        return false;
      },
      abandon: () => {
        abandoned = true;
        releaseVm();
        giveUp();
      },
    };
    starts.set(draftId, start);
    start.target = deps.run(input, start).then(
      (target) => {
        if (target === null) {
          start.failed = true;
          releaseVm();
        }
        return target;
      },
      () => {
        start.failed = true;
        releaseVm();
        return null;
      },
    );
    return start;
  };

  const abandon = (draftId: string) => {
    const start = starts.get(draftId);
    if (start === undefined) return;
    starts.delete(draftId);
    start.abandon();
  };

  return {
    /** The draft's start for this repository and size: the one running, else a new one. */
    begin,
    /** The draft's start, retried once when the one it had already failed. */
    prepare: async (draftId: string, key: string, input: Input): Promise<Target | null> => {
      const existing = starts.get(draftId);
      const start = begin(draftId, key, input);
      const target = await start.target;
      if (target !== null || start !== existing || start.abandoned()) return target;
      return begin(draftId, key, input).target;
    },
    /** Gives the draft's start up; its VM, once known, is released. */
    abandon,
    /** The draft made its thread on the VM, which now keeps it. */
    finish: (draftId: string) => {
      starts.delete(draftId);
    },
    /** Holds every VM still wanted, and ends the starts that are not. */
    hold: (wantOf: (draftId: string) => DraftStartWant) => {
      for (const [draftId, start] of starts) {
        const want = wantOf(draftId);
        if (want === "gone") abandon(draftId);
        else if (want === "done") starts.delete(draftId);
        else {
          const sandboxId = start.sandboxId();
          if (sandboxId !== null) deps.hold(sandboxId, start.input);
        }
      }
    },
    size: () => starts.size,
  };
}
