import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_PAGES, ATTACHMENTS_READY, canonicalJson, createActionCatalog, defineAction, param, validateActionParams } from './action-catalog.mjs';
import { PROBE_CONFIRM, PROBE_KEY, PROBE_NOTE, probeCatalog } from './action-probe-contract.mjs';

// Sổ danh mục thao tác ghi dùng chung (NEN-CHUNG-THAO-TAC-GHI.md mục 5): kiểm khi nạp, kiểm params ở connector với gợi ý
// TĨNH dựng từ khuôn (không nhắc lại giá trị mô hình gửi), JSON chuẩn hoá cho khoá binding xác nhận.
const base = { id: 'probe.sample', page: 'probe', key: PROBE_KEY, class: 'money', title: 'Thử', rpc: 'hermes_action_probe_v1' };

test('defineAction từ chối khai sai: mã, trang, lớp, khoá, tiêu đề, khuôn, lý do ngoài danh sách đóng, tham số ảnh khi chưa có luồng ảnh', () => {
  assert.ok(Object.isFrozen(defineAction(base)));
  assert.deepEqual([...ACTION_PAGES], ['expense', 'invoice', 'contract', 'task', 'probe']);
  for (const bad of [{ id: 'Probe.x' }, { id: 'probe' }, { id: 'probe.x' }, { id: 'contract.sample' }, { page: 'payroll', id: 'payroll.sample' }, { class: 'cheap' }, { key: 'Bad Key' },
    { title: '' }, { title: 'a\nb' }, { params: { 'bad-name': param.bool() } }, { params: { ok: { kind: 'text' } } }, { reasons: ['nope'] },
    { reasons: ['state_changed', 'state_changed'] }, { extra: true }])
    assert.throws(() => defineAction({ ...base, ...bad }), /invalid_action_catalog/, JSON.stringify(bad));
  assert.equal(ATTACHMENTS_READY, false);
  assert.throws(() => defineAction({ ...base, params: { photos: param.attachments() } }), /invalid_action_catalog/, 'câu 11: luồng ảnh làm ở đợt Thu chi');
  for (const bad of [() => param.text(0, 5), () => param.text(5, 4), () => param.int(3, 1), () => param.vnd({ min: -1 }), () => param.oneOf([]),
    () => param.oneOf(['a', 'a']), () => param.name('planet'), () => param.attachments({ max: 11 })]) assert.throws(bad, /invalid_action_catalog/);
});

test('createActionCatalog: mã trùng hay khoá ngoài tập cho phép ⇒ lỗi nạp; mục lục chỉ thao tác kết nối giữ khoá', () => {
  assert.throws(() => createActionCatalog([PROBE_NOTE, PROBE_NOTE], { keys: [PROBE_KEY] }), /invalid_action_catalog/);
  assert.throws(() => createActionCatalog([PROBE_NOTE], { keys: ['tasks.create'] }), /invalid_action_catalog/);
  assert.throws(() => createActionCatalog([{ ...PROBE_NOTE }], { keys: [PROBE_KEY] }), /invalid_action_catalog/, 'phải qua defineAction (đông cứng)');
  const empty = createActionCatalog([], { keys: [] });
  assert.equal(empty.empty, true); assert.equal(empty.any({ action: [PROBE_KEY] }), false);
  const catalog = probeCatalog();
  assert.deepEqual([...catalog.ids], ['probe.note', 'probe.confirm']);
  assert.deepEqual([...catalog.keys], [PROBE_KEY]);
  assert.equal(catalog.any({ action: [] }), false);
  assert.equal(catalog.any({ action: [PROBE_KEY] }), true);
  assert.equal(catalog.granted({ action: [PROBE_KEY] }, 'probe.nope'), false);
  assert.deepEqual(catalog.listing({ action: [] }), []);
  const listing = catalog.listing({ action: [PROBE_KEY] });
  assert.deepEqual(listing.map(item => [item.action, item.confirm]), [['probe.note', 'if_required'], ['probe.confirm', 'always']]);
  assert.deepEqual(listing[1].params.amount, { type: 'vnd', required: true, hint: 'số nguyên VND (3tr5 = 3500000)' });
  assert.deepEqual(listing[1].params.roomName, { type: 'name', required: false, hint: 'tên phòng như người dùng nói' });
  assert.deepEqual(catalog.listing({ action: [PROBE_KEY] }, 'contract'), []);
});

