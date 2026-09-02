#!/usr/bin/env node
// Gate: bảng tool trong tài liệu phải SINH TỪ mã nguồn, và không chỗ nào trong
// tài liệu được tự khai một con số tool khác.
//
// VÌ SAO CẦN GATE CHO MỘT CON SỐ
//   `docs/ai-copilot/README.md` mở đầu bằng "10 tool đọc + 1 write tool". Đo
//   14/08/2026: registry có 12 tool đọc, 1 tool ghi và 1 tool điều hướng. Con số
//   đó lệch từ lúc nào không ai biết, vì nó là chữ người gõ tay cạnh một danh
//   sách người gõ tay khác — và chính danh sách bên dưới nó lại ĐÚNG (12 mục).
//
//   Cái giá của con số sai không nằm ở tài liệu. Đánh giá live 13/08 ghi nhận mô
//   hình TỪ CHỐI SAI bốn công cụ có thật ("không có công cụ" cho `ty_le_lap_day`,
//   `cong_no_tong_quan`, `coc_dang_giu`, `so_quy` — ca C25). Khi tài liệu, prompt
//   và registry mỗi nơi kể một danh sách khác nhau thì không ai biết bản nào là
//   thật, kể cả người đọc lẫn mô hình.
//
//   node scripts/check-copilot-tool-inventory.mjs           # kiểm (mặc định)
//   node scripts/check-copilot-tool-inventory.mjs --write   # sinh lại khối
//
// Thoát 0 · 1 vi phạm · 3 KHÔNG ĐO ĐƯỢC.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inventoryFromCopilotSource,
  validateCopilotActionInventory,
} from './check-copilot-forbidden-actions.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const THU_MUC_TOOL = join(repoRoot, 'src', 'copilot', 'tools');
const FILE_README = join(repoRoot, 'docs', 'ai-copilot', 'README.md');

export const MOC_DAU = '<!-- COPILOT_TOOL_INVENTORY:START -->';
export const MOC_CUOI = '<!-- COPILOT_TOOL_INVENTORY:END -->';

/** Dưới ngần này tool đọc được thì bộ đọc hỏng, không phải registry rỗng. */
export const SAN_TOOL = 10;

/**
 * Bóc tool từ mã nguồn.
 *
 * Đọc bằng regex thay vì import thật: `registry.ts` kéo theo supabase client và
 * hook React, chạy được dưới node là chuyện may rủi. Đổi lại phải có SÀN — một
 * bộ đọc regex hỏng sẽ trả rỗng, và rỗng trông y hệt "registry sạch".
 */
export function docTool(nguon) {
  const ra = [];
  for (const [tep, vanBan] of Object.entries(nguon)) {
    const moc = [...vanBan.matchAll(/name:\s*'([a-z_][a-z0-9_]*)'/g)];
    for (let i = 0; i < moc.length; i++) {
      // Khối của tool này kéo tới `name:` KẾ TIẾP, không phải một cửa sổ ký tự
      // cố định. Bản đầu đọc 1200 ký tự và nuốt luôn cờ của tool đứng sau:
      // `liet_ke_chu_de` bị gán nhầm `navigate` vì `mo_trang` khai
      // `uiControlOnly: true` chỉ hơn hai chục dòng bên dưới.
      const khoi = vanBan.slice(moc[i].index, moc[i + 1]?.index ?? vanBan.length);
      ra.push({
        ten: moc[i][1],
        tep,
        uiControlOnly: /uiControlOnly:\s*true/.test(khoi),
        navigationOnly: /navigationOnly:\s*true/.test(khoi),
        chatOnly: /chatOnly:\s*true/.test(khoi),
        quyen:
          (khoi.match(/requiredPermission:\s*\{\s*module:\s*'([^']+)'\s*,\s*action:\s*'([^']+)'/) ?? [])
            .slice(1)
            .join('.') || null,
      });
    }
  }
  return ra.sort((a, b) => a.ten.localeCompare(b.ten));
}

/**
 * `read` · `write` · `navigate` — suy từ cờ, không gõ tay.
 *
 * `navigationOnly` đứng TRƯỚC `uiControlOnly` vì hai cờ trả lời hai câu khác nhau:
 * `uiControlOnly` là cờ LỌC ADAPTER (tool này không đưa cho chat), còn
 * `navigationOnly` là BẢN CHẤT tool (chỉ mở trang/trả link). Chúng từng trùng nhau
 * ở đúng một tool nên suy loại từ cờ lọc vẫn đúng — tới khi `mo_trang` mở cho cả
 * chat (02/09/2026) thì cách suy đó in ra "0 tool điều hướng" trong lúc tool điều
 * hướng vẫn còn đó.
 */
export function phanLoai(t) {
  if (t.chatOnly) return 'write';
  if (t.navigationOnly || t.uiControlOnly) return 'navigate';
  return 'read';
}

export function dungKhoi(tools) {
  const dem = { read: 0, write: 0, navigate: 0 };
  const dong = tools.map((t) => {
    const loai = phanLoai(t);
    dem[loai] += 1;
    return `| \`${t.ten}\` | ${loai} | ${t.quyen ? `\`${t.quyen}\`` : '— (lọc theo từng kết quả)'} | \`${t.tep}\` |`;
  });
  return [
    MOC_DAU,
    '',
    '<!-- KHỐI NÀY SINH TỰ ĐỘNG. Đừng sửa tay:',
    '     node scripts/check-copilot-tool-inventory.mjs --write -->',
    '',
    `**${tools.length} tool**: ${dem.read} đọc · ${dem.write} ghi · ${dem.navigate} điều hướng (chỉ mở trang / trả link).`,
    '',
    '| Tool | Loại | Quyền | Nguồn |',
    '| --- | --- | --- | --- |',
    ...dong,
    '',
    MOC_CUOI,
  ].join('\n');
}

