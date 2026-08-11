#!/usr/bin/env node
// Sinh file migration rào biên giới tổ chức, TỪ INVENTORY chứ không gõ tay.
//
//   node scripts/sinh-migration-org-boundary.mjs GĐ3 supabase/migrations/<ts>_ten.sql
//
// VÌ SAO SINH RA MỘT DANH SÁCH TƯỜNG MINH THAY VÌ MỘT VÒNG LẶP ĐỘNG.
// Có hai cách hỏng đối nghịch nhau, và phải tránh cả hai:
//   • Gõ tay danh sách bảng — đúng khuyết tật gốc: Sprint 3b liệt kê 28 bảng,
//     mọi bảng sinh sau đều rơi ra ngoài, âm thầm hơn một năm.
//   • Vòng DO quét catalog ngay trong migration — không ai review được nó sẽ
//     đụng vào bảng nào, và một migration không review được thì không ai dám
//     apply, hoặc tệ hơn, apply mà không đọc.
// Cách ở đây: MÁY sinh danh sách từ số đo, nhưng file .sql ra là danh sách
// TƯỜNG MINH, đọc được, diff được, và mỗi dòng kèm lý do vì sao nó an toàn.
// Vòng quét catalog vẫn sẽ có — ở GĐ5, làm nhiệm vụ khác hẳn: bắt bảng TƯƠNG LAI.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = join(repoRoot, 'docs/generated/org-boundary-inventory.json');

const LY_DO_NHOM = {
  A_RONG: 'bảng rỗng — không có dòng nào để mất',
  B_KHONG_CAP_QUYEN: 'authenticated không có quyền SELECT — đã chặn từ tầng quyền',
  C_DA_KIN: 'có dữ liệu và đọc được, nhưng đo ra 0 dòng của tổ chức khác — đã kín bằng đường khác',
};

export function chonBang(inventory, giaiDoan) {
  return inventory.rows
    .filter((r) => r.assigned_phase === giaiDoan)
    .filter((r) => !r.boundary_policy_name)
    .filter((r) => r.has_organization_id)
    .sort((a, b) => a.table_name.localeCompare(b.table_name));
}

