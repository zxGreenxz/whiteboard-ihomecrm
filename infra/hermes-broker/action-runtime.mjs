// Lõi chạy thao tác ghi dùng chung (Đợt 1 nền chung, docs/plans/hermes-crm/NEN-CHUNG-THAO-TAC-GHI.md mục 3). Broker chỉ
// móc ba điểm (định nghĩa tool, tool được liệt kê, một nhánh callTool); mọi quyết định của vòng đời nằm ở đây:
//   lượt 1 (không confirmToken): thao tác lạ / params sai ⇒ KẾT QUẢ needs_input (không phải lỗi: rào 3 lần của Hermes);
//     money/irreversible ⇒ luôn xem trước (sàn D2, cấu hình không nới được); reversible ⇒ 'auto' (SQL theo chính sách DB:
//     ghi thẳng hoặc trả bản xem trước). requestId do connector cấp nếu mô hình không gửi (bớt một lời gọi
//     crm_new_request_id). Có bản xem trước ⇒ cấp confirmToken gắn [kết nối, thao tác, params chuẩn hoá, requestId];
//     bản ghi chờ giữ đầu vào ĐÃ GIẢI + basis (mô hình không gửi lại nên không giả được).
//   lượt 2 (confirmToken; requestId lấy theo bản ghi của token — lượt 16, mô hình chép sai / thiếu thì audit ghi requestIdFix): token sai /
//     hết hạn / đã dùng / lệch nội dung / của kết nối hay thao tác khác ⇒ confirmation_invalid; khớp ⇒ phase 'apply'
//     gửi đúng bản đã giải + expectedBasis xuống SQL (không giải tên lần hai); SQL tính lại basis, lệch ⇒ state_changed.
//   Mất phản hồi sau khi gửi lệnh ghi ⇒ action_outcome_unknown + requestId (broker), mô hình tra crm_action_status. Cờ "chưa
//     rõ" chỉ tắt khi phản hồi ĐỦ KHUÔN (mục 12.1): lệnh ghi đã gửi mà phản hồi lệch khuôn vẫn là action_outcome_unknown, không
//     bao giờ là lỗi chung (mô hình sẽ gọi lại với requestId mới ⇒ ghi trùng). Kết cục applied (đã ghi) KHÔNG tắt cờ: lỗi của
//     broker sau finalize (quá cỡ, hết giờ) vẫn ra action_outcome_unknown + requestId.
// Cổng dịch vụ (service) là adapter SQL (Mốc 6): prepareAction(token, request, {signal}) ⇒ biên nhận rỗng đông cứng;
// finalizeAction(token, receipt, {signal, onDispatch, onRejected}) ⇒ outcome (khuôn kiểm ở dưới).
import { randomUUID } from 'node:crypto';
import { BrokerError, actionFacts, actionItem, actionRejected, itemDetail, ACTION_WEB_LINK } from './broker.mjs';
import { ACTION_ID, canonicalJson, validateActionParams } from './action-catalog.mjs';
import { ACTION_INPUT_REASONS, ACTION_REASONS, ACTION_REJECT_REASONS } from './action-reasons.mjs';
import { ACTION_TOOL_SHAPE, CONFIRM_INVALID_DETAILS, NAME_FIELDS, NAME_WHYS, RequestIdShapeError, actionEnvelope, actionToolRoute, actionTools,
  confirmationRequired, listedActionTools, nameUnresolvedDetail, needsInput, requestIdShapeDetail } from './action-contract.mjs';
import { confirmBinding, createConfirmStore, splitConfirmField } from './confirm-guard.mjs';
import { consentAuditText, consentClear, consentRequired } from './consent-guard.mjs';

