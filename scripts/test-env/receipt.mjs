import { createHash } from 'node:crypto';

export function assertSuite(report, minimum) {
  if (!Number.isInteger(report?.passed) || report.passed < minimum || minimum < 1 ||
      report.failed || report.skipped || report.cleanup === 'failed') {
    throw new Error('Bộ kiểm TEST thiếu ca bắt buộc, có lỗi/skip hoặc chưa dọn fixture.');
  }
  return report;
}

export function catalogDigest(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Catalog TEST rỗng.');
  return createHash('sha256').update(JSON.stringify([...rows].sort((a, b) => a.k.localeCompare(b.k)))).digest('hex');
}

export function checkSnapshot(receipt, { digest, ownersDigest, now = Date.now(), maxAgeHours = 24 }) {
  const ageHours = (now - Date.parse(receipt?.snapshot_prod)) / 3_600_000;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || receipt?.ket_qua !== 'DAT' ||
      !receipt.chi_tiet?.schemaDigest || receipt.chi_tiet.schemaDigest !== digest ||
      typeof ownersDigest !== 'string' || !ownersDigest || receipt.chi_tiet.ownersDigest !== ownersDigest ||
      !Number.isFinite(ageHours) || ageHours < 0 || ageHours > maxAgeHours) {
    throw new Error('Snapshot TEST thiếu biên nhận đạt, đã cũ hoặc schema/owner/role/ACL đổi. Chạy test-env:check -- --sync.');
  }
  return { snapshotAt: receipt.snapshot_prod, ageHours, schemaDigest: digest, ownersDigest };
}
