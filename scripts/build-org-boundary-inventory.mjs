#!/usr/bin/env node
// Inventory biên giới tổ chức — gán cho MỌI relation đúng một chỗ đứng.
//
//   node scripts/build-org-boundary-inventory.mjs --write   # sinh inventory
//   node scripts/build-org-boundary-inventory.mjs --check   # gate CI, exit 1 nếu hở
//
// VÌ SAO NHÓM VÀ GIAI ĐOẠN PHẢI SINH TỪ VIỆC ĐỌC FILE PLAN, KHÔNG GÕ TAY.
// Khuyết tật gốc của toàn bộ chuyện tách dữ liệu là 20260713121000_sprint3b gắn
// biên giới theo một DANH SÁCH VIẾT TAY 28 bảng. Bảng nào ra đời sau đó đều thiếu
// — âm thầm, suốt hơn một năm, cho tới khi đo mới lòi ra 272/304 bảng không có
// biên giới nào. Nếu công cụ này cũng gõ tay danh sách bảng theo giai đoạn thì nó
// tái tạo y nguyên khuyết tật ấy ở một tầng cao hơn, và lần sau sẽ không ai đo lại
// nữa vì "đã có inventory rồi".
//
// Nên: danh sách bảng đến từ CATALOG THẬT, giai đoạn đến từ việc QUÉT CHÍNH FILE
// PLAN, miễn trừ đến từ SỔ TRONG DATABASE. Bảng nào không nơi nào nhận thì rơi vào
// UNASSIGNED và gate đỏ. Đó là cách duy nhất phát hiện được thứ chưa ai từng nhắc.
//
// CHỈ ĐỌC: mọi truy vấn đều là SELECT trên pg_catalog / app_private. Có chốt từ
// chối bất kỳ câu nào chứa từ khoá ghi.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPat, readProjectRef, runSql } from './capture-production-catalog.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DUONG_PLAN = join(repoRoot, 'docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY-V2.md');
const DUONG_CATALOG = join(repoRoot, 'docs/generated/database-inventory.json');
const RA_JSON = join(repoRoot, 'docs/generated/org-boundary-inventory.json');
const RA_MD = join(repoRoot, 'docs/generated/org-boundary-inventory.md');

const TU_KHOA_GHI = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COMMIT)\b/i;

/** Chốt: công cụ này không bao giờ được ghi vào database. */
function bacCauGhi(sql) {
  if (TU_KHOA_GHI.test(sql)) {
    throw new Error('Câu truy vấn chứa từ khoá ghi — công cụ inventory chỉ được ĐỌC.');
  }
  return sql;
}

/**
 * Quét file plan, trả về Map<tên bảng, {phase, line}>.
 *
 * Chỉ nhận tên đứng như một từ trọn vẹn, để `material` không ăn theo `materials`.
 * Lấy lần nhắc ĐẦU TIÊN: giai đoạn sớm nhất là giai đoạn chịu trách nhiệm.
 */
export function docTenBangTrongPlan(noiDungPlan, tenBang) {
  const dong = noiDungPlan.split('\n');
  const kq = new Map();
  let phaseHienTai = null;

  for (let i = 0; i < dong.length; i += 1) {
    const d = dong[i];
    const tieuDe = /^#{2,4}\s+(GĐ[-\w]+)/.exec(d);
    if (tieuDe) {
      phaseHienTai = tieuDe[1];
      continue;
    }
    if (!phaseHienTai) continue;

    for (const ten of tenBang) {
      if (kq.has(ten)) continue;
      // \b không đủ: dấu gạch dưới được \w tính là ký tự từ, nên `materials` nằm
      // trong `materials_v2` vẫn khớp \bmaterials\b. Phải tự chặn hai đầu.
      const re = new RegExp(`(^|[^A-Za-z0-9_])${ten}([^A-Za-z0-9_]|$)`);
      if (re.test(d)) kq.set(ten, { phase: phaseHienTai, line: i + 1 });
    }
  }
  return kq;
}

