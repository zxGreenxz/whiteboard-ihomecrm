import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_TTL_MS } from './confirm-guard.mjs';
import { POLICY_CANCEL_AUDIT_ACTION, POLICY_CANCEL_TOOL, createPolicyCancelGuard, restatesStopCommand, splitPolicyCancelFields } from './policy-cancel-guard.mjs';
import { CONSENT_UNCLEAR_PREVIEW_DETAIL } from './consent-guard.mjs';
import { SALE_POLICY_TOOLS, salePolicyInput } from './sale-policy-contract.mjs';

// Rào lý do dừng chương trình sale (PS-D05, lô ps08 10/11/2026). Ở đây: bộ nhận "reason chỉ nhắc lại lệnh", sổ token và rào lời đồng ý của
// rào (thuần). Vòng đời qua broker thật (cầu crm_sale_action operation=policy_cancel, không tới dịch vụ khi chưa có token + lời đồng ý rõ, sổ
// audit mang câu đồng ý) ở sale-tool-bridge.test.mjs.
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const CONNECTION = id('a'), OTHER_CONNECTION = id('9'), POLICY = id('6'), OTHER_POLICY = id('7');
const START = Date.parse('2026-11-11T03:00:00.000Z');
const CF = /^cf_[A-Za-z0-9_-]{43}$/;
const cancel = (reason, extra = {}) => ({ requestId: id('1'), policyId: POLICY, expectedVersion: 1, reason, ...extra });
const setup = () => { const clock = { now: START }; return { clock, guard: createPolicyCancelGuard({ clock: () => clock.now }) }; };

test('reason chỉ nhắc lại lệnh dừng (không nói VÌ SAO) bị nhận ra: đủ các câu bot đã tự đặt ở PS-D05 và biến thể của chúng', () => {
  for (const reason of [
    'Ngưng chương trình ưu đãi', 'Ngưng chương trình ưu đãi theo yêu cầu', // đúng hai reason trong bản ghi sai (r3b1, r2b1)
    'Ngưng chương trình ưu đãi phòng 105 toà 1392QT', 'Ngưng chương trình ưu đãi phòng 105 toà 1392QT giúp anh', 'NGƯNG CHƯƠNG TRÌNH ƯU ĐÃI.',
    'Kết thúc', 'Dừng chương trình', 'Hủy khuyến mãi', 'Huỷ CTKM P105', 'Tắt chính sách sale', 'Chấm dứt chương trình ưu đãi', 'Tạm ngưng chương trình',
    'Theo yêu cầu', 'Theo yêu cầu của anh', 'Theo yêu cầu người dùng', 'Người dùng yêu cầu dừng', 'Anh yêu cầu ngưng', 'Dừng theo lệnh', 'Lý do: dừng chương trình',
    'Cancel policy', 'stop promo', 'Ngưng áp dụng ưu đãi', 'Dừng chương trình này đi em nhé', '.', '—', '105', ' ', 'a',
  ]) assert.equal(restatesStopCommand(reason), true, reason);
  for (const reason of [undefined, null, 42, {}, ['khách chê giá cao']]) assert.equal(restatesStopCommand(reason), true, String(reason));
});

test('lời thật của người dùng đi tiếp: mọi lý do người dùng đã nêu trong các bản ghi ma trận, kể cả câu ngắn, câu "không có lý do" và người yêu cầu có tên', () => {
  for (const reason of [
    'khách chê giá cao', 'khách chê giá cao, anh đổi chương trình khác', // lượt 2 của PS-D05
    'Khách đã cọc', 'Phòng có khách cọc rồi', 'phòng có khách cọc rồi', 'phòng có khách thuê rồi', // PS-D04, PS-DJ3 (người dùng nêu ngay lượt 1)
    'hết chương trình', 'Hết hạn', 'Hết thời gian áp dụng ưu đãi', 'đổi chương trình khác', 'nhập sai nội dung', 'sai giá', 'trùng chương trình',
    'không có lý do', 'không cần lý do', 'chủ nhà yêu cầu', 'chủ nhà không cho giảm nữa', 'chị Mai yêu cầu', 'theo yêu cầu của anh Minh', 'sếp bảo dừng',
    'phòng 105 đã kín', 'đủ khách rồi', 'test', 'full',
  ]) assert.equal(restatesStopCommand(reason), false, reason);
});