export function sinhSql(bang, { giaiDoan, capturedAt }) {
  const theoNhom = bang.reduce((m, r) => ({ ...m, [r.group]: [...(m[r.group] ?? []), r] }), {});
  const dem = Object.entries(theoNhom).map(([k, v]) => `${k}=${v.length}`).sort().join(' · ');

  const dong = [];
  const dangRo = bang.filter((r) => r.group === 'LIVE_LEAK');
  const laNhomRo = dangRo.length > 0;

  dong.push('-- =============================================================================');
  dong.push(
    laNhomRo
      ? `-- ${giaiDoan} — Rào ${bang.length} bảng ĐANG RÒ THẬT sang tổ chức khác`
      : `-- ${giaiDoan} — Rào biên giới tổ chức cho ${bang.length} bảng ĐÃ ĐO là an toàn`,
  );
  dong.push('--');
  dong.push('-- SINH BẰNG MÁY: node scripts/sinh-migration-org-boundary.mjs');
  dong.push(`-- Nguồn: docs/generated/org-boundary-inventory.json (chụp ${capturedAt})`);
  dong.push(`-- Phân bố: ${dem}`);
  dong.push('--');

  if (laNhomRo) {
    dong.push('-- ⚠ FILE NÀY LÀM NGƯỜI DÙNG MẤT DỮ LIỆU KHỎI TẦM NHÌN — VÀ ĐÓ LÀ MỤC ĐÍCH.');
    dong.push('-- Khác hẳn giai đoạn trước (nơi số đo chứng minh không ai mất gì), mỗi bảng dưới');
    dong.push('-- đây ĐANG phát dữ liệu của tổ chức khác cho người dùng, đo trên production bằng');
    dong.push('-- vai thật. Số trong ngoặc là số dòng của tổ chức KHÁC mà một người dùng thường');
    dong.push('-- đang đọc được:');
    dong.push('--');
    for (const r of dangRo) {
      dong.push(`--   ${r.table_name} — ${r.visible_foreign ?? '?'} dòng`);
    }
    dong.push('--');
    dong.push('-- Sau khi chạy, đúng những dòng đó biến mất khỏi tầm nhìn của họ. Dòng của chính');
    dong.push('-- tổ chức họ phải còn NGUYÊN — đó là mệnh đề bắt buộc phải đo trước/sau, không');
    dong.push('-- được suy luận: bằng chứng "không hồi quy" ở đây là visible_own không đổi VÀ');
    dong.push('-- visible_foreign về 0, đo trong cùng một transaction rồi rollback.');
    dong.push('--');
    dong.push('-- Nếu một màn hình nào đó đang DỰA vào chỗ hở này để hoạt động, nó sẽ hỏng sau');
    dong.push('-- khi chạy. Đó không phải lý do để hoãn — đó là lý do phải sửa màn hình ấy.');
  } else {
    dong.push('-- VÌ SAO NHÓM NÀY KHÔNG THỂ GÂY HỒI QUY.');
    dong.push('-- Mỗi bảng dưới đây đã được ĐO trên production bằng vai người dùng thật của ba');
    dong.push('-- tổ chức (scripts/measure-org-leak.mjs, 4 chốt chống ảo giác đạt cho từng vai),');
    dong.push('-- và rơi vào đúng một trong ba tình huống:');
    dong.push('--   • rỗng — gắn biên giới không lấy mất của ai dòng nào;');
    dong.push('--   • authenticated không có quyền SELECT — RLS đã chặn từ tầng trên;');
    dong.push('--   • có dữ liệu, đọc được, nhưng 0 dòng của tổ chức khác — đã kín bằng đường');
    dong.push('--     khác (theo toà, theo người), nên đây là siết chồng chứ không phải siết mới.');
    dong.push('--');
    dong.push('-- Bảng ĐANG RÒ THẬT nằm ở giai đoạn sau, không có trong file này — vá chúng cần');
    dong.push('-- xét từng đường đọc đang phụ thuộc vào chỗ hở.');
  }
  dong.push('--');
  dong.push('-- Công thức nguyên văn Sprint 3b (20260713121000), RESTRICTIVE = chỉ siết:');
  dong.push('--   organization_id IS NULL OR is_super_admin() OR organization_id IN my_org_ids()');
  dong.push('-- Nhánh IS NULL giữ đúng parity với 32 bảng đã có; nó sẽ được đóng ở GĐ6 sau khi');
  dong.push('-- backfill, không đóng ở đây kẻo lệch công thức giữa các bảng.');
  dong.push('--');
  dong.push('-- Idempotent: DROP POLICY IF EXISTS trước CREATE.');
  dong.push('-- =============================================================================');
  dong.push('');
  dong.push('BEGIN;');
  dong.push('');
  dong.push('DO $preflight$');
  dong.push('DECLARE v_thieu text;');
  dong.push('BEGIN');
  dong.push('  -- Mọi bảng trong file phải còn tồn tại và còn cột organization_id. Lệch là');
  dong.push('  -- inventory đã cũ so với production — dừng chứ không đoán.');
  dong.push('  SELECT string_agg(t, \', \') INTO v_thieu FROM unnest(ARRAY[');
  dong.push(bang.map((r) => `    '${r.table_name}'`).join(',\n'));
  dong.push('  ]) AS t');
  dong.push('  WHERE NOT EXISTS (');
  dong.push('    SELECT 1 FROM pg_class c');
  dong.push('      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = \'organization_id\'');
  dong.push('                         AND a.attnum > 0 AND NOT a.attisdropped');
  dong.push('     WHERE c.relnamespace = \'public\'::regnamespace AND c.relname = t');
  dong.push('  );');
  dong.push('  IF v_thieu IS NOT NULL THEN');
  dong.push('    RAISE EXCEPTION \'Không thấy (hoặc mất cột organization_id): %. Inventory đã cũ so với production. DỪNG.\', v_thieu;');
  dong.push('  END IF;');
  dong.push('');
  dong.push('  -- Không bảng nào trong file được nằm trong sổ miễn trừ.');
  dong.push('  SELECT string_agg(e.table_name, \', \') INTO v_thieu');
  dong.push('    FROM app_private.org_boundary_exemptions e');
  dong.push('   WHERE e.table_name = ANY(ARRAY[');
  dong.push(bang.map((r) => `    '${r.table_name}'`).join(',\n'));
  dong.push('  ]);');
  dong.push('  IF v_thieu IS NOT NULL THEN');
  dong.push('    RAISE EXCEPTION \'Bảng vừa nằm trong sổ miễn trừ vừa bị rào ở đây: %. DỪNG.\', v_thieu;');
  dong.push('  END IF;');
  dong.push('END');
  dong.push('$preflight$;');
  dong.push('');

  for (const nhom of Object.keys(theoNhom).sort()) {
    dong.push(`-- ─── ${nhom}: ${LY_DO_NHOM[nhom] ?? nhom} (${theoNhom[nhom].length} bảng) ───`);
    for (const r of theoNhom[nhom]) {
      const ghiChu = r.relkind === 'p' ? '  -- bảng phân mảnh cha' : '';
      dong.push(`DROP POLICY IF EXISTS ${r.table_name}_org_boundary ON public.${r.table_name};${ghiChu}`);
      dong.push(`CREATE POLICY ${r.table_name}_org_boundary ON public.${r.table_name}`);
      dong.push('  AS RESTRICTIVE FOR ALL TO authenticated');
      dong.push('  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))');
      dong.push('  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));');
    }
    dong.push('');
  }

  dong.push('DO $verify$');
  dong.push('DECLARE v_thieu text; v_sai text;');
  dong.push('BEGIN');
  dong.push('  SELECT string_agg(t, \', \') INTO v_thieu FROM unnest(ARRAY[');
  dong.push(bang.map((r) => `    '${r.table_name}'`).join(',\n'));
  dong.push('  ]) AS t');
  dong.push('  WHERE NOT EXISTS (');
  dong.push('    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid');
  dong.push('     WHERE c.relname = t AND p.polname = t || \'_org_boundary\'');
  dong.push('  );');
  dong.push('  IF v_thieu IS NOT NULL THEN');
  dong.push('    RAISE EXCEPTION \'Thiếu policy biên giới sau khi chạy: %. DỪNG.\', v_thieu;');
  dong.push('  END IF;');
  dong.push('');
  dong.push('  -- Policy phải RESTRICTIVE. PERMISSIVE là NỚI quyền — hỏng ngược hoàn toàn.');
  dong.push('  SELECT string_agg(c.relname, \', \') INTO v_sai');
  dong.push('    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid');
  dong.push('   WHERE p.polname = c.relname || \'_org_boundary\' AND p.polpermissive;');
  dong.push('  IF v_sai IS NOT NULL THEN');
  dong.push('    RAISE EXCEPTION \'Policy biên giới ra PERMISSIVE (nới quyền) ở: %. DỪNG.\', v_sai;');
  dong.push('  END IF;');
  dong.push('END');
  dong.push('$verify$;');
  dong.push('');
  dong.push('COMMIT;');
  dong.push('');
  dong.push('-- =============================================================================');
  dong.push('-- ROLLBACK: sinh lại bằng');
  dong.push('--   node -e "const i=require(\'./docs/generated/org-boundary-inventory.json\');');
  dong.push(`--     i.rows.filter(r=>r.assigned_phase==='${giaiDoan}'&&!r.boundary_policy_name)`);
  dong.push('--      .forEach(r=>console.log(`DROP POLICY IF EXISTS ${r.table_name}_org_boundary ON public.${r.table_name};`))"');
  dong.push('-- =============================================================================');
  return `${dong.join('\n')}\n`;
}