/**
 * Xếp một relation vào đúng một nhóm. Thứ tự xét là thứ tự ưu tiên, và thứ tự đó
 * chính là nội dung của luật:
 *   NO_ORG_COLUMN  — không có cột org thì generator không với tới (vùng GĐ7)
 *   DA_CO_BOUNDARY — đã rào rồi
 *   EXEMPT         — sổ miễn trừ là quyết định CỨNG, thắng cả khi plan có nhắc
 *   LIVE_LEAK      — đang rò thật, ưu tiên hơn chỗ plan xếp nó
 *   CHO_VA         — plan có nhận
 *   UNASSIGNED     — chưa ai nhận  ← đây là thứ cả công cụ sinh ra để tìm
 */
export function phanLoaiBang(bang, { nhacTrongPlan, mienTru, soDo = null }) {
  const chung = {
    ...bang,
    boundary_name_matches_convention:
      bang.boundary_policy_name === `${bang.table_name}_org_boundary`,
    assigned_phase: null,
    exemption_reason: null,
    decided_by: null,
    expires_at: null,
    source_line: nhacTrongPlan?.line ?? null,
  };

  if (!bang.has_organization_id) return { ...chung, group: 'NO_ORG_COLUMN' };
  if (bang.boundary_policy_name) return { ...chung, group: 'DA_CO_BOUNDARY' };

  if (mienTru) {
    // Miễn trừ thắng, NHƯNG phải nói ra nếu bảng đó đang rò thật. Một bảng vừa
    // được tha vừa đang phát dữ liệu sang tổ chức khác là trạng thái khác hẳn
    // một bảng được tha mà kín — gộp chung hai thứ đó là cách cái sổ miễn trừ
    // biến thành chỗ giấu vấn đề.
    return {
      ...chung,
      group: 'EXEMPT',
      dang_ro: (soDo?.visible_foreign ?? bang.visible_foreign ?? 0) > 0,
      visible_foreign_do_duoc: soDo?.visible_foreign ?? null,
      exemption_reason: mienTru.reason,
      decided_by: mienTru.decided_by,
      expires_at: mienTru.expires_at,
    };
  }

  // SỐ ĐO THẮNG MỌI THỨ KHÁC.
  //
  // Bản kế hoạch gọi tên được 48 bảng trong khi có 272 bảng cần xử lý — phần còn
  // lại nằm trong một con số tổng, mà con số tổng thì không ai thi hành được. Gán
  // giai đoạn theo "plan có nhắc hay không" vì thế tái tạo đúng khuyết tật gốc:
  // danh sách người ta nhớ ra, chứ không phải danh sách thật.
  //
  // Nên khi có số đo từ scripts/measure-org-leak.mjs (đo bằng vai người dùng thật,
  // 4 chốt chống ảo giác), nó là nguồn gán giai đoạn chính. Plan chỉ còn dùng để
  // ghi nhận bảng nào đã được bàn tới — thông tin, không phải thẩm quyền.
  const soDongRo = soDo?.visible_foreign ?? bang.visible_foreign ?? 0;
  if (soDongRo > 0) {
    // Mang theo SỐ ĐO, không chỉ nhãn. Migration sinh ra sẽ in con số này vào
    // chú thích để người review thấy đúng bao nhiêu dòng sắp biến mất khỏi tầm
    // nhìn của ai — một nhãn "LIVE_LEAK" trần thì không nói lên điều đó.
    return { ...chung, group: 'LIVE_LEAK', assigned_phase: 'GĐ4', visible_foreign: soDongRo };
  }

  if (soDo?.assigned_phase) {
    return { ...chung, group: soDo.group, assigned_phase: soDo.assigned_phase };
  }

  if (nhacTrongPlan) {
    return { ...chung, group: 'CHO_VA', assigned_phase: nhacTrongPlan.phase };
  }

  return { ...chung, group: 'UNASSIGNED' };
}

