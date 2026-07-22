import type { PullReadiness } from "./types";

export type ViewedFiles = ReadonlySet<string>;

export type ViewedFilesByPull = ReadonlyMap<string, ViewedFiles>;

export type ToggleViewedFile = (
  pull: Pick<
    PullReadiness,
    "baseRefOid" | "headRefOid" | "number" | "repository"
  >,
  path: string,
) => void;

export const EMPTY_VIEWED_FILES: ViewedFiles = new Set<string>();

export const EMPTY_VIEWED_FILES_BY_PULL: ViewedFilesByPull = new Map<
  string,
  ViewedFiles
>();

export const getPullDiffKey = (
  pull: Pick<
    PullReadiness,
    "baseRefOid" | "headRefOid" | "number" | "repository"
  >,
  viewerLogin: string | null,
  artifactEpoch: number,
): string =>
  JSON.stringify([
    artifactEpoch,
    viewerLogin?.trim().toLowerCase() ?? null,
    pull.repository.toLowerCase(),
    pull.number,
    pull.baseRefOid.toLowerCase(),
    pull.headRefOid.toLowerCase(),
  ]);

export const pruneViewedFiles = (
  current: ViewedFilesByPull,
  pulls: readonly PullReadiness[],
  viewerLogin: string | null,
  artifactEpoch: number,
): ViewedFilesByPull => {
  const active = new Set(
    pulls.map((pull) => getPullDiffKey(pull, viewerLogin, artifactEpoch)),
  );
  let next: Map<string, ViewedFiles> | null = null;

  for (const key of current.keys()) {
    if (active.has(key)) continue;

    next ??= new Map(current);
    next.delete(key);
  }

  return next ?? current;
};