test('cụm đi liền nhau đều được bỏ ("chương trình ưu đãi", "tạm ngưng chương trình khuyến mãi"); chữ thật bên trong không bị nuốt theo', () => {
  assert.equal(restatesStopCommand('chương trình ưu đãi khuyến mãi chính sách'), true);
  assert.equal(restatesStopCommand('tạm ngưng chương trình khuyến mãi theo đề nghị'), true);
  // "ưu đãi" bị bỏ nhưng "quá thấp" còn ⇒ là lý do; chữ dính liền ("ngungchuongtrinh") không phải cụm ⇒ không đoán, cho sang bản xem trước.
  assert.equal(restatesStopCommand('ưu đãi quá thấp'), false);
  assert.equal(restatesStopCommand('ngungchuongtrinh'), false);
});

test('lượt không token: reason nhắc lại lệnh ⇒ needs_input reason_required (không token); reason khác ⇒ bản xem trước nguyên văn + token 10 phút', () => {
  const { guard } = setup();
  const asked = guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel('Ngưng chương trình ưu đãi'), undefined, undefined);
  assert.deepEqual(Object.keys(asked), ['confirmation']);
  assert.deepEqual(Object.keys(asked.confirmation), ['outcome', 'applied', 'tool', 'policyId', 'reason', 'detail', 'huongDan']);
  assert.deepEqual([asked.confirmation.outcome, asked.confirmation.applied, asked.confirmation.tool, asked.confirmation.policyId, asked.confirmation.reason],
    ['needs_input', false, POLICY_CANCEL_TOOL, POLICY, 'reason_required']);
  assert.match(asked.confirmation.detail, /chỉ nhắc lại lệnh dừng, chưa nói VÌ SAO/);
  assert.match(asked.confirmation.huongDan, /^CHƯA dừng\. Hỏi người dùng vì sao dừng chương trình rồi gọi lại với reason = nguyên văn câu họ trả lời; không tự đặt lý do, không ghi "theo yêu cầu"\./);
  assert.doesNotMatch(JSON.stringify(asked), /cf_/, 'không cấp token cho reason chưa có lý do');
  const said = 'khách chê giá cao, anh đổi chương trình khác';
  const preview = guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), undefined, undefined).confirmation;
  assert.deepEqual(Object.keys(preview), ['outcome', 'applied', 'tool', 'policyId', 'preview', 'confirmToken', 'expiresAt', 'huongDan']);
  assert.deepEqual([preview.outcome, preview.applied, preview.tool, preview.policyId, preview.preview], ['confirmation_required', false, POLICY_CANCEL_TOOL, POLICY, { reason: said }]);
  assert.match(preview.confirmToken, CF);
  assert.equal(preview.expiresAt, new Date(START + CONFIRM_TTL_MS).toISOString());
  assert.match(preview.huongDan, /^CHƯA dừng\. reason trong preview sẽ lưu làm lý do dừng và phải là lời NGƯỜI DÙNG đã nói; họ chưa nói vì sao dừng ⇒ hỏi họ, không dùng token này\./);
  assert.match(preview.huongDan, /chờ họ đồng ý rõ ở tin SAU; khi đó gọi lại đúng lệnh này \(giữ requestId, y nguyên input\) kèm confirmToken và consentText = NGUYÊN VĂN câu đồng ý đó \(câu yêu cầu ban đầu không phải lời đồng ý\)/);
  // consentText ở lượt không token không đổi gì (chỉ lượt kèm token mới đọc).
  assert.equal(guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), undefined, 'ok').confirmation.outcome, 'confirmation_required');
});