const fail = code => { throw new BrokerError(code); };
// confirmation_invalid kèm câu tĩnh nói phần nào lệch (Thu chi lượt 14; action-contract.mjs CONFIRM_INVALID_DETAILS).
const invalidConfirm = why => { const error = new BrokerError('confirmation_invalid'); error.detail = CONFIRM_INVALID_DETAILS[why]; throw error; };
// invalid_request kèm câu tĩnh khi biết đúng phần sai (lượt 16: requestId sai khuôn — requestIdShapeDetail); không thì lỗi chung như cũ.
const invalidRequest = detail => { const error = new BrokerError('invalid_request'); if (detail) error.detail = detail; throw error; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const data = value => plain(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' &&
  Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exact = (value, required, optional = []) => data(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const emptyReceipt = value => data(value) && Object.keys(value).length === 0 && Object.isFrozen(value);
const content = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
const shortText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const candidatesOf = value => Array.isArray(value) && value.length <= 8 && value.every(entry => exact(entry, ['name'], ['buildingName']) &&
  shortText(entry.name, 120) && (entry.buildingName === undefined || shortText(entry.buildingName, 120)));
// Kết quả của thao tác ĐÃ GHI lớn hơn mức này ⇒ trả applied gọn (result null, resultOmitted) thay vì để broker từ chối vì quá
// cỡ (trần mặc định 16 384 B) — kết cục "đã ghi" luôn tới được mô hình.
export const APPLIED_RESULT_MAX_BYTES = 8_192;
const fitsApplied = result => Buffer.byteLength(JSON.stringify(result)) <= APPLIED_RESULT_MAX_BYTES;
// Thu chi lượt 14 (nghiệm thu 24/10, TEST): lượt đồng ý gửi lệnh ghi khi trần cả lời gọi (callTimeoutMs) đã gần cạn — xác thực / dựng
// quyền chậm 5,6–8,4 s ⇒ lệnh ghi bị cắt giữa chừng ⇒ action_outcome_unknown dù SQL lùi. Lượt đồng ý chỉ gửi khi còn ít nhất phần này
// của trần (15 s ⇒ 11,25 s: đủ cho kiểm quyền lần hai + statement_timeout 8 s của vai authenticated, để lỗi SQL — 57014 / 55P03, giao dịch
// đã lùi — về trước khi broker tự cắt); không đủ ⇒ timeout TRƯỚC khi đổi token (chưa gửi gì, token còn dùng lại được trong hạn).
export const APPLY_MIN_REMAINING_SHARE = 0.75;

export function createActionRuntime({ catalog, service, clock = Date.now, shape = ACTION_TOOL_SHAPE, mintRequestId = randomUUID, live, permissionGaps,
  applyBudgetMs } = {}) {
  if (!catalog || typeof catalog.get !== 'function' || ['prepareAction', 'finalizeAction'].some(key => typeof service?.[key] !== 'function') ||
      typeof clock !== 'function' || typeof mintRequestId !== 'function' || (live !== undefined && typeof live?.has !== 'function') ||
      (permissionGaps !== undefined && typeof permissionGaps?.lacks !== 'function') ||
      !(applyBudgetMs === undefined || (Number.isSafeInteger(applyBudgetMs) && applyBudgetMs >= 1000 && applyBudgetMs <= 30_000))) throw new TypeError('invalid_action_runtime');
  // applyBudgetMs (lượt 14): trần cả lời gọi của broker; không truyền ⇒ không chặn theo thời gian (như cũ).
  const applyTooLate = plan => applyBudgetMs !== undefined && clock() - plan.startedAt > applyBudgetMs * (1 - APPLY_MIN_REMAINING_SHARE);
  // live (Đợt 2b): danh mục thao tác SỐNG phía SQL (createActionLiveCatalog). Có thì thao tác chỉ được quảng bá / chạy khi SQL đã có
  // dòng của nó (connector mới + DB cũ ⇒ không hiện, không nghỉ hưu tool cũ); không truyền ⇒ như cũ (mọi thao tác của danh mục).
  const alive = id => live === undefined || live.has(id);
  const usable = (effective, id) => catalog.granted(effective, id) && alive(id);
  const anyUsable = effective => catalog.ids.some(id => usable(effective, id));
  const definitions = Object.freeze(actionTools(catalog, shape));
  const confirms = createConfirmStore({ clock });
  const binding = (connectionId, action, params, requestId) => confirmBinding([connectionId, action, canonicalJson(params), requestId]);
  const mint = () => { const value = mintRequestId(); if (typeof value !== 'string' || !UUID.test(value)) fail('backend_unavailable'); return value; };

  function needsFromOutcome(plan, outcome) {
    // item (Công việc Mốc 4, lô task.create_batch): số mục 1–20 của MỤC ĐẦU TIÊN chưa ổn; câu chi tiết nêu "Mục #n: …".
    if (!exact(outcome, ['kind', 'reason'], ['field', 'wanted', 'why', 'candidates', 'more', 'item']) || !ACTION_INPUT_REASONS.includes(outcome.reason) ||
        !(outcome.item === undefined || Number.isSafeInteger(outcome.item) && outcome.item >= 1 && outcome.item <= 20)) fail('backend_unavailable');
    const mark = text => outcome.item === undefined ? text : `Mục #${outcome.item}: ${text}`;
    if (outcome.reason !== 'name_unresolved') {
      return needsInput({ action: plan.action, reason: outcome.reason, ...(outcome.item === undefined ? {} : { detail: mark(ACTION_REASONS[outcome.reason].text) }) });
    }
    // Khuôn kết quả "unresolved" của hermes_write_name_resolve_v1 (field, wanted, why, candidates ≤ 8, more).
    // why unspecified (Công việc, Q31): trường chưa được nêu ⇒ wanted rỗng; mọi why khác phải nhắc lại đúng chuỗi người dùng nói.
    if (!NAME_FIELDS.includes(outcome.field) || !(outcome.why === 'unspecified' ? outcome.wanted === '' : shortText(outcome.wanted, 200)) ||
        !(outcome.why === undefined || NAME_WHYS.includes(outcome.why)) ||
        !candidatesOf(outcome.candidates ?? []) || !(outcome.more === undefined || typeof outcome.more === 'boolean')) fail('backend_unavailable');
    // outside_scope không bao giờ kèm tên (SQL không trả tên ngoài phạm vi được ghi; review #253): bỏ mọi tên nếu có.
    const candidates = outcome.why === 'outside_scope' ? [] : outcome.candidates ?? [];
    return needsInput({ action: plan.action, reason: 'name_unresolved', candidates,
      detail: mark(nameUnresolvedDetail({ field: outcome.field, wanted: outcome.wanted, why: outcome.why, candidates, more: outcome.more === true })) });
  }

  return Object.freeze({
    definitions,
    listed: effective => (anyUsable(effective) ? listedActionTools(catalog, effective, shape) : []),
    route: name => actionToolRoute(name, catalog, shape),
    /** Danh mục có thao tác này (broker dùng để ẩn họ tool cũ mà thao tác thay thế). */
    knows: id => catalog.get(id) !== null && alive(id),
    /** Đồng bộ, trước admission: tách confirmToken (chỉ ở run) và kiểm phong bì. Không đọc gì của CRM. */
    begin(route, args) {
      const plan = { op: route.op, invalid: false, invalidDetail: null, tokenInvalid: false, confirmToken: undefined, uncertain: false, immediate: null,
        startedAt: clock(), consent: null, requestIdFix: null };
      let rest = args;
      if (route.op === 'run') {
        const split = splitConfirmField(args);
        rest = split.args; plan.confirmToken = split.confirmToken; plan.tokenInvalid = split.invalid;
      }
      try { Object.assign(plan, actionEnvelope(route, rest, { confirming: plan.confirmToken !== undefined })); }
      catch (error) { plan.invalid = true; if (error instanceof RequestIdShapeError) plan.invalidDetail = requestIdShapeDetail(error.length); }
      return plan;
    },
    /** handler của broker.invoke: trả biên nhận đông cứng (hoặc kết quả cuối với list). */
    async handle(plan, token, identity, signal) {
      if (!anyUsable(identity.effective)) fail('tool_not_available');
      if (plan.invalid) invalidRequest(plan.invalidDetail);
      if (plan.tokenInvalid) invalidConfirm('unknown');
      if (plan.op === 'list') {
        // Lượt 14 Hoá đơn (nghiệm thu C3c): thao tác ẩn vì người dùng THIẾU QUYỀN CRM (cùng điều kiện forbidden của crm_action_run) vào
        // notPermitted gọn, không params ⇒ bot nói "anh/chị chưa có quyền …", khác thao tác chưa có trên bot. Khoá chưa bật ⇒ vẫn không nêu.
        const notPermitted = catalog.ids.map(catalog.get).filter(action => (plan.page === null || action.page === plan.page) && alive(action.id) &&
          !usable(identity.effective, action.id) && permissionGaps?.lacks(identity.contextVersion, action.key) === true)
          .map(action => ({ action: action.id, title: action.title, reason: 'forbidden' }));
        return content({ organizationId: identity.row.organizationId, fetchedAt: new Date(clock()).toISOString(),
          items: catalog.listing(identity.effective, plan.page).filter(item => alive(item.action)), ...(notPermitted.length ? { notPermitted } : {}) });
      }
      if (plan.op === 'status') {
        const receipt = await service.prepareAction(token, Object.freeze({ op: 'status', requestId: plan.requestId }), { signal });
        if (!emptyReceipt(receipt)) fail('backend_unavailable');
        return receipt;
      }
      const action = catalog.get(plan.action);
      // Mã lạ: chỉ nhắc lại khi đúng mẫu mã thao tác (không phản chiếu chuỗi tuỳ ý của mô hình).
      if (action === null) { plan.immediate = needsInput({ action: ACTION_ID.test(plan.action) ? plan.action : null, reason: 'unknown_action' }); return Object.freeze({}); }
      // Lượt 11 (nghiệm thu 24/10): khoá đã bật cho kết nối + công ty mà người dùng thiếu quyền CRM ⇒ forbidden ("anh/chị chưa có quyền
      // …"); còn lại (khoá chưa bật, SQL chưa có dòng của thao tác, không có ảnh chụp) ⇒ action_disabled như trước.
      if (!usable(identity.effective, action.id))
        throw actionRejected(alive(action.id) && permissionGaps?.lacks(identity.contextVersion, action.key) === true ? 'forbidden' : 'action_disabled');
      const checked = validateActionParams(action, plan.params);
      // Lượt 13 Công việc: danh sách khai overflow dài quá ⇒ lý do riêng (vd batch_too_large "chia lô") kèm số mục đã gửi, không phải
      // invalid_params chung (mô hình đọc thành "thiếu tham số" rồi thử lại y như cũ).
      if (!checked.ok) {
        const over = checked.overflow;
        plan.immediate = over ? needsInput({ action: action.id, reason: over.reason,
          detail: `${ACTION_REASONS[over.reason].text} Đã gửi ${over.count} mục ở ${over.path} (tối đa ${over.max}).` })
          : needsInput({ action: action.id, reason: 'invalid_params', detail: checked.detail });
        return Object.freeze({});
      }
      plan.params = checked.value; plan.class = action.class;
      let request;
      if (plan.confirmToken !== undefined) {
        // Lượt 12 Hợp đồng (rào đồng ý, consent-guard.mjs): thao tác không lùi được chỉ đổi token khi consentText là lời đồng ý rõ của người
        // dùng; không thì needs_input consent_unclear TRƯỚC khi đổi token (người dùng đáp "ok" thì token còn hạn vẫn dùng được). Câu đã qua
        // rào vào sổ audit của host cùng dòng prepared của lượt ghi.
        const consenting = consentRequired(action);
        if (consenting && !consentClear(plan.consentText)) { plan.immediate = needsInput({ action: action.id, reason: 'consent_unclear' }); return Object.freeze({}); }
        if (applyTooLate(plan)) fail('timeout');
        // Thu chi lượt 16 (nghiệm thu C3d: bot chép requestId thiếu một ký tự ⇒ invalid_request, rồi tra trạng thái bằng mã sai): requestId của
        // lượt xác nhận lấy theo bản ghi của token. Khoá vẫn là [kết nối, thao tác, params chuẩn hoá, requestId lúc cấp] — token của kết nối /
        // thao tác / params khác vẫn lệch như trước; chỉ requestId mô hình chép (thiếu, sai khuôn, khác) không còn làm hỏng lượt đồng ý. Lệch ⇒
        // dùng requestId của token và ghi requestIdFix vào dòng audit prepared.
        const redeemed = confirms.redeem(plan.confirmToken, payload => binding(identity.row.id, action.id, plan.params, payload?.requestId));
        if (!redeemed.ok) invalidConfirm(redeemed.why === 'expired' ? 'expired' : redeemed.why !== 'mismatch' || redeemed.payload?.action !== action.id ? 'unknown'
          : redeemed.payload?.params !== canonicalJson(plan.params) ? 'params' : 'unknown');
        const issuedRequestId = redeemed.payload?.requestId;
        if (typeof issuedRequestId !== 'string' || !UUID.test(issuedRequestId)) invalidConfirm('unknown');
        if (plan.requestId !== issuedRequestId) plan.requestIdFix = Object.freeze({ action: action.id, requestId: issuedRequestId,
          supplied: plan.requestId !== undefined ? 'different' : plan.requestIdMalformed ? 'malformed' : 'missing' });
        plan.requestId = issuedRequestId;
        if (consenting) plan.consent = Object.freeze({ action: action.id, requestId: plan.requestId, text: consentAuditText(plan.consentText) });
        plan.phase = 'apply';
        request = { op: 'run', action: action.id, phase: 'apply', requestId: plan.requestId, params: plan.params,
          resolved: redeemed.payload.resolved, basis: redeemed.payload.basis };
      } else {
        plan.requestId ??= mint();
        plan.phase = action.class === 'reversible' ? 'auto' : 'preview';
        request = { op: 'run', action: action.id, phase: plan.phase, requestId: plan.requestId, params: plan.params };
      }
      const receipt = await service.prepareAction(token, Object.freeze(request), { signal });
      if (!emptyReceipt(receipt)) fail('backend_unavailable');
      return receipt;
    },
    /** finalize của broker.invoke: lời gọi cổng dịch vụ là await cuối; dựng kết quả cho mô hình. */
    async finish(plan, token, receipt, identity, signal) {
      if (plan.immediate) return content(plan.immediate);
      const outcome = await service.finalizeAction(token, receipt, { signal,
        onDispatch() { plan.uncertain = true; }, onRejected() { plan.uncertain = false; } });
      // Cờ "chưa rõ" chỉ tắt khi phản hồi đủ khuôn (known / rejected dưới đây). Lệnh ghi đã gửi mà khuôn lệch giữ cờ ⇒ broker
      // trả action_outcome_unknown + requestId, không phải backend_unavailable (mô hình sẽ gọi lại với requestId mới ⇒ ghi trùng).
      const known = value => { plan.uncertain = false; return value; };
      const rejected = (reason, ...extras) => { plan.uncertain = false; return actionRejected(reason, ...extras); };
      if (!data(outcome) || typeof outcome.kind !== 'string') fail('backend_unavailable');
      if (plan.op === 'status') {
        if (outcome.kind !== 'status' || !exact(outcome, ['kind', 'outcome'], ['action', 'result', 'reason']) ||
            !['applied', 'rejected', 'not_found', 'unknown'].includes(outcome.outcome)) fail('backend_unavailable');
        const reason = outcome.outcome === 'rejected' ? (ACTION_REJECT_REASONS.includes(outcome.reason) || ACTION_INPUT_REASONS.includes(outcome.reason) ? outcome.reason : 'crm_refused') : null;
        return known(content({ requestId: plan.requestId, outcome: outcome.outcome, ...(typeof outcome.action === 'string' ? { action: outcome.action } : {}),
          ...(outcome.outcome === 'applied' && data(outcome.result) ? fitsApplied(outcome.result) ? { result: outcome.result } : { resultOmitted: true } : {}),
          ...(reason ? { reason, detail: ACTION_REASONS[reason].text } : {}) }));
      }
      if (outcome.kind === 'needs_input') return known(content(needsFromOutcome(plan, outcome)));
      if (outcome.kind === 'rejected') {
        // CV12 (Công việc Mốc 3): từ chối có thể kèm link web tới đúng đối tượng; item: khoản số mấy của lô bị từ chối (Thu chi Mốc 4)
        // — số nguyên 1–20, không bao giờ chuỗi tự do; facts (lượt 14 Hoá đơn): dữ kiện của đúng mã theo khuôn đóng (actionFacts). Sai khuôn
        // ⇒ khuôn lệch.
        if (!exact(outcome, ['kind', 'reason'], ['link', 'item', 'facts'])
          || !(outcome.link === undefined || (typeof outcome.link === 'string' && ACTION_WEB_LINK.test(outcome.link)))
          || !(outcome.item === undefined || actionItem(outcome.item))
          || !(outcome.facts === undefined || actionFacts(outcome.reason, outcome.facts) !== undefined)) fail('backend_unavailable');
        // Lý do dạng needs_input từ SQL (vd thiếu lý do lúc ghi) vẫn là kết quả thường, không phải lỗi.
        if (ACTION_INPUT_REASONS.includes(outcome.reason) && outcome.reason !== 'name_unresolved') return known(content(needsInput({ action: plan.action, reason: outcome.reason,
          detail: outcome.item === undefined ? undefined : itemDetail(outcome.item, ACTION_REASONS[outcome.reason].text) })));
        throw rejected(outcome.reason, outcome.item, outcome.link, outcome.facts);
      }
      if (outcome.kind === 'preview') {
        if (plan.phase === 'apply' || !exact(outcome, ['kind', 'preview', 'basis', 'resolved', 'confirm'], ['warnings']) || !data(outcome.preview) ||
            !shortText(outcome.basis, 128) || !data(outcome.resolved) || !['required', 'not_required'].includes(outcome.confirm) ||
            !(outcome.warnings === undefined || (Array.isArray(outcome.warnings) && outcome.warnings.length <= 10 && outcome.warnings.every(item => shortText(item, 300))))) fail('backend_unavailable');
        // 'auto' chỉ trả bản xem trước khi cần xác nhận (không cần thì SQL đã ghi và trả applied).
        if (plan.phase === 'auto' && outcome.confirm !== 'required') fail('backend_unavailable');
        const issued = confirms.issue(binding(identity.row.id, plan.action, plan.params, plan.requestId),
          // requestId / params (lượt 14), action (lượt 16): để nói phần lệch khi token bị trình sai; requestId còn là requestId của lượt xác nhận
          // (lượt 16). Không gửi xuống SQL, không tới mô hình.
          { resolved: structuredClone(outcome.resolved), basis: outcome.basis, requestId: plan.requestId, params: canonicalJson(plan.params), action: plan.action });
        return known(content(confirmationRequired({ action: plan.action, requestId: plan.requestId, preview: outcome.preview, warnings: outcome.warnings ?? [],
          confirmToken: issued.token, expiresAt: issued.expiresAt, consent: consentRequired(catalog.get(plan.action)) })));
      }
      if (outcome.kind === 'applied') {
        if (plan.phase === 'preview' || !exact(outcome, ['kind', 'result'], ['link']) || !data(outcome.result) ||
            !(outcome.link === undefined || outcome.link === null || (shortText(outcome.link, 300) && outcome.link.startsWith('/')))) fail('backend_unavailable');
        // SQL ĐÃ GHI: KHÔNG tắt cờ "chưa rõ" (khác mọi nhánh trên) — broker còn có thể hỏng SAU finalize (quá cỡ, hết giờ đúng
        // lúc trả); khi đó vẫn phải là action_outcome_unknown + requestId để mô hình tra crm_action_status thay vì gọi lại với
        // requestId mới ⇒ ghi trùng (như họ phiếu chi cũ, broker.mjs). Kết quả quá cỡ ⇒ applied gọn.
        const fits = fitsApplied(outcome.result);
        return content({ outcome: 'applied', applied: true, action: plan.action, requestId: plan.requestId, result: fits ? outcome.result : null,
          ...(fits ? {} : { resultOmitted: true }), link: outcome.link ?? null });
      }
      fail('backend_unavailable');
    },
    context: plan => plan.op === 'list' ? {} : { mutationUncertain: () => plan.uncertain, mutationCode: 'action_outcome_unknown', mutationRequestId: () => plan.requestId,
      auditConsent: () => plan.consent, auditRequestIdFix: () => plan.requestIdFix },
  });
}
