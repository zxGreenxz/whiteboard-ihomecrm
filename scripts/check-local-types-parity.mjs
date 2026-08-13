#!/usr/bin/env node
// =============================================================================
// So types sinh từ MIGRATION với types sinh từ PRODUCTION — theo NỘI DUNG, không
// theo byte.
//
// CÂU HỎI CỬA NÀY TRẢ LỜI
//   "Replay toàn bộ migration vào một database trắng có dựng lại đúng schema mà
//   production đang chạy không?" Đó là nền của forward-only lane và của mọi kịch
//   bản khôi phục: nếu không, thì bản baseline + migration KHÔNG phải bản sao của
//   production, và ngày cần dựng lại mới biết.
//
// VÌ SAO KHÔNG SO BẰNG `git diff --exit-code`
//   Bước cũ trong ci-gates.yml làm đúng thế và KHÔNG BAO GIỜ xanh được — nhưng
//   không ai biết, vì job `generated-types-local-drift` cần quality-gates xanh
//   mới chạy, mà quality-gates đỏ 168 lượt liên tiếp.
//
//   Đo 12/08/2026, hai bản đều đã qua `types:normalize`:
//     production : 28.569 dòng
//     migration  : 28.409 dòng
//     git diff   : 10.069 thêm / 10.229 xoá
//   Nghe như hai schema khác hẳn nhau. Nhưng so theo MULTISET DÒNG:
//     dòng chỉ có ở bản migration : 0
//     dòng chỉ có ở production    : 160 — và cả 160 đều là `isOneToOne: false`
//   Tức nội dung TRÙNG KHÍT; phần còn lại chỉ là THỨ TỰ KHOÁ khác nhau.
//
//   Hai khác biệt đó thuộc về BỘ NỘI SUY, không thuộc về schema:
//     · thứ tự: PGlite và Postgres hosted liệt kê quan hệ theo trật tự khác nhau;
//     · `isOneToOne`: siêu dữ liệu quan hệ khoá ngoại mà bản PGlite không phát.
//   Bắt hai thứ đó phải trùng byte là đòi hai engine cho ra output y hệt — một
//   điều kiện không liên quan gì tới "migration có tái tạo được production không".
//
// CÁI CỬA NÀY VẪN BẮT ĐƯỢC
//   Thiếu/thừa BẤT KỲ bảng, cột, hàm, enum hay kiểu nào — vì mỗi thứ đó là một
//   dòng riêng trong multiset. Một migration quên `ALTER TABLE`, một object chỉ
//   tồn tại trên production do sửa tay, một cột bị đổi kiểu: đều lộ ra.
//
// CÁI NÓ KHÔNG BẮT — ghi ra để không ai tin quá lời
//   Thứ tự khoá, `isOneToOne`, và việc một dòng giống hệt bị CHUYỂN từ bảng này
//   sang bảng khác (multiset dòng không mang ngữ cảnh cha). Muốn phủ nốt phải so
//   AST, và cái giá đó chưa đáng ở đây.
//
//   node scripts/check-local-types-parity.mjs <production.ts> <migration.ts>
// =============================================================================

import { readFileSync } from 'node:fs';

/** Sàn chống-xanh-rỗng: file types thật ~28.000 dòng. */
export const TOI_THIEU_DONG = 20_000;

/**
 * Trường do BỘ NỘI SUY sinh, không mô tả schema.
 *
 * Danh sách này CHỈ ĐƯỢC TEO. Thêm một mục nghĩa là bỏ qua thêm một phần schema,
 * nên mỗi mục phải nói rõ vì sao nó không phải schema.
 */
export const TRUONG_CUA_BO_NOI_SUY = [
  // Quan hệ khoá ngoại là 1-1 hay 1-n. Bản PGlite không phát trường này; nó suy
  // từ chỉ mục unique mà hai engine không liệt kê giống nhau. Không có cột hay
  // ràng buộc nào mất đi khi bỏ qua nó — chỉ mất nhãn mô tả quan hệ.
  /^isOneToOne:/,
];

