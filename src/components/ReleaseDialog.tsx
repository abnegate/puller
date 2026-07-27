import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ExternalLink, LoaderCircle, Rocket } from "lucide-react";

import { createRelease, getReleasePreview } from "@/api";
import type {
  CreateReleaseResponse,
  ReleaseOptions,
  ReleasePreview,
  ReleaseRepository,
} from "@/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import ReleaseTagPicker from "@/components/ReleaseTagPicker";
import RepositoryPicker from "@/components/RepositoryPicker";
import { useReleaseOptions } from "@/release-options";
import { formatRelativeTime } from "@/time";

type ReleaseDialogProps = {
  onCreated: (release: CreateReleaseResponse) => Promise<void> | void;
  viewerLogin: string | null;
};

const errorText = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : "Release options could not be loaded.";

const isNonActionableHistoryWarning = (warning: string): boolean =>
  /\bhistory may be incomplete\b/i.test(warning) ||
  /\bgithub\b.*\btruncated\b.*\bauthored merged pull requests?\b.*\bsearch\b/i.test(
    warning,
  ) ||
  /\bauthored merged pull requests?\b.*\bcould not be loaded\b.*\brelease membership\b/i.test(
    warning,
  );

const findRepository = (
  options: ReleaseOptions | null,
  repository: string,
): ReleaseRepository | null =>
  options?.repositories.find(
    (item) => item.repository.toLowerCase() === repository.toLowerCase(),
  ) ?? null;

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formatTimestamp = (value: string): string | undefined => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : timestampFormatter.format(date);
};

const canonicalViewer = (viewerLogin: string | null): string | null => {
  const viewer = viewerLogin?.trim().toLowerCase() ?? "";
  return viewer || null;
};

export default function ReleaseDialog(props: ReleaseDialogProps) {
  const viewerLogin = canonicalViewer(props.viewerLogin);
  return (
    <ReleaseDialogContent
      key={viewerLogin ?? "anonymous"}
      {...props}
      viewerLogin={viewerLogin}
    />
  );
}

