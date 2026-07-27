import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export type KeyboardSection = "blocked" | "progress" | "ready";

export type KeyboardItem =
  | {
      identity: string;
      index: number;
      key: string;
      kind: "pull";
      section: KeyboardSection;
    }
  | {
      id: string;
      index: number;
      key: string;
      kind: "task";
      section: KeyboardSection;
    };

export type KeyboardPages = Record<KeyboardSection, number>;

export const RELEASE_FOCUS_REQUEST = "puller:release-focus-request";

export type ReleaseFocusRequest = {
  generation: number;
};

export const releaseFocusRequest = (
  generation: number,
  target: Document = document,
): void => {
  target.dispatchEvent(
    new CustomEvent<ReleaseFocusRequest>(RELEASE_FOCUS_REQUEST, {
      detail: { generation },
    }),
  );
};

const EDITABLE_SELECTOR = [
  "input",
  "select",
  "textarea",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='textbox']",
].join(",");

const OPEN_OVERLAY_SELECTOR = [
  "[data-slot='alert-dialog-content'][data-state='open']",
  "[data-slot='command-dialog-content'][data-state='open']",
  "[data-slot='context-menu-content'][data-state='open']",
  "[data-slot='dialog-content'][data-state='open']",
  "[data-slot='dropdown-menu-content'][data-state='open']",
  "[data-slot='popover-content'][data-state='open']",
  "[data-slot='select-content'][data-state='open']",
  "[data-slot='sheet-content'][data-state='open']",
  "[role='dialog'][data-state='open']",
  "[role='listbox'][data-state='open']",
  "[role='menu'][data-state='open']",
].join(",");

const KEYBOARD_SCROLL_REGION_SELECTOR = "[data-keyboard-scroll-region]";

export type DashboardKeyboardCommand =
  | "end"
  | "help"
  | "home"
  | "new"
  | "next"
  | "previous"
  | "pulls"
  | "releases";

const commandForKey = (key: string): DashboardKeyboardCommand | null => {
  switch (key) {
    case "?":
      return "help";
    case "End":
      return "end";
    case "Home":
      return "home";
    case "j":
      return "next";
    case "k":
      return "previous";
    case "n":
      return "new";
    case "p":
      return "pulls";
    case "r":
      return "releases";
    default:
      return null;
  }
};

const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(EDITABLE_SELECTOR) !== null;

const isKeyboardScrollRegionTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest(KEYBOARD_SCROLL_REGION_SELECTOR) !== null;

type GuardedKeyboardEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "ctrlKey"
  | "defaultPrevented"
  | "isComposing"
  | "metaKey"
  | "repeat"
  | "target"
>;

export const keyboardEventBlocked = (
  event: GuardedKeyboardEvent,
  target: Document = document,
  options: { allowRepeat?: boolean } = {},
): boolean =>
  event.defaultPrevented ||
  event.isComposing ||
  event.altKey ||
  event.ctrlKey ||
  event.metaKey ||
  (!options.allowRepeat && event.repeat) ||
  isEditableTarget(event.target) ||
  isKeyboardScrollRegionTarget(event.target) ||
  target.querySelector(OPEN_OVERLAY_SELECTOR) !== null;

export const dashboardKeyboardCommand = (
  event: Pick<
    KeyboardEvent,
    | "altKey"
    | "ctrlKey"
    | "defaultPrevented"
    | "isComposing"
    | "key"
    | "metaKey"
    | "repeat"
    | "shiftKey"
    | "target"
  >,
  target: Document = document,
): DashboardKeyboardCommand | null => {
  const command = commandForKey(event.key);
  if (command === null) return null;
  if (event.shiftKey && command !== "help") return null;
  if (
    keyboardEventBlocked(event, target, {
      allowRepeat: command === "next" || command === "previous",
    })
  ) {
    return null;
  }
  return command;
};

const itemForElement = (
  items: readonly KeyboardItem[],
  element: Element | null,
): KeyboardItem | null => {
  if (element === null) return null;

  const pull = element.closest<HTMLElement>("[data-pull-identity]");
  if (pull?.dataset.pullIdentity) {
    return (
      items.find(
        (item) =>
          item.kind === "pull" && item.identity === pull.dataset.pullIdentity,
      ) ?? null
    );
  }

  const task = element.closest<HTMLElement>("[data-task-id]");
  if (task?.dataset.taskId) {
    return (
      items.find(
        (item) => item.kind === "task" && item.id === task.dataset.taskId,
      ) ?? null
    );
  }

  return null;
};

const elementForItem = (
  item: KeyboardItem,
  target: Document = document,
): HTMLElement | null => {
  const selector =
    item.kind === "pull" ? "[data-pull-identity]" : "[data-task-id]";
  return (
    [...target.querySelectorAll<HTMLElement>(selector)].find((element) =>
      item.kind === "pull"
        ? element.dataset.pullIdentity === item.identity
        : element.dataset.taskId === item.id,
    ) ?? null
  );
};

const pageForItem = (item: KeyboardItem, pageSize: number): number =>
  Math.floor(item.index / pageSize) + 1;

type FocusRequest = {
  generation: number;
  key: string;
};

