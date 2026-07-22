import { Check, ChevronsUpDown, Search } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type BranchPickerProps = {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  onValueChange: (branch: string) => void;
  options: readonly string[];
  placeholder?: string;
  value: string;
};

const optionButtons = (list: HTMLElement | null): HTMLButtonElement[] =>
  list
    ? [...list.querySelectorAll<HTMLButtonElement>("[data-branch-select]")]
    : [];

export default function BranchPicker({
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  className,
  disabled = false,
  id,
  label,
  onValueChange,
  options,
  placeholder = "Base branch",
  value,
}: BranchPickerProps) {
  const listId = useId();
  const searchId = useId();
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((branch) => branch === value);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = options.filter((branch) =>
    branch.toLocaleLowerCase().includes(normalizedQuery),
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  useEffect(() => {
    close();
  }, [close, options]);

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
        if (next) setOpen(true);
        else close();
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
          <span className="min-w-0 truncate" title={selected}>
            {selected ?? placeholder}
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
            aria-label="Search branches"
            autoComplete="off"
            className="h-8 pl-8"
            id={searchId}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") move(event, 1);
            }}
            placeholder="Search branches…"
            value={query}
          />
        </div>
        <div
          aria-label="Branches"
          className="mt-1 max-h-64 overflow-x-hidden overflow-y-auto"
          id={listId}
          ref={list}
          role="listbox"
        >
          {filtered.map((branch) => {
            const selectedOption = branch === value;

            return (
              <button
                aria-selected={selectedOption}
                className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                data-branch-select=""
                key={branch}
                onClick={() => {
                  onValueChange(branch);
                  close();
                }}
                onKeyDown={handleOptionKeyDown}
                role="option"
                type="button"
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0",
                    selectedOption ? "opacity-100" : "opacity-0",
                  )}
                />
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={branch}
                >
                  {branch}
                </span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p
              className="px-2 py-5 text-center text-xs text-muted-foreground"
              role="status"
            >
              No branches found.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
