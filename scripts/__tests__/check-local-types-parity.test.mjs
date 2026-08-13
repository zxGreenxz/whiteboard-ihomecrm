// Tự kiểm bộ đối chiếu types migration ↔ production (Contract §8).
//
// Cửa này BỎ QUA hai thứ có chủ đích (thứ tự khoá, `isOneToOne`), nên rủi ro lớn
// nhất của nó không phải báo nhầm mà là BỎ LỌT. Các ca dưới đây pin đúng ranh
// giới đó: bỏ qua cái phải bỏ qua, và vẫn thấy cái phải thấy.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOI_THIEU_DONG,
  TRUONG_CUA_BO_NOI_SUY,
  dangChuan,
  soMultiset,
} from '../check-local-types-parity.mjs';

test('thứ tự khác nhau KHÔNG phải khác biệt', () => {
  const a = dangChuan('b: string\na: number\n');
  const b = dangChuan('a: number\nb: string\n');
  assert.deepEqual(soMultiset(a, b), { chiTrai: [], chiPhai: [] });
});

test('bỏ qua isOneToOne — trường của bộ nội suy, không phải schema', () => {
  const a = dangChuan('foreignKeyName: "fk_a"\nisOneToOne: false\n');
  const b = dangChuan('foreignKeyName: "fk_a"\n');
  assert.deepEqual(soMultiset(a, b), { chiTrai: [], chiPhai: [] });
});

test('khoảng trắng đầu dòng không tạo ra khác biệt giả', () => {
  const a = dangChuan('      organization_id: string\n');
  const b = dangChuan('  organization_id: string\n');
  assert.deepEqual(soMultiset(a, b), { chiTrai: [], chiPhai: [] });
});

test('CỘT THIẾU ở bản migration ⇒ bị bắt', () => {
  const a = dangChuan('id: string\norganization_id: string\n');
  const b = dangChuan('id: string\n');
  const { chiTrai, chiPhai } = soMultiset(a, b);
  assert.deepEqual(chiTrai, ['organization_id: string'], 'production có, migration không dựng được');
  assert.deepEqual(chiPhai, []);
});

test('OBJECT THỪA ở bản migration ⇒ bị bắt (migration merge nhưng chưa apply)', () => {
  const a = dangChuan('id: string\n');
  const b = dangChuan('id: string\nbang_chua_apply: {\n');
  const { chiTrai, chiPhai } = soMultiset(a, b);
  assert.deepEqual(chiTrai, []);
  assert.deepEqual(chiPhai, ['bang_chua_apply: {']);
});

test('giữ TRÙNG LẶP — mất một trong hai dòng giống hệt vẫn bị bắt', () => {
  // Hai bảng khác nhau cùng có cột `id: string`. Nếu dùng Set thì mất một cái là
  // vô hình; đó chính là kiểu hụt mà multiset sinh ra để chặn.
  const a = dangChuan('id: string\nid: string\n');
  const b = dangChuan('id: string\n');
  assert.equal(soMultiset(a, b).chiTrai.length, 1);
});

test('sàn chống-xanh-rỗng đủ cao so với file types thật (~28.000 dòng)', () => {
  assert.ok(TOI_THIEU_DONG >= 20_000, 'sàn thấp thì generator hỏng nửa chừng sẽ đi qua');
});

test('danh sách trường bỏ qua phải NHỎ và có lý do', () => {
  // Mỗi mục thêm vào là một phần schema thôi được kiểm. Ghim số lượng để việc
  // nới ra phải đi kèm sửa test — tức phải có người nhìn.
  assert.equal(TRUONG_CUA_BO_NOI_SUY.length, 1);
});
