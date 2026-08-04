import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { ExecuteButton } from "@/components/network-center/ExecuteGuard";
import type { NetworkRolloutState } from "@/lib/network-center/contracts";
import {
  canRetryActionIntent,
  shouldPreserveActionDraft,
} from "@/components/network-center/NetworkActionDialog";

function getGuardedControl(onClick: () => void) {
  const tree = ExecuteButton({
    canExecute: false,
    rolloutState: "EXECUTE",
    disabledReason: "Bạn chỉ có quyền xem",
    onClick,
    children: "Xác nhận sự cố",
  }) as ReactElement<any>;
  const trigger = Children.toArray(tree.props.children)[0] as ReactElement<any>;
  return trigger.props.children as ReactElement<any>;
}

function getRolloutGuardedControl(
  rolloutState: NetworkRolloutState,
  onClick: () => void,
) {
  const tree = ExecuteButton({
    canExecute: true,
    rolloutState,
    disabledReason: "Thiếu quyền thực thi",
    onClick,
    children: "Thực thi",
  }) as ReactElement<any>;
  if (tree.type !== Tooltip) return tree;
  const trigger = Children.toArray(tree.props.children)[0] as ReactElement<any>;
  return trigger.props.children as ReactElement<any>;
}

describe("ExecuteButton accessibility guard", () => {
  it("keeps one focusable named control with aria-disabled", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ExecuteButton
          canExecute={false}
          rolloutState="EXECUTE"
          disabledReason="Bạn chỉ có quyền xem"
          onClick={() => undefined}
        >
          Xác nhận sự cố
        </ExecuteButton>
      </TooltipProvider>,
    );

    expect(html).toContain("Xác nhận sự cố");
    expect(html).toContain('aria-disabled="true"');
    expect(html.match(/tabindex="0"/g) ?? []).toHaveLength(0);
    expect(html.match(/<button/g) ?? []).toHaveLength(1);
  });

  it.each(["click", "Enter", " "])("blocks guarded %s activation", (activation) => {
    const onClick = vi.fn();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const control = getGuardedControl(onClick);

    if (activation === "click") {
      control.props.onClick({ preventDefault, stopPropagation });
    } else {
      control.props.onKeyDown({ key: activation, preventDefault, stopPropagation });
    }

    expect(onClick).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it.each(["OFF", "READ_ONLY"] as const)(
    "blocks %s even when the user has execute permission",
    (rolloutState) => {
      const onClick = vi.fn();
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      const control = getRolloutGuardedControl(rolloutState, onClick);

      control.props.onClick({ preventDefault, stopPropagation });

      expect(onClick).not.toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(stopPropagation).toHaveBeenCalledOnce();
    },
  );

  it("allows EXECUTE when the user also has execute permission", () => {
    const onClick = vi.fn();
    const control = ExecuteButton({
      canExecute: true,
      rolloutState: "EXECUTE",
      disabledReason: "Thiếu quyền thực thi",
      onClick,
      children: "Thực thi",
    }) as ReactElement<any>;

    control.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    expect(onClick).toHaveBeenCalledOnce();
  });

  it("keeps the active intent locked across close and reopen", () => {
    expect(shouldPreserveActionDraft({ submitting: true, status: null })).toBe(true);
    expect(shouldPreserveActionDraft({ submitting: false, status: "queued" })).toBe(true);
    expect(shouldPreserveActionDraft({ submitting: false, status: "running" })).toBe(true);
    expect(shouldPreserveActionDraft({ submitting: false, status: "uncertain" })).toBe(true);
    expect(shouldPreserveActionDraft({
      submitting: false,
      status: null,
      persistedStatus: "SUBMISSION_UNKNOWN",
    })).toBe(true);
    expect(shouldPreserveActionDraft({
      submitting: false,
      status: null,
      persistedStatus: "UNCERTAIN",
    })).toBe(true);
    expect(shouldPreserveActionDraft({ submitting: false, status: "success" })).toBe(false);
    expect(shouldPreserveActionDraft({ submitting: false, status: "failed" })).toBe(false);
    expect(canRetryActionIntent("SUBMISSION_UNKNOWN")).toBe(true);
    expect(canRetryActionIntent("UNCERTAIN")).toBe(false);
    expect(canRetryActionIntent("RUNNING")).toBe(false);
  });
});
