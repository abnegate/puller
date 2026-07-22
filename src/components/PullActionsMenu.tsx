import { EyeOff, Star } from "lucide-react";
import {
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

export type PullActionsMenuProps = {
  children: ReactNode;
  className?: string;
  favorite: boolean;
  onFavoriteChange: (favorite: boolean) => void;
  onHide: () => void;
};

const stopClick = (event: MouseEvent<HTMLElement>): void => {
  event.stopPropagation();
};

const stopPointer = (event: PointerEvent<HTMLElement>): void => {
  event.stopPropagation();
};

const openFromKeyboard = (
  event: KeyboardEvent<HTMLDivElement>,
): void => {
  const opensMenu =
    event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
  if (!opensMenu) return;

  event.preventDefault();
  event.stopPropagation();

  const trigger = event.currentTarget;
  const bounds = trigger.getBoundingClientRect();
  const clientX = bounds.left + Math.max(0, bounds.width / 2);
  const clientY = bounds.top + Math.max(0, bounds.height / 2);

  trigger.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      button: 2,
      cancelable: true,
      clientX,
      clientY,
    }),
  );
};

export function PullFavoriteIndicator({
  className,
}: {
  className?: string;
}) {
  return (
    <span
      aria-label="Favourite pull request"
      className={cn(
        "inline-flex shrink-0 text-amber-500 dark:text-amber-400",
        className,
      )}
      title="Favourite pull request"
    >
      <Star aria-hidden="true" className="size-3.5 fill-current" />
    </span>
  );
}

const PullActionsMenu = forwardRef<HTMLDivElement, PullActionsMenuProps>(
  function PullActionsMenu(
    { children, className, favorite, onFavoriteChange, onHide },
    ref,
  ) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={className}
            data-favorite={favorite ? "" : undefined}
            data-slot="pull-actions-trigger"
            onKeyDown={openFromKeyboard}
            ref={ref}
          >
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          aria-label="Pull request actions"
          className="w-48"
          onClick={stopClick}
          onPointerDown={stopPointer}
        >
          <ContextMenuLabel>Pull request actions</ContextMenuLabel>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem
            checked={favorite}
            onCheckedChange={(checked) => onFavoriteChange(checked === true)}
            onSelect={(event) => event.stopPropagation()}
          >
            <Star
              aria-hidden="true"
              className={favorite ? "fill-current text-amber-500" : undefined}
            />
            Favourite
          </ContextMenuCheckboxItem>
          <ContextMenuItem
            onSelect={(event) => {
              event.stopPropagation();
              onHide();
            }}
            variant="destructive"
          >
            <EyeOff aria-hidden="true" />
            Hide pull request
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  },
);

export default PullActionsMenu;
