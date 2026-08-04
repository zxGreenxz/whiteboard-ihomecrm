import type { KeyboardEvent, MouseEvent } from "react";

import type { ButtonProps } from "@/components/ui/button";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { NetworkRolloutState } from "@/lib/network-center/contracts";
import { networkRolloutDisabledMessage } from "@/lib/network-center/model";

interface ExecuteButtonProps extends ButtonProps {
  canExecute: boolean;
  rolloutState: NetworkRolloutState;
  disabledReason: string;
}

export function ExecuteButton({
  canExecute,
  rolloutState,
  disabledReason,
  disabled,
  children,
  onClick,
  onKeyDown,
  ...props
}: ExecuteButtonProps) {
  const guarded = !canExecute || rolloutState !== "EXECUTE";
  const guardedReason = networkRolloutDisabledMessage(
    canExecute,
    rolloutState,
    disabledReason,
  );
  const blockActivation = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const control = (
    <Button
      {...props}
      disabled={disabled}
      aria-disabled={guarded || undefined}
      onClick={(event) => {
        if (guarded) return blockActivation(event);
        onClick?.(event);
      }}
      onKeyDown={(event) => {
        if (guarded && (event.key === "Enter" || event.key === " ")) return blockActivation(event);
        onKeyDown?.(event);
      }}
    >
      {children}
    </Button>
  );

  if (!guarded) return control;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {control}
      </TooltipTrigger>
      <TooltipContent className="network-center nc-tooltip-content">
        {guardedReason}
      </TooltipContent>
    </Tooltip>
  );
}