/**
 * Câu tự khai số tool nằm NGOÀI khối sinh tự động.
 *
 * Bắt các dạng "10 tool", "12 tool đọc", "1 write tool" — thứ sẽ lệch âm thầm
 * ngay lần thêm tool tiếp theo.
 */
export function timSoTuKhai(vanBan) {
  const ngoai = vanBan.split(MOC_DAU)[0] + (vanBan.split(MOC_CUOI)[1] ?? '');
  // KHÔNG dùng `\b` sau "công cụ": `ụ` không phải ký tự \w của JS regex nên
  // không có ranh giới từ ở đó, và cả nhánh im lặng không bao giờ khớp. Đây
  // đúng là cái bẫy đã được ghi chú sẵn ở `safetyGuard.ts` cho DANGER_RE.
  return [...ngoai.matchAll(/(\d+)\s+(?:write\s+)?(?:tool\b|công cụ)/gi)].map((m) => m[0].trim());
}

/** Compare generated documentation independent of the checkout line ending. */
export const khopBoCRLF = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

function main() {
  const ghi = process.argv.includes('--write');

  const nguon = {};
  for (const tep of ['registry.ts', 'nghiepVuTools.ts', 'writeTools.ts']) {
    nguon[`src/copilot/tools/${tep}`] = readFileSync(join(THU_MUC_TOOL, tep), 'utf8');
  }
  const tools = docTool(nguon);
  if (tools.length < SAN_TOOL) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ bóc được ${tools.length} tool (sàn ${SAN_TOOL}).`);
    console.error('   Hình dạng khai báo tool đã đổi — đừng đọc thành "registry rỗng".');
    process.exit(3);
  }

  // Keep the inventory gate build-failing when a forbidden executor is added.
  // This runs against executable source, not human-facing descriptions.
  const actionProblems = validateCopilotActionInventory(inventoryFromCopilotSource(nguon));
  if (actionProblems.length) {
    console.error(`Copilot forbidden-action gate: ${actionProblems.length} problem(s)`);
    for (const problem of actionProblems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  const readme = readFileSync(FILE_README, 'utf8');
  const khoiMoi = dungKhoi(tools);
  const iDau = readme.indexOf(MOC_DAU);
  const iCuoi = readme.indexOf(MOC_CUOI);

  if (ghi) {
    if (iDau < 0 || iCuoi < 0) {
      console.error(`❌ README thiếu mốc ${MOC_DAU} … ${MOC_CUOI}. Thêm hai mốc đó trước.`);
      process.exit(1);
    }
    writeFileSync(
      FILE_README,
      readme.slice(0, iDau) + khoiMoi + readme.slice(iCuoi + MOC_CUOI.length),
      'utf8',
    );
    console.log(`✅ Đã sinh lại khối inventory: ${tools.length} tool.`);
    return;
  }

  const van = [];
  if (iDau < 0 || iCuoi < 0) {
    van.push(`README thiếu khối sinh tự động (${MOC_DAU} … ${MOC_CUOI}).`);
  } else if (!khopBoCRLF(readme.slice(iDau, iCuoi + MOC_CUOI.length), khoiMoi)) {
    van.push(
      'Khối inventory trong README lệch với registry. Chạy ' +
        '`node scripts/check-copilot-tool-inventory.mjs --write` rồi commit.',
    );
  }
  for (const s of timSoTuKhai(readme)) {
    van.push(
      `README tự khai "${s}" ngoài khối sinh tự động. Con số gõ tay sẽ lệch âm thầm ` +
        'ngay lần thêm tool tiếp theo — để khối sinh tự động nói con số đó.',
    );
  }

  console.log(`Registry Copilot: ${tools.length} tool (${tools.map((t) => phanLoai(t)).filter((l) => l === 'read').length} đọc).`);

  if (van.length > 0) {
    console.error(`\n❌ ${van.length} vấn đề:\n`);
    for (const v of van) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }
  console.log('✅ Tài liệu tool khớp registry, không có con số gõ tay nào ngoài khối sinh.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