function main(argv) {
  const giaiDoan = argv[2];
  const ra = argv[3];
  if (!giaiDoan || !ra) {
    console.error('Dùng: node scripts/sinh-migration-org-boundary.mjs <giai-doan> <file-ra.sql>');
    return 1;
  }
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const bang = chonBang(inv, giaiDoan);
  if (!bang.length) {
    console.error(`❌ Không có bảng nào ở ${giaiDoan} cần rào.`);
    return 1;
  }
  writeFileSync(join(repoRoot, ra), sinhSql(bang, { giaiDoan, capturedAt: inv.capturedAt }));

  // Ghi kèm SỔ TAY danh sách bảng tại thời điểm sinh.
  //
  // Không có nó thì test "file khớp inventory" chỉ đúng cho tới lúc migration
  // được apply: apply xong, inventory cập nhật, mọi bảng chuyển sang nhóm
  // DA_CO_BOUNDARY, và test đỏ dù chẳng ai sửa gì. Một test chỉ đúng trong vài
  // giờ là một test sẽ bị xoá. Sổ tay đóng băng danh sách nên mệnh đề "file này
  // không bị sửa tay" đúng vĩnh viễn.
  const soTay = `${join(repoRoot, ra)}.tables.json`;
  writeFileSync(soTay, `${JSON.stringify({
    note: 'Sinh cùng file .sql — dùng để chứng minh file .sql không bị sửa tay. Đừng sửa.',
    giaiDoan,
    inventoryCapturedAt: inv.capturedAt,
    generatedAt: new Date().toISOString(),
    tables: bang.map((r) => r.table_name),
  }, null, 2)}\n`);

  console.log(`✅ Sinh ${ra}: ${bang.length} bảng (+ sổ tay .tables.json)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
