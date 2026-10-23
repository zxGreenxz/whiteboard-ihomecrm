// Adapter SQL của thao tác ghi dùng chung (Đợt 1 nền chung, Mốc 6; NEN-CHUNG-THAO-TAC-GHI.md mục 9, 11). Cùng khuôn với
// expense-action-adapter.mjs: transport bound-user-rpc (JWT người dùng, chỉ các tên RPC đã khai), lớp quyền mở rộng
// (capabilities ⇒ khoá Action + phạm vi toà), cổng prepare/finalize của bound-user-operation.
// Chịu được thiếu SQL: hermes_action_capabilities_v1 chưa áp (PGRST202) ⇒ không thêm khoá nào ⇒ họ thao tác ẩn. Chỉ khoá mà
// danh mục của connector biết mới được gộp: SQL có thể khai thao tác (vd probe) mà bản connector này không đăng ký.
import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { domainExact, domainId } from './domain-contract.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { readWithBaseAuthorization } from './authorization-extension.mjs';

const fail = code => { throw new BrokerError(code); };
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const BINDING_KEYS = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
const PHASES = Object.freeze(['preview', 'auto', 'apply']);
const ACTION_RPCS = Object.freeze(['hermes_action_capabilities_v1', 'hermes_action_status_v1']);

/** Kiểm yêu cầu runtime gửi xuống (action-runtime.mjs handle). TypeError ⇒ invalid_request ở bound-user-operation. */
export function actionRequest(catalog, operation, request) {
  const bad = () => { throw new TypeError('invalid_action_request'); };
  if (!plain(request) || request.op !== operation) bad();
  if (operation === 'status') { if (!domainExact(request, ['op', 'requestId']) || !UUID.test(request.requestId)) bad(); return request; }
  if (operation !== 'run') bad();
  const apply = request.phase === 'apply';
  if (!domainExact(request, apply ? ['op', 'action', 'phase', 'requestId', 'params', 'resolved', 'basis'] : ['op', 'action', 'phase', 'requestId', 'params']) ||
      catalog.get(request.action) === null || !PHASES.includes(request.phase) || !UUID.test(request.requestId) || !plain(request.params) ||
      (apply && (!plain(request.resolved) || typeof request.basis !== 'string' || request.basis.length > 128))) bad();
  return request;
}

export function createActionReads({ catalog, ...options } = {}) {
  if (!catalog || !Array.isArray(catalog.rpcs)) throw new TypeError('invalid_action_reads');
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: [...ACTION_RPCS, ...catalog.rpcs] });
  return Object.freeze({
    async capabilities({ accessToken, organizationId }, callOptions) {
      if (!domainId(organizationId)) fail('invalid_request');
      return rpc('hermes_action_capabilities_v1', accessToken, { p_organization_id: organizationId }, callOptions, { optional: true });
    },
    async execute(operation, value, callOptions) {
      if (!domainExact(value, ['accessToken', 'binding', 'input']) || !domainExact(value.binding, BINDING_KEYS) || !domainId(value.binding.connectionId) ||
          !domainId(value.binding.expectedMembershipId) || !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest) ||
          ['expectedEpoch', 'expectedAuthorizationVersion', 'expectedSessionRevision'].some(key => !positive(value.binding[key])) ||
          !(value.binding.expectedPolicyVersion === 0 || positive(value.binding.expectedPolicyVersion))) fail('invalid_request');
      let input; try { input = actionRequest(catalog, operation, value.input); } catch { fail('invalid_request'); }
      if (operation === 'status') return rpc('hermes_action_status_v1', value.accessToken, { p_binding: value.binding, p_request_id: input.requestId }, callOptions, { action: true });
      // preview chỉ đọc; auto/apply có thể ghi ⇒ mất ACK là bất định (không bao giờ tự gọi lại).
      return rpc(catalog.get(input.action).rpc, value.accessToken, { p_binding: value.binding, p_action: input.action, p_phase: input.phase,
        p_request_id: input.requestId, p_params: input.params, p_resolved: input.resolved ?? null, p_expected_basis: input.basis ?? null },
      callOptions, { write: input.phase !== 'preview', action: true });
    },
  });
}

/** Danh mục thao tác SỐNG phía SQL: các dòng của app_private.hermes_action_policies, đọc qua `actions` của
 * hermes_action_capabilities_v1 mỗi lần lớp quyền chạy (Đợt 2b, review Mốc 2 mục 6). Connector mới chạy với DB cũ (chưa có dòng của
 * một thao tác) thì thao tác đó không "sống": runtime không quảng bá nó và broker không nghỉ hưu họ tool cũ mà nó thay. Của cả tiến
 * trình (danh mục SQL là của cả DB, không theo người); chưa đọc được lần nào, hoặc RPC vắng ⇒ không thao tác nào sống. */
export function createActionLiveCatalog() {
  let ids = new Set();
  return Object.freeze({
    observe(actions) { ids = new Set(actions !== null && typeof actions === 'object' && !Array.isArray(actions) ? Object.keys(actions) : []); },
    has: id => ids.has(id),
  });
}