/** Luật của gate. Tách khỏi I/O để test được từng luật. */
export function kiemInventory({ rows, homNay }) {
  const loi = [];

  const chuaAiNhan = rows.filter((r) => r.group === 'UNASSIGNED');
  if (chuaAiNhan.length) {
    loi.push(
      `${chuaAiNhan.length} bảng UNASSIGNED — chưa giai đoạn nào nhận và cũng không có trong sổ miễn trừ: ${chuaAiNhan
        .map((r) => r.table_name)
        .join(', ')}`,
    );
  }

  const mienTru = rows.filter((r) => r.group === 'EXEMPT');
  for (const r of mienTru) {
    if (!r.exemption_reason || !r.decided_by || !r.expires_at) {
      loi.push(`Miễn trừ ${r.table_name} thiếu lý do / người quyết định / hạn.`);
      continue;
    }
    if (r.expires_at < homNay) {
      loi.push(`Miễn trừ ${r.table_name} đã quá hạn ${r.expires_at} — hạn là hạn, không phải gợi ý.`);
    }
  }

  for (const r of rows.filter((x) => x.group === 'CHO_VA' || x.group === 'LIVE_LEAK')) {
    if (!r.assigned_phase) {
      loi.push(`${r.table_name} nhóm ${r.group} nhưng không có giai đoạn nào nhận.`);
    }
  }

  return { dat: loi.length === 0, loi };
}

/** Vân tay catalog lấy từ snapshot đã commit — không tự tính lại một phiên bản khác. */
function docVanTayCatalog() {
  try {
    return JSON.parse(readFileSync(DUONG_CATALOG, 'utf8')).catalogFingerprint ?? null;
  } catch {
    return null;
  }
}

const SQL_CATALOG = `
  SELECT c.relname                                   AS table_name,
         c.relkind::text                             AS relkind,
         c.relispartition                            AS is_partition,
         c.relrowsecurity                            AS rls_enabled,
         (a.attname IS NOT NULL)                     AS has_organization_id,
         COALESCE(oc.cols, ARRAY[]::text[])          AS org_column_names,
         bp.polname                                  AS boundary_policy_name,
         has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_can_select,
         EXISTS (
           SELECT 1 FROM pg_publication_rel pr
             JOIN pg_publication p ON p.oid = pr.prpubid
            WHERE pr.prrelid = c.oid AND p.pubname = 'supabase_realtime'
         )                                           AS in_realtime_publication
    FROM pg_class c
    LEFT JOIN pg_attribute a
      ON a.attrelid = c.oid AND a.attname = 'organization_id'
     AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN LATERAL (
      SELECT array_agg(x.attname ORDER BY x.attname) AS cols
        FROM pg_attribute x
       WHERE x.attrelid = c.oid AND x.attnum > 0 AND NOT x.attisdropped
         AND x.attname LIKE '%organization_id'
    ) oc ON TRUE
    LEFT JOIN LATERAL (
      SELECT p.polname FROM pg_policy p
       WHERE p.polrelid = c.oid AND p.polpermissive = false
         AND p.polname = c.relname || '_org_boundary'
       LIMIT 1
    ) bp ON TRUE
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r','p')
     AND NOT c.relispartition
   ORDER BY c.relname`;

const SQL_MIEN_TRU = `
  SELECT table_name, reason, decided_by, expires_at::text AS expires_at, replacement_policy
    FROM app_private.org_boundary_exemptions`;

