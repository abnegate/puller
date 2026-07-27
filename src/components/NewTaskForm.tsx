import { LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  canonicalRepository,
  useRepositoryPreferences,
} from "../repository-preferences";
import type { NewTaskRequest } from "../tasks";
import type { Task, TaskOptions, TaskRepository } from "../types";
import BranchPicker from "./BranchPicker";
import RepositoryPicker from "./RepositoryPicker";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type NewTaskFormProps = {
  error: string | null;
  loading: boolean;
  options: TaskOptions | null;
  refreshOptions: () => void;
  start: (request: NewTaskRequest) => Promise<Task>;
};

const EMPTY_BRANCHES: readonly string[] = [];

const selectedRepository = (
  options: TaskOptions | null,
  repository: string,
): TaskRepository | null =>
  options?.repositories.find((item) => item.repository === repository) ?? null;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "The PR could not be created.";

export default function NewTaskForm({
  error,
  loading,
  options,
  refreshOptions,
  start,
}: NewTaskFormProps) {
  const [prompt, setPrompt] = useState("");
  const [repository, setRepository] = useState("");
  const [base, setBase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pending = useRef(false);
  const preferences = useRepositoryPreferences();

  useEffect(() => {
    const favorite =
      options?.repositories.find((item) => {
        const canonical = canonicalRepository(item.repository);
        return canonical !== null && preferences.favorites.has(canonical);
      }) ?? null;
    const selected =
      selectedRepository(options, repository) ??
      favorite ??
      options?.repositories[0] ??
      null;
    if (!selected) {
      setRepository("");
      setBase("");
      return;
    }

    if (selected.repository !== repository) setRepository(selected.repository);
    if (!selected.branches.includes(base)) setBase(selected.defaultBranch);
  }, [base, options, preferences.favorites, repository]);

  const selected = useMemo(
    () => selectedRepository(options, repository),
    [options, repository],
  );
  const promptTooLarge =
    new TextEncoder().encode(prompt.trim()).byteLength > 32 * 1024;
  const valid =
    prompt.trim().length > 0 &&
    !promptTooLarge &&
    selected !== null &&
    selected.branches.includes(base);

  const chooseRepository = (value: string) => {
    const next = selectedRepository(options, value);
    setRepository(value);
    setBase(next?.defaultBranch ?? "");
    setSubmitError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || pending.current) return;

    pending.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await start({ base, prompt: prompt.trim(), repository });
      setPrompt("");
    } catch (submitFailure) {
      setSubmitError(message(submitFailure));
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  };

  const unavailable = !loading && options?.repositories.length === 0;
  const status =
    submitError ??
    error ??
    (promptTooLarge ? "Enter PR instructions of 32 KiB or less." : null) ??
    (unavailable
      ? "No trusted local repositories with remote branches were found."
      : null);
  const describedBy = status ? "new-task-status" : undefined;

  return (
    <Card
      className="gap-0 rounded-none bg-transparent py-0 ring-0"
      data-new-task-form=""
      size="sm"
    >
      <CardContent className="p-3">
        <form
          aria-label="New PR"
          className="grid gap-2 sm:grid-cols-[minmax(14rem,1fr)_minmax(10rem,0.36fr)_minmax(9rem,0.28fr)_auto] sm:items-center"
          onSubmit={(event) => void submit(event)}
        >
          <div className="min-w-0">
            <Label className="sr-only" htmlFor="new-task-prompt">
              New PR
            </Label>
            <Input
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={Boolean(submitError || promptTooLarge) || undefined}
              aria-keyshortcuts="n"
              disabled={submitting || unavailable}
              id="new-task-prompt"
              onChange={(event) => {
                setPrompt(event.target.value);
                setSubmitError(null);
              }}
              placeholder="New PR…"
              value={prompt}
            />
          </div>

          <div className="min-w-0">
            <Label className="sr-only" htmlFor="new-task-repository">
              Repository
            </Label>
            <RepositoryPicker
              aria-describedby={describedBy}
              aria-invalid={Boolean(error) || undefined}
              disabled={loading || submitting || unavailable}
              onValueChange={chooseRepository}
              options={options?.repositories ?? []}
              label="Repository"
              loading={loading}
              placeholder="Repository"
              value={repository}
              id="new-task-repository"
            />
          </div>

          <div className="min-w-0">
            <Label className="sr-only" htmlFor="new-task-base">
              Base branch
            </Label>
            <BranchPicker
              aria-describedby={describedBy}
              aria-invalid={Boolean(error) || undefined}
              className="font-mono text-xs"
              disabled={!selected || submitting}
              id="new-task-base"
              label="Base branch"
              onValueChange={(value) => {
                setBase(value);
                setSubmitError(null);
              }}
              options={selected?.branches ?? EMPTY_BRANCHES}
              placeholder="Base branch"
              value={base}
            />
          </div>

          <Button
            className="min-h-11 sm:min-h-8"
            disabled={!valid || submitting}
            type="submit"
          >
            {submitting ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" />
            ) : (
              <Plus aria-hidden="true" />
            )}
            {submitting ? "Creating" : "Create PR"}
          </Button>
        </form>

        {status && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <p
              className="m-0 text-xs text-muted-foreground wrap-anywhere"
              id="new-task-status"
              role={submitError || promptTooLarge ? "alert" : "status"}
            >
              {status}
            </p>
            {(error || unavailable) && (
              <Button
                disabled={loading}
                onClick={refreshOptions}
                size="sm"
                type="button"
                variant="ghost"
              >
                <RefreshCw aria-hidden="true" />
                Retry repositories
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
