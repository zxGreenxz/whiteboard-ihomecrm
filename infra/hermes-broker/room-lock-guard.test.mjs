import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_LOCK_ACTION, ROOM_LOCK_HOURS, roomLockGuard, roomLockHoursDetail } from './room-lock-guard.mjs';
import { CONTRACT_ROOM_LOCK } from './contract-action-contract.mjs';
import { previewFirst, validateActionParams } from './action-catalog.mjs';
import { consentRequired } from './consent-guard.mjs';

// Lưới giữ / khoá tạm phòng (PS-K03): số giờ ngoài 6 / 12 / 24 ⇒ hỏi lại người dùng, không tới SQL. Vòng đời đủ hai lượt qua broker thật ở
// action-runtime.test.mjs và contract-action.test.mjs; SQL thật (preview không ghi) ở contract-action-sql.test.mjs.
test('roomLockGuard: chỉ ba mức 6 / 12 / 24 đi tiếp; số giờ nguyên khác ⇒ offHours; thao tác khác và params lạ ⇒ cho qua', () => {
  assert.equal(ROOM_LOCK_ACTION, CONTRACT_ROOM_LOCK.id);
  assert.deepEqual([...ROOM_LOCK_HOURS], [6, 12, 24]);
  for (const hours of ROOM_LOCK_HOURS) assert.deepEqual(roomLockGuard(ROOM_LOCK_ACTION, { hours }), { offHours: null }, String(hours));
  for (const hours of [1, 5, 7, 8, 10, 13, 23, 25, 48, 72, 720]) assert.deepEqual(roomLockGuard(ROOM_LOCK_ACTION, { hours }), { offHours: hours }, String(hours));
  // Không phải việc của lưới: thao tác khác (kể cả bỏ khoá), params không phải object, hours không phải số nguyên (khuôn danh mục đã chặn trước).
  for (const [action, params] of [['contract.room_unlock', { hours: 8 }], ['contract.renew', { hours: 8 }], [ROOM_LOCK_ACTION, null], [ROOM_LOCK_ACTION, undefined],
    [ROOM_LOCK_ACTION, 'hours=8'], [ROOM_LOCK_ACTION, {}], [ROOM_LOCK_ACTION, { hours: '8' }], [ROOM_LOCK_ACTION, { hours: 8.5 }], [ROOM_LOCK_ACTION, { hours: Number.NaN }]])
    assert.deepEqual(roomLockGuard(action, params), { offHours: null }, JSON.stringify([action, params]));
});

test('câu hỏi lại: nêu số giờ người dùng nói, đủ ba mức, dặn hỏi chọn và không tự đổi; một câu tĩnh theo số giờ', () => {
  const detail = roomLockHoursDetail(8);
  assert.equal(detail, 'Không giữ phòng được 8 giờ: chỉ có mức 6, 12 hoặc 24 giờ. Nói với người dùng mức họ nêu không có và hỏi họ chọn mức nào — ' +
    'KHÔNG tự đổi sang mức khác rồi gọi lại.');
  assert.equal(roomLockHoursDetail(48), detail.replace('8 giờ:', '48 giờ:'));
  assert.ok(detail.length <= 300);
});

test('khuôn danh mục và lưới khớp nhau: mọi số giờ khuôn nhận mà không thuộc ba mức đều bị lưới giữ lại; khoá tạm luôn xem trước, xác nhận cần lời đồng ý', () => {
  const { min, max } = CONTRACT_ROOM_LOCK.params.hours;
  assert.deepEqual([min, max], [1, 720]);
  for (let hours = min; hours <= max; hours += 1) {
    const checked = validateActionParams(CONTRACT_ROOM_LOCK, { buildingName: '44TL', roomName: '303', hours });
    assert.equal(checked.ok, true, String(hours));
    assert.equal(roomLockGuard(CONTRACT_ROOM_LOCK.id, checked.value).offHours, ROOM_LOCK_HOURS.includes(hours) ? null : hours, String(hours));
  }
  assert.equal(previewFirst(CONTRACT_ROOM_LOCK), true);
  assert.equal(consentRequired(CONTRACT_ROOM_LOCK), true);
});