async function main(argv) {
  const ghi = argv.includes('--write');
  const kiem = argv.includes('--check');
  if (!ghi && !kiem) {
    console.error('Dùng: node scripts/build-org-boundary-inventory.mjs --write | --check');
    return 1;
  }

  const pat = readPat();
  if (!pat) { console.error('❌ Không tìm thấy PAT'); return 1; }
  const ref = readProjectRef();

  const catalog = await runSql(bacCauGhi(SQL_CATALOG), { pat, ref });
  let mienTruRows = [];
  try {
    mienTruRows = await runSql(bacCauGhi(SQL_MIEN_TRU), { pat, ref });
  } catch {
    console.error('⚠ Chưa có app_private.org_boundary_exemptions — chạy migration GĐ1 trước.');
    return 1;
  }
  const soMienTru = new Map(mienTruRows.map((r) => [r.table_name, r]));

  const plan = readFileSync(DUONG_PLAN, 'utf8');
  const nhac = docTenBangTrongPlan(plan, catalog.map((r) => r.table_name));

  // Số đo (nếu đã chạy measure-org-leak.mjs) là nguồn gán giai đoạn chính.
  let soDo = new Map();
  try {
    const bl = JSON.parse(readFileSync(join(repoRoot, 'docs/generated/org-leak-baseline.json'), 'utf8'));
    soDo = new Map(bl.rows.map((r) => [r.table_name, r]));
    console.log(`ℹ Dùng số đo từ org-leak-baseline.json (${bl.capturedAt}) để gán giai đoạn.`);
  } catch {
    console.log('⚠ Chưa có org-leak-baseline.json — chạy `node scripts/measure-org-leak.mjs --write` để gán giai đoạn bằng số đo.');
  }

  const rows = catalog.map((b) =>
    phanLoaiBang(b, {
      nhacTrongPlan: nhac.get(b.table_name) ?? null,
      mienTru: soMienTru.get(b.table_name) ?? null,
      soDo: soDo.get(b.table_name) ?? null,
    }),
  );

  const homNay = new Date().toISOString().slice(0, 10);
  const kq = kiemInventory({ rows, homNay });

  const dem = rows.reduce((m, r) => ({ ...m, [r.group]: (m[r.group] ?? 0) + 1 }), {});
  const tomTat = Object.entries(dem).sort().map(([k, v]) => `${k}=${v}`).join(' · ');

  const mienTruDangRo = rows.filter((r) => r.group === 'EXEMPT' && r.dang_ro);
  if (mienTruDangRo.length) {
    console.log('');
    console.log(`⚠ ${mienTruDangRo.length} bảng vừa ĐƯỢC MIỄN TRỪ vừa ĐANG RÒ THẬT — được tha vì siết ngay sẽ hỏng tính năng, KHÔNG phải vì chúng an toàn:`);
    for (const r of mienTruDangRo) {
      console.log(`   ! ${r.table_name} — ${r.visible_foreign_do_duoc} dòng của tổ chức khác · hạn ${r.expires_at}`);
    }
    console.log('   Hạn ở trên là thứ duy nhất ngăn chúng nằm đây vĩnh viễn.');
  }

  if (ghi) {
    const doc = {
      note: 'Sinh bằng máy. Giai đoạn LẤY TỪ việc quét docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY-V2.md, miễn trừ LẤY TỪ app_private.org_boundary_exemptions. Đừng sửa tay.',
      projectRef: ref,
      capturedAt: new Date().toISOString(),
      // Mượn vân tay của snapshot catalog đã commit thay vì tự tính lại: cùng một
      // con số thì gate "inventory cũ hơn catalog" mới so được với gate catalog:check.
      // Tự tính lại một vân tay riêng nghĩa là hai công cụ đo hai thứ rồi cãi nhau.
      catalogFingerprint: docVanTayCatalog(),
      counts: dem,
      rows,
    };
    writeFileSync(RA_JSON, `${JSON.stringify(doc, null, 2)}\n`);

    const md = [
      '# Inventory biên giới tổ chức',
      '',
      '> Sinh bằng máy — `node scripts/build-org-boundary-inventory.mjs --write`. Đừng sửa tay.',
      '',
      `Chụp lúc ${doc.capturedAt} · ${tomTat}`,
      '',
      '| Bảng | Nhóm | Giai đoạn | Có cột org | Biên giới | authenticated đọc | Realtime | Dòng trong plan |',
      '|---|---|---|---|---|---|---|---|',
      ...rows.map((r) =>
        `| ${r.table_name} | ${r.group} | ${r.assigned_phase ?? '—'} | ${r.has_organization_id ? 'có' : 'không'} | ${r.boundary_policy_name ?? '—'} | ${r.authenticated_can_select ? 'có' : 'không'} | ${r.in_realtime_publication ? 'có' : 'không'} | ${r.source_line ?? '—'} |`,
      ),
    ].join('\n');
    writeFileSync(RA_MD, `${md}\n`);
    console.log(`✅ Đã ghi inventory: ${rows.length} relation · ${tomTat}`);
  }

  if (!kq.dat) {
    console.error('❌ Inventory hở:');
    for (const l of kq.loi) console.error(`   - ${l}`);
    return 1;
  }
  console.log(`✅ Mọi relation đều có chỗ đứng (${rows.length} relation · ${tomTat}).`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
    .then((c) => process.exit(c))
    .catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
