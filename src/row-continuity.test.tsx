// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { PullKey } from "./preferences";
import {
  PullRowContinuityProvider,
  usePullRowContinuity,
  type PullRowFocus,
} from "./row-continuity";

const KEY = "appwrite/cloud#42" as PullKey;

const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
  <PullRowContinuityProvider>{children}</PullRowContinuityProvider>
);

afterEach(cleanup);

const Probe = ({ pull = KEY }: { pull?: PullKey }): ReactNode => {
  const continuity = usePullRowContinuity(pull);
  return (
    <>
      <button
        onClick={() =>
          continuity.update({
            blockersExpanded: true,
            commitsExpanded: true,
            diffExpanded: true,
          })
        }
      >
        open
      </button>
      <output data-testid={pull}>{JSON.stringify(continuity.entry)}</output>
    </>
  );
};

describe("usePullRowContinuity", () => {
  it("persists a row entry while its child unmounts and remounts", () => {
    const App = ({ visible }: { visible: boolean }): ReactNode => (
      <PullRowContinuityProvider>
        {visible ? <Probe /> : null}
      </PullRowContinuityProvider>
    );
    const { rerender } = render(<App visible />);

    act(() => screen.getByRole("button", { name: "open" }).click());
    rerender(<App visible={false} />);
    rerender(<App visible />);

    expect(JSON.parse(screen.getByTestId(KEY).textContent!)).toMatchObject({
      blockersExpanded: true,
      commitsExpanded: true,
      diffExpanded: true,
    });
  });

  it("resets only diff state when a pull receives a new diff key", () => {
    const { result } = renderHook(() => usePullRowContinuity(KEY), { wrapper });

    act(() => {
      result.current.ensureDiffKey("first", "blocked");
      result.current.update({
        blockersExpanded: true,
        commits: {
          persistence: {
            diffs: {},
            listVisible: false,
            selectedSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            viewed: {},
          },
        },
        commitsExpanded: true,
        diff: { selectedFile: "src/App.tsx" },
        diffExpanded: true,
        focus: {
          generation: 2,
          pending: false,
          token: "diff",
          variant: "blocked",
        },
      });
      result.current.ensureDiffKey("second", "ready");
    });

    expect(result.current.entry).toEqual({
      blockersExpanded: true,
      commitsExpanded: false,
      diffExpanded: true,
      diffKey: "second",
      focus: null,
      variant: "ready",
    });
  });

  it("prunes entries that are no longer visible", () => {
    const other = "appwrite/edge#7" as PullKey;
    let prune: ((keys: ReadonlySet<PullKey>) => void) | null = null;
    const Pair = (): ReactNode => {
      const primary = usePullRowContinuity(KEY);
      const secondary = usePullRowContinuity(other);
      prune = primary.prune;
      return (
        <>
          <button onClick={() => primary.update({ blockersExpanded: true })}>
            primary
          </button>
          <button onClick={() => secondary.update({ diffExpanded: true })}>
            secondary
          </button>
          <output data-testid={KEY}>{JSON.stringify(primary.entry)}</output>
          <output data-testid={other}>{JSON.stringify(secondary.entry)}</output>
        </>
      );
    };
    render(
      <PullRowContinuityProvider>
        <Pair />
      </PullRowContinuityProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "primary" }).click();
      screen.getByRole("button", { name: "secondary" }).click();
      prune!(new Set([KEY]));
    });

    expect(JSON.parse(screen.getByTestId(KEY).textContent!)).toMatchObject({
      blockersExpanded: true,
    });
    expect(JSON.parse(screen.getByTestId(other).textContent!)).toEqual({
      blockersExpanded: false,
      commitsExpanded: false,
      diffExpanded: false,
      diffKey: null,
      focus: null,
      variant: null,
    });
  });

  it("removes exactly one row entry through the shared controller", () => {
    const other = "appwrite/edge#7" as PullKey;
    const { result } = renderHook(
      () => ({
        primary: usePullRowContinuity(KEY),
        secondary: usePullRowContinuity(other),
      }),
      { wrapper },
    );

    act(() => {
      result.current.primary.update({ blockersExpanded: true });
      result.current.secondary.update({ diffExpanded: true });
      result.current.primary.remove(KEY);
    });

    expect(result.current.primary.entry).toEqual({
      blockersExpanded: false,
      commitsExpanded: false,
      diffExpanded: false,
      diffKey: null,
      focus: null,
      variant: null,
    });
    expect(result.current.secondary.entry.diffExpanded).toBe(true);
  });

  it("moves the latest pending focus to the new variant and claims it once", () => {
    const { result } = renderHook(() => usePullRowContinuity(KEY), { wrapper });
    const focus: PullRowFocus = {
      generation: 4,
      pending: false,
      token: "blockers",
      variant: "blocked",
    };

    act(() => {
      result.current.ensureDiffKey("stable", "blocked");
      result.current.update({ focus });
      result.current.ensureDiffKey("stable", "progress");
    });

    const transferred = result.current.entry.focus!;
    expect(transferred).toEqual({
      ...focus,
      generation: 5,
      pending: true,
      variant: "progress",
    });

    let firstClaim = false;
    let secondClaim = false;
    act(() => {
      firstClaim = result.current.claimFocus(transferred);
      secondClaim = result.current.claimFocus(transferred);
    });

    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);
    expect(result.current.entry.focus).toBeNull();
  });

  it("preserves compact commit continuity when only the section changes", () => {
    const { result } = renderHook(() => usePullRowContinuity(KEY), { wrapper });
    const commits = {
      persistence: {
        diffs: {
          aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
            navigationVisible: false,
            selectedPath: "src/commit.ts",
          },
        },
        listVisible: false,
        selectedSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        viewed: {
          aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: ["src/commit.ts"],
        },
      },
    };

    act(() => {
      result.current.ensureDiffKey("stable", "ready");
      result.current.update({ commits, commitsExpanded: true });
      result.current.ensureDiffKey("stable", "progress");
    });

    expect(result.current.entry.commits).toBe(commits);
    expect(result.current.entry.commitsExpanded).toBe(true);
    expect(
      (
        result.current.entry.commits as {
          persistence: { listVisible: boolean };
        }
      ).persistence.listVisible,
    ).toBe(false);
    expect(result.current.entry.variant).toBe("progress");
  });

  it("does not transfer focus after it is explicitly cleared", () => {
    const { result } = renderHook(() => usePullRowContinuity(KEY), { wrapper });

    act(() => {
      result.current.ensureDiffKey("stable", "blocked");
      result.current.update({
        focus: {
          generation: 1,
          pending: false,
          token: "diff",
          variant: "blocked",
        },
      });
      result.current.update({ focus: null });
      result.current.ensureDiffKey("stable", "ready");
    });

    expect(result.current.entry.focus).toBeNull();
    expect(result.current.entry.variant).toBe("ready");
  });

  it("notifies only subscribers for the pull that changed", () => {
    const other = "appwrite/edge#7" as PullKey;
    const renders = { other: 0, primary: 0 };
    const RenderCount = ({
      label,
      pull,
    }: {
      label: keyof typeof renders;
      pull: PullKey;
    }): ReactNode => {
      const continuity = usePullRowContinuity(pull);
      renders[label] += 1;
      return (
        <button
          onClick={() =>
            continuity.update({
              blockersExpanded: !continuity.entry.blockersExpanded,
            })
          }
        >
          {label}
        </button>
      );
    };
    render(
      <PullRowContinuityProvider>
        <RenderCount label="primary" pull={KEY} />
        <RenderCount label="other" pull={other} />
      </PullRowContinuityProvider>,
    );
    const otherBefore = renders.other;

    act(() => screen.getByRole("button", { name: "primary" }).click());

    expect(renders.primary).toBeGreaterThan(1);
    expect(renders.other).toBe(otherBefore);
  });
});