test('validateActionParams: chuẩn hoá snake_case, số dạng chuỗi chữ số, chuỗi trống của tham số tuỳ chọn; từ chối với gợi ý tĩnh', () => {
  assert.deepEqual(validateActionParams(PROBE_CONFIRM, { amount: '3500000', building_name: ' Toà 44TL ', roomName: '', date: '2026-10-21' }),
    { ok: true, value: { amount: 3_500_000, buildingName: 'Toà 44TL', date: '2026-10-21' } });
  assert.deepEqual(validateActionParams(PROBE_NOTE, undefined), { ok: false, detail: validateActionParams(PROBE_NOTE, {}).detail });
  const canary = 'tok-PRIVATE-fake-q1';
  for (const raw of [{ amount: '3tr5', buildingName: 'A' }, { amount: 0, buildingName: 'A' }, { amount: 10_000_001, buildingName: 'A' }, { buildingName: 'A' },
    { amount: 1000, buildingName: 'A', date: '21/10/2026' }, { amount: 1000, buildingName: 'A', reason: 'ngắn' }, { amount: 1000, buildingName: canary, [canary]: 1 },
    { amount: 1000, buildingName: 'A', building_name: 'B' }, { amount: 1000, buildingName: `A\nB` }, [1], 'x']) {
    const checked = validateActionParams(PROBE_CONFIRM, raw);
    assert.equal(checked.ok, false, JSON.stringify(raw));
    assert.doesNotMatch(checked.detail, /tok-PRIVATE-fake|21\/10\/2026|ngắn/, 'không nhắc lại giá trị mô hình gửi');
    assert.match(checked.detail, /Khuôn probe\.confirm: amount\* \(số nguyên VND/);
  }
  assert.match(validateActionParams(PROBE_CONFIRM, { buildingName: 'A' }).detail, /^Thiếu hoặc sai: amount \(số nguyên VND/);
  assert.match(validateActionParams(PROBE_CONFIRM, { amount: 1, buildingName: 'A', building_name: 'B' }).detail, /buildingName gửi hai lần/);
  // Accessor không được chạy (không đọc getter của mô hình).
  const accessor = Object.defineProperty({ buildingName: 'A' }, 'amount', { enumerable: true, get: () => { throw new Error('ran'); } });
  assert.equal(validateActionParams(PROBE_CONFIRM, accessor).ok, false);
  const kinds = defineAction({ ...base, id: 'probe.kinds', params: { m: param.month(), k: param.oneOf(['NATURAL', 'EARLY']), b: param.bool(), n: param.int(1, 60) } });
  assert.deepEqual(validateActionParams(kinds, { m: '2026-10', k: ' EARLY ', b: 'true', n: ' 6 ' }), { ok: true, value: { m: '2026-10', k: 'EARLY', b: true, n: 6 } });
  for (const raw of [{ m: '2026-13', k: 'EARLY', b: true, n: 6 }, { m: '2026-10', k: 'early', b: true, n: 6 }, { m: '2026-10', k: 'EARLY', b: 1, n: 6 },
    { m: '2026-10', k: 'EARLY', b: true, n: 6.5 }]) assert.equal(validateActionParams(kinds, raw).ok, false, JSON.stringify(raw));
});

test('canonicalJson: cùng nội dung khác thứ tự khoá ⇒ cùng chuỗi; khác nội dung ⇒ khác', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  assert.notEqual(canonicalJson({ amount: 1000 }), canonicalJson({ amount: 1001 }));
  assert.equal(canonicalJson({ a: undefined }), '{"a":null}');
});
