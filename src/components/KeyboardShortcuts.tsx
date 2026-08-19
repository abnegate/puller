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

const groups = [
  {
    label: "Global",
    shortcuts: [
      ["J / K", "Next / previous pull request or task"],
      ["Home / End", "First / last pull request or task"],
      ["P", "Show pull requests and return to the current row"],
      ["R", "Show recent releases"],
      ["N", "Jump to New PR"],
      ["?", "Show keyboard shortcuts"],
    ],
  },
  {
    label: "Pull requests",
    shortcuts: [
      ["F / B / C", "Open files, blockers, or commits"],
      ["← / →", "Collapse panels / enter row actions"],
      ["Esc", "Return to the panel button, then the row"],
    ],
  },
  {
    label: "Files",
    shortcuts: [
      ["Search", "Filter the file tree by full path"],
      ["↑ / ↓", "Previous / next tree item"],
      ["Home / End", "First / last tree item"],
      ["Enter / Space", "Open a file or toggle a directory"],
      ["← / →", "Parent or collapse / child or file header"],
      ["Viewed", "Collapse file and move to the next file"],
      ["Esc", "Clear search, then return to Files changed"],
    ],
  },
  {
    label: "Commits",
    shortcuts: [
      ["↑ / ↓", "Previous / next commit"],
      ["Home / End", "First / last commit"],
      ["Enter / Space", "Select commit"],
      ["→", "Enter the selected commit diff"],
      ["← / Esc", "Return to Commits"],
    ],
  },
  {
    label: "Blockers",
    shortcuts: [
      ["↑ / ↓", "Previous / next blocker"],
      ["Home / End", "First / last blocker"],
      ["Enter", "Enter the blocker’s safe first item"],
      ["Esc", "Return to the blocker, then Blocker details"],
    ],
  },
  {
    label: "Releases",
    shortcuts: [
      ["Enter / Space / →", "Expand release"],
      ["← / Esc", "Collapse release or return to it"],
      ["↓", "Enter the release’s pull requests"],
      ["J / K", "Next / previous release"],
      ["Home / End", "First / last release"],
    ],
  },
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
        className="max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-2xl"
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
        <div
          aria-label="Keyboard shortcut reference"
          className="grid min-h-0 gap-4 overflow-y-auto pr-1 sm:grid-cols-2"
          role="region"
          tabIndex={0}
        >
          {groups.map((group) => {
            const headingId = `keyboard-shortcuts-${group.label.toLowerCase().replaceAll(" ", "-")}`;
            return (
              <section aria-labelledby={headingId} key={group.label}>
                <h3
                  className="mb-2 text-xs font-medium text-foreground"
                  id={headingId}
                >
                  {group.label}
                </h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                  {group.shortcuts.map(([keys, description]) => (
                    <div className="contents" key={`${keys}-${description}`}>
                      <dt>
                        <kbd className="inline-flex min-h-6 min-w-8 items-center justify-center rounded-md border bg-muted px-1.5 font-mono text-[11px] font-medium">
                          {keys}
                        </kbd>
                      </dt>
                      <dd className="m-0 self-center text-xs leading-5 text-muted-foreground">
                        {description}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