export type UseDashboardKeyboardOptions = {
  items: readonly KeyboardItem[];
  newPullId: string;
  onHelp: () => void;
  onRevealPulls: () => void;
  onRevealReleases: () => void;
  pageSize: number;
  pages: KeyboardPages;
  setPage: (section: KeyboardSection, page: number) => void;
};

export function useDashboardKeyboard({
  items,
  newPullId,
  onHelp,
  onRevealPulls,
  onRevealReleases,
  pageSize,
  pages,
  setPage,
}: UseDashboardKeyboardOptions): void {
  const itemsRef = useRef(items);
  const previousItems = useRef(items);
  const selected = useRef<string | null>(null);
  const itemFocusActive = useRef(false);
  const focusRequest = useRef<FocusRequest | null>(null);
  const focusGeneration = useRef(0);
  const releaseGeneration = useRef(0);
  const [requestRevision, setRequestRevision] = useState(0);
  itemsRef.current = items;

  const requestFocus = useCallback(
    (item: KeyboardItem): void => {
      selected.current = item.key;
      const generation = ++focusGeneration.current;
      focusRequest.current = { generation, key: item.key };
      setPage(item.section, pageForItem(item, pageSize));
      setRequestRevision(generation);
    },
    [pageSize, setPage],
  );

  useLayoutEffect(() => {
    const request = focusRequest.current;
    if (request === null || request.generation !== requestRevision) return;

    const item = items.find((candidate) => candidate.key === request.key);
    if (item === undefined) {
      focusRequest.current = null;
      return;
    }
    if (pages[item.section] !== pageForItem(item, pageSize)) return;

    const element = elementForItem(item);
    if (element === null) return;

    focusRequest.current = null;
    itemFocusActive.current = true;
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: "nearest" });
  }, [items, pageSize, pages, requestRevision]);

  useEffect(() => {
    const handleFocus = (event: FocusEvent): void => {
      const element = event.target instanceof Element ? event.target : null;
      const item = itemForElement(itemsRef.current, element);
      if (item !== null) {
        selected.current = item.key;
        itemFocusActive.current = true;
        return;
      }

      if (element !== document.body) itemFocusActive.current = false;
    };

    document.addEventListener("focusin", handleFocus);
    return () => document.removeEventListener("focusin", handleFocus);
  }, []);

  useLayoutEffect(() => {
    const previous = previousItems.current;
    previousItems.current = items;
    const selectedKey = selected.current;
    if (selectedKey === null || !itemFocusActive.current) return;

    const current = items.find((item) => item.key === selectedKey);
    if (current !== undefined) {
      const active =
        document.activeElement instanceof Element
          ? itemForElement(items, document.activeElement)
          : null;
      if (active?.key !== current.key) requestFocus(current);
      return;
    }

    const oldIndex = previous.findIndex((item) => item.key === selectedKey);
    if (oldIndex < 0) return;
    const currentKeys = new Set(items.map((item) => item.key));
    const next =
      previous.slice(oldIndex + 1).find((item) => currentKeys.has(item.key)) ??
      previous
        .slice(0, oldIndex)
        .reverse()
        .find((item) => currentKeys.has(item.key)) ??
      null;

    if (next === null) {
      selected.current = null;
      itemFocusActive.current = false;
      return;
    }

    const destination = items.find((item) => item.key === next.key);
    if (destination !== undefined) requestFocus(destination);
  }, [items, requestFocus]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const command = dashboardKeyboardCommand(event);
      if (command === null) return;

      event.preventDefault();

      if (command === "help") {
        onHelp();
        return;
      }

      if (command === "new") {
        onRevealPulls();
        const input = document.getElementById(newPullId);
        if (input instanceof HTMLElement) input.focus({ preventScroll: true });
        return;
      }

      if (command === "releases") {
        onRevealReleases();
        const generation = ++releaseGeneration.current;
        queueMicrotask(() => releaseFocusRequest(generation));
        return;
      }

      if (itemsRef.current.length === 0) {
        if (command === "pulls") onRevealPulls();
        return;
      }

      onRevealPulls();
      const currentItems = itemsRef.current;
      const active =
        document.activeElement instanceof Element
          ? itemForElement(currentItems, document.activeElement)
          : null;
      if (active !== null) selected.current = active.key;
      const currentIndex = currentItems.findIndex(
        (item) => item.key === selected.current,
      );

      let destination: KeyboardItem;
      if (command === "home") {
        destination = currentItems[0]!;
      } else if (command === "end") {
        destination = currentItems.at(-1)!;
      } else if (command === "next") {
        destination =
          currentIndex < 0
            ? currentItems[0]!
            : currentItems[
                Math.min(currentIndex + 1, currentItems.length - 1)
              ]!;
      } else if (command === "previous") {
        destination =
          currentIndex < 0
            ? currentItems.at(-1)!
            : currentItems[Math.max(currentIndex - 1, 0)]!;
      } else {
        destination =
          currentIndex < 0 ? currentItems[0]! : currentItems[currentIndex]!;
      }

      requestFocus(destination);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [newPullId, onHelp, onRevealPulls, onRevealReleases, requestFocus]);
}
