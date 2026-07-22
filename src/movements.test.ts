import { describe, expect, it } from "vitest";

import {
  MOVEMENT_TTL_MS,
  movementPullKey,
  PullMovementTracker,
  type PullMovementEntry,
  type PullMovementSnapshot,
  type ReadinessRank,
} from "./movements";

const pull = (
  repository: string,
  number: number,
  rank: ReadinessRank,
): PullMovementEntry => ({ number, rank, repository });

const snapshot = (
  pulls: readonly PullMovementEntry[],
  options: Partial<Pick<PullMovementSnapshot, "complete" | "viewerLogin">> = {},
): PullMovementSnapshot => ({
  complete: true,
  pulls,
  viewerLogin: "Jake",
  ...options,
});

describe("PullMovementTracker", () => {
  it("uses the first complete snapshot as a case-insensitive baseline", () => {
    let now = 1_000;
    const tracker = new PullMovementTracker(() => now);

    tracker.observe(
      snapshot([pull("Appwrite/Cloud", 42, "blocked")], {
        complete: false,
      }),
    );
    now = 2_000;
    expect(
      tracker.observe(snapshot([pull("appwrite/cloud", 42, "ready")])),
    ).toEqual(new Map());

    now = 3_000;
    const movements = tracker.observe(
      snapshot([pull("APPWRITE/CLOUD", 42, "progress")]),
    );
    expect(movementPullKey(pull(" APPWRITE/CLOUD ", 42, "ready"))).toBe(
      "appwrite/cloud#42",
    );
    expect(movements.get("appwrite/cloud#42")).toEqual({
      direction: "down",
      from: "ready",
      label: "Moved down from Ready to In progress",
      movedAt: 3_000,
      to: "progress",
    });
  });

  it("ignores incomplete snapshots without changing ranks or timestamps", () => {
    let now = 10_000;
    const tracker = new PullMovementTracker(() => now);
    tracker.observe(snapshot([pull("appwrite/cloud", 7, "blocked")]));

    now = 11_000;
    expect(
      tracker.observe(
        snapshot([pull("appwrite/cloud", 7, "ready")], {
          complete: false,
        }),
      ),
    ).toEqual(new Map());

    now = 12_000;
    const movement = tracker
      .observe(snapshot([pull("appwrite/cloud", 7, "progress")]))
      .get("appwrite/cloud#7");
    expect(movement).toMatchObject({
      direction: "up",
      from: "blocked",
      movedAt: 12_000,
      to: "progress",
    });

    now = 13_000;
    expect(
      tracker
        .observe(snapshot([pull("appwrite/cloud", 7, "progress")]))
        .get("appwrite/cloud#7")?.movedAt,
    ).toBe(12_000);
  });

  it("ignores insertion and removal rather than presenting them as movement", () => {
    let now = 20_000;
    const tracker = new PullMovementTracker(() => now);
    tracker.observe(snapshot([pull("appwrite/cloud", 1, "blocked")]));

    now = 21_000;
    const changed = tracker.observe(
      snapshot([
        pull("appwrite/cloud", 1, "ready"),
        pull("appwrite/edge", 2, "ready"),
      ]),
    );
    expect([...changed.keys()]).toEqual(["appwrite/cloud#1"]);

    now = 22_000;
    expect(
      tracker.observe(snapshot([pull("appwrite/edge", 2, "ready")])),
    ).toEqual(new Map());

    now = 23_000;
    expect(
      tracker.observe(
        snapshot([
          pull("appwrite/cloud", 1, "blocked"),
          pull("appwrite/edge", 2, "ready"),
        ]),
      ),
    ).toEqual(new Map());
  });

  it("retains off-page movement across presentation-only refreshes", () => {
    let now = 30_000;
    const tracker = new PullMovementTracker(() => now);
    const baseline = Array.from({ length: 41 }, (_, index) =>
      pull("appwrite/cloud", index + 1, "blocked"),
    );
    tracker.observe(snapshot(baseline));

    now = 31_000;
    const moved = baseline.map((entry) =>
      entry.number === 41 ? { ...entry, rank: "ready" as const } : entry,
    );
    tracker.observe(snapshot(moved));

    now = 32_000;
    const retained = tracker.observe(snapshot(moved));
    expect(retained.get("appwrite/cloud#41")).toMatchObject({
      direction: "up",
      from: "blocked",
      movedAt: 31_000,
      to: "ready",
    });
    expect(tracker.current().has("appwrite/cloud#41")).toBe(true);
  });

  it("expires movement after one minute without depending on a mounted row", () => {
    let now = 40_000;
    const tracker = new PullMovementTracker(() => now);
    tracker.observe(snapshot([pull("appwrite/cloud", 9, "blocked")]));
    now = 41_000;
    tracker.observe(snapshot([pull("appwrite/cloud", 9, "ready")]));

    expect(tracker.nextExpiration()).toBe(41_000 + MOVEMENT_TTL_MS);
    now = 41_000 + MOVEMENT_TTL_MS - 1;
    expect(tracker.current().has("appwrite/cloud#9")).toBe(true);
    now += 1;
    expect(tracker.current()).toEqual(new Map());
    expect(tracker.nextExpiration()).toBeNull();
  });

  it("supports trusted local transitions with semantic up and down labels", () => {
    let now = 50_000;
    const tracker = new PullMovementTracker(() => now);
    const identity = pull("appwrite/cloud", 5, "blocked");
    tracker.observe(snapshot([identity]));

    now = 51_000;
    expect(
      tracker.recordTransition(identity, "ready").get("appwrite/cloud#5"),
    ).toMatchObject({
      direction: "up",
      label: "Moved up from Not ready to Ready",
      movedAt: 51_000,
    });

    now = 52_000;
    expect(
      tracker.recordTransition(identity, "blocked").get("appwrite/cloud#5"),
    ).toMatchObject({
      direction: "down",
      label: "Moved down from Ready to Not ready",
      movedAt: 52_000,
    });
  });

  it("clears movements and establishes a new baseline when the viewer changes", () => {
    let now = 60_000;
    const tracker = new PullMovementTracker(() => now);
    tracker.observe(snapshot([pull("appwrite/cloud", 3, "blocked")]));
    now = 61_000;
    expect(
      tracker
        .observe(snapshot([pull("appwrite/cloud", 3, "ready")]))
        .has("appwrite/cloud#3"),
    ).toBe(true);

    now = 62_000;
    expect(
      tracker.observe(
        snapshot([pull("appwrite/cloud", 3, "blocked")], {
          viewerLogin: "another-viewer",
        }),
      ),
    ).toEqual(new Map());

    now = 63_000;
    expect(
      tracker
        .observe(
          snapshot([pull("appwrite/cloud", 3, "progress")], {
            viewerLogin: "ANOTHER-VIEWER",
          }),
        )
        .get("appwrite/cloud#3"),
    ).toMatchObject({
      direction: "up",
      from: "blocked",
      to: "progress",
    });

    tracker.resetViewer(null);
    expect(tracker.current()).toEqual(new Map());
  });
});
