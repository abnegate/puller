import { Check, ChevronsUpDown, Search, Star } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import {
  canonicalRepository,
  useRepositoryPreferences,
} from "@/repository-preferences";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export type RepositoryOption = {
  repository: string;
};

type RepositoryPickerProps<Option extends RepositoryOption> = {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  loading?: boolean;
  onValueChange: (repository: string) => void;
  options: readonly Option[];
  placeholder?: string;
  value: string;
};

const optionButtons = (list: HTMLElement | null): HTMLButtonElement[] =>
  list
    ? [...list.querySelectorAll<HTMLButtonElement>("[data-repository-select]")]
    : [];

export default function RepositoryPicker<Option extends RepositoryOption>({
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  className,
  disabled = false,
  id,
  label,
  loading = false,
  onValueChange,
  options,
  placeholder = "Repository",
  value,
}: RepositoryPickerProps<Option>) {
  const contentId = useId();
  const listId = useId();
  const searchId = useId();
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const preferences = useRepositoryPreferences();
  const selected = options.find(
    (option) => option.repository.toLowerCase() === value.trim().toLowerCase(),
  );
  const ordered = useMemo(
    () =>
      [...options].sort((left, right) => {
        const leftFavorite = preferences.favorites.has(
          canonicalRepository(left.repository) ?? "",
        );
        const rightFavorite = preferences.favorites.has(
          canonicalRepository(right.repository) ?? "",
        );
        if (leftFavorite !== rightFavorite) return leftFavorite ? -1 : 1;
        return left.repository.localeCompare(right.repository);
      }),
    [options, preferences.favorites],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = ordered.filter((option) =>
    option.repository.toLocaleLowerCase().includes(normalizedQuery),
  );

  const move = (event: KeyboardEvent<HTMLElement>, direction: number): void => {
    const buttons = optionButtons(list.current);
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const index = Math.max(
      0,
      Math.min(buttons.length - 1, current < 0 ? 0 : current + direction),
    );
    buttons[index]?.focus();
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") move(event, 1);
    else if (event.key === "ArrowUp") move(event, -1);
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.currentTarget.click();
    } else if (event.key === "Home") {
      event.preventDefault();
      optionButtons(list.current)[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      optionButtons(list.current).at(-1)?.focus();
    }
  };

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-controls={listId}
          aria-describedby={describedBy}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          aria-label={label}
          className={cn(
            "w-full justify-between border-input bg-transparent px-2.5 font-normal hover:bg-muted/50 dark:bg-input/30 dark:hover:bg-input/50",
            !selected && "text-muted-foreground",
            className,
          )}
          disabled={disabled}
          id={id}
          role="combobox"
          type="button"
          variant="outline"
        >
          <span className="min-w-0 truncate">
            {selected?.repository ??
              (loading ? "Loading repositories…" : placeholder)}
          </span>
          <ChevronsUpDown
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-64 p-1.5"
        id={contentId}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(searchId)?.focus();
        }}
      >
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-controls={listId}
            aria-label="Search repositories"
            autoComplete="off"
            className="h-8 pl-8"
            id={searchId}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") move(event, 1);
            }}
            placeholder="Search repositories…"
            value={query}
          />
        </div>
        <div className="mt-1 grid max-h-64 grid-cols-[minmax(0,1fr)_auto] overflow-y-auto">
          <div
            aria-label="Repositories"
            className="contents"
            id={listId}
            ref={list}
            role="listbox"
          >
            {filtered.map((option, index) => {
              const selectedOption =
                option.repository.toLowerCase() === value.trim().toLowerCase();

              return (
                <button
                  aria-selected={selectedOption}
                  className="flex min-h-9 min-w-0 items-center gap-2 rounded-l-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring"
                  data-repository-select=""
                  key={option.repository}
                  onClick={() => {
                    onValueChange(option.repository);
                    setOpen(false);
                  }}
                  onKeyDown={handleOptionKeyDown}
                  role="option"
                  style={{ gridColumn: 1, gridRow: index + 1 }}
                  type="button"
                >
                  <Check
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 shrink-0",
                      selectedOption ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {option.repository}
                  </span>
                </button>
              );
            })}
          </div>
          {filtered.map((option, index) => {
            const canonical = canonicalRepository(option.repository);
            const favorite =
              canonical !== null && preferences.favorites.has(canonical);

            return (
              <button
                aria-label={`${favorite ? "Remove" : "Add"} favourite repository ${option.repository}`}
                aria-pressed={favorite}
                className="mr-0.5 flex size-9 shrink-0 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring"
                key={option.repository}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  preferences.setFavorite(option.repository, !favorite);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                style={{ gridColumn: 2, gridRow: index + 1 }}
                title={favorite ? "Remove favourite" : "Add favourite"}
                type="button"
              >
                <Star
                  aria-hidden="true"
                  className={cn(
                    "size-3.5",
                    favorite && "fill-current text-amber-500",
                  )}
                />
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p
              className="col-span-2 px-2 py-5 text-center text-xs text-muted-foreground"
              role="status"
            >
              No repositories found.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
