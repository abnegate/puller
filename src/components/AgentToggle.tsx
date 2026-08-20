import { useState } from "react";

import { Bot, ChevronDown } from "lucide-react";

import { agentLabel } from "../agent";
import type { Agent } from "../types";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type AgentToggleProps = {
  agent: Agent;
  onAgentChange: (agent: Agent) => void;
};

const description =
  "Applies to future runs only; active and queued work keeps its original agent. Codex 0.144.6 uses its standard macOS sandbox, including temporary-root access. Grok 1.0.5 uses an isolated GROK_HOME and the strict sandbox (read-only for Verify). New tasks intentionally load repository instructions.";

export default function AgentToggle({
  agent,
  onAgentChange,
}: AgentToggleProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const label = agentLabel(agent);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        setMenuOpen(open);
        if (open) {
          setTooltipOpen(false);
        }
      }}
      open={menuOpen}
    >
      <Tooltip onOpenChange={setTooltipOpen} open={!menuOpen && tooltipOpen}>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`Agent: ${label}. Choose local coding agent.`}
                className="min-h-11 gap-1.5 px-2.5 sm:min-h-7"
                data-agent-selector=""
                size="sm"
                type="button"
                variant="outline"
              >
                <Bot aria-hidden="true" />
                {label}
                <ChevronDown aria-hidden="true" className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        {!menuOpen ? (
          <TooltipContent sideOffset={6}>{description}</TooltipContent>
        ) : null}
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Local coding agent</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(value) => onAgentChange(value as Agent)}
          value={agent}
        >
          <DropdownMenuRadioItem value="claude">Claude</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="codex">Codex</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="grok">Grok</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <p className="px-1.5 pt-1 pb-0.5 text-[0.6875rem] leading-4 text-muted-foreground">
          New runs only
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
