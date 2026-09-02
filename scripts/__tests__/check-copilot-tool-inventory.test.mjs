// Đột biến cho check-copilot-tool-inventory.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MOC_CUOI,
  MOC_DAU,
  SAN_TOOL,
  docTool,
  dungKhoi,
  phanLoai,
  timSoTuKhai,
} from '../check-copilot-tool-inventory.mjs';

const MAU = {
  'src/copilot/tools/registry.ts': `
    dt({
      name: 'phong_trong',
      requiredPermission: { module: 'rooms', action: 'view' },
      execute: async () => 'x',
    }),
    dt({
      name: 'liet_ke_chu_de',
      execute: async () => 'y',
    }),
    dt({
      name: 'mo_trang',
      uiControlOnly: true,
      navigationOnly: true,
      execute: async () => 'z',
    }),
  `,
  'src/copilot/tools/writeTools.ts': `
    name: 'tao_phieu_thu_chi_nhap',
    requiredPermission: { module: 'income_expenses', action: 'create' },
    chatOnly: true,
  `,
};

test('bóc đúng tên, cờ và quyền của từng tool', () => {
  const ra = docTool(MAU);
  assert.deepEqual(
    ra.map((t) => [t.ten, phanLoai(t), t.quyen]),
    [
      ['liet_ke_chu_de', 'read', null],
      ['mo_trang', 'navigate', null],
      ['phong_trong', 'read', 'rooms.view'],
      ['tao_phieu_thu_chi_nhap', 'write', 'income_expenses.create'],
    ],
  );
});

test('ĐỘT BIẾN: cờ của tool SAU không được lấn sang tool TRƯỚC', () => {
  // Bản đầu đọc một cửa sổ 1200 ký tự cố định nên `liet_ke_chu_de` ăn nhầm
  // `uiControlOnly: true` của `mo_trang` nằm ngay bên dưới, và bảng in ra
  // "2 điều hướng" trong khi registry chỉ có 1.
  const ra = docTool(MAU);
  const liet = ra.find((t) => t.ten === 'liet_ke_chu_de');
  assert.equal(liet.uiControlOnly, false);
  assert.equal(phanLoai(liet), 'read');
});

test('ĐỘT BIẾN: tool chỉ-mở-trang MỞ CHO CHAT vẫn phải là "điều hướng"', () => {
  // 02/09/2026: `mo_trang` bỏ `uiControlOnly` để chat dùng được (trả link). Nếu
  // loại vẫn suy từ cờ lọc adapter thì bảng in "0 điều hướng" — con số đúng cú
  // pháp, sai sự thật, đúng loại drift mà gate này sinh ra để chặn.
  const chiChat = { ten: 'mo_trang', uiControlOnly: false, navigationOnly: true, chatOnly: false };
  assert.equal(phanLoai(chiChat), 'navigate');
  // Và cờ ghi vẫn thắng: tool GHI không bao giờ bị đọc thành điều hướng.
  assert.equal(phanLoai({ ten: 'x', chatOnly: true, navigationOnly: true }), 'write');
  // Đọc được cờ từ mã nguồn thật, không chỉ từ object dựng tay.
  assert.equal(docTool(MAU).find((x) => x.ten === 'mo_trang').navigationOnly, true);
});

test('ĐỘT BIẾN: đổi hình dạng khai báo ⇒ đọc ra rỗng, sàn biến nó thành exit 3', () => {
  assert.deepEqual(docTool({ 'a.ts': `ten: "phong_trong"` }), []);
  assert.ok(SAN_TOOL >= 10, 'sàn phải đủ cao để bắt bộ đọc hỏng');
});

test('khối sinh ra có mốc, có số đếm theo loại và một dòng mỗi tool', () => {
  const khoi = dungKhoi(docTool(MAU));
  assert.ok(khoi.startsWith(MOC_DAU));
  assert.ok(khoi.endsWith(MOC_CUOI));
  assert.match(khoi, /\*\*4 tool\*\*: 2 đọc · 1 ghi · 1 điều hướng/);
  for (const ten of ['phong_trong', 'liet_ke_chu_de', 'mo_trang', 'tao_phieu_thu_chi_nhap']) {
    assert.ok(khoi.includes(`\`${ten}\``), `thiếu dòng cho ${ten}`);
  }
});

test('sinh lại hai lần cho ra cùng một khối (không phụ thuộc thứ tự file)', () => {
  const a = dungKhoi(docTool(MAU));
  const b = dungKhoi(docTool(Object.fromEntries(Object.entries(MAU).reverse())));
  assert.equal(a, b);
});

test('bắt con số tool gõ tay NGOÀI khối sinh, bỏ qua số nằm TRONG khối', () => {
  const trong = `# T\n\n${MOC_DAU}\n**14 tool**: 12 đọc\n${MOC_CUOI}\n`;
  assert.deepEqual(timSoTuKhai(trong), []);

  const ngoai = `# T\n\n> 10 tool đọc + 1 write tool\n\n${MOC_DAU}\n**14 tool**\n${MOC_CUOI}\n`;
  const thay = timSoTuKhai(ngoai);
  assert.ok(thay.length >= 1, 'phải bắt được câu tự khai ngoài khối');
  assert.ok(thay.some((s) => s.includes('10')));
});

test('câu tự khai nằm SAU khối cũng bị bắt', () => {
  const sau = `${MOC_DAU}\n**14 tool**\n${MOC_CUOI}\n\nGhi chú: 9 công cụ đọc.`;
  assert.ok(timSoTuKhai(sau).some((s) => s.includes('9')));
});

// 28/08/2026: gate do oan tren MOI may Windows — checkout autocrlf tra README
// ve CRLF, khoi sinh ra la LF, phep so sanh chuoi tho :148 lech tung dong mot
// du noi dung giong het (CI Linux van xanh nen khong ai thay). Cung lop loi ma
// generate-docs-views da tu ghi trong ham bo() cua no.
import { khopBoCRLF } from '../check-copilot-tool-inventory.mjs';

test('khopBoCRLF: khoi CRLF (Windows checkout) van khop khoi LF (generator)', () => {
  assert.equal(khopBoCRLF('a\r\nb\r\n', 'a\nb\n'), true);
  assert.equal(khopBoCRLF('a\nb\n', 'a\nb\n'), true);
});

test('khopBoCRLF: noi dung khac that su van phai lech', () => {
  assert.equal(khopBoCRLF('a\r\nb\r\n', 'a\nc\n'), false);
});
