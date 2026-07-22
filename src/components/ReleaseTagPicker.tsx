import { ChevronDown } from "lucide-react";
import { type KeyboardEvent, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type ReleaseTagPickerProps = {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  disabled?: boolean;
  id?: string;
  label: string;
  nextTag: string;
  onValueChange: (tag: string) => void;
  previousTags: readonly string[];
  value: string;
};

type CloseReason = "input" | "outside" | null;

const tagButtons = (list: HTMLElement | null): HTMLButtonElement[] =>
  list
    ? [...list.querySelectorAll<HTMLButtonElement>("[data-release-tag]")]
    : [];

export default function ReleaseTagPicker({
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  disabled = false,
  id,
  label,
  nextTag,
  onValueChange,
  previousTags,
  value,
}: ReleaseTagPickerProps) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const focusIndex = useRef(0);
  const closeReason = useRef<CloseReason>(null);
  const [open, setOpen] = useState(false);
  const history = previousTags.slice(0, 10);

  const openAt = (index: number) => {
    focusIndex.current = index;
    if (open) {
      tagButtons(list.current)[index]?.focus();
    } else {
      setOpen(true);
    }
  };

  const move = (event: KeyboardEvent<HTMLButtonElement>, direction: number) => {
    const buttons = tagButtons(list.current);
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.indexOf(event.currentTarget);
    const index = Math.max(
      0,
      Math.min(buttons.length - 1, current + direction),
    );
    buttons[index]?.focus();
  };

  const closeToInput = () => {
    closeReason.current = "input";
    setOpen(false);
  };

  const selectSuggestion = () => {
    onValueChange(nextTag);
    closeToInput();
  };

  const handleOptionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    actionable: boolean,
  ) => {
    if (event.key === "ArrowDown") move(event, 1);
    else if (event.key === "ArrowUp") move(event, -1);
    else if (event.key === "Home") {
      event.preventDefault();
      tagButtons(list.current)[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      tagButtons(list.current).at(-1)?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      closeToInput();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (actionable) selectSuggestion();
    }
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <div className="relative">
        <Input
          aria-autocomplete="list"
          aria-controls={listId}
          aria-describedby={describedBy}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          aria-label={label}
          autoComplete="off"
          className="pr-9 font-mono"
          disabled={disabled}
          id={id}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              openAt(0);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              openAt(history.length);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              event.nativeEvent.stopImmediatePropagation();
              closeToInput();
            }
          }}
          placeholder="v1.2.3"
          ref={input}
          role="combobox"
          spellCheck={false}
          title={value || undefined}
          value={value}
        />
        <PopoverTrigger asChild>
          <Button
            aria-controls={listId}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label="Show release tag options"
            className="absolute top-1/2 right-0.5 -translate-y-1/2 text-muted-foreground"
            disabled={disabled}
            onClick={() => {
              focusIndex.current = 0;
            }}
            onPointerDown={() => {
              focusIndex.current = 0;
            }}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </Button>
        </PopoverTrigger>
      </div>
      <PopoverContent
        align="end"
        className="w-72 p-1.5"
        onCloseAutoFocus={(event) => {
          const reason = closeReason.current;
          closeReason.current = null;
          if (reason === "input") {
            event.preventDefault();
            input.current?.focus();
          } else if (reason === "outside") {
            event.preventDefault();
          }
        }}
        onInteractOutside={() => {
          closeReason.current = "outside";
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          closeToInput();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          tagButtons(list.current)[focusIndex.current]?.focus();
        }}
      >
        <div
          aria-label="Release tag options"
          className="grid max-h-64 overflow-y-auto"
          id={listId}
          ref={list}
          role="listbox"
        >
          <button
            aria-label={`${nextTag}, Suggested`}
            aria-selected={value === nextTag}
            className="flex min-h-9 min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            data-release-tag=""
            onClick={selectSuggestion}
            onKeyDown={(event) => handleOptionKeyDown(event, true)}
            role="option"
            tabIndex={-1}
            type="button"
          >
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs"
              title={nextTag}
            >
              {nextTag}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              Suggested
            </span>
          </button>
          {history.map((tag) => (
            <button
              aria-disabled="true"
              aria-label={`${tag}, Existing`}
              aria-selected={value.trim() === tag}
              className={cn(
                "flex min-h-9 min-w-0 cursor-not-allowed items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground outline-none",
                "hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
              )}
              data-release-tag=""
              key={tag}
              onClick={(event) => event.preventDefault()}
              onKeyDown={(event) => handleOptionKeyDown(event, false)}
              role="option"
              tabIndex={-1}
              type="button"
            >
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs"
                title={tag}
              >
                {tag}
              </span>
              <span className="shrink-0 text-[11px]">Existing</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
