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
  // Review #253 mục 5: object tự đông cứng (lý do ngoài danh sách, attachments, class lạ) không qua defineAction ⇒ từ chối nạp.
  const forged = Object.freeze({ ...PROBE_NOTE, id: 'probe.forged', reasons: Object.freeze(['totally_new_reason']),
    params: Object.freeze({ photos: Object.freeze({ kind: 'attachments', optional: true, hint: 'x', max: 5 }) }), class: 'Money' });
  assert.throws(() => createActionCatalog([forged], { keys: [PROBE_KEY] }), /invalid_action_catalog/);
  assert.throws(() => createActionCatalog([Object.freeze({ ...PROBE_NOTE })], { keys: [PROBE_KEY] }), /invalid_action_catalog/, 'bản chép đông cứng cũng không');
  // Khoá mặc định và trần = HERMES_ACTION_CAPABILITIES: không truyền keys vẫn nạp được khoá thử; khoá ngoài hợp đồng thì không.
  assert.deepEqual([...createActionCatalog([PROBE_NOTE]).keys], [PROBE_KEY]);
  assert.throws(() => createActionCatalog([], { keys: ['made.up_key'] }), /invalid_action_catalog/);
  const outside = defineAction({ ...base, id: 'probe.outside', key: 'made.up_key' });
  assert.throws(() => createActionCatalog([outside]), /invalid_action_catalog/);
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

test('list/record (Đợt 2: lô Thu chi ≤ 5 khoản, Hợp đồng ≤ 20 HĐ): khai sai ⇒ lỗi nạp; kiểm từng phần tử với đường dẫn tĩnh', () => {
  const item = param.record({ buildingName: param.name('building'), amount: param.vnd(), note: param.text(1, 20, { optional: true }) });
  const batch = defineAction({ ...base, id: 'probe.batch', params: { items: param.list(item, { max: 3 }), codes: param.list(param.name('voucher'), { max: 2, optional: true }) } });
  // Khai sai: record đứng riêng, list lồng list/ảnh/record rỗng, phần tử tuỳ chọn, giới hạn ngoài 1–20, record > 12 trường.
  for (const bad of [() => defineAction({ ...base, id: 'probe.rec', params: { r: item } }), () => param.list(param.list(param.bool(), { max: 2 }), { max: 2 }),
    () => param.list(param.attachments(), { max: 2 }), () => param.record({}), () => param.list(param.bool({ optional: true }), { max: 2 }),
    () => param.list(param.bool(), { max: 21 }), () => param.list(param.bool(), { min: 0, max: 2 }), () => param.list(param.bool(), { min: 3, max: 2 }),
    () => param.record(Object.fromEntries(Array.from({ length: 13 }, (_, n) => [`f${n}`, param.bool()]))), () => param.record({ 'bad-name': param.bool() })])
    assert.throws(bad, /invalid_action_catalog/);
  assert.equal(param.name('category').hint, 'tên hạng mục như người dùng nói');
  assert.equal(param.name('cashbook').hint, 'tên sổ quỹ như người dùng nói');
  assert.deepEqual(validateActionParams(batch, { items: [{ building_name: ' A ', amount: '350000' }, { buildingName: 'B', amount: 1, note: '' }] }),
    { ok: true, value: { items: [{ buildingName: 'A', amount: 350_000 }, { buildingName: 'B', amount: 1 }] } });
  assert.deepEqual(validateActionParams(batch, { items: [{ buildingName: 'A', amount: 1 }], codes: [' PC2610001 '] }).value.codes, ['PC2610001']);
  const canary = 'tok-PRIVATE-fake-q2';
  const detail = raw => { const checked = validateActionParams(batch, raw); assert.equal(checked.ok, false); assert.doesNotMatch(checked.detail, /tok-PRIVATE-fake/); return checked.detail; };
  assert.match(detail({ items: [{ buildingName: 'A', amount: 1 }, { buildingName: 'B', amount: '3tr5' }] }), /items#2\.amount \(số nguyên VND/);
  assert.match(detail({ items: [{ buildingName: 'A' }] }), /items#1\.amount/);
  assert.match(detail({ items: [] }), /items \(danh sách 1–3 mục\)/);
  assert.match(detail({ items: [1, 2, 3, 4].map(() => ({ buildingName: 'A', amount: 1 })) }), /items \(danh sách 1–3 mục\)/);
  assert.match(detail({ items: [{ buildingName: 'A', amount: 1, [canary]: 1 }] }), /items#1 \(có trường không nhận\)/);
  assert.match(detail({ items: [{ buildingName: 'A', building_name: canary, amount: 1 }] }), /items#1\.buildingName \(gửi hai lần\)/);
  assert.match(detail({ items: ['A'] }), /items#1 \(mỗi mục là object\)/);
  assert.match(detail({ items: [{ buildingName: 'A', amount: 1 }], codes: [canary, 'b', 'c'] }), /codes \(danh sách 1–2 mục\)/);
  assert.match(detail({ items: { 0: { buildingName: 'A', amount: 1 }, length: 1 } }), /items \(danh sách/);
  // Mảng có lỗ, có khoá thêm hay có accessor ⇒ sai; accessor không bao giờ chạy.
  const holey = [{ buildingName: 'A', amount: 1 }, , { buildingName: 'B', amount: 1 }]; // eslint-disable-line no-sparse-arrays
  const extra = Object.assign([{ buildingName: 'A', amount: 1 }], { extra: true });
  const getter = Object.defineProperty([], 0, { enumerable: true, get: () => { throw new Error('ran'); } });
  for (const items of [holey, extra, getter]) assert.match(detail({ items }), /items \(danh sách/);
  // Mục lục: khuôn phần tử và từng trường của record.
  const listed = createActionCatalog([batch], { keys: [PROBE_KEY] }).listing({ action: [PROBE_KEY] })[0].params;
  assert.deepEqual(listed.items.item.fields.amount, { type: 'vnd', required: true, hint: 'số nguyên VND (3tr5 = 3500000)' });
  assert.deepEqual([listed.items.type, listed.items.min, listed.items.max, listed.items.required], ['list', 1, 3, true]);
  assert.deepEqual([listed.codes.item.type, listed.codes.required], ['name', false]);
  // Token gắn cả lô theo thứ tự phần tử.
  assert.notEqual(canonicalJson({ items: [{ a: 1 }, { a: 2 }] }), canonicalJson({ items: [{ a: 2 }, { a: 1 }] }));
});

test('canonicalJson: cùng nội dung khác thứ tự khoá ⇒ cùng chuỗi; khác nội dung ⇒ khác', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  assert.notEqual(canonicalJson({ amount: 1000 }), canonicalJson({ amount: 1001 }));
  assert.equal(canonicalJson({ a: undefined }), '{"a":null}');
});
