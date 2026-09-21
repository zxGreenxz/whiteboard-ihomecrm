// =============================================================================
// Chặn đúng lớp lỗi đã lọt lên production 21/09/2026.
//
// Hai hộp thoại của khu này dựng bằng `createPortal` ra `document.body`, tức
// NẰM NGOÀI `.tt-stage` — nơi duy nhất khai đám biến CSS (`--surface`, `--line`,
// `--mono`…). Biến CSS kế thừa theo cây DOM, nên ra ngoài là chúng biến mất.
//
// Khi đó `background: var(--surface)` KHÔNG có giá trị ⇒ hộp thoại trong suốt,
// bảng phía sau xuyên qua, chữ chồng lên nhau. Người dùng nhìn thấy ngay, còn
// tsc / eslint / test DOM đều im.
//
// Vì sao lọt qua khâu kiểm tay: ảnh `fullPage` của Playwright dựng lại phần tử
// `position: fixed` nên nền hộp thoại trông mờ GIỐNG HỆT lỗi thật — tôi đã thấy
// đúng triệu chứng này rồi kết luận nhầm là artifact của ảnh.
//
// Nên phép kiểm phải là TĨNH như dưới đây, không phụ thuộc mắt người.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const thuMuc = dirname(fileURLToPath(new URL('.', import.meta.url)));
const doc = (f: string) => readFileSync(join(thuMuc, f), 'utf8');

const css = doc('contract-settlement.css');
const tsx = readdirSync(thuMuc)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => doc(f))
  .join('\n');

/** Token được KHAI (`--x: …`) trong khối `.cs-scrim`. */
const khaiTrongScrim = (): Set<string> => {
  const i = css.indexOf('.cs-scrim {');
  expect(i, 'không tìm thấy khối .cs-scrim — nơi phải khai token cho portal').toBeGreaterThan(-1);
  const khoi = css.slice(i, css.indexOf('}', i));
  return new Set([...khoi.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
};

/** Token được DÙNG (`var(--x)`) ở bất kỳ đâu trong khu này. */
const dungODau = (): Set<string> =>
  new Set([...`${css}\n${tsx}`.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));

// `--cs-cols` là biến bố cục đặt inline ngay trên phần tử bảng (nằm TRONG
// .tt-stage), không phải token màu kế thừa — nên không cần khai ở scrim.
const MIEN_TRU = new Set(['--cs-cols']);

describe('token CSS cho hộp thoại dựng qua portal', () => {
  it('.cs-scrim khai đủ mọi token mà khu này dùng', () => {
    const khai = khaiTrongScrim();
    const thieu = [...dungODau()].filter((t) => !MIEN_TRU.has(t) && !khai.has(t)).sort();
    expect(
      thieu,
      `Thiếu khai trong .cs-scrim: ${thieu.join(', ')}.\n`
      + 'Hộp thoại portal ra ngoài .tt-stage nên KHÔNG kế thừa được token; '
      + 'thiếu là nền trong suốt. Khai thêm vào khối .cs-scrim, giá trị khớp '
      + '.tt-stage trong src/pages/thu-tien.css.',
    ).toEqual([]);
  });

  it('nền hộp thoại có giá trị dự phòng, không bao giờ rỗng', () => {
    // Kể cả khi ai đó lỡ xoá khối token, nền vẫn phải ra màu chứ không trong suốt.
    expect(css).toMatch(/\.cs-modal\s*\{[^}]*background:\s*var\(--surface,\s*#[0-9a-f]{3,6}\)/i);
  });

  it('khối token của .cs-scrim khớp giá trị gốc ở .tt-stage', () => {
    const goc = readFileSync(join(thuMuc, '../../../pages/thu-tien.css'), 'utf8');
    const iGoc = goc.indexOf('.tt-stage {');
    const khoiGoc = goc.slice(iGoc, goc.indexOf('position: fixed', iGoc));
    const bangGoc = new Map(
      [...khoiGoc.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
    );

    const iScrim = css.indexOf('.cs-scrim {');
    const khoiScrim = css.slice(iScrim, css.indexOf('position: fixed', iScrim));
    const lech: string[] = [];
    for (const [ten, giaTri] of khoiScrim.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      const g = bangGoc.get(ten);
      if (g && g !== giaTri.trim()) lech.push(`${ten}: "${giaTri.trim()}" ≠ "${g}"`);
    }
    expect(lech, `Token lệch giá trị so với .tt-stage:\n${lech.join('\n')}`).toEqual([]);
  });
});