/** Dạng chuẩn: bỏ trắng, bỏ dòng rỗng, bỏ trường của bộ nội suy, rồi SẮP XẾP. */
export function dangChuan(noiDung) {
  return noiDung
    .split(/\r?\n/)
    .map((d) => d.trim())
    .filter((d) => d !== '')
    .filter((d) => !TRUONG_CUA_BO_NOI_SUY.some((re) => re.test(d)))
    .sort();
}

/** Trả về phần THỪA RA ở mỗi bên, giữ trùng lặp. */
export function soMultiset(trai, phai) {
  const dem = new Map();
  for (const d of phai) dem.set(d, (dem.get(d) ?? 0) + 1);
  const chiTrai = [];
  for (const d of trai) {
    const n = dem.get(d) ?? 0;
    if (n > 0) dem.set(d, n - 1);
    else chiTrai.push(d);
  }
  const chiPhai = [];
  for (const [d, n] of dem) for (let i = 0; i < n; i += 1) chiPhai.push(d);
  return { chiTrai, chiPhai };
}

function main(argv) {
  const [duongDanProd, duongDanMigration] = argv.slice(2);
  if (!duongDanProd || !duongDanMigration) {
    console.error('Dùng: node scripts/check-local-types-parity.mjs <production.ts> <migration.ts>');
    process.exit(3);
  }

  let prod;
  let migration;
  try {
    prod = dangChuan(readFileSync(duongDanProd, 'utf8'));
    migration = dangChuan(readFileSync(duongDanMigration, 'utf8'));
  } catch (e) {
    console.error(`=== ⚠ KHÔNG KIỂM ĐƯỢC — không đọc được file: ${e.message} ===`);
    process.exit(3);
  }

  if (prod.length < TOI_THIEU_DONG || migration.length < TOI_THIEU_DONG) {
    console.error(
      `=== ⚠ KHÔNG KIỂM ĐƯỢC — file quá ngắn (production ${prod.length}, migration ${migration.length}, sàn ${TOI_THIEU_DONG}) ===`,
    );
    console.error('  Nhiều khả năng generator hỏng giữa chừng. "0 khác biệt" ở đây là câu đúng mà vô nghĩa.');
    process.exit(3);
  }

  const { chiTrai: chiProd, chiPhai: chiMigration } = soMultiset(prod, migration);

  console.log(
    `Đối chiếu types: production ${prod.length} dòng · migration ${migration.length} dòng (đã bỏ thứ tự và ${TRUONG_CUA_BO_NOI_SUY.length} trường của bộ nội suy)`,
  );

  if (chiProd.length === 0 && chiMigration.length === 0) {
    console.log('✅ Replay migration dựng lại ĐÚNG schema production — không thiếu, không thừa object nào.');
    console.log('   CHƯA PHỦ: thứ tự khoá, isOneToOne, và một dòng giống hệt bị chuyển giữa hai bảng.');
    return;
  }

  if (chiProd.length > 0) {
    console.error(`\n❌ ${chiProd.length} dòng CHỈ CÓ trên production — migration KHÔNG dựng lại được:`);
    for (const d of chiProd.slice(0, 40)) console.error(`   - ${d.slice(0, 120)}`);
    if (chiProd.length > 40) console.error(`   … còn ${chiProd.length - 40} dòng`);
    console.error('   Nghĩa là production có object mà lịch sử migration không mô tả — dựng lại từ');
    console.error('   baseline + forward lane sẽ THIẾU chúng, và chỉ biết vào ngày cần khôi phục.');
  }
  if (chiMigration.length > 0) {
    console.error(`\n❌ ${chiMigration.length} dòng CHỈ CÓ ở bản dựng từ migration — production thiếu:`);
    for (const d of chiMigration.slice(0, 40)) console.error(`   - ${d.slice(0, 120)}`);
    if (chiMigration.length > 40) console.error(`   … còn ${chiMigration.length - 40} dòng`);
    console.error('   Nghĩa là có migration đã merge nhưng CHƯA apply lên production.');
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  main(process.argv);
}
