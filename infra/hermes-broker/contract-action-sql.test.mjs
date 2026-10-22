import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setup, binding, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, ORG } from './finance-fixture.mjs';

// RPC trang HỢP ĐỒNG (20261022022951, HOP-DONG-THAO-TAC-GHI.md mục 2–5) trên PGlite: binding/phiên/chính sách Hermes THẬT của
// fixture, M5 + M1 + M2 thật, và bản port TỐI GIẢN của ba hàm ghi web (giữ chữ ký, tác dụng chính, câu lỗi dùng để ánh xạ).
// Chứng minh logic của trang (tra cứu dưới RLS, đối chiếu id, basis, biên nhận, lý do, hậu điều kiện), KHÔNG chứng minh hàm
// web — hàm web thật chạy ở tầng 2 trên TEST.
const file = slug => { const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name)); assert.equal(found.length, 1, slug);
  return readFileSync(`supabase/migrations/${found[0]}`, 'utf8').replaceAll('\r\n', '\n'); };
const CONTRACT_ACTION_SQL = file('hermes_contract_action_v1');
const RESOLVE = file('hermes_write_name_resolve_v1'), FOUNDATION = file('hermes_action_foundation_v1'), KEYS = file('hermes_action_keys_seed_v1');
// Hàm dùng chung tính ngày gia hạn (Mốc 3; web cùng gọi) + bộ vector dùng chung.
const RENEWAL_DATE = file('contract_renewal_end_date_v1');
const RENEWAL_VECTORS = JSON.parse(readFileSync('infra/hermes-broker/contract-renewal-vectors.json', 'utf8')).cases;
const u = n => `00000000-0000-4000-8000-${String(500 + n).padStart(12, '0')}`;
const CONTRACT = u(1), CUSTOMER = u(2), EMPTY_ROOM = u(3), RETURNED_ROOM = u(4), OLD_CONTRACT = u(5), OTHER_USER = u(6);
const rid = n => `00000000-0000-4000-8000-${String(700 + n).padStart(12, '0')}`;
const code = expected => error => error.code === expected;
const TODAY = '2026-10-22';
// Bảng/hàm mà RPC trang đọc (fixture tối giản). RLS: contracts theo contracts.view, customers theo customers.view (fixture_acl).
const SUPPORT = `CREATE TABLE IF NOT EXISTS public.building_common_names(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,name text);
  CREATE TABLE IF NOT EXISTS public.job_types(id uuid PRIMARY KEY,organization_id uuid,name text,is_active boolean);
  CREATE TABLE IF NOT EXISTS public.profiles(id uuid PRIMARY KEY,full_name text);
  ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS code text;
  ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS contract_number text, ADD COLUMN IF NOT EXISTS start_date date, ADD COLUMN IF NOT EXISTS end_date date,
    ADD COLUMN IF NOT EXISTS expected_move_out_date date, ADD COLUMN IF NOT EXISTS actual_end_date date,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), ADD COLUMN IF NOT EXISTS rent_price numeric,
    ADD COLUMN IF NOT EXISTS notes text;
  ALTER TABLE public.income_expenses ADD COLUMN IF NOT EXISTS contract_id uuid;
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS contract_id uuid;
  CREATE TABLE IF NOT EXISTS public.contract_extensions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid,old_end_date date,new_end_date date,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE IF NOT EXISTS public.customers(id uuid PRIMARY KEY,organization_id uuid,full_name text,phone text);
  CREATE TABLE IF NOT EXISTS public.contract_customers(contract_id uuid,customer_id uuid,is_representative boolean);
  CREATE TABLE IF NOT EXISTS public.contract_exit_cases(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,state text);
  CREATE TABLE IF NOT EXISTS public.room_sale_locks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,room_id uuid,hours integer,
    note text,locked_by uuid,locked_at timestamptz DEFAULT clock_timestamp(),expires_at timestamptz,released_at timestamptz,released_by uuid,release_reason text);
  CREATE TABLE IF NOT EXISTS public.fixture_today(d date);
  CREATE TABLE IF NOT EXISTS public.fixture_contract_writer(raise_state text,bad text);
  DELETE FROM public.fixture_today; DELETE FROM public.fixture_contract_writer;
  INSERT INTO public.fixture_today VALUES('${TODAY}'); INSERT INTO public.fixture_contract_writer(raise_state) VALUES(null);
  ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY; ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS fixture_contracts ON public.contracts; DROP POLICY IF EXISTS fixture_customers ON public.customers;
  CREATE POLICY fixture_contracts ON public.contracts FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.fixture_acl a WHERE a.permission='contracts.view' AND a.allowed));
  CREATE POLICY fixture_customers ON public.customers FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.fixture_acl a WHERE a.permission='customers.view' AND a.allowed));
  REVOKE USAGE ON SCHEMA app_private FROM authenticated, PUBLIC;
  GRANT SELECT ON public.building_common_names,public.job_types,public.profiles,public.buildings,public.rooms,public.contracts,public.customers,
    public.contract_customers,public.fixture_acl TO authenticated;
  CREATE OR REPLACE FUNCTION app_private.hermes_task_assignee_member_v1(p_user uuid,p_org uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ SELECT p_user=auth.uid() $f$;
  GRANT EXECUTE ON FUNCTION app_private.hermes_task_assignee_member_v1(uuid,uuid) TO authenticated;
  CREATE OR REPLACE FUNCTION app_private.hermes_web_building_ids_v1(p_org uuid) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public,app_private AS $f$
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) FROM public.buildings b
      CROSS JOIN LATERAL (SELECT COALESCE(bool_or(s.org_wide),false) org_wide,COALESCE(array_agg(x),'{}'::uuid[]) ids
        FROM app_private.authorized_scope_v3('buildings.view',p_org) s LEFT JOIN LATERAL unnest(s.building_ids) x ON true) scope
      WHERE p_org IS NOT NULL AND auth.uid() IS NOT NULL AND b.organization_id=p_org AND b.deleted_at IS NULL AND (scope.org_wide OR b.id=ANY(scope.ids)) $f$;
  REVOKE ALL ON FUNCTION app_private.hermes_web_building_ids_v1(uuid) FROM PUBLIC,authenticated;
  CREATE OR REPLACE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ SELECT d FROM public.fixture_today $f$;
  CREATE OR REPLACE FUNCTION app_private.org_timezone_v1(p_organization_id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog AS $f$ SELECT 'Asia/Ho_Chi_Minh'::text $f$;
  -- P0a (20261021114556) đã áp: chỉ cần dấu trong thân.
  CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1(p_termination_id uuid,p_note text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ BEGIN RAISE EXCEPTION '[TERMINATION_CONTRACT_CLOSED] fixture' USING ERRCODE='55000'; END $f$;
  -- Port hàm ghi web: báo trả (quyền theo toà như rào câu 26: contracts.terminate; khoá lạc quan; ngày ≥ start).
  CREATE OR REPLACE FUNCTION public.set_contract_move_out_notice_v1(p_organization_id uuid,p_contract_id uuid,p_expected_updated_at timestamptz,
    p_expected_move_out_date date DEFAULT NULL,p_reason text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $w$
    DECLARE c public.contracts; v_room public.rooms;
    BEGIN
      IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Notice organization unavailable' USING ERRCODE='42501'; END IF;
      IF (SELECT raise_state FROM public.fixture_contract_writer) IS NOT NULL THEN
        RAISE EXCEPTION 'fixture writer refused' USING ERRCODE=(SELECT raise_state FROM public.fixture_contract_writer); END IF;
      SELECT * INTO c FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Notice contract unavailable' USING ERRCODE='42501'; END IF;
      SELECT * INTO v_room FROM public.rooms WHERE id=c.room_id;
      IF NOT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission='contracts.terminate' AND allowed AND (org_wide OR v_room.building_id=ANY(building_ids)))
        THEN RAISE EXCEPTION '[THIEU_QUYEN:contracts.terminate] Bạn không có quyền báo ngày trả phòng ở toà nhà này.' USING ERRCODE='42501'; END IF;
      IF c.status<>'ACTIVE' OR c.actual_end_date IS NOT NULL THEN RAISE EXCEPTION 'Contract is no longer current' USING ERRCODE='55000'; END IF;
      IF c.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION 'Notice snapshot changed; reload' USING ERRCODE='PT409'; END IF;
      IF (p_expected_move_out_date IS NULL AND NULLIF(btrim(p_reason),'') IS NULL) OR p_expected_move_out_date<c.start_date
        THEN RAISE EXCEPTION 'Invalid notice date or reason' USING ERRCODE='22023'; END IF;
      IF c.expected_move_out_date IS DISTINCT FROM p_expected_move_out_date THEN
        UPDATE public.contracts SET expected_move_out_date=p_expected_move_out_date,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c; END IF;
      RETURN jsonb_build_object('contract_id',c.id,'organization_id',c.organization_id,'expected_move_out_date',c.expected_move_out_date,
        'updated_at',c.updated_at,'today',public.org_today_v1(p_organization_id),'status',c.status);
    END $w$;
  -- Port gia hạn (renew_contract_with_notice_v1): quyền theo toà như rào câu 26 (contracts.renew); khoá lạc quan; lý do ≥ 8 như
  -- trigger hoa hồng z98; ngày mới phải sau ngày cũ; CANCEL gỡ báo trả; giá/cọc NULL = giữ. bad: giả lập hàm ghi sai — 'price' đổi giá,
  -- 'notice' chọn CANCEL mà không gỡ báo trả, 'invoice' phát sinh hoá đơn (để thử hậu điều kiện của bước ghi).
  CREATE OR REPLACE FUNCTION public.renew_contract_with_notice_v1(p_organization_id uuid,p_contract_id uuid,p_expected_updated_at timestamptz,
    p_new_end_date date,p_notice_choice text,p_request_id uuid,p_new_rent_price numeric DEFAULT NULL,p_new_deposit numeric DEFAULT NULL,
    p_notes text DEFAULT NULL,p_notice_reason text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $w$
    DECLARE c public.contracts; v_room public.rooms;
    BEGIN
      IF (SELECT raise_state FROM public.fixture_contract_writer) IS NOT NULL THEN
        RAISE EXCEPTION 'fixture writer refused' USING ERRCODE=(SELECT raise_state FROM public.fixture_contract_writer); END IF;
      IF p_notice_choice IS NULL OR p_notice_choice NOT IN ('KEEP','CANCEL') OR p_request_id IS NULL THEN
        RAISE EXCEPTION 'Cần chọn giữ hoặc hủy báo dọn và mã yêu cầu hợp lệ' USING ERRCODE='22023'; END IF;
      SELECT * INTO c FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hợp đồng trong tổ chức này' USING ERRCODE='42501'; END IF;
      SELECT * INTO v_room FROM public.rooms WHERE id=c.room_id;
      IF NOT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission='contracts.renew' AND allowed AND (org_wide OR v_room.building_id=ANY(building_ids)))
        THEN RAISE EXCEPTION '[THIEU_QUYEN:contracts.renew] Bạn không có quyền gia hạn hợp đồng ở toà nhà này.' USING ERRCODE='42501'; END IF;
      IF c.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION 'Hợp đồng đã thay đổi; vui lòng tải lại trước khi tiếp tục' USING ERRCODE='PT409'; END IF;
      IF char_length(btrim(COALESCE(p_notes,'')))<8 THEN RAISE EXCEPTION 'Cần ghi rõ lý do thay đổi hoa hồng (từ 8 đến 2000 ký tự).' USING ERRCODE='22023'; END IF;
      IF p_new_end_date<=c.end_date THEN RAISE EXCEPTION 'Ngày kết thúc mới phải sau ngày kết thúc hiện tại (%)',c.end_date; END IF;
      IF p_notice_choice='CANCEL' AND (SELECT bad FROM public.fixture_contract_writer) IS DISTINCT FROM 'notice' THEN
        UPDATE public.contracts SET expected_move_out_date=NULL WHERE id=c.id; END IF;
      IF (SELECT bad FROM public.fixture_contract_writer)='invoice' THEN
        INSERT INTO public.invoices(id,organization_id,contract_id,total_amount) VALUES(gen_random_uuid(),c.organization_id,c.id,1); END IF;
      INSERT INTO public.contract_extensions(contract_id,old_end_date,new_end_date) VALUES(c.id,c.end_date,p_new_end_date);
      UPDATE public.contracts SET end_date=p_new_end_date,
        rent_price=COALESCE(p_new_rent_price,rent_price)+CASE WHEN (SELECT bad FROM public.fixture_contract_writer)='price' THEN 1 ELSE 0 END,
        total_deposit=COALESCE(p_new_deposit,total_deposit),notes=COALESCE(notes,'')||E'\n[Gia hạn] '||p_notes,updated_at=clock_timestamp() WHERE id=c.id;
      RETURN c.id;
    END $w$;
  -- Port khoá tạm: 6/12/24 giờ; phòng phải còn trên danh sách bán; một khoá mở mỗi phòng; cùng người/giờ/ghi chú trong 2 phút ⇒ trả lại khoá cũ.
  CREATE OR REPLACE FUNCTION public.lock_room_for_sale_v1(p_organization_id uuid,p_room_id uuid,p_hours integer,p_note text DEFAULT NULL)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $w$
    DECLARE r public.rooms; k public.room_sale_locks;
    BEGIN
      IF p_hours IS NULL OR p_hours NOT IN (6,12,24) THEN RAISE EXCEPTION 'Chỉ lock tạm 6, 12 hoặc 24 giờ' USING ERRCODE='22023'; END IF;
      SELECT * INTO r FROM public.rooms WHERE id=p_room_id AND organization_id=p_organization_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phòng trong tổ chức' USING ERRCODE='42501'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission='sale_phong.lock_room' AND allowed AND (org_wide OR r.building_id=ANY(building_ids)))
        THEN RAISE EXCEPTION 'Không có quyền lock tạm phòng ở tòa này' USING ERRCODE='42501'; END IF;
      SELECT * INTO k FROM public.room_sale_locks WHERE room_id=p_room_id AND released_at IS NULL AND expires_at>clock_timestamp();
      IF FOUND THEN
        IF k.locked_by=auth.uid() AND k.hours=p_hours AND k.note IS NOT DISTINCT FROM p_note AND k.locked_at>clock_timestamp()-interval '2 minutes' THEN
          RETURN jsonb_build_object('id',k.id,'room_id',k.room_id,'hours',k.hours,'expires_at',k.expires_at,'active',true); END IF;
        RAISE EXCEPTION 'Phòng đang được lock tạm. Tải lại danh sách.' USING ERRCODE='55000';
      END IF;
      IF r.status IS DISTINCT FROM 'AVAILABLE' THEN
        RAISE EXCEPTION 'Phòng không còn trên danh sách bán (đã cọc, đang giữ chỗ hoặc đang có khách ở)' USING ERRCODE='55000'; END IF;
      INSERT INTO public.room_sale_locks(organization_id,building_id,room_id,hours,note,locked_by,expires_at)
        VALUES(p_organization_id,r.building_id,p_room_id,p_hours,p_note,auth.uid(),clock_timestamp()+make_interval(hours=>p_hours)) RETURNING * INTO k;
      RETURN jsonb_build_object('id',k.id,'room_id',k.room_id,'hours',k.hours,'expires_at',k.expires_at,'active',true);
    END $w$;
  CREATE OR REPLACE FUNCTION public.release_room_sale_lock_v1(p_organization_id uuid,p_lock_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,public AS $w$
    DECLARE k public.room_sale_locks;
    BEGIN
      SELECT * INTO k FROM public.room_sale_locks WHERE id=p_lock_id AND organization_id=p_organization_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy lock tạm trong tổ chức' USING ERRCODE='42501'; END IF;
      IF k.locked_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Chỉ người đã lock hoặc người được tạo cọc ở tòa này mới gỡ được lock' USING ERRCODE='42501'; END IF;
      IF k.released_at IS NULL THEN UPDATE public.room_sale_locks SET released_at=clock_timestamp(),released_by=auth.uid(),release_reason='MANUAL'
        WHERE id=k.id RETURNING * INTO k; END IF;
      RETURN jsonb_build_object('id',k.id,'room_id',k.room_id,'active',false,'released_at',k.released_at);
    END $w$;`;

