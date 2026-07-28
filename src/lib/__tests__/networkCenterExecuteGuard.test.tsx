import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ExecuteButton } from "@/components/network-center/ExecuteGuard";

function getGuardedControl(onClick: () => void) {
  const tree = ExecuteButton({
    canExecute: false,
    disabledReason: "Bạn chỉ có quyền xem",
    onClick,
    children: "Xác nhận sự cố",
  }) as ReactElement<any>;
  const trigger = Children.toArray(tree.props.children)[0] as ReactElement<any>;
  return trigger.props.children as ReactElement<any>;
}

describe("ExecuteButton accessibility guard", () => {
  it("keeps one focusable named control with aria-disabled", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ExecuteButton
          canExecute={false}
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
});