test('PS-D05 lớp 3: lượt kèm token mà consentText không phải lời đồng ý rõ ⇒ consent_unclear, token CHƯA tiêu; câu yêu cầu ban đầu không tự xác nhận được', () => {
  const { guard } = setup(), made = 'Hết thời gian áp dụng ưu đãi';
  // Lý do bịa mà "có nghĩa" qua lớp 1 (bản ghi sai đổi khác đi một chút) ⇒ bản xem trước; tự xác nhận NGAY trong lượt ra lệnh không qua lớp 3.
  const token = guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(made), undefined, undefined).confirmation.confirmToken;
  for (const consentText of [undefined, 'Ngưng chương trình ưu đãi phòng 105 toà 1392QT giúp anh', 'khách chê giá cao, anh đổi chương trình khác',
    'ok nhưng khoan đã', 'dừng hả?', 'x'.repeat(301)]) {
    const held = guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(made), token, consentText);
    assert.deepEqual(Object.keys(held), ['confirmation'], String(consentText));
    assert.deepEqual([held.confirmation.outcome, held.confirmation.applied, held.confirmation.reason, held.confirmation.detail],
      ['needs_input', false, 'consent_unclear', CONSENT_UNCLEAR_PREVIEW_DETAIL], String(consentText));
    assert.match(held.confirmation.huongDan, /^CHƯA dừng; token xác nhận chưa dùng, còn hạn thì dùng lại được\./);
    assert.doesNotMatch(JSON.stringify(held), /cf_/);
  }
  // Người dùng đọc bản xem trước rồi đáp "ok" ⇒ cùng token mở đúng một lần; câu đồng ý trả về cho sổ audit (một dòng).
  assert.deepEqual(guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(made), token, 'Ok em,\nngưng đi'), { allow: true, consent: 'Ok em, ngưng đi' });
  assert.deepEqual(guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(made), token, 'ok'), { refused: true }, 'dùng một lần');
});

test('token chỉ mở đúng một lượt với y nguyên input trên cùng kết nối; lệch reason / policy / version / requestId / kết nối, dùng lại, hết hạn ⇒ refused', () => {
  const said = 'khách chê giá cao';
  const fresh = () => { const env = setup(); return { ...env, token: env.guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), undefined, undefined).confirmation.confirmToken }; };
  const ok = fresh();
  assert.deepEqual(ok.guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), ok.token, 'ok'), { allow: true, consent: 'ok' });
  assert.deepEqual(ok.guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), ok.token, 'ok'), { refused: true }, 'dùng một lần');
  for (const [label, connection, input] of [
    ['reason khác (lý do người dùng nói sau khi bot đã xin token cho lý do tự đặt)', CONNECTION, cancel('khách chê giá cao, anh đổi chương trình khác')],
    ['reason khác hoa thường', CONNECTION, cancel('Khách chê giá cao')],
    ['chương trình khác', CONNECTION, cancel(said, { policyId: OTHER_POLICY })],
    ['version khác', CONNECTION, cancel(said, { expectedVersion: 2 })],
    ['requestId khác', CONNECTION, cancel(said, { requestId: id('2') })],
    ['kết nối khác', OTHER_CONNECTION, cancel(said)],
  ]) {
    const env = fresh();
    assert.deepEqual(env.guard.review(connection, POLICY_CANCEL_TOOL, input, env.token, 'ok'), { refused: true }, label);
    // Trình ra là tiêu (confirm-guard.mjs): token lệch không quay lại dùng cho nội dung đúng được.
    assert.deepEqual(env.guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), env.token, 'ok'), { refused: true }, `${label}: đã tiêu`);
  }
  const late = fresh(); late.clock.now = START + CONFIRM_TTL_MS + 1;
  assert.deepEqual(late.guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), late.token, 'ok'), { refused: true }, 'hết hạn');
  const edge = fresh(); edge.clock.now = START + CONFIRM_TTL_MS - 1;
  assert.deepEqual(edge.guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), edge.token, 'đồng ý'), { allow: true, consent: 'đồng ý' }, 'còn hạn');
  // Token của rào khác / bịa đúng khuôn / sổ khác ⇒ không mở.
  const other = fresh(), forged = fresh();
  assert.deepEqual(forged.guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), `cf_${'x'.repeat(43)}`, 'ok'), { refused: true });
  assert.deepEqual(forged.guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), other.token, 'ok'), { refused: true }, 'token của tiến trình / sổ khác');
});

