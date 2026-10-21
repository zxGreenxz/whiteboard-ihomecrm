// Lõi chạy thao tác ghi dùng chung (Đợt 1 nền chung, docs/plans/hermes-crm/NEN-CHUNG-THAO-TAC-GHI.md mục 3). Broker chỉ
// móc ba điểm (định nghĩa tool, tool được liệt kê, một nhánh callTool); mọi quyết định của vòng đời nằm ở đây:
//   lượt 1 (không confirmToken): thao tác lạ / params sai ⇒ KẾT QUẢ needs_input (không phải lỗi: rào 3 lần của Hermes);
//     money/irreversible ⇒ luôn xem trước (sàn D2, cấu hình không nới được); reversible ⇒ 'auto' (SQL theo chính sách DB:
//     ghi thẳng hoặc trả bản xem trước). requestId do connector cấp nếu mô hình không gửi (bớt một lời gọi
//     crm_new_request_id). Có bản xem trước ⇒ cấp confirmToken gắn [kết nối, thao tác, params chuẩn hoá, requestId];
//     bản ghi chờ giữ đầu vào ĐÃ GIẢI + basis (mô hình không gửi lại nên không giả được).
//   lượt 2 (confirmToken + requestId): token sai/hết hạn/đã dùng/lệch nội dung ⇒ confirmation_invalid; khớp ⇒ phase 'apply'
//     gửi đúng bản đã giải + expectedBasis xuống SQL (không giải tên lần hai); SQL tính lại basis, lệch ⇒ state_changed.
//   Mất phản hồi sau khi gửi lệnh ghi ⇒ action_outcome_unknown + requestId (broker), mô hình tra crm_action_status.
// Cổng dịch vụ (service) là adapter SQL (Mốc 6): prepareAction(token, request, {signal}) ⇒ biên nhận rỗng đông cứng;
// finalizeAction(token, receipt, {signal, onDispatch, onRejected}) ⇒ outcome (khuôn kiểm ở dưới).
import { randomUUID } from 'node:crypto';
import { BrokerError, actionRejected } from './broker.mjs';
import { canonicalJson, validateActionParams } from './action-catalog.mjs';
import { ACTION_INPUT_REASONS, ACTION_REASONS, ACTION_REJECT_REASONS } from './action-reasons.mjs';
import { ACTION_TOOL_SHAPE, NAME_FIELDS, NAME_WHYS, actionEnvelope, actionToolRoute, actionTools, confirmationRequired, listedActionTools,
  nameUnresolvedDetail, needsInput } from './action-contract.mjs';
import { confirmBinding, createConfirmStore, splitConfirmField } from './confirm-guard.mjs';

const fail = code => { throw new BrokerError(code); };
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

