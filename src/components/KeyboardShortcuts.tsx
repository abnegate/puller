import { CircleHelp } from "lucide-react";
import type { RefObject } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";

type KeyboardShortcutsProps = {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  restoreFocus: RefObject<HTMLElement | null>;
};

const shortcuts = [
  ["J / K", "Next / previous pull request or task"],
  ["Home / End", "First / last pull request or task"],
  ["P", "Show pull requests and return to the current row"],
  ["R", "Show recent releases"],
  ["N", "Jump to New PR"],
  ["?", "Show keyboard shortcuts"],
] as const;

export default function KeyboardShortcuts({
  onOpenChange,
  open,
  restoreFocus,
}: KeyboardShortcutsProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogTrigger asChild>
        <Button
          aria-keyshortcuts="?"
          aria-label="Keyboard shortcuts"
          className="min-h-11 min-w-11 sm:min-h-7 sm:min-w-7"
          size="icon-sm"
          title="Keyboard shortcuts (?)"
          type="button"
          variant="outline"
        >
          <CircleHelp aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby="keyboard-shortcuts-description"
        onCloseAutoFocus={(event) => {
          const destination = restoreFocus.current;
          if (!destination?.isConnected) return;
          event.preventDefault();
          destination.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription id="keyboard-shortcuts-description">
            Navigate the dashboard without triggering pull request actions.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          {shortcuts.map(([keys, description]) => (
            <div className="contents" key={keys}>
              <dt>
                <kbd className="inline-flex min-h-6 min-w-8 items-center justify-center rounded-md border bg-muted px-1.5 font-mono text-xs font-medium">
                  {keys}
                </kbd>
              </dt>
              <dd className="m-0 self-center text-sm text-muted-foreground">
                {description}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