test('trang Hợp đồng — RPC thao tác (Mốc 2): báo trả / dời / huỷ, khoá tạm / gỡ khoá', { timeout: 240000 }, async t => {
  const f = await setup(t, { action: `${SUPPORT}\n${RESOLVE}\n${RENEWAL_DATE.replace(/^BEGIN;|^COMMIT;|^NOTIFY pgrst[^\n]*/gm, '')}` });
  const { db, call } = f;
  await db.exec(FOUNDATION); await db.exec(KEYS);
  await db.exec(CONTRACT_ACTION_SQL); await db.exec(CONTRACT_ACTION_SQL); // Idempotent re-apply.
  const keys = ['contracts.terminate', 'sale_phong.lock_room', 'contracts.renew'];
  assert.deepEqual((await db.query('SELECT capability,enabled FROM app_private.hermes_capabilities WHERE capability=ANY($1) ORDER BY 1', [keys])).rows,
    [...keys].sort().map(capability => ({ capability, enabled: false })), 'khoá seed TẮT');
  // Bật như script TEST: registry, quyền CRM giao vào, trần công ty, khoá của kết nối.
  await db.query('UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=ANY($1)', [keys]);
  for (const permission of ['buildings.view', 'contracts.view', 'customers.view', ...keys])
    await db.query('INSERT INTO public.fixture_acl(permission,building_ids) VALUES($1,$2) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true',
      [permission, [BUILDING, OTHER_BUILDING]]);
  await db.query('UPDATE app_private.hermes_org_policies SET action_capabilities=action_capabilities||$1::text[]', [keys]);
  await db.query('UPDATE app_private.hermes_connections SET action_capabilities=action_capabilities||$1::text[]', [keys]);
  await db.exec(`INSERT INTO public.rooms VALUES('${EMPTY_ROOM}','${ORG}','${BUILDING}','P102','AVAILABLE',null),('${RETURNED_ROOM}','${ORG}','${BUILDING}','P103','AVAILABLE',null);
    INSERT INTO public.contracts(id,organization_id,room_id,status,contract_number,start_date,end_date,expected_move_out_date)
      VALUES('${CONTRACT}','${ORG}','${ROOM}','ACTIVE','HĐ-THU-001','2026-03-01','2027-02-28',null),
            ('${OLD_CONTRACT}','${ORG}','${RETURNED_ROOM}','TERMINATED','HĐ-THU-000','2025-10-01','2026-09-30',null);
    INSERT INTO public.customers VALUES('${CUSTOMER}','${ORG}','Khách Thử','0900000001');
    INSERT INTO public.contract_customers VALUES('${CONTRACT}','${CUSTOMER}',true);
    INSERT INTO public.contract_exit_cases(organization_id,contract_id,state) VALUES('${ORG}','${OLD_CONTRACT}','PENDING');`);
  const run = (action, phase, requestId, params, extra = {}, options) => call(
    'SELECT public.hermes_contract_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result',
    [JSON.stringify(binding), action, phase, requestId, JSON.stringify(params), extra.resolved ? JSON.stringify(extra.resolved) : null, extra.basis ?? null], options);
  const receipts = async () => (await db.query('SELECT request_id,action,state,sqlstate FROM app_private.hermes_action_receipts ORDER BY created_at,request_id')).rows;
  const contract = async () => (await db.query('SELECT expected_move_out_date::text d,updated_at FROM public.contracts WHERE id=$1', [CONTRACT])).rows[0];
  const P101 = { buildingName: 'toa a', roomName: 'P101' };

  await t.test('capabilities: bốn thao tác của trang có lớp/chính sách; hai khoá theo phạm vi toà', async () => {
    const caps = await call('SELECT public.hermes_action_capabilities_v1($1::uuid) result', [ORG]);
    for (const key of keys) assert.deepEqual(caps.permissions[key], { allowed: true, companyEnabled: true, buildingIds: [BUILDING, OTHER_BUILDING].sort() }, key);
    for (const [action, capability] of [['contract.notice_set', keys[0]], ['contract.notice_cancel', keys[0]], ['contract.room_lock', keys[1]], ['contract.room_unlock', keys[1]]])
      assert.deepEqual(caps.actions[action], { capability, actionClass: 'reversible', confirm: 'never', privateOnly: true }, action);
    assert.deepEqual(caps.actions['contract.renew'], { capability: 'contracts.renew', actionClass: 'irreversible', confirm: 'always', privateOnly: true });
  });

  await t.test('báo trả: ghi thẳng ở auto, câu kết quả nêu cũ → mới + thứ + số ngày; phát lại; xung đột; không đổi ngày', async () => {
    const applied = await run('contract.notice_set', 'auto', rid(1), { ...P101, date: '2026-10-31' });
    assert.equal(applied.kind, 'applied'); assert.equal(applied.link, `/contracts/${CONTRACT}`);
    assert.equal(applied.result.text, 'Đã ghi báo trả phòng P101 toà Toà A (HĐ HĐ-THU-001, khách Khách Thử): ngày dự kiến dọn đi thứ Bảy 31/10/2026 (còn 9 ngày) (trước đó: chưa báo).');
    assert.deepEqual(applied.result.moveOutDate, { from: null, to: '2026-10-31' }); assert.equal(applied.result.changed, true);
    assert.equal((await contract()).d, '2026-10-31');
    const before = await contract();
    assert.deepEqual(await run('contract.notice_set', 'auto', rid(1), { ...P101, date: '2026-10-31' }), applied, 'phát lại y nguyên');
    assert.deepEqual(await contract(), before, 'phát lại không ghi lần hai');
    assert.deepEqual(await run('contract.notice_set', 'auto', rid(1), { ...P101, date: '2026-11-15' }), { kind: 'rejected', reason: 'request_conflict' });
    const same = await run('contract.notice_set', 'auto', rid(2), { ...P101, date: '2026-10-31' });
    assert.equal(same.result.changed, false); assert.match(same.result.text, /đã là thứ Bảy 31\/10\/2026.*không đổi/);
    const moved = await run('contract.notice_set', 'auto', rid(3), { ...P101, date: '2026-12-15', note: 'khách xin ở thêm' });
    assert.deepEqual(moved.result.moveOutDate, { from: '2026-10-31', to: '2026-12-15' });
    assert.match(moved.result.text, /\(trước đó: thứ Bảy 31\/10\/2026 \(còn 9 ngày\)\)/);
    assert.deepEqual((await receipts()).filter(row => [rid(1), rid(2), rid(3)].includes(row.request_id)).map(row => row.state), ['applied', 'applied', 'applied']);
    assert.equal((await db.query("SELECT count(*)::int n FROM public.authorization_audit_events WHERE event_type='HERMES_ACTION_APPLIED'")).rows[0].n, 3);
  });

  await t.test('báo trả: ngày đã qua / trước ngày bắt đầu ⇒ needs_input; sau hết hạn ⇒ ghi kèm cảnh báo; không mở biên nhận khi từ chối sớm', async () => {
    assert.deepEqual(await run('contract.notice_set', 'auto', rid(10), { ...P101, date: '2026-10-21' }), { kind: 'needs_input', reason: 'notice_date_past' });
    await db.query("UPDATE public.contracts SET start_date='2026-11-01' WHERE id=$1", [CONTRACT]);
    assert.deepEqual(await run('contract.notice_set', 'auto', rid(11), { ...P101, date: '2026-10-25' }), { kind: 'needs_input', reason: 'date_out_of_range' });
    await db.query("UPDATE public.contracts SET start_date='2026-03-01' WHERE id=$1", [CONTRACT]);
    const late = await run('contract.notice_set', 'auto', rid(12), { ...P101, date: '2027-03-15' });
    assert.equal(late.kind, 'applied'); assert.deepEqual(late.result.warnings, ['Ngày dọn đi sau ngày hết hạn HĐ (28/02/2027); nhớ gia hạn HĐ hoặc ghi nhận trả phòng đúng ngày.']);
    assert.equal((await receipts()).some(row => [rid(10), rid(11)].includes(row.request_id)), false);
  });

  await t.test('huỷ báo trả: cần lý do; không có báo trả ⇒ no_notice; kết quả nêu ngày cũ', async () => {
    assert.deepEqual(await run('contract.notice_cancel', 'auto', rid(20), { ...P101, reason: 'ngắn' }), { kind: 'needs_input', reason: 'reason_required' });
    const cancelled = await run('contract.notice_cancel', 'auto', rid(21), { ...P101, reason: 'khách gia hạn ở tiếp' });
    assert.equal(cancelled.kind, 'applied'); assert.deepEqual(cancelled.result.moveOutDate, { from: '2027-03-15', to: null });
    assert.equal(cancelled.result.text, 'Đã huỷ báo trả phòng P101 toà Toà A (HĐ HĐ-THU-001, khách Khách Thử) (trước đó: dọn đi thứ Hai 15/03/2027 (còn 144 ngày)); lý do: khách gia hạn ở tiếp.');
    assert.equal((await contract()).d, null);
    assert.deepEqual(await run('contract.notice_cancel', 'auto', rid(22), { ...P101, reason: 'khách gia hạn ở tiếp' }), { kind: 'rejected', reason: 'no_notice' });
  });

  await t.test('HĐ hiện hành: phòng trống ⇒ room_has_no_active_contract; đã trả chờ quyết toán ⇒ already_returned; RLS ẩn HĐ / tên khách', async () => {
    assert.deepEqual(await run('contract.notice_set', 'auto', rid(30), { buildingName: 'Toà A', roomName: 'P102', date: '2026-11-30' }),
      { kind: 'needs_input', reason: 'room_has_no_active_contract' });
    assert.deepEqual(await run('contract.notice_set', 'auto', rid(31), { buildingName: 'Toà A', roomName: 'P103', date: '2026-11-30' }),
      { kind: 'rejected', reason: 'already_returned' });
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.fixture_acl SET allowed=false WHERE permission='customers.view'");
      const hidden = await run('contract.notice_set', 'auto', rid(32), { ...P101, date: '2026-11-30' });
      assert.equal(hidden.result.representativeName, undefined, 'không customers.view ⇒ không tên khách');
      assert.equal(hidden.result.text, 'Đã ghi báo trả phòng P101 toà Toà A (HĐ HĐ-THU-001): ngày dự kiến dọn đi thứ Hai 30/11/2026 (còn 39 ngày) (trước đó: chưa báo).');
    });
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.fixture_acl SET allowed=false WHERE permission='contracts.view'");
      assert.deepEqual(await run('contract.notice_set', 'auto', rid(33), { ...P101, date: '2026-11-30' }), { kind: 'needs_input', reason: 'room_has_no_active_contract' },
        'HĐ RLS không cho thấy ⇒ coi như không có, không ghi');
    });
    assert.equal((await contract()).d, null);
  });

  await t.test('phạm vi: toà ngoài khoá ⇒ name_unresolved outside_scope không tên; id lượt 2 ngoài phạm vi / lệch phòng / lệch HĐ ⇒ từ chối', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.fixture_acl SET building_ids=$1 WHERE permission='contracts.terminate'", [[OTHER_BUILDING]]);
      assert.deepEqual(await run('contract.notice_set', 'auto', rid(40), { ...P101, date: '2026-11-30' }), { kind: 'needs_input', reason: 'name_unresolved',
        field: 'building', wanted: 'toa a', why: 'outside_scope', candidates: [], more: false });
    });
    assert.deepEqual(await run('contract.notice_set', 'apply', rid(41), { ...P101, date: '2026-11-30' },
      { resolved: { buildingId: BUILDING, roomId: OTHER_ROOM, contractId: CONTRACT }, basis: 'x' }), { kind: 'rejected', reason: 'not_allowed' });
    assert.deepEqual(await run('contract.notice_set', 'apply', rid(42), { ...P101, date: '2026-11-30' },
      { resolved: { buildingId: BUILDING, buildingName: 'Toà A', roomId: EMPTY_ROOM, roomName: 'P102', contractId: CONTRACT }, basis: 'x' }),
      { kind: 'rejected', reason: 'state_changed' }, 'HĐ không thuộc phòng đã giải ⇒ không ghi');
    // Toà B: RLS cho thấy, nhưng ngoài overlay của kết nối ⇒ ngoài phạm vi khoá dù phòng thuộc đúng toà đó.
    assert.deepEqual(await run('contract.room_lock', 'apply', rid(43), { buildingName: 'Toà B', roomName: 'P201', hours: 6 },
      { resolved: { buildingId: OTHER_BUILDING, buildingName: 'Toà B', roomId: OTHER_ROOM, roomName: 'P201' }, basis: 'x' }), { kind: 'rejected', reason: 'not_allowed' });
    // basis thật của HĐ phòng P101 nhưng bản đã giải trỏ sang phòng khác cùng toà ⇒ không ghi (HĐ phải thuộc đúng phòng).
    const real = await run('contract.notice_set', 'preview', rid(44), { ...P101, date: '2026-11-30' });
    assert.equal(real.kind, 'preview');
    assert.deepEqual(await run('contract.notice_set', 'apply', rid(44), { ...P101, date: '2026-11-30' },
      { resolved: { ...real.resolved, roomId: EMPTY_ROOM, roomName: 'P102' }, basis: real.basis }), { kind: 'rejected', reason: 'state_changed' });
    assert.equal((await receipts()).some(row => [rid(41), rid(42), rid(43), rid(44)].includes(row.request_id)), false);
    assert.equal((await contract()).d, null);
  });

  await t.test('chính sách DB siết (always): auto ⇒ bản xem trước; apply cần đúng basis; HĐ đổi giữa hai lượt ⇒ state_changed', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_action_policies SET confirm='always' WHERE action='contract.notice_set'");
      const preview = await run('contract.notice_set', 'auto', rid(50), { ...P101, date: '2026-11-30' });
      assert.equal(preview.kind, 'preview'); assert.equal(preview.confirm, 'required');
      assert.match(preview.preview.text, /^Sẽ báo trả phòng P101 toà Toà A/);
      assert.equal((await receipts()).some(row => row.request_id === rid(50)), false, 'xem trước không mở biên nhận');
      assert.equal((await run('contract.notice_set', 'apply', rid(50), { ...P101, date: '2026-11-30' }, preview)).kind, 'applied');
      const second = await run('contract.notice_set', 'preview', rid(51), { ...P101, date: '2026-12-01' });
      await db.query("UPDATE public.contracts SET updated_at=clock_timestamp() WHERE id=$1", [CONTRACT]);
      assert.deepEqual(await run('contract.notice_set', 'apply', rid(51), { ...P101, date: '2026-12-01' }, second), { kind: 'rejected', reason: 'state_changed' });
      assert.equal((await receipts()).some(row => row.request_id === rid(51)), false);
    });
  });

  await t.test('lỗi hàm ghi: cuối ⇒ lý do đóng + chốt; tạm ⇒ cả giao dịch lùi, cùng requestId gọi lại được', async () => {
    await db.query("UPDATE public.fixture_contract_writer SET raise_state='XX000'");
    assert.deepEqual(await run('contract.notice_set', 'auto', rid(60), { ...P101, date: '2026-11-30' }), { kind: 'rejected', reason: 'crm_refused' });
    await db.query("UPDATE public.fixture_contract_writer SET raise_state='42501'");
    assert.deepEqual(await run('contract.notice_set', 'auto', rid(61), { ...P101, date: '2026-11-30' }), { kind: 'rejected', reason: 'not_allowed' });
    for (const [n, state] of [[62, '40001'], [63, 'PT409']]) {
      await db.query('UPDATE public.fixture_contract_writer SET raise_state=$1', [state]);
      await assert.rejects(run('contract.notice_set', 'auto', rid(n), { ...P101, date: '2026-11-30' }), code(state), state);
      assert.equal((await receipts()).some(row => row.request_id === rid(n)), false, `${state}: biên nhận lùi theo giao dịch`);
    }
    await db.query('UPDATE public.fixture_contract_writer SET raise_state=NULL');
    assert.equal((await run('contract.notice_set', 'auto', rid(62), { ...P101, date: '2026-11-30' })).kind, 'applied', 'cùng requestId ghi được sau lỗi tạm');
    assert.deepEqual((await receipts()).filter(row => [rid(60), rid(61)].includes(row.request_id)).map(row => [row.state, row.sqlstate]), [['rejected', 'XX000'], ['rejected', '42501']]);
    assert.equal((await receipts()).filter(row => row.state === 'started').length, 0);
  });

  await t.test('khoá tạm: ghi thẳng; giờ ngoài 6/12/24 ⇒ needs_input; phòng đang có khách / đã khoá ⇒ lý do riêng; gỡ khoá; khoá của người khác', async () => {
    assert.deepEqual(await run('contract.room_lock', 'auto', rid(70), { buildingName: 'Toà A', roomName: 'P102', hours: 7 }), { kind: 'needs_input', reason: 'invalid_params' });
    const locked = await run('contract.room_lock', 'auto', rid(71), { buildingName: 'Toà A', roomName: 'P102', hours: 12, note: 'khách xem chiều nay' });
    assert.equal(locked.kind, 'applied'); assert.equal(locked.result.hours, 12);
    assert.match(locked.result.text, /^Đã khoá tạm phòng P102 toà Toà A trong 12 giờ .*Khoá tới \d{2}:\d{2} (thứ|Chủ nhật)/);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.room_sale_locks WHERE room_id=$1 AND released_at IS NULL', [EMPTY_ROOM])).rows[0].n, 1);
    assert.deepEqual(await run('contract.room_lock', 'auto', rid(72), { buildingName: 'Toà A', roomName: 'P102', hours: 6 }), { kind: 'rejected', reason: 'room_already_locked' });
    assert.deepEqual(await run('contract.room_lock', 'auto', rid(73), { ...P101, hours: 6 }), { kind: 'rejected', reason: 'room_not_lockable' });
    assert.deepEqual((await receipts()).filter(row => [rid(72), rid(73)].includes(row.request_id)).map(row => [row.state, row.sqlstate]), [['rejected', '55000'], ['rejected', '55000']]);
    await f.rollbackCase(async () => {
      await db.query('UPDATE public.room_sale_locks SET locked_by=$1 WHERE room_id=$2', [OTHER_USER, EMPTY_ROOM]);
      assert.deepEqual(await run('contract.room_unlock', 'auto', rid(74), { buildingName: 'Toà A', roomName: 'P102' }), { kind: 'rejected', reason: 'not_allowed' });
    });
    const released = await run('contract.room_unlock', 'auto', rid(75), { buildingName: 'Toà A', roomName: 'P102' });
    assert.equal(released.kind, 'applied'); assert.match(released.result.text, /^Đã gỡ khoá tạm phòng P102 toà Toà A \(khoá tới /);
    assert.deepEqual(await run('contract.room_unlock', 'auto', rid(76), { buildingName: 'Toà A', roomName: 'P102' }), { kind: 'rejected', reason: 'no_open_lock' });
  });

  await t.test('hàm ngày gia hạn dùng chung: mọi vector (cuối tháng giữ cuối tháng, còn lại giữ số ngày, kẹp cuối tháng)', async () => {
    for (const { endDate, months, expected, note } of RENEWAL_VECTORS) {
      const got = (await db.query('SELECT public.contract_renewal_end_date_v1($1::date,$2)::text d', [endDate, months])).rows[0].d;
      assert.equal(got, expected, note);
    }
  });

  await t.test('gia hạn giữ giá: luôn xem trước (cả lượt auto); lý do / câu cố định; ngày; giá khác ⇒ chỉ đường web; báo trả giữ/huỷ; ghi đúng; trùng 24 giờ; hậu điều kiện', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.contracts SET expected_move_out_date=NULL,rent_price=4500000,total_deposit=4500000,end_date='2027-02-28' WHERE id=$1", [CONTRACT]);
      const base = { ...P101, months: 6, reason: 'Khách xin ở tiếp' };
      const preview = await run('contract.renew', 'auto', rid(90), base);
      assert.equal(preview.kind, 'preview', 'irreversible: lượt auto vẫn chỉ xem trước'); assert.equal(preview.confirm, 'required');
      assert.match(preview.preview.text, /^Sẽ gia hạn phòng P101 toà Toà A \(HĐ HĐ-THU-001, khách Khách Thử\): ngày kết thúc 28\/02\/2027 → (thứ|Chủ nhật)[^(]* 31\/08\/2027 \(còn \d+ ngày\) \(\+6 tháng\)\. Giá thuê giữ 4\.500\.000đ\/tháng, cọc giữ 4\.500\.000đ\. Báo trả: không có\. Lý do ghi vào HĐ: "Khách xin ở tiếp"\. Không phát sinh hoá đơn hay phiếu\.$/);
      assert.deepEqual([preview.preview.endDate, preview.preview.rentPrice, preview.preview.moveOutNotice], [{ from: '2027-02-28', to: '2027-08-31' }, '4500000', 'none']);
      assert.equal((await receipts()).some(row => row.request_id === rid(90)), false, 'xem trước không mở biên nhận');
      assert.deepEqual(await run('contract.renew', 'preview', rid(91), { ...P101, months: 6 }), { kind: 'needs_input', reason: 'renew_reason_ask' });
      const fixed = await run('contract.renew', 'preview', rid(92), { ...P101, months: 6, noReason: true });
      assert.match(fixed.preview.text, /Lý do ghi vào HĐ: "Gia hạn theo yêu cầu qua Hermes, không nêu lý do\."/);
      assert.deepEqual(await run('contract.renew', 'preview', rid(93), { ...P101, months: 6, reason: 'ngắn' }), { kind: 'needs_input', reason: 'reason_required' });
      assert.deepEqual(await run('contract.renew', 'preview', rid(94), { ...P101, reason: 'Khách xin ở tiếp' }), { kind: 'needs_input', reason: 'invalid_params' });
      assert.deepEqual(await run('contract.renew', 'preview', rid(95), { ...base, newEndDate: '2027-12-31' }), { kind: 'needs_input', reason: 'invalid_params' });
      assert.deepEqual(await run('contract.renew', 'preview', rid(96), { ...P101, newEndDate: '2027-02-28', reason: 'Khách xin ở tiếp' }), { kind: 'needs_input', reason: 'date_out_of_range' });
      assert.deepEqual(await run('contract.renew', 'preview', rid(102), { ...P101, newEndDate: '2037-12-31', reason: 'Khách xin ở tiếp' }), { kind: 'needs_input', reason: 'date_out_of_range' }, 'quá 3 660 ngày');
      assert.equal((await run('contract.renew', 'preview', rid(97), { ...P101, newEndDate: '2027-12-31', reason: 'Khách xin ở tiếp' })).preview.endDate.to, '2027-12-31');
      assert.deepEqual(await run('contract.renew', 'preview', rid(98), { ...base, newRentPrice: 4800000 }), { kind: 'rejected', reason: 'renew_price_change_web_only' });
      assert.deepEqual(await run('contract.renew', 'preview', rid(99), { ...base, newDeposit: 5000000 }), { kind: 'rejected', reason: 'renew_price_change_web_only' });
      assert.equal((await run('contract.renew', 'preview', rid(100), { ...base, newRentPrice: 4500000, newDeposit: 4500000 })).kind, 'preview', 'nhắc lại đúng giá/cọc hiện tại thì nhận');
      // Ghi bằng bản đã giải + basis của lượt xem trước: đúng ngày mới, giá/cọc giữ, 1 dòng gia hạn, biên nhận + audit.
      const applied = await run('contract.renew', 'apply', rid(90), base, preview);
      assert.equal(applied.kind, 'applied'); assert.equal(applied.link, `/contracts/${CONTRACT}`);
      assert.deepEqual([applied.result.endDate, applied.result.months, applied.result.rentPrice, applied.result.moveOutNotice], [{ from: '2027-02-28', to: '2027-08-31' }, 6, '4500000', 'none']);
      assert.match(applied.result.text, /^Đã gia hạn phòng P101 toà Toà A .*Lý do ghi vào HĐ: "Khách xin ở tiếp"\.$/);
      const row = (await db.query('SELECT end_date::text e,rent_price::text r,total_deposit::text d FROM public.contracts WHERE id=$1', [CONTRACT])).rows[0];
      assert.deepEqual(row, { e: '2027-08-31', r: '4500000', d: '4500000' });
      assert.equal((await db.query('SELECT count(*)::int n FROM public.contract_extensions WHERE contract_id=$1', [CONTRACT])).rows[0].n, 1);
      assert.deepEqual((await receipts()).filter(item => item.request_id === rid(90)).map(item => item.state), ['applied']);
      assert.deepEqual(await run('contract.renew', 'apply', rid(90), base, preview), applied, 'phát lại cùng requestId: không gia hạn lần hai');
      assert.equal((await db.query('SELECT count(*)::int n FROM public.contract_extensions WHERE contract_id=$1', [CONTRACT])).rows[0].n, 1);
      // Trùng: xem trước mới trong 24 giờ có cảnh báo "vừa được gia hạn".
      const again = await run('contract.renew', 'preview', rid(101), { ...P101, months: 6, reason: 'Khách xin ở tiếp' });
      assert.ok(again.warnings.some(text => /^HĐ vừa được gia hạn lúc .*28\/02\/2027 → 31\/08\/2027.*gia hạn chồng/.test(text)), JSON.stringify(again.warnings));
      // HĐ đổi giữa hai lượt (vd đổi giá trên web) ⇒ state_changed, không ghi.
      await db.query('UPDATE public.contracts SET rent_price=4600000 WHERE id=$1', [CONTRACT]);
      assert.deepEqual(await run('contract.renew', 'apply', rid(101), { ...P101, months: 6, reason: 'Khách xin ở tiếp' }, again), { kind: 'rejected', reason: 'state_changed' });
    });
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.contracts SET expected_move_out_date='2027-01-15',rent_price=4500000,total_deposit=4500000,end_date='2027-02-28' WHERE id=$1", [CONTRACT]);
      const base = { ...P101, months: 12, reason: 'Khách xin ở tiếp' };
      assert.deepEqual(await run('contract.renew', 'preview', rid(110), base), { kind: 'needs_input', reason: 'notice_choice_required' });
      const keep = await run('contract.renew', 'preview', rid(111), { ...base, keepMoveOutNotice: true });
      assert.match(keep.preview.text, /Báo trả: GIỮ ngày 15\/01\/2027\./); assert.equal(keep.preview.moveOutNotice, 'keep');
      assert.ok(keep.warnings.some(text => /^Báo trả 15\/01\/2027 vẫn GIỮ/.test(text)));
      const cancel = await run('contract.renew', 'preview', rid(112), { ...base, keepMoveOutNotice: false });
      assert.match(cancel.preview.text, /Báo trả: HUỶ \(trước đó dọn đi 15\/01\/2027\)\./);
      const done = await run('contract.renew', 'apply', rid(112), { ...base, keepMoveOutNotice: false }, cancel);
      assert.equal(done.result.moveOutNotice, 'cancelled');
      assert.deepEqual((await db.query('SELECT end_date::text e,expected_move_out_date d FROM public.contracts WHERE id=$1', [CONTRACT])).rows[0], { e: '2028-02-29', d: null });
    });
    // Hậu điều kiện: hàm ghi (giả lập) đổi giá / không gỡ báo trả khi chọn huỷ / phát sinh hoá đơn ⇒ lùi về savepoint, chốt
    // crm_refused, HĐ không đổi.
    for (const [index, bad] of ['price', 'notice', 'invoice'].entries()) await f.rollbackCase(async () => {
      await db.query("UPDATE public.contracts SET expected_move_out_date=$2,rent_price=4500000,total_deposit=4500000,end_date='2027-02-28' WHERE id=$1",
        [CONTRACT, bad === 'notice' ? '2027-01-15' : null]);
      await db.query('UPDATE public.fixture_contract_writer SET bad=$1', [bad]);
      const base = { ...P101, months: 6, reason: 'Khách xin ở tiếp', ...(bad === 'notice' ? { keepMoveOutNotice: false } : {}) };
      const preview = await run('contract.renew', 'preview', rid(120 + index), base);
      assert.deepEqual(await run('contract.renew', 'apply', rid(120 + index), base, preview), { kind: 'rejected', reason: 'crm_refused' }, bad);
      assert.deepEqual((await db.query('SELECT end_date::text e,rent_price::text r,expected_move_out_date::text d FROM public.contracts WHERE id=$1', [CONTRACT])).rows[0],
        { e: '2027-02-28', r: '4500000', d: bad === 'notice' ? '2027-01-15' : null }, bad);
      assert.equal((await db.query('SELECT count(*)::int n FROM public.contract_extensions WHERE contract_id=$1', [CONTRACT])).rows[0].n, 0, bad);
      assert.equal((await db.query('SELECT count(*)::int n FROM public.invoices WHERE contract_id=$1', [CONTRACT])).rows[0].n, 0, bad);
      assert.deepEqual((await receipts()).filter(item => item.request_id === rid(120 + index)).map(item => item.state), ['rejected'], bad);
    });
  });

  await t.test('rào khung: registry tắt ⇒ 42501; tham số NULL ⇒ 22023; anon không gọi được; lookup ngoài vai authenticated ⇒ 42501', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='sale_phong.lock_room'");
      await assert.rejects(run('contract.room_unlock', 'auto', rid(80), { buildingName: 'Toà A', roomName: 'P102' }), code('42501'));
    });
    await assert.rejects(run('contract.notice_set', 'apply', rid(81), { ...P101, date: '2026-11-30' }, { resolved: { buildingId: BUILDING }, basis: null }), code('22023'));
    await assert.rejects(run(null, 'auto', rid(82), P101), code('42501'));
    const grants = (await db.query(`SELECT has_function_privilege('anon','public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE') shell,
      has_function_privilege('authenticated','app_private.hermes_contract_reason_v1(text,text,text)','EXECUTE') reason`)).rows[0];
    assert.deepEqual(grants, { shell: false, reason: false });
    // Có claims người dùng (auth.uid() có giá trị) nhưng không chạy dưới vai authenticated (vd gọi từ DEFINER/chủ sở hữu) ⇒ từ chối:
    // RLS chỉ có nghĩa dưới vai authenticated.
    await assert.rejects(call('SELECT public.hermes_contract_action_lookup_v1($1::uuid,$2::uuid) result', [ORG, ROOM], { role: 'postgres' }), code('42501'),
      'chủ sở hữu (không phải authenticated) bị từ chối');
    assert.equal((await call('SELECT public.hermes_contract_action_lookup_v1($1::uuid,$2::uuid) result', [ORG, ROOM])).contractId, CONTRACT);
    // P0a (20261021114556) chưa áp ⇒ khối $requires$ dừng migration (ghi nhận trả phòng ở Mốc 4 dựa vào rào đó).
    const requires = CONTRACT_ACTION_SQL.slice(CONTRACT_ACTION_SQL.indexOf('DO $requires$'), CONTRACT_ACTION_SQL.indexOf('END $requires$;') + 'END $requires$;'.length);
    await f.rollbackCase(async () => {
      await db.exec(requires);
      await db.exec(`CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1(p_termination_id uuid,p_note text) RETURNS jsonb LANGUAGE sql
        SECURITY DEFINER SET search_path=pg_catalog AS $f$ SELECT '{}'::jsonb $f$`);
      await assert.rejects(db.exec(requires), error => /hermes_contract_action_dependency_invalid/.test(error.message));
    });
    const reason = async (state, message) => (await db.query('SELECT app_private.hermes_contract_reason_v1($1,$2) r', [state, message])).rows[0].r;
    assert.equal(await reason('55000', 'Phòng đang được lock tạm. Tải lại danh sách.'), 'room_already_locked');
    assert.equal(await reason('55000', 'Phòng không còn trên danh sách bán (đã cọc)'), 'room_not_lockable');
    assert.equal(await reason('55000', 'Contract is no longer current'), 'crm_refused');
    assert.equal(await reason('42501', '[THIEU_QUYEN:contracts.terminate] Bạn không có quyền'), 'not_allowed');
    assert.equal(await reason('22023', 'Invalid notice date or reason'), 'reason_required');
  });
});