test('reason nhắc lại lệnh kèm token vẫn là câu hỏi vì sao và không tiêu token của lý do thật', () => {
  const { guard } = setup(), said = 'khách chê giá cao';
  const token = guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), undefined, undefined).confirmation.confirmToken;
  const swapped = guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel('Ngưng chương trình ưu đãi theo yêu cầu'), token, 'ok');
  assert.deepEqual([swapped.confirmation?.outcome, swapped.confirmation?.reason, swapped.allow, swapped.refused], ['needs_input', 'reason_required', undefined, undefined]);
  assert.deepEqual(guard.review(CONNECTION, POLICY_CANCEL_TOOL, cancel(said), token, 'ok'), { allow: true, consent: 'ok' });
});

test('chỉ rào đúng tool dừng chương trình: tool khác cho qua, không tách trường của tool khác; tách confirmToken + consentText trước validator; khai sai đồng hồ ⇒ không khởi động', () => {
  const { guard } = setup();
  for (const name of SALE_POLICY_TOOLS.map(tool => tool.name).filter(name => name !== POLICY_CANCEL_TOOL).concat(['crm_sale_room_patch', 'crm_action_run', 'toString']))
    assert.deepEqual(guard.review(CONNECTION, name, cancel('Ngưng chương trình ưu đãi'), undefined, undefined), { allow: true }, name);
  assert.equal(splitPolicyCancelFields('crm_sale_policy_save', { confirmToken: `cf_${'x'.repeat(43)}`, consentText: 'ok' }), undefined);
  const token = `cf_${'x'.repeat(43)}`, split = splitPolicyCancelFields(POLICY_CANCEL_TOOL, { ...cancel('khách chê giá cao'), confirmToken: token, consentText: 'ok' });
  assert.deepEqual([split.confirmToken, split.consentText, split.invalid, split.args], [token, 'ok', false, cancel('khách chê giá cao')]);
  assert.deepEqual(salePolicyInput('cancel', split.args), cancel('khách chê giá cao'), 'validator không bao giờ thấy confirmToken / consentText');
  for (const extra of [{ confirmToken: token }, { consentText: 'ok' }])
    assert.throws(() => salePolicyInput('cancel', { ...cancel('khách chê giá cao'), ...extra }), /invalid_sale_policy/);
  // Vắng / null / trống = không gửi; sai kiểu, quá trần phong bì, accessor ⇒ invalid (broker trả invalid_request trước mọi I/O).
  for (const consentText of [null, ''])
    assert.deepEqual(splitPolicyCancelFields(POLICY_CANCEL_TOOL, { ...cancel('x'), consentText }), { args: cancel('x'), confirmToken: undefined, consentText: undefined, invalid: false });
  for (const args of [{ ...cancel('x'), confirmToken: 42 }, { ...cancel('x'), consentText: 42 }, { ...cancel('x'), consentText: 'o'.repeat(4001) },
    Object.defineProperty({ ...cancel('x') }, 'consentText', { enumerable: true, get() { throw Error('getter must not execute'); } })])
    assert.equal(splitPolicyCancelFields(POLICY_CANCEL_TOOL, args).invalid, true);
  for (const clock of [undefined, null, 0, START]) assert.throws(() => createPolicyCancelGuard({ clock }), /invalid_policy_cancel_clock/);
  // Khuôn tool khớp rào: tool dừng chương trình nhận confirmToken + consentText (tuỳ chọn), reason vẫn bắt buộc và mô tả nói rõ là lời người dùng.
  const tool = SALE_POLICY_TOOLS.find(item => item.name === POLICY_CANCEL_TOOL);
  assert.deepEqual(tool.inputSchema.required, ['requestId', 'policyId', 'expectedVersion', 'reason']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['requestId', 'policyId', 'expectedVersion', 'reason', 'confirmToken', 'consentText']);
  assert.equal(tool.inputSchema.properties.confirmToken.type, 'string');
  assert.match(tool.inputSchema.properties.consentText.description, /NGUYÊN VĂN câu người dùng vừa đáp đồng ý/);
  assert.match(tool.description, /reason = lời người dùng nói VÌ SAO dừng; họ chưa nói ⇒ hỏi trước, không tự đặt\. Luôn xem trước: người dùng đồng ý rõ ở tin sau/);
  assert.equal(POLICY_CANCEL_AUDIT_ACTION, 'sale.policy_cancel');
});
