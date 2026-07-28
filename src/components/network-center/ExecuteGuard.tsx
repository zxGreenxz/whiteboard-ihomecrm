import type { KeyboardEvent, MouseEvent } from "react";

import type { ButtonProps } from "@/components/ui/button";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ExecuteButtonProps extends ButtonProps {
  canExecute: boolean;
  disabledReason: string;
}

export function ExecuteButton({
  canExecute,
  disabledReason,
  disabled,
  children,
  onClick,
  onKeyDown,
  ...props
}: ExecuteButtonProps) {
  const guarded = !canExecute;
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

  if (canExecute) return control;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {control}
      </TooltipTrigger>
      <TooltipContent className="network-center nc-tooltip-content">
        {disabledReason}
      </TooltipContent>
    </Tooltip>
  );
}
