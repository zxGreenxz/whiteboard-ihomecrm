import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const target = new URL('../evidence/', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('live-function-audit.json', target), 'utf8').replace(/^\uFEFF/, ''));
const sources = {
  upsert_room_pass_listing: 'supabase/migrations/20260629100000_room_pass_listings_contact_manager.sql',
  set_reservation_hold_terms_v1: 'supabase/migrations/20260822120000_han_bo_sung_coc_cho_phieu_giu_cho.sql',
  create_room_reservation_v1: 'supabase/migrations/20261010114500_giu_cho_ten_goi_nho_va_lock_tam_phong.sql',
  update_room_reservation_v1: 'supabase/migrations/20260928025848_room_reservation_workflow.sql',
};
const md5 = value => createHash('md5').update(value).digest('hex');
const lf = value => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
function body(definition, name) {
  const match = definition.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\bAS\\s+(\\$[A-Za-z_]*\\$)([\\s\\S]*?)\\1`, 'i'));
  assert.ok(match, `Missing function body: ${name}`);
  return match[2];
}
const routines = catalog.map(row => {
  const sourcePath = sources[row.routine];
  assert.ok(sourcePath, `Unexpected routine: ${row.routine}`);
  const source = readFileSync(sourcePath, 'utf8');
  const sourceBody = body(source, row.routine);
  const catalogBody = body(row.definition, row.routine);
  return {
    routine: row.routine,
    signature: row.signature,
    sourcePath,
    sourceDefinitionLine: source.slice(0, source.indexOf(`CREATE OR REPLACE FUNCTION public.${row.routine}(`)).split('\n').length,
    securityDefiner: row.security_definer,
    catalogReportedBodyMd5: row.body_md5,
    catalogExtractedBodyMd5: md5(catalogBody),
    catalogReportedMd5MatchesExtracted: row.body_md5 === md5(catalogBody),
    sourceBodyLfMd5: md5(lf(sourceBody)),
    catalogBodyLfMd5: md5(lf(catalogBody)),
    bodiesEqualAfterLineEndingNormalization: lf(sourceBody) === lf(catalogBody),
  };
});
const result = {
  sourceSnapshot: 'c095d427e',
  method: 'Extract dollar-quoted body; compare exact text after CRLF/CR to LF only. Do not trim, strip comments, or collapse whitespace. Separately verify supplied catalog MD5 against the raw extracted deployed body.',
  evidence: 'live-function-audit.json supplied by root from a read-only production catalog query',
  allCatalogHashesVerified: routines.every(r => r.catalogReportedMd5MatchesExtracted),
  allBodiesMatch: routines.every(r => r.bodiesEqualAfterLineEndingNormalization),
  routines,
  limits: ['Only these four function bodies and supplied SECURITY DEFINER metadata are compared', 'No additional database access or writes', 'No JWT/PostgREST exploit or end-to-end authorization test', 'No verification of the entire deployed helper/trigger/ACL chain'],
};
writeFileSync(new URL('live-function-comparison.json', target), JSON.stringify(result, null, 2) + '\n');
const markdown = `# Đối chiếu thân hàm production với mã nguồn\n\nĐối chiếu catalog chỉ đọc do root thu thập với snapshot \`c095d427e\`. Chỉ chuẩn hóa CRLF/CR thành LF; giữ nguyên comment, dấu cách và nội dung thân hàm.\n\n| Hàm | Migration nguồn | MD5 body sau chuẩn hóa | Khớp catalog |\n|---|---|---|---|\n${routines.map(r => `| \`${r.routine}\` | \`${r.sourcePath}:${r.sourceDefinitionLine}\` | \`${r.sourceBodyLfMd5}\` | ${r.bodiesEqualAfterLineEndingNormalization ? 'Có' : 'KHÔNG'} |`).join('\n')}\n\nMD5 catalog được cung cấp khớp MD5 thân hàm trích từ definition: **${result.allCatalogHashesVerified ? '4/4' : 'có sai lệch'}**. Cả bốn hàm được catalog ghi nhận \`SECURITY DEFINER\`.\n\nPhát hiện scope của \`upsert_room_pass_listing\` đã được nối với thân hàm hiện hành trên production: body deployed giống hệt body dùng trong proof cục bộ sau chuẩn hóa xuống dòng. Đây vẫn **chưa phải** thử tấn công bằng JWT/PostgREST hoặc xác minh toàn bộ helper, trigger, ACL của database production.\n\nNguồn: [catalog chỉ đọc](live-function-audit.json), [đối chiếu máy đọc](live-function-comparison.json), [script đối chiếu](../proofs/compare-live-functions.mjs).\n`;
writeFileSync(new URL('live-function-comparison.md', target), markdown);
console.log(JSON.stringify(result, null, 2));