function ReleaseDialogContent({ onCreated, viewerLogin }: ReleaseDialogProps) {
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [repository, setRepository] = useState("");
  const [tag, setTag] = useState("");
  const [prerelease, setPrerelease] = useState(false);
  const [preview, setPreview] = useState<ReleasePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateReleaseResponse | null>(null);
  const [createdPrerelease, setCreatedPrerelease] = useState<boolean | null>(
    null,
  );
  const {
    error: loadError,
    forceRefresh,
    loading,
    options,
    refreshing,
  } = useReleaseOptions(viewerLogin, open);
  const prereleaseDescriptionId = useId();
  const previewController = useRef<AbortController | null>(null);
  const previewRevision = useRef(0);
  const tagDescriptionId = useId();
  const tagErrorId = useId();
  const repositoryRef = useRef(repository);
  const requestRevision = useRef(0);
  const submitController = useRef<AbortController | null>(null);
  const submitPending = useRef(false);
  const tagRevision = useRef(0);
  const wasLoading = useRef(false);

  const forceRefreshOptions =
    useCallback((): Promise<ReleaseOptions | null> => {
      requestRevision.current = tagRevision.current;
      return forceRefresh();
    }, [forceRefresh]);

  useEffect(() => {
    const busy = loading || refreshing;
    if (busy && !wasLoading.current) {
      requestRevision.current = tagRevision.current;
    }
    wasLoading.current = busy;
  }, [loading, refreshing]);

  useEffect(() => {
    if (options === null) return;

    const currentRepository = repositoryRef.current;
    const selected =
      findRepository(options, currentRepository) ??
      options.repositories[0] ??
      null;
    const repositoryChanged =
      selected !== null &&
      selected.repository.toLowerCase() !== currentRepository.toLowerCase();

    repositoryRef.current = selected?.repository ?? "";
    setRepository(selected?.repository ?? "");
    if (
      selected === null ||
      repositoryChanged ||
      tagRevision.current === requestRevision.current
    ) {
      setTag(selected?.nextTag ?? "");
    }
  }, [options]);

  useEffect(() => {
    return () => {
      previewController.current?.abort();
      previewController.current = null;
      submitController.current?.abort();
      submitController.current = null;
    };
  }, []);

  const selected = useMemo(
    () => findRepository(options, repository),
    [options, repository],
  );
  const warnings = useMemo(
    () =>
      options?.warnings.filter(
        (warning) => !isNonActionableHistoryWarning(warning),
      ) ?? [],
    [options],
  );
  const normalizedTag = tag.trim();
  const tagExists = selected?.previousTags.includes(normalizedTag) ?? false;
  const valid = selected !== null && normalizedTag.length > 0 && !tagExists;
  const previewMatches =
    preview !== null &&
    selected !== null &&
    preview.repository === selected.repository &&
    preview.tag === normalizedTag &&
    preview.baseTag === selected.latestTag;

  useEffect(() => {
    previewRevision.current += 1;
    previewController.current?.abort();
    previewController.current = null;
    setPreview(null);
    setPreviewError(null);
    setPreviewing(false);
  }, [normalizedTag, selected?.latestTag, selected?.repository]);

  const handleOpenChange = (next: boolean) => {
    if (!next && submitting) return;
    setOpen(next);
    if (next) {
      setCreated(null);
      setCreatedPrerelease(null);
      setSubmitError(null);
    } else {
      previewController.current?.abort();
      previewController.current = null;
      setConfirmOpen(false);
      setPreviewing(false);
    }
  };

  const selectRepository = (value: string) => {
    if (!value) return;

    repositoryRef.current = value;
    setRepository(value);
    const item = findRepository(options, value);
    setTag(item?.nextTag ?? "");
    setSubmitError(null);
    setCreated(null);
  };

  const reloadAfterConflict = () => {
    void forceRefreshOptions();
  };

  const loadPreview = async () => {
    if (!selected || !valid) return;

    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    const revision = ++previewRevision.current;
    const expected = {
      baseTag: selected.latestTag,
      repository: selected.repository,
      tag: normalizedTag,
    };
    setPreview(null);
    setPreviewError(null);
    setPreviewing(true);
    try {
      const result = await getReleasePreview(
        {
          expectedLatestTag: expected.baseTag,
          repository: expected.repository,
          tag: expected.tag,
        },
        controller.signal,
      );
      if (
        previewController.current !== controller ||
        previewRevision.current !== revision ||
        result.baseTag !== expected.baseTag ||
        result.repository !== expected.repository ||
        result.tag !== expected.tag
      ) {
        return;
      }
      setPreview(result);
    } catch (error) {
      if (
        previewController.current === controller &&
        previewRevision.current === revision &&
        !(error instanceof DOMException && error.name === "AbortError")
      ) {
        setPreviewError(errorText(error));
      }
    } finally {
      if (
        previewController.current === controller &&
        previewRevision.current === revision
      ) {
        previewController.current = null;
        setPreviewing(false);
      }
    }
  };

  const submit = async () => {
    if (
      !selected ||
      !valid ||
      !previewMatches ||
      submitting ||
      submitPending.current
    )
      return;

    submitPending.current = true;
    submitController.current?.abort();
    const controller = new AbortController();
    submitController.current = controller;
    setSubmitting(true);
    setSubmitError(null);
    const submittedPrerelease = prerelease;

    try {
      const result = await createRelease(
        {
          expectedLatestTag: selected.latestTag,
          prerelease: submittedPrerelease,
          preview,
          repository: selected.repository,
          tag: normalizedTag,
        },
        controller.signal,
      );
      if (submitController.current !== controller) return;

      setCreated(result);
      setCreatedPrerelease(submittedPrerelease);
      setPrerelease(false);
      setConfirmOpen(false);
      void Promise.resolve(onCreated(result)).catch(() => undefined);
      void forceRefreshOptions();
    } catch (error) {
      if (
        submitController.current === controller &&
        !(error instanceof DOMException && error.name === "AbortError")
      ) {
        setSubmitError(errorText(error));
        setPreview(null);
        setPreviewError(null);
      }
    } finally {
      if (submitController.current === controller) {
        submitController.current = null;
        setSubmitting(false);
      }
      submitPending.current = false;
    }
  };

  return (
    <>
      <Dialog onOpenChange={handleOpenChange} open={open}>
        <DialogTrigger asChild>
          <Button className="min-h-11 sm:min-h-7" size="sm" type="button">
            <Rocket aria-hidden="true" data-icon="inline-start" />
            Release
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create a release</DialogTitle>
            <DialogDescription>
              Publish the next patch release with GitHub-generated release
              notes.
            </DialogDescription>
          </DialogHeader>

          {created ? (
            <div className="rounded-lg border bg-muted/35 p-3" role="status">
              <p className="text-sm font-medium">
                {createdPrerelease
                  ? `${created.tag} is published as a pre-release.`
                  : `${created.tag} is published.`}
              </p>
              <a
                className="mt-1 inline-flex items-center gap-1 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
                href={created.url}
                rel="noreferrer"
                target="_blank"
              >
                View release
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </div>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (valid) {
                  setConfirmOpen(true);
                  void loadPreview();
                }
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="release-repository">Repository</Label>
                <RepositoryPicker
                  disabled={
                    options === null || options.repositories.length === 0
                  }
                  id="release-repository"
                  label="Release repository"
                  loading={loading}
                  onValueChange={selectRepository}
                  options={options?.repositories ?? []}
                  placeholder="Choose a repository"
                  value={repository}
                />
              </div>

              <div className="grid gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor="release-tag">Release tag</Label>
                  {selected && (
                    <span className="text-xs text-muted-foreground">
                      Latest: {selected.latestTag ?? "none"}
                    </span>
                  )}
                </div>
                <ReleaseTagPicker
                  aria-describedby={
                    tagExists
                      ? `${tagDescriptionId} ${tagErrorId}`
                      : tagDescriptionId
                  }
                  aria-invalid={tagExists || undefined}
                  disabled={selected === null}
                  id="release-tag"
                  label="Release tag"
                  nextTag={selected?.nextTag ?? ""}
                  onValueChange={(value) => {
                    tagRevision.current += 1;
                    setTag(value);
                    setSubmitError(null);
                  }}
                  previousTags={selected?.previousTags ?? []}
                  value={tag}
                />
                <p
                  className="text-xs text-muted-foreground"
                  id={tagDescriptionId}
                >
                  The next patch tag is suggested automatically and remains
                  editable.
                </p>
                {tagExists && (
                  <p
                    className="text-xs text-destructive"
                    id={tagErrorId}
                    role="alert"
                  >
                    That tag already exists.
                  </p>
                )}
                <div
                  className="flex items-center gap-2.5 rounded-lg border bg-muted/25 px-3 py-2"
                  data-slot="release-prerelease-option"
                >
                  <Checkbox
                    aria-describedby={prereleaseDescriptionId}
                    checked={prerelease}
                    disabled={submitting}
                    id="release-prerelease"
                    onCheckedChange={(checked) =>
                      setPrerelease(checked === true)
                    }
                  />
                  <div className="grid gap-0.5">
                    <Label
                      className="cursor-pointer text-sm leading-4"
                      htmlFor="release-prerelease"
                    >
                      Pre-release
                    </Label>
                    <p
                      className="text-xs leading-4 text-muted-foreground"
                      id={prereleaseDescriptionId}
                    >
                      Mark this release as not ready for production.
                    </p>
                  </div>
                </div>
              </div>

              {options && (
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>
                    Repositories updated{" "}
                    <time
                      dateTime={options.repositoriesUpdatedAt}
                      title={formatTimestamp(options.repositoriesUpdatedAt)}
                    >
                      {formatRelativeTime(options.repositoriesUpdatedAt)}
                    </time>
                  </span>
                  <span>
                    Tags checked{" "}
                    <time
                      dateTime={options.tagsUpdatedAt}
                      title={formatTimestamp(options.tagsUpdatedAt)}
                    >
                      {formatRelativeTime(options.tagsUpdatedAt)}
                    </time>
                  </span>
                </p>
              )}

              {warnings.map((warning) => (
                <p className="text-xs text-muted-foreground" key={warning}>
                  {warning}
                </p>
              ))}

              {loadError && (
                <div className="space-y-2" role="alert">
                  <p className="text-sm text-destructive">{loadError}</p>
                  <Button
                    onClick={() => void forceRefreshOptions()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Try again
                  </Button>
                </div>
              )}

              {!loading && options?.repositories.length === 0 && !loadError && (
                <p className="text-sm text-muted-foreground">
                  No repositories with authored pull requests are available.
                </p>
              )}

              <DialogFooter className="mt-1">
                <Button disabled={!valid} type="submit">
                  Review release
                </Button>
              </DialogFooter>
            </form>
          )}

          {created && (
            <DialogFooter>
              <Button onClick={() => setOpen(false)} type="button">
                Done
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        onOpenChange={(next) => {
          if (!next && submitting) return;
          if (!next) {
            previewController.current?.abort();
            previewController.current = null;
            setPreviewing(false);
          }
          setConfirmOpen(next);
        }}
        open={confirmOpen}
      >
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {prerelease
                ? `Publish ${normalizedTag} as a pre-release?`
                : `Publish ${normalizedTag}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This publishes <strong>{normalizedTag}</strong>
              {prerelease ? " as a pre-release" : ""} in{" "}
              <strong>{repository}</strong> using GitHub&apos;s auto-generated
              release notes. GitHub will reject a release with no new commits.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <section
            aria-busy={previewing}
            aria-label="Included pull requests"
            className="overflow-hidden rounded-lg border bg-muted/20"
          >
            <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
              <h3 className="text-sm font-medium">Included pull requests</h3>
              {preview && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                  {preview.pulls.length}
                </span>
              )}
            </div>
            {previewing ? (
              <div
                className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground"
                role="status"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 animate-spin"
                />
                Generating release notes…
              </div>
            ) : previewError ? (
              <div className="space-y-2 px-3 py-3" role="alert">
                <p className="text-sm text-destructive">{previewError}</p>
                <Button
                  onClick={() => void loadPreview()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              </div>
            ) : preview?.pulls.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                No pull requests are included in these generated notes.
              </p>
            ) : preview ? (
              <ol className="max-h-52 divide-y overflow-y-auto">
                {preview.pulls.map((pull) => (
                  <li className="px-3 py-2" key={pull.number}>
                    <a
                      className="flex min-w-0 items-baseline gap-2 text-sm hover:underline"
                      href={pull.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <span className="shrink-0 text-muted-foreground">
                        #{pull.number}
                      </span>
                      <span className="truncate">{pull.title}</span>
                    </a>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="space-y-2 px-3 py-3">
                <p className="text-sm text-muted-foreground">
                  Review the current release contents before publishing.
                </p>
                <Button
                  onClick={() => void loadPreview()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Review again
                </Button>
              </div>
            )}
          </section>

          {submitError && (
            <div className="space-y-2" role="alert">
              <p className="text-sm text-destructive">{submitError}</p>
              <p className="text-xs text-muted-foreground">
                Reload the repository tags before trying again.
              </p>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            {submitError && (
              <Button
                disabled={submitting || options === null}
                onClick={reloadAfterConflict}
                type="button"
                variant="outline"
              >
                {loading || refreshing
                  ? "Reloading options…"
                  : "Reload options"}
              </Button>
            )}
            <AlertDialogAction
              disabled={submitting || !previewMatches}
              onClick={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {submitting && (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              )}
              {submitting
                ? "Publishing…"
                : prerelease
                  ? "Publish pre-release"
                  : "Publish release"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
