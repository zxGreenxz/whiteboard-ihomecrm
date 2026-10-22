import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setup, binding, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, SCOPE, ORG, USER } from './finance-fixture.mjs';
import { ACTION_REASON_CODES } from './action-reasons.mjs';
import { HERMES_ACTION_FOUNDATION_KEYS, HERMES_CAPABILITIES } from './capability-contract.mjs';

// M1 (NEN-CHUNG-THAO-TAC-GHI.md mục 9) trên PGlite với fixture Hermes của thu chi (binding/phiên/chính sách công ty thật
// của các migration Hermes; quyền CRM giả qua fixture_acl). Kiểm: guard chung, capabilities, sổ biên nhận chung (phát lại,
// xung đột, không để dòng 'started'), basis tính lại ⇒ state_changed, lỗi "hàm ghi" ⇒ lý do đóng, tra trạng thái, chính
// sách DB siết được nhưng sàn money không nới được. RPC thử không ghi bảng nghiệp vụ nào.
const file = slug => { const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name)); assert.equal(found.length, 1, slug);
  return readFileSync(`supabase/migrations/${found[0]}`, 'utf8').replaceAll('\r\n', '\n'); };
const RESOLVE = file('hermes_write_name_resolve_v1'), FOUNDATION = file('hermes_action_foundation_v1');
const PROBE = 'assistant.action_probe';
const rid = n => `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`;
const code = expected => error => error.code === expected;
// Bảng tên thường gọi / loại việc / hồ sơ mà hàm giải tên đọc (fixture tối giản, RLS mở trong công ty).
const SUPPORT = `CREATE TABLE IF NOT EXISTS public.building_common_names(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,name text);
  CREATE TABLE IF NOT EXISTS public.job_types(id uuid PRIMARY KEY,organization_id uuid,name text,is_active boolean);
  CREATE TABLE IF NOT EXISTS public.profiles(id uuid PRIMARY KEY,full_name text);
  ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS code text;
  -- Như production và TEST (đọc 21/10 23:35): authenticated KHÔNG có USAGE trên app_private. Vỏ public SQL-standard phải tới
  -- guard / bước ghi / lõi giải tên qua OID gắn lúc tạo; một thân plpgsql tra app_private lúc chạy sẽ đỏ ở đây (42501).
  REVOKE USAGE ON SCHEMA app_private FROM authenticated, PUBLIC;
  GRANT SELECT ON public.building_common_names,public.job_types,public.profiles,public.buildings,public.rooms TO authenticated;
  -- Helper thành viên giả: chỉ người gọi là thành viên ACTIVE (giải tên đòi người gọi thuộc công ty; không ai khác để giao việc).
  CREATE OR REPLACE FUNCTION app_private.hermes_task_assignee_member_v1(p_user uuid,p_org uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ SELECT p_user=auth.uid() $f$;
  GRANT EXECUTE ON FUNCTION app_private.hermes_task_assignee_member_v1(uuid,uuid) TO authenticated;
  -- Tập toà web (20261021170452, PR #261): cùng thân production trừ nhánh has_full_building_scope() (fixture không có siêu quản trị).
  CREATE OR REPLACE FUNCTION app_private.hermes_web_building_ids_v1(p_org uuid) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public,app_private AS $f$
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) FROM public.buildings b
      CROSS JOIN LATERAL (SELECT COALESCE(bool_or(s.org_wide),false) org_wide,COALESCE(array_agg(x),'{}'::uuid[]) ids
        FROM app_private.authorized_scope_v3('buildings.view',p_org) s LEFT JOIN LATERAL unnest(s.building_ids) x ON true) scope
      WHERE p_org IS NOT NULL AND auth.uid() IS NOT NULL AND b.organization_id=p_org AND b.deleted_at IS NULL AND (scope.org_wide OR b.id=ANY(scope.ids)) $f$;
  REVOKE ALL ON FUNCTION app_private.hermes_web_building_ids_v1(uuid) FROM PUBLIC,authenticated;`;