export function createActionRuntime({ catalog, service, clock = Date.now, shape = ACTION_TOOL_SHAPE, mintRequestId = randomUUID } = {}) {
  if (!catalog || typeof catalog.get !== 'function' || ['prepareAction', 'finalizeAction'].some(key => typeof service?.[key] !== 'function') ||
      typeof clock !== 'function' || typeof mintRequestId !== 'function') throw new TypeError('invalid_action_runtime');
  const definitions = Object.freeze(actionTools(catalog, shape));
  const confirms = createConfirmStore({ clock });
  const binding = (connectionId, action, params, requestId) => confirmBinding([connectionId, action, canonicalJson(params), requestId]);
  const mint = () => { const value = mintRequestId(); if (typeof value !== 'string' || !UUID.test(value)) fail('backend_unavailable'); return value; };

  function needsFromOutcome(plan, outcome) {
    if (!exact(outcome, ['kind', 'reason'], ['field', 'wanted', 'why', 'candidates', 'more']) || !ACTION_INPUT_REASONS.includes(outcome.reason)) fail('backend_unavailable');
    if (outcome.reason !== 'name_unresolved') return needsInput({ action: plan.action, reason: outcome.reason });
    // Khuôn kết quả "unresolved" của hermes_write_name_resolve_v1 (field, wanted, why, candidates ≤ 8, more).
    if (!NAME_FIELDS.includes(outcome.field) || !shortText(outcome.wanted, 200) || !(outcome.why === undefined || NAME_WHYS.includes(outcome.why)) ||
        !candidatesOf(outcome.candidates ?? []) || !(outcome.more === undefined || typeof outcome.more === 'boolean')) fail('backend_unavailable');
    const candidates = outcome.candidates ?? [];
    return needsInput({ action: plan.action, reason: 'name_unresolved', candidates,
      detail: nameUnresolvedDetail({ field: outcome.field, wanted: outcome.wanted, why: outcome.why, candidates, more: outcome.more === true }) });
  }

  return Object.freeze({
    definitions,
    listed: effective => listedActionTools(catalog, effective, shape),
    route: name => actionToolRoute(name, catalog, shape),
    /** Đồng bộ, trước admission: tách confirmToken (chỉ ở run) và kiểm phong bì. Không đọc gì của CRM. */
    begin(route, args) {
      const plan = { op: route.op, invalid: false, tokenInvalid: false, confirmToken: undefined, uncertain: false, immediate: null };
      let rest = args;
      if (route.op === 'run') {
        const split = splitConfirmField(args);
        rest = split.args; plan.confirmToken = split.confirmToken; plan.tokenInvalid = split.invalid;
      }
      try { Object.assign(plan, actionEnvelope(route, rest)); } catch { plan.invalid = true; }
      return plan;
    },
    /** handler của broker.invoke: trả biên nhận đông cứng (hoặc kết quả cuối với list). */
    async handle(plan, token, identity, signal) {
      if (!catalog.any(identity.effective)) fail('tool_not_available');
      if (plan.invalid) fail('invalid_request');
      if (plan.tokenInvalid) fail('confirmation_invalid');
      if (plan.op === 'list') return content({ organizationId: identity.row.organizationId, fetchedAt: new Date(clock()).toISOString(),
        items: catalog.listing(identity.effective, plan.page) });
      if (plan.op === 'status') {
        const receipt = await service.prepareAction(token, Object.freeze({ op: 'status', requestId: plan.requestId }), { signal });
        if (!emptyReceipt(receipt)) fail('backend_unavailable');
        return receipt;
      }
      const action = catalog.get(plan.action);
      if (action === null) { plan.immediate = needsInput({ action: plan.action, reason: 'unknown_action' }); return Object.freeze({}); }
      if (!catalog.granted(identity.effective, action.id)) throw actionRejected('action_disabled');
      const checked = validateActionParams(action, plan.params);
      if (!checked.ok) { plan.immediate = needsInput({ action: action.id, reason: 'invalid_params', detail: checked.detail }); return Object.freeze({}); }
      plan.params = checked.value; plan.class = action.class;
      let request;
      if (plan.confirmToken !== undefined) {
        if (plan.requestId === undefined) fail('confirmation_invalid');
        const redeemed = confirms.redeem(plan.confirmToken, binding(identity.row.id, action.id, plan.params, plan.requestId));
        if (!redeemed.ok) fail('confirmation_invalid');
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
      // Đã nhận đủ một phản hồi: kết cục đã biết, không còn bất định (kể cả khi dưới đây ném action_rejected).
      plan.uncertain = false;
      if (!data(outcome) || typeof outcome.kind !== 'string') fail('backend_unavailable');
      if (plan.op === 'status') {
        if (outcome.kind !== 'status' || !exact(outcome, ['kind', 'outcome'], ['action', 'result', 'reason']) ||
            !['applied', 'rejected', 'not_found', 'unknown'].includes(outcome.outcome)) fail('backend_unavailable');
        const reason = outcome.outcome === 'rejected' ? (ACTION_REJECT_REASONS.includes(outcome.reason) || ACTION_INPUT_REASONS.includes(outcome.reason) ? outcome.reason : 'crm_refused') : null;
        return content({ requestId: plan.requestId, outcome: outcome.outcome, ...(typeof outcome.action === 'string' ? { action: outcome.action } : {}),
          ...(outcome.outcome === 'applied' && data(outcome.result) ? { result: outcome.result } : {}),
          ...(reason ? { reason, detail: ACTION_REASONS[reason].text } : {}) });
      }
      if (outcome.kind === 'needs_input') return content(needsFromOutcome(plan, outcome));
      if (outcome.kind === 'rejected') {
        if (!exact(outcome, ['kind', 'reason'])) fail('backend_unavailable');
        // Lý do dạng needs_input từ SQL (vd thiếu lý do lúc ghi) vẫn là kết quả thường, không phải lỗi.
        if (ACTION_INPUT_REASONS.includes(outcome.reason) && outcome.reason !== 'name_unresolved') return content(needsInput({ action: plan.action, reason: outcome.reason }));
        throw actionRejected(outcome.reason);
      }
      if (outcome.kind === 'preview') {
        if (plan.phase === 'apply' || !exact(outcome, ['kind', 'preview', 'basis', 'resolved', 'confirm'], ['warnings']) || !data(outcome.preview) ||
            !shortText(outcome.basis, 128) || !data(outcome.resolved) || !['required', 'not_required'].includes(outcome.confirm) ||
            !(outcome.warnings === undefined || (Array.isArray(outcome.warnings) && outcome.warnings.length <= 10 && outcome.warnings.every(item => shortText(item, 300))))) fail('backend_unavailable');
        // 'auto' chỉ trả bản xem trước khi cần xác nhận (không cần thì SQL đã ghi và trả applied).
        if (plan.phase === 'auto' && outcome.confirm !== 'required') fail('backend_unavailable');
        const issued = confirms.issue(binding(identity.row.id, plan.action, plan.params, plan.requestId),
          { resolved: structuredClone(outcome.resolved), basis: outcome.basis });
        return content(confirmationRequired({ action: plan.action, requestId: plan.requestId, preview: outcome.preview, warnings: outcome.warnings ?? [],
          confirmToken: issued.token, expiresAt: issued.expiresAt }));
      }
      if (outcome.kind === 'applied') {
        if (plan.phase === 'preview' || !exact(outcome, ['kind', 'result'], ['link']) || !data(outcome.result) ||
            !(outcome.link === undefined || outcome.link === null || (shortText(outcome.link, 300) && outcome.link.startsWith('/')))) fail('backend_unavailable');
        return content({ outcome: 'applied', applied: true, action: plan.action, requestId: plan.requestId, result: outcome.result, link: outcome.link ?? null });
      }
      fail('backend_unavailable');
    },
    context: plan => plan.op === 'list' ? {} : { mutationUncertain: () => plan.uncertain, mutationCode: 'action_outcome_unknown', mutationRequestId: () => plan.requestId },
  });
}
