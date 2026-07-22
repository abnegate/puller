export const MOVEMENT_TTL_MS = 60_000;

export type ReadinessRank = "blocked" | "progress" | "ready";

export type PullMovement = {
  direction: "down" | "up";
  from: ReadinessRank;
  label: string;
  movedAt: number;
  to: ReadinessRank;
};

export type PullMovementEntry = {
  number: number;
  rank: ReadinessRank;
  repository: string;
};

export type PullMovementSnapshot = {
  complete: boolean;
  pulls: readonly PullMovementEntry[];
  viewerLogin: string | null;
};

export const READINESS_RANKS: Readonly<Record<ReadinessRank, number>> = {
  blocked: 0,
  progress: 1,
  ready: 2,
};

const RANK_LABELS: Record<ReadinessRank, string> = {
  blocked: "Not ready",
  progress: "In progress",
  ready: "Ready",
};

const viewerKey = (viewerLogin: string | null): string | null => {
  const viewer = viewerLogin?.trim().toLowerCase() ?? "";
  return viewer.length > 0 ? viewer : null;
};

export const movementPullKey = (
  pull: Pick<PullMovementEntry, "number" | "repository">,
): string | null => {
  const repository = pull.repository.trim().toLowerCase();
  return repository.length > 0 &&
    Number.isSafeInteger(pull.number) &&
    pull.number > 0
    ? `${repository}#${pull.number}`
    : null;
};

const movementLabel = (
  direction: PullMovement["direction"],
  from: ReadinessRank,
  to: ReadinessRank,
): string =>
  `Moved ${direction} from ${RANK_LABELS[from]} to ${RANK_LABELS[to]}`;

const createMovement = (
  from: ReadinessRank,
  to: ReadinessRank,
  movedAt: number,
): PullMovement => {
  const direction = READINESS_RANKS[to] > READINESS_RANKS[from] ? "up" : "down";
  return {
    direction,
    from,
    label: movementLabel(direction, from, to),
    movedAt,
    to,
  };
};

const ranksFromSnapshot = (
  pulls: readonly PullMovementEntry[],
): Map<string, ReadinessRank> => {
  const ranks = new Map<string, ReadinessRank>();
  for (const pull of pulls) {
    const key = movementPullKey(pull);
    if (key !== null) ranks.set(key, pull.rank);
  }
  return ranks;
};

export class PullMovementTracker {
  readonly #clock: () => number;
  #movements = new Map<string, PullMovement>();
  #ranks: Map<string, ReadinessRank> | null = null;
  #viewerLogin: string | null = null;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  observe(
    snapshot: PullMovementSnapshot,
    observedAt = this.#clock(),
  ): ReadonlyMap<string, PullMovement> {
    const viewerLogin = viewerKey(snapshot.viewerLogin);
    if (viewerLogin !== this.#viewerLogin) this.resetViewer(viewerLogin);
    this.#expire(observedAt);

    if (!snapshot.complete || viewerLogin === null) {
      return this.current(observedAt);
    }

    const next = ranksFromSnapshot(snapshot.pulls);
    if (this.#ranks === null) {
      this.#ranks = next;
      return this.current(observedAt);
    }

    for (const [key, to] of next) {
      const from = this.#ranks.get(key);
      if (from !== undefined && from !== to) {
        this.#movements.set(key, createMovement(from, to, observedAt));
      }
    }

    for (const key of this.#ranks.keys()) {
      if (!next.has(key)) this.#movements.delete(key);
    }

    this.#ranks = next;
    return this.current(observedAt);
  }

  recordTransition(
    pull: Pick<PullMovementEntry, "number" | "repository">,
    to: ReadinessRank,
    movedAt = this.#clock(),
  ): ReadonlyMap<string, PullMovement> {
    this.#expire(movedAt);
    const key = movementPullKey(pull);
    const from = key === null ? undefined : this.#ranks?.get(key);
    if (key === null || from === undefined || from === to) {
      return this.current(movedAt);
    }

    this.#ranks?.set(key, to);
    this.#movements.set(key, createMovement(from, to, movedAt));
    return this.current(movedAt);
  }

  resetViewer(viewerLogin: string | null): void {
    const viewer = viewerKey(viewerLogin);
    if (viewer === this.#viewerLogin) return;
    this.#viewerLogin = viewer;
    this.#ranks = null;
    this.#movements.clear();
  }

  current(at = this.#clock()): ReadonlyMap<string, PullMovement> {
    this.#expire(at);
    return new Map(this.#movements);
  }

  nextExpiration(at = this.#clock()): number | null {
    this.#expire(at);
    let next: number | null = null;
    for (const movement of this.#movements.values()) {
      const expiration = movement.movedAt + MOVEMENT_TTL_MS;
      if (next === null || expiration < next) next = expiration;
    }
    return next;
  }

  #expire(at: number): void {
    for (const [key, movement] of this.#movements) {
      if (at - movement.movedAt >= MOVEMENT_TTL_MS) {
        this.#movements.delete(key);
      }
    }
  }
}
