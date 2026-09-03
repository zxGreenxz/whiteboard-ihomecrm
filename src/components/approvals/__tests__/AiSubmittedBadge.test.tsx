import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AiSubmittedBadge, AI_COPILOT_SYSTEM_SOURCE } from "@/components/approvals/AiSubmittedBadge";

/**
 * Task G4 — badge "Do AI nộp" trên hộp chờ duyệt. Component đã sẵn sàng nhưng
 * hiện tại `system_source` luôn về null từ list_my_pending_approvals_v1() trên
 * production (RPC chưa chiếu cột này ra — xem AiSubmittedBadge.tsx). Test này
 * khoá đúng hành vi RENDER của component, độc lập với RPC còn thiếu cột.
 */
function render(node: ReactElement): string {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

describe("AiSubmittedBadge", () => {
  it("hiện badge khi system_source = AI_COPILOT", () => {
    const html = render(<AiSubmittedBadge systemSource={AI_COPILOT_SYSTEM_SOURCE} />);
    expect(html).toContain("Do AI nộp");
  });

  it("không hiện gì khi system_source là null (phiếu người thật tự nộp)", () => {
    const html = render(<AiSubmittedBadge systemSource={null} />);
    expect(html).not.toContain("Do AI nộp");
  });

  it("không hiện gì khi system_source undefined (RPC hiện tại chưa trả cột)", () => {
    const html = render(<AiSubmittedBadge systemSource={undefined} />);
    expect(html).not.toContain("Do AI nộp");
  });

  it("không hiện gì khi system_source là một giá trị khác (vd nguồn hệ thống khác)", () => {
    const html = render(<AiSubmittedBadge systemSource="HANDOVER" />);
    expect(html).not.toContain("Do AI nộp");
  });
});
