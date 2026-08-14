import { expect, type Page } from '@playwright/test';

/**
 * Bản đang chạy có ĐÚNG là bản vừa được review không.
 *
 * VÌ SAO MỌI SPEC COPILOT PHẢI GỌI HÀM NÀY TRƯỚC
 *   Ca C38 của đánh giá live 13/08/2026: source CÓ tính năng đọc ảnh, unit test
 *   CÓ, nhưng deployment production KHÔNG có nút upload. Cả buổi thử 40 ca chạy
 *   trên một bản mà không ai biết chính xác là bản nào — và kết quả của nó,
 *   dù xanh hay đỏ, đều không nói được điều gì về mã đang review.
 *
 *   Một suite E2E không biết mình đang thử cái gì thì không phải bằng chứng.
 *
 * THIẾU DỮ LIỆU LÀ THẤT BẠI, KHÔNG PHẢI "BỎ QUA"
 *   Không set `EXPECTED_SOURCE_SHA` ⇒ ném. Không có thẻ meta ⇒ ném. Một phép
 *   kiểm tự tắt khi thiếu dữ liệu là một phép kiểm không tồn tại, và nó tắt
 *   đúng lúc nguy hiểm nhất: khi bản build không khai được mình là ai.
 */
export async function xacMinhBanBuild(page: Page): Promise<string> {
  const mongDoi = process.env.EXPECTED_SOURCE_SHA;
  if (!mongDoi) {
    throw new Error(
      'Thiếu EXPECTED_SOURCE_SHA. Đặt bằng `git rev-parse HEAD` của commit đang review — ' +
        'chạy E2E mà không biết đang thử bản nào thì kết quả không chứng minh được gì.',
    );
  }
  if (!/^[0-9a-f]{40}$/.test(mongDoi)) {
    throw new Error(
      `EXPECTED_SOURCE_SHA phải là 40 ký tự hex (nhận "${mongDoi}"). SHA ngắn đủ cho người đọc log, ` +
        'nhưng đây là phép so máy với máy.',
    );
  }

  const thuc = await page
    .locator('meta[name="build-sha"]')
    .getAttribute('content', { timeout: 15_000 })
    .catch(() => null);

  if (!thuc) {
    throw new Error(
      'Bản đang chạy KHÔNG khai build SHA (thiếu <meta name="build-sha">). Bản build được dựng mà ' +
        'không có VITE_BUILD_SHA/VERCEL_GIT_COMMIT_SHA — không xác minh được nó dựng từ đâu.',
    );
  }

  expect(
    thuc,
    'Bản đang chạy KHÔNG phải bản đang review — deployment drift. Deploy lại rồi chạy suite này.',
  ).toBe(mongDoi);

  return thuc;
}

/**
 * `FLEET_BASE_URL` phải trỏ tới bản dựng từ commit đang review.
 *
 * Mặc định của Playwright config là production. Với spec chỉ ĐỌC thì tiện; với
 * spec GHI dữ liệu thì đó là ghi vào production bằng một bản mã chưa ai duyệt.
 * Gọi hàm này ở đầu mọi spec có ghi.
 */
export function chanChayTrenProduction(): void {
  const base = process.env.FLEET_BASE_URL;
  if (!base) {
    throw new Error(
      'Spec này GHI dữ liệu nên phải đặt FLEET_BASE_URL tường minh, trỏ tới bản preview/local dựng ' +
        'từ commit đang review. Mặc định của config là production — không nhận.',
    );
  }
  if (/ptcrm\.vercel\.app/.test(base)) {
    throw new Error(
      `FLEET_BASE_URL đang trỏ production (${base}). Spec ghi dữ liệu không chạy trên production ` +
        'trước khi phát hành.',
    );
  }
}