/** Lớp quyền mở rộng: khoá Action của danh mục được bật cho người dùng (registry ∩ trần công ty ∩ quyền CRM) + phạm vi toà.
 * `live` (tuỳ chọn) ghi lại danh mục thao tác sống mỗi lần đọc capability.
 * `borrowedKeys` (tuỳ chọn, ⊆ khoá danh mục): khoá mà MỘT lớp quyền khác trong chuỗi đã là nguồn cấp (vd. sale_phong.lock_room của lớp
 * Sale, khoá cho contract.room_lock / room_unlock). Hai lớp cùng cấp một khoá là context_changed (rào ở mọi lớp), nên lớp này không
 * kiểm, không cấp các khoá đó; thao tác dùng chúng vẫn chạy được khi lớp chủ của khoá cấp (runtime xét quyền cuối cùng của chuỗi), còn
 * SQL của thao tác tự kiểm lại registry / chính sách / quyền CRM / phạm vi mỗi lượt. */
export function createActionAuth({ baseAuth, reads, catalog, live, borrowedKeys = [] } = {}) {
  if ([baseAuth?.verifySession, baseAuth?.readAuthorization, reads?.capabilities].some(fn => typeof fn !== 'function') || !Array.isArray(catalog?.keys) ||
      !Array.isArray(borrowedKeys) || borrowedKeys.some(key => typeof key !== 'string' || !catalog.keys.includes(key)) || new Set(borrowedKeys).size !== borrowedKeys.length)
    throw new TypeError('invalid_action_auth');
  const BORROWED = new Set(borrowedKeys);
  const KEYS = catalog.keys.filter(key => !BORROWED.has(key));
  return Object.freeze({ verifySession: input => baseAuth.verifySession(input), async readAuthorization(input) {
    // Danh mục rỗng: không gọi RPC nào. Danh mục chỉ có khoá mượn vẫn đọc capability để biết thao tác nào sống.
    if (!catalog.keys.length) return baseAuth.readAuthorization(input);
    const extended = await readWithBaseAuthorization(baseAuth, input,
      () => reads.capabilities({ accessToken: input.accessToken, organizationId: input.organizationId }, { signal: input.signal }));
    const current = extended.current;
    // Khoá của họ này chỉ đến từ capabilities, không bao giờ từ lớp quyền gốc.
    if (KEYS.some(key => current.permissions.action.includes(key) || current.companyCeilings.action.includes(key))) fail('context_changed');
    const cap = extended.capability();
    if (cap === null) { live?.observe(null); return current; }
    if (!domainExact(cap, ['organizationId', 'userId', 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'permissions', 'actions']) ||
        cap.organizationId !== input.organizationId || cap.userId !== input.userId || cap.membershipId !== current.membership.membershipId ||
        cap.authorizationVersion !== current.membership.authorizationVersion || cap.isSuperadmin !== current.isSuperadmin ||
        !(cap.policyVersion === 0 || positive(cap.policyVersion)) || !plain(cap.permissions) || !plain(cap.actions)) fail('context_changed');
    const granted = [], ceilings = [], scopes = {};
    for (const key of KEYS) {
      // Khoá danh mục biết mà SQL chưa khai (bản migration cũ hơn) ⇒ không cấp.
      if (!Object.hasOwn(cap.permissions, key)) continue;
      const permission = cap.permissions[key];
      if (!domainExact(permission, ['allowed', 'companyEnabled', 'buildingIds']) || typeof permission.allowed !== 'boolean' || typeof permission.companyEnabled !== 'boolean' ||
          permission.allowed && !permission.companyEnabled || !Array.isArray(permission.buildingIds) || permission.buildingIds.length > 256 ||
          permission.buildingIds.some(value => !domainId(value)) || new Set(permission.buildingIds).size !== permission.buildingIds.length ||
          !permission.allowed && permission.buildingIds.length) fail('context_changed');
      if (permission.companyEnabled) ceilings.push(key);
      if (permission.allowed) { granted.push(key); scopes[key] = { buildingIds: [...permission.buildingIds], cashbookIds: [] }; }
    }
    live?.observe(cap.actions);
    return { ...current, permissions: { ...current.permissions, action: [...current.permissions.action, ...granted] },
      companyCeilings: { ...current.companyCeilings, action: [...current.companyCeilings.action, ...ceilings] },
      scopesByPermission: { ...current.scopesByPermission, ...scopes }, epoch: createHash('sha256').update(JSON.stringify({ base: current.epoch, cap })).digest('hex') };
  } });
}

/** Cổng prepareAction/finalizeAction cho action-runtime.mjs (createActionRuntime({ service })). */
export function createActionService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now, catalog } = {}) {
  const reads = createActionReads({ ...supabase, dependencyScope, fetch, catalog });
  const service = createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads, clock,
    mayUse: (effective, operation) => ['run', 'status'].includes(operation) && catalog.any(effective),
    validateInput: (operation, request) => actionRequest(catalog, operation, request),
    // Khuôn chi tiết của kết quả do action-runtime.mjs kiểm; ở đây chỉ chặn thứ không phải object dữ liệu.
    validateResult: (_operation, result) => { if (!plain(result) || typeof result.kind !== 'string') throw new TypeError('invalid_action_result'); return result; } });
  return Object.freeze({
    prepareAction: (token, request, options) => service.prepare(token, request?.op, request, options),
    finalizeAction: (token, receipt, options) => service.finalize(token, receipt, options),
  });
}
