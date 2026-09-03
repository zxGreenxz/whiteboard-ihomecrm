// Modal PIN step-up (G5-A) — render tĩnh (không có jsdom trong repo này, cùng
// khuôn với `keHoachCard.test.tsx`): đo đủ bốn ô nhập, hai testid bắt buộc của
// brief (`copilot-step-up-modal`, `copilot-step-up-submit`), và PIN không rò
// vào bất kỳ thuộc tính HTML nào.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

const StepUpPinModal = (await import('../StepUpPinModal')).default;

const ORG = 'aaaa0000-0000-4000-8000-000000000001';

describe('StepUpPinModal — render tĩnh', () => {
  it('vẽ container với testid bắt buộc + nút xác thực', () => {
    const html = renderToStaticMarkup(
      <StepUpPinModal organizationId={ORG} onXacThucXong={() => {}} onHuy={() => {}} />,
    );
    expect(html).toContain('copilot-step-up-modal');
    expect(html).toContain('copilot-step-up-submit');
    expect(html).toContain('copilot-step-up-cancel');
  });

  it('đúng BỐN ô nhập, mỗi ô inputmode="numeric" autocomplete phù hợp', () => {
    const html = renderToStaticMarkup(
      <StepUpPinModal organizationId={ORG} onXacThucXong={() => {}} onHuy={() => {}} />,
    );
    for (let i = 0; i < 4; i += 1) {
      expect(html).toContain(`copilot-step-up-digit-${i}`);
    }
    // React server-render giữ nguyên tên prop JSX (`inputMode`/`autoComplete`)
    // thay vì hạ về tên thuộc tính HTML chuẩn (`inputmode`/`autocomplete`) —
    // đo được ở bản react-dom 18.3.1 dùng trong repo này. Trình duyệt thật
    // không phân biệt hoa/thường của thuộc tính HTML, nên khớp không phân
    // biệt hoa/thường ở đây đo đúng ý JSX, không phải một cách né bug.
    expect((html.match(/inputmode="numeric"/gi) ?? []).length).toBe(4);
    expect(html).toMatch(/autocomplete="one-time-code"/i);
  });

  it('nút xác thực bị khoá khi chưa đủ 4 số (state khởi tạo rỗng)', () => {
    const html = renderToStaticMarkup(
      <StepUpPinModal organizationId={ORG} onXacThucXong={() => {}} onHuy={() => {}} />,
    );
    const nut = html.slice(html.indexOf('copilot-step-up-submit'));
    expect(nut.slice(0, 200)).toContain('disabled=""');
  });

  it('KHÔNG chuỗi nào trong HTML trông như một token step-up (hex 64 ký tự)', () => {
    const html = renderToStaticMarkup(
      <StepUpPinModal organizationId={ORG} onXacThucXong={() => {}} onHuy={() => {}} />,
    );
    expect(html).not.toMatch(/[0-9a-f]{64}/);
  });
});
