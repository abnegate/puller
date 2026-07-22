import { Eye, EyeOff } from "lucide-react";
import { type MouseEvent, type PointerEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type HiddenPull = {
  identity: string;
  number: number;
  repository: string;
};

export type HiddenPullsMenuProps = {
  hidden: readonly HiddenPull[];
  onShow: (identity: string) => void;
  onShowAll: () => void;
};

const stopClick = (event: MouseEvent<HTMLElement>): void => {
  event.stopPropagation();
};

const stopPointer = (event: PointerEvent<HTMLElement>): void => {
  event.stopPropagation();
};

export default function HiddenPullsMenu({
  hidden,
  onShow,
  onShowAll,
}: HiddenPullsMenuProps) {
  if (hidden.length === 0) return null;

  const count = hidden.length;
  const noun = count === 1 ? "pull request" : "pull requests";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Manage ${count} hidden ${noun}`}
          size="sm"
          type="button"
          variant="outline"
        >
          <EyeOff aria-hidden="true" />
          Hidden {count}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        onClick={stopClick}
        onPointerDown={stopPointer}
      >
        <DropdownMenuLabel>Hidden pull requests</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hidden.map((pull) => (
          <DropdownMenuItem
            aria-label={`Show ${pull.repository} #${pull.number}`}
            key={pull.identity}
            onSelect={(event) => {
              event.stopPropagation();
              onShow(pull.identity);
            }}
          >
            <Eye aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              {pull.repository} #{pull.number}
            </span>
            <span className="text-xs text-muted-foreground">Show</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.stopPropagation();
            onShowAll();
          }}
        >
          <Eye aria-hidden="true" />
          Show all
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