test('action foundation M1: guard, capabilities, receipts, basis, reasons, status, policy floor', { timeout: 240000 }, async t => {
  const f = await setup(t, { action: `${SUPPORT}\n${RESOLVE}` });
  const { db, call } = f;
  await db.exec(FOUNDATION); await db.exec(FOUNDATION); // Idempotent re-apply.
  const disabled = (await db.query("SELECT enabled FROM app_private.hermes_capabilities WHERE capability=$1", [PROBE])).rows;
  assert.deepEqual(disabled, [{ enabled: false }], 'khoá thử seed TẮT');
  // Bật khoá thử như script TEST sẽ làm: registry, quyền CRM giao vào (buildings.view), trần công ty, khoá của kết nối.
  await db.query("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=$1", [PROBE]);
  await db.query("INSERT INTO public.fixture_acl(permission,building_ids) VALUES('buildings.view',$1) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true", [[BUILDING, OTHER_BUILDING]]);
  await db.query('UPDATE app_private.hermes_org_policies SET action_capabilities=array_append(action_capabilities,$1)', [PROBE]);
  await db.query('UPDATE app_private.hermes_connections SET action_capabilities=array_append(action_capabilities,$1)', [PROBE]);
  const probe = (action, phase, requestId, params, extra = {}, b = binding, options) => call(
    'SELECT public.hermes_action_probe_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result',
    [JSON.stringify(b), action, phase, requestId, JSON.stringify(params), extra.resolved ? JSON.stringify(extra.resolved) : null, extra.basis ?? null], options);
  const status = (requestId, b = binding) => call('SELECT public.hermes_action_status_v1($1::jsonb,$2::uuid) result', [JSON.stringify(b), requestId]);
  const receipts = async () => (await db.query('SELECT request_id,action,state,sqlstate FROM app_private.hermes_action_receipts ORDER BY created_at,request_id')).rows;
  const audits = async () => (await db.query("SELECT count(*)::int n FROM public.authorization_audit_events WHERE event_type LIKE 'HERMES_ACTION_%'")).rows[0].n;

  await t.test('capabilities: probe allowed with the CRM scope; registry off ⇒ not allowed; actions carry class/confirm', async () => {
    const caps = await call('SELECT public.hermes_action_capabilities_v1($1::uuid) result', [ORG]);
    assert.deepEqual(caps.permissions[PROBE], { allowed: true, companyEnabled: true, buildingIds: [BUILDING, OTHER_BUILDING].sort() });
    assert.deepEqual(caps.actions['probe.confirm'], { capability: PROBE, actionClass: 'money', confirm: 'always', privateOnly: true });
    assert.deepEqual(caps.actions['probe.note'], { capability: PROBE, actionClass: 'reversible', confirm: 'never', privateOnly: true });
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability=$1", [PROBE]);
      const off = await call('SELECT public.hermes_action_capabilities_v1($1::uuid) result', [ORG]);
      assert.deepEqual(off.permissions[PROBE], { allowed: false, companyEnabled: false, buildingIds: [] });
    });
  });

  await t.test('reversible note: auto writes at once (policy never), replay by requestId, conflict on changed input, audit', async () => {
    const applied = await probe('probe.note', 'auto', rid(1), { note: 'kiểm nền chung', buildingName: 'toa a' });
    assert.deepEqual(applied, { kind: 'applied', link: null, result: { probe: true, action: 'probe.note', building: 'Toà A', note: 'kiểm nền chung' } });
    assert.deepEqual(await probe('probe.note', 'auto', rid(1), { note: 'kiểm nền chung', buildingName: 'toa a' }), applied, 'phát lại y nguyên');
    assert.deepEqual(await probe('probe.note', 'auto', rid(1), { note: 'nội dung khác', buildingName: 'toa a' }), { kind: 'rejected', reason: 'request_conflict' });
    assert.deepEqual((await receipts()).filter(row => row.request_id === rid(1)).map(row => [row.action, row.state]), [['probe.note', 'applied']]);
    assert.equal(await audits(), 1);
    assert.deepEqual(await status(rid(1)), { kind: 'status', outcome: 'applied', action: 'probe.note',
      result: { probe: true, action: 'probe.note', building: 'Toà A', note: 'kiểm nền chung' } });
    assert.deepEqual(await status(rid(99)), { kind: 'status', outcome: 'not_found' });
  });

  await t.test('money confirm: preview never writes; apply needs the same basis; renamed building between turns ⇒ state_changed, no receipt', async () => {
    const preview = await probe('probe.confirm', 'auto', rid(2), { amount: 1000, buildingName: 'Toà A', roomName: 'P101' });
    assert.equal(preview.kind, 'preview'); assert.equal(preview.confirm, 'required');
    assert.deepEqual(preview.resolved.buildingName, 'Toà A');
    assert.equal((await receipts()).some(row => row.request_id === rid(2)), false, 'xem trước không mở biên nhận');
    const applied = await probe('probe.confirm', 'apply', rid(2), { amount: 1000, buildingName: 'Toà A', roomName: 'P101' }, preview);
    assert.equal(applied.kind, 'applied');
    assert.deepEqual(applied.result, { probe: true, action: 'probe.confirm', building: 'Toà A', room: 'P101', amount: 1000 });
    const again = await probe('probe.confirm', 'preview', rid(3), { amount: 2000, buildingName: 'Toà A' });
    await db.query("UPDATE public.buildings SET name='Toà A mới' WHERE id=$1", [BUILDING]);
    assert.deepEqual(await probe('probe.confirm', 'apply', rid(3), { amount: 2000, buildingName: 'Toà A' }, again), { kind: 'rejected', reason: 'state_changed' });
    assert.equal((await receipts()).some(row => row.request_id === rid(3)), false, 'từ chối trước khi ghi không chốt biên nhận');
    await db.query("UPDATE public.buildings SET name='Toà A' WHERE id=$1", [BUILDING]);
    // R3 (review #253): Toà B: CRM cho xem nhưng overlay của kết nối chỉ có toà A ⇒ ngoài phạm vi được ghi, không đoán, và
    // KHÔNG nêu tên (kết nối bị overlay giới hạn không được liệt kê toà ngoài overlay, kể cả khi dò bằng chuỗi 2 ký tự).
    assert.deepEqual(await probe('probe.confirm', 'preview', rid(10), { amount: 1, buildingName: 'Toà B' }), { kind: 'needs_input', reason: 'name_unresolved',
      field: 'building', wanted: 'Toà B', why: 'outside_scope', candidates: [], more: false });
    assert.deepEqual(await probe('probe.note', 'preview', rid(13), { note: 'x', buildingName: 'a b' }), { kind: 'needs_input', reason: 'name_unresolved',
      field: 'building', wanted: 'a b', why: 'outside_scope', candidates: [], more: false });
    // Bản đã giải đưa lại ở lượt 2: toà ngoài phạm vi khoá, hay phòng không thuộc toà đó ⇒ not_allowed, không mở biên nhận.
    assert.deepEqual(await probe('probe.confirm', 'apply', rid(11), { amount: 1 }, { resolved: { buildingId: OTHER_BUILDING }, basis: 'x' }), { kind: 'rejected', reason: 'not_allowed' });
    assert.deepEqual(await probe('probe.confirm', 'apply', rid(12), { amount: 1 }, { resolved: { buildingId: BUILDING, roomId: OTHER_ROOM }, basis: 'x' }), { kind: 'rejected', reason: 'not_allowed' });
    assert.equal((await receipts()).some(row => [rid(11), rid(12)].includes(row.request_id)), false);
    // Model-supplied resolved ids outside the current scope are refused even with a matching basis.
    await assert.rejects(probe('probe.confirm', 'apply', rid(4), { amount: 1 }, { resolved: {}, basis: null }), code('22023'));
  });

  await t.test('names: unresolved building is needs_input with why; never written', async () => {
    assert.deepEqual(await probe('probe.note', 'auto', rid(5), { note: 'x', buildingName: 'Toà Z' }), { kind: 'needs_input', reason: 'name_unresolved',
      field: 'building', wanted: 'Toà Z', why: 'not_visible', candidates: [], more: false });
    assert.equal((await receipts()).some(row => row.request_id === rid(5)), false);
  });

  await t.test('writer failures: final ones map to the closed list and are stored; transient ones roll the receipt back (R4, R5)', async () => {
    // R5: 23505 của một ràng buộc khác khoá idempotency (vd kẹt dãy mã phiếu) KHÔNG phải "đã được ghi trước đó".
    for (const [n, sqlstate, reason] of [[6, '23505', 'crm_refused'], [7, '42501', 'not_allowed'], [9, 'XX000', 'crm_refused']]) {
      const outcome = await probe('probe.note', 'auto', rid(n), { note: `!raise ${sqlstate}` });
      assert.deepEqual(outcome, { kind: 'rejected', reason }, sqlstate);
      assert.deepEqual(await status(rid(n)), { kind: 'status', outcome: 'rejected', action: 'probe.note', reason });
      assert.deepEqual(await probe('probe.note', 'auto', rid(n), { note: `!raise ${sqlstate}` }), outcome, 'từ chối cuối phát lại y nguyên');
    }
    assert.deepEqual((await receipts()).filter(row => row.state === 'rejected').map(row => row.sqlstate), ['23505', '42501', 'XX000']);
    // R4: lỗi tạm (tranh chấp tuần tự, deadlock, chờ khoá, ngữ cảnh đổi) KHÔNG chốt biên nhận: cả giao dịch lùi, cùng requestId
    // gọi lại được (connector giữ requestId cho lần thử lại) thay vì phát lại state_changed mãi.
    for (const [n, sqlstate] of [[50, '40001'], [51, '40P01'], [52, '55P03'], [53, 'PT409']]) {
      await assert.rejects(probe('probe.note', 'auto', rid(n), { note: `!raise ${sqlstate}` }), code(sqlstate), sqlstate);
      assert.equal((await receipts()).some(row => row.request_id === rid(n)), false, `${sqlstate}: biên nhận lùi theo giao dịch`);
      assert.deepEqual(await status(rid(n)), { kind: 'status', outcome: 'not_found' }, sqlstate);
      assert.equal((await probe('probe.note', 'auto', rid(n), { note: 'thử lại sau lỗi tạm' })).kind, 'applied', `${sqlstate}: cùng requestId ghi được khi gọi lại`);
    }
    assert.equal((await receipts()).filter(row => row.state === 'started').length, 0);
    const mapped = async (sqlstate, message, constraint = null) => (await db.query('SELECT app_private.hermes_action_reason_v1($1,$2,$3) r', [sqlstate, message, constraint])).rows[0].r;
    for (const [sqlstate, message, expected, constraint] of [['P0001', 'Không ghi được: [PROFIT_LOCKED] tháng 09', 'period_locked'], ['P0001', 'Sổ quỹ đã khoá tại ngày phiếu', 'period_locked'],
      ['P0001', '[STRICT_MODE] chặn', 'strict_mode'], ['42501', 'Không có quyền sử dụng sổ quỹ này', 'cashbook_not_held'], ['P0001', 'Chỉ sửa được phiếu Chờ duyệt', 'not_pending'],
      ['P0001', 'Tổng tiền phiếu vượt giới hạn', 'amount_out_of_range'], ['P0001', 'hermes_task_quota_exceeded', 'quota_exceeded'], ['22023', 'Cần lý do ít nhất 8 ký tự', 'reason_required'],
      ['40001', 'serialization', 'state_changed'], ['40P01', 'deadlock', 'state_changed'], ['55P03', 'lock not available', 'state_changed'], ['42501', 'denied', 'not_allowed'],
      ['23505', 'dup', 'crm_refused'], ['23505', 'duplicate key value violates unique constraint "income_expenses_code_key"', 'crm_refused', 'income_expenses_code_key'],
      ['23505', 'dup', 'duplicate_request', 'hermes_action_receipts_pkey'], ['22023', 'bad', 'crm_refused'], [null, null, 'crm_refused']]) {
      const got = await mapped(sqlstate, message, constraint);
      assert.equal(got, expected, `${sqlstate} ${message} ${constraint}`);
      assert.ok(ACTION_REASON_CODES.includes(got), 'chỉ mã trong danh sách đóng');
    }
  });

  await t.test('R1–R2: a NULL action or phase never slips past the fence; nothing answered, nothing written', async () => {
    const before = (await receipts()).length, auditsBefore = await audits();
    // R1: khoá thử TẮT (trạng thái production) + action NULL ⇒ không còn nhánh "chỉ kiểm binding": không trả kết quả giải tên.
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability=$1", [PROBE]);
      for (const phase of ['preview', 'auto', 'apply'])
        await assert.rejects(probe(null, phase, rid(40), { note: 'x', buildingName: 'Toà A' }, phase === 'apply' ? { resolved: { buildingId: BUILDING }, basis: 'x' } : {}), code('42501'), phase);
    });
    await assert.rejects(probe(null, 'preview', rid(41), { buildingName: 'Toà A' }), code('42501'), 'khoá bật vẫn đòi thao tác');
    // R2: thao tác tiền với phase NULL/lạ ⇒ 22023, không bao giờ ghi thẳng mà bỏ qua xem trước.
    for (const phase of [null, 'write', 'APPLY']) {
      await assert.rejects(probe('probe.confirm', phase, rid(42), { amount: 1000 }), code('22023'), String(phase));
      await assert.rejects(probe('probe.note', phase, rid(43), { note: 'x' }), code('22023'), String(phase));
    }
    // Lượt 2 phải đưa lại đúng bản đã giải dạng object.
    for (const resolved of [['x'], 'x', 1])
      await assert.rejects(probe('probe.confirm', 'apply', rid(44), { amount: 1 }, { resolved, basis: 'x' }), code('22023'), JSON.stringify(resolved));
    assert.equal((await receipts()).length, before, 'không mở biên nhận');
    assert.equal(await audits(), auditsBefore, 'không có audit');
  });

  await t.test('frame: a receipt is never committed while still started (a page that forgets finish rolls back)', async () => {
    await assert.rejects(db.exec(`BEGIN; INSERT INTO app_private.hermes_action_receipts(organization_id,user_id,request_id,connection_id,action,input)
      VALUES('${ORG}','${USER}','${rid(60)}','${binding.connectionId}','probe.note','{}'); COMMIT;`), /hermes_action_receipt_unfinished/);
    assert.equal((await receipts()).some(row => row.request_id === rid(60)), false);
    // Mở rồi chốt trong cùng giao dịch thì COMMIT được (đường của mọi thao tác).
    await db.exec(`BEGIN; INSERT INTO app_private.hermes_action_receipts(organization_id,user_id,request_id,connection_id,action,input)
      VALUES('${ORG}','${USER}','${rid(61)}','${binding.connectionId}','probe.note','{}');
      UPDATE app_private.hermes_action_receipts SET state='rejected',finished_at=clock_timestamp() WHERE request_id='${rid(61)}'; COMMIT;`);
    assert.deepEqual((await receipts()).filter(row => row.request_id === rid(61)).map(row => row.state), ['rejected']);
  });

  await t.test('guard: registry off, key not on the connection, stale binding, non-authenticated role all refused; nothing written', async () => {
    const before = (await receipts()).length;
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability=$1", [PROBE]);
      await assert.rejects(probe('probe.note', 'auto', rid(20), { note: 'x' }), code('42501'));
    });
    await f.rollbackCase(async () => {
      await db.query('UPDATE app_private.hermes_connections SET action_capabilities=array_remove(action_capabilities,$1)', [PROBE]);
      await assert.rejects(probe('probe.note', 'auto', rid(21), { note: 'x' }), code('42501'));
    });
    await assert.rejects(probe('probe.note', 'auto', rid(22), { note: 'x' }, {}, { ...binding, expectedEpoch: 99 }), code('PT409'));
    await assert.rejects(probe('probe.nope', 'auto', rid(23), { note: 'x' }), code('42501'), 'thao tác không có trong hermes_action_policies');
    await assert.rejects(probe('probe.note', 'auto', rid(24), { note: 'x' }, {}, binding, { role: 'anon' }));
    // Client không gọi thẳng được hàm app_private nào bằng tên (không USAGE), kể cả guard.
    await assert.rejects(call('SELECT app_private.hermes_action_guard_v1($1::jsonb,$2) result', [JSON.stringify(binding), 'probe.note']),
      error => error.code === '42501' && /schema app_private/.test(error.message));
    assert.equal((await receipts()).length, before);
  });

  await t.test('review #253 mục 6 (lượt 5): khoá miền toàn công ty nhưng buildings.view hẹp ⇒ guard + capabilities chỉ còn toà web thấy', async () => {
    const UNSELECTED_ORG_SCOPE = '00000000-0000-4000-8000-0000000000a1';
    await f.rollbackCase(async () => {
      // Thao tác thử giao vào một khoá miền (tasks.edit) được cấp TOÀN công ty (như override thành viên phạm vi ORGANIZATION),
      // overlay kết nối phủ cả công ty, nhưng web (buildings.view) chỉ cho xem toà A.
      await db.query("UPDATE app_private.hermes_action_policies SET crm_permission='tasks.edit' WHERE capability=$1", [PROBE]);
      await db.query("INSERT INTO public.fixture_acl(permission,org_wide,building_ids) VALUES('tasks.edit',true,'{}') ON CONFLICT(permission) DO UPDATE SET org_wide=true,allowed=true");
      await db.query("UPDATE public.fixture_acl SET org_wide=false,building_ids=$1 WHERE permission='buildings.view'", [[BUILDING]]);
      await db.query('UPDATE app_private.hermes_org_policies SET scope_ids=array_append(scope_ids,$1::uuid)', [UNSELECTED_ORG_SCOPE]);
      await db.query('UPDATE app_private.hermes_connections SET scope_ids=array_append(scope_ids,$1::uuid)', [UNSELECTED_ORG_SCOPE]);
      const caps = await call('SELECT public.hermes_action_capabilities_v1($1::uuid) result', [ORG]);
      assert.deepEqual(caps.permissions[PROBE], { allowed: true, companyEnabled: true, buildingIds: [BUILDING] });
      // Toà B: khoá miền + overlay cho, web không cho ⇒ ngoài phạm vi được ghi (không giải, không nêu tên), lượt 2 đưa id ⇒ not_allowed.
      assert.deepEqual(await probe('probe.confirm', 'preview', rid(70), { amount: 1, buildingName: 'Toà B' }), { kind: 'needs_input', reason: 'name_unresolved',
        field: 'building', wanted: 'Toà B', why: 'outside_scope', candidates: [], more: false });
      assert.deepEqual(await probe('probe.confirm', 'apply', rid(71), { amount: 1 }, { resolved: { buildingId: OTHER_BUILDING }, basis: 'x' }), { kind: 'rejected', reason: 'not_allowed' });
      assert.equal((await probe('probe.confirm', 'preview', rid(72), { amount: 1, buildingName: 'Toà A' })).kind, 'preview', 'toà web thấy vẫn làm được');
      // Web mở cả hai toà ⇒ toà B vào phạm vi (đối chứng: chính tập toà web là thứ chặn).
      await db.query("UPDATE public.fixture_acl SET building_ids=$1 WHERE permission='buildings.view'", [[BUILDING, OTHER_BUILDING]]);
      assert.deepEqual((await call('SELECT public.hermes_action_capabilities_v1($1::uuid) result', [ORG])).permissions[PROBE].buildingIds, [BUILDING, OTHER_BUILDING].sort());
      assert.equal((await probe('probe.confirm', 'preview', rid(73), { amount: 1, buildingName: 'Toà B' })).kind, 'preview');
    });
  });

  await t.test('policy: DB can tighten a reversible action to always; the floor forbids never on money', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_action_policies SET confirm='always' WHERE action='probe.note'");
      assert.equal((await probe('probe.note', 'auto', rid(30), { note: 'x' })).kind, 'preview');
    });
    await f.rollbackCase(async () => {
      await assert.rejects(db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action='probe.confirm'"), code('23514'));
    });
    assert.equal((await probe('probe.confirm', 'auto', rid(31), { amount: 5, buildingName: 'Toà A' })).kind, 'preview', 'money luôn xem trước');
  });

  await t.test('M2: thirteen planned write keys seeded OFF (no thu_tien.collect), idempotent; a same-named key of another mode stops the apply', async () => {
    const SEED = file('hermes_action_keys_seed_v1');
    await db.exec(SEED); await db.exec(SEED);
    const { rows } = await db.query("SELECT capability,mode,enabled FROM app_private.hermes_capabilities WHERE capability ~ '^(income_expenses\\.(edit|cancel|approve_vouchers)|meter_readings\\.create|invoices\\.(edit|cancel|approve)|contracts\\.(terminate|renew|edit|create|transfer)|sale_phong\\.lock_room|thu_tien\\.collect)$' ORDER BY 1");
    assert.equal(rows.length, 13);
    assert.ok(rows.every(row => row.mode === 'action' && row.enabled === false));
    assert.equal(rows.some(row => row.capability === 'thu_tien.collect'), false);
    // Hợp đồng quyền của web + connector biết ĐÚNG các khoá SQL seed (13 khoá M2 + khoá thử M1), cùng mode action, theo toà.
    assert.deepEqual([...rows.map(row => row.capability), PROBE].sort(), [...HERMES_ACTION_FOUNDATION_KEYS].sort());
    for (const key of HERMES_ACTION_FOUNDATION_KEYS) assert.deepEqual(HERMES_CAPABILITIES[key], { mode: 'action', resource: 'building' }, key);
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET mode='read' WHERE capability='contracts.renew'");
      await assert.rejects(db.exec(SEED), /hermes_action_keys_mode_conflict/);
    });
  });

  await t.test('catalog: probe/status/capabilities executable by authenticated only; tables private; guard DEFINER, probe INVOKER', async () => {
    const { rows } = await db.query(`SELECT has_table_privilege('authenticated','app_private.hermes_action_receipts','SELECT') r,
      has_table_privilege('authenticated','app_private.hermes_action_policies','SELECT') p,
      has_function_privilege('anon','public.hermes_action_probe_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE') a,
      (SELECT prosecdef FROM pg_proc WHERE oid='public.hermes_action_probe_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure) probe_definer,
      (SELECT prosecdef FROM pg_proc WHERE oid='app_private.hermes_action_guard_v1(jsonb,text)'::regprocedure) guard_definer,
      (SELECT prosqlbody IS NOT NULL FROM pg_proc WHERE oid='public.hermes_action_probe_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure) probe_bound,
      has_schema_privilege('authenticated','app_private','USAGE') usage,
      has_function_privilege('authenticated','app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)','EXECUTE') begin_exec,
      has_function_privilege('authenticated','app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)','EXECUTE') finish_exec,
      has_function_privilege('authenticated','app_private.hermes_action_reason_v1(text,text,text)','EXECUTE') reason_exec,
      has_function_privilege('authenticated','app_private.hermes_action_binding_v1(jsonb)','EXECUTE') binding_exec,
      (SELECT tgdeferrable AND tginitdeferred FROM pg_trigger WHERE tgrelid='app_private.hermes_action_receipts'::regclass AND tgname='hermes_action_receipt_settled') settled_deferred`);
    assert.deepEqual(rows[0], { r: false, p: false, a: false, probe_definer: false, guard_definer: true, probe_bound: true, usage: false,
      begin_exec: false, finish_exec: false, reason_exec: false, binding_exec: false, settled_deferred: true });
    void ROOM; void SCOPE; void USER;
  });
});
