// Tự kiểm cửa ratchet lint (Contract §8: gate phải có test của chính nó).
//
// Kiểm hai hàm THUẦN bằng dữ liệu dựng tay, không gọi eslint thật: chạy eslint
// trên toàn repo mất hàng chục giây và kết quả phụ thuộc mã nguồn đang có, nên
// một test như thế đo lẫn hai thứ và sẽ đỏ vì lý do chẳng liên quan.
//
// Ca quan trọng nhất ở đây là ca MULTISET. Nếu ai đó "đơn giản hoá" fingerprint
// thành tập hợp, mọi test khác vẫn xanh — chỉ ca đó đỏ. Đó chính là lỗ hổng mà
// check-ts-baseline đã phải vá sau khi đo thấy một lỗi cũ cấp phép cho lỗi mới
// cùng dạng trong cùng file.

import assert from 'node:assert/strict';
import test from 'node:test';

import { BO_QUA, TOI_THIEU_FILE, dungFingerprint, soMultiset } from '../check-eslint-baseline.mjs';

const goc = '/repo';
const ketQua = (duongDan, ...tin) => ({
  filePath: `${goc}/${duongDan}`.split('/').join(process.platform === 'win32' ? '\\' : '/'),
  messages: tin,
});
const loi = (ruleId) => ({ severity: 2, ruleId });
const canhBao = (ruleId) => ({ severity: 1, ruleId });

test('chỉ ratchet mức ERROR, bỏ qua warning', () => {
  const fp = dungFingerprint(
    [ketQua('src/a.ts', loi('@typescript-eslint/no-explicit-any'), canhBao('react-refresh/only-export-components'))],
    goc,
  );
  assert.deepEqual(fp, ['src/a.ts|@typescript-eslint/no-explicit-any']);
});

test('giữ TRÙNG LẶP — hai lỗi cùng rule cùng file cho hai fingerprint', () => {
  const fp = dungFingerprint(
    [ketQua('src/a.ts', loi('rule-x'), loi('rule-x'))],
    goc,
  );
  assert.equal(fp.length, 2, 'multiset phải giữ cả hai, nếu không lỗi thứ hai được tha miễn phí');
});

test('lỗi không có ruleId vẫn được ghi, không bị nuốt', () => {
  const fp = dungFingerprint([ketQua('src/a.ts', { severity: 2, ruleId: null })], goc);
  assert.deepEqual(fp, ['src/a.ts|(khong-ro-rule)']);
});

test('đường dẫn luôn dùng dấu / để baseline chạy chung Windows và Linux', () => {
  const fp = dungFingerprint([ketQua('src/sub/a.ts', loi('r'))], goc);
  assert.ok(fp[0].startsWith('src/sub/a.ts|'), `nhận: ${fp[0]}`);
});

test('không có gì đổi ⇒ không lỗi mới, không lỗi đã dọn', () => {
  const nen = ['a|r', 'a|r', 'b|r'];
  const { moi, daDon } = soMultiset(['a|r', 'a|r', 'b|r'], nen);
  assert.deepEqual(moi, []);
  assert.deepEqual(daDon, []);
});

test('THÊM một lỗi vào file ĐANG SẠCH ⇒ báo lỗi mới', () => {
  const { moi } = soMultiset(['a|r', 'c|r'], ['a|r']);
  assert.deepEqual(moi, ['c|r']);
});

test('CA QUYẾT ĐỊNH: thêm lỗi thứ HAI vào file đã có sẵn một lỗi cùng rule ⇒ vẫn báo', () => {
  // Bản dùng Set sẽ trả về [] ở đây và cửa xanh — đó là lỗ hổng.
  const { moi } = soMultiset(['a|r', 'a|r'], ['a|r']);
  assert.deepEqual(moi, ['a|r'], 'multiset phải thấy lần xuất hiện thứ hai');
});

test('dọn bớt lỗi ⇒ không phải lỗi mới, và được ghi nhận là đã dọn', () => {
  const { moi, daDon } = soMultiset(['a|r'], ['a|r', 'a|r', 'b|r']);
  assert.deepEqual(moi, []);
  assert.deepEqual(daDon.sort(), ['a|r', 'b|r']);
});

test('sàn chống-xanh-rỗng và bộ ignore khớp CI', () => {
  assert.ok(TOI_THIEU_FILE >= 500, 'sàn quá thấp thì "0 lỗi mới" mất ý nghĩa');
  // Bộ ignore phải trùng bước "Lint root-owned code" trong ci-gates.yml.
  for (const p of ['services/**', 'infra/**', 'supabase/functions/**', '.e2e-fleet/**']) {
    assert.ok(BO_QUA.includes(p), `thiếu ignore ${p}`);
  }
});
