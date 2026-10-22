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
// Mốc 4: file MỚI thay hai hàm của trang (ghi nhận trả phòng); md5 thân của file trang ghim ở $requires$.
const RETURN_SQL = file('hermes_contract_return_v1');
// Mốc 5: file MỚI — hàm tra khách INVOKER, vỏ dựng lại, bước ghi dựng từ thân 061813 (md5 ghim ở $requires$).
const PARTY_SQL = file('hermes_contract_party_draft_v1');
const plain = sql => sql.replace(/^BEGIN;|^COMMIT;|^NOTIFY pgrst[^\n]*/gm, '');
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

// Dựng chung cho các test của trang: fixture Hermes thật + M1/M2 + giải tên + hàm ngày gia hạn + file trang, mỗi file chạy hai lần
// (chạy lại được). `support`/`migrations`: fixture bổ sung và migration nối tiếp của mốc sau (vd Mốc 4).
async function pageSetup(t, { support = '', migrations = [] } = {}) {
  const f = await setup(t, { action: `${SUPPORT}\n${support}\n${RESOLVE}\n${plain(RENEWAL_DATE)}` });
  const { db, call } = f;
  await db.exec(FOUNDATION); await db.exec(KEYS);
  await db.exec(CONTRACT_ACTION_SQL); await db.exec(CONTRACT_ACTION_SQL); // Idempotent re-apply.
  for (const sql of migrations) { await db.exec(sql); await db.exec(sql); }
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
  return { f, db, call, keys, run, receipts, contract };
}
const P101 = { buildingName: 'toa a', roomName: 'P101' };

test('trang Hợp đồng — RPC thao tác (Mốc 2): báo trả / dời / huỷ, khoá tạm / gỡ khoá', { timeout: 240000 }, async t => {
  const { f, db, call, keys, run, receipts, contract } = await pageSetup(t);

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

// Review #270 mục 1–2: khoá tổ chức (giao thức ghi chung của hàm web) đứng sau guard, TRƯỚC lần kiểm biên nhận và mọi khoá dòng;
// lượt preview không khoá dòng. PGlite một kết nối không tái hiện được hai phiên song song ⇒ kiểm thứ tự trong thân bước ghi.
test('bước ghi: khoá tổ chức trước kiểm biên nhận và trước mọi FOR UPDATE; preview không khoá dòng', () => {
  for (const sql of [CONTRACT_ACTION_SQL, RETURN_SQL, PARTY_SQL]) stepLockOrder(sql);
});
function stepLockOrder(sql) {
  const body = /CREATE OR REPLACE FUNCTION app_private\.hermes_contract_action_step_v1[\s\S]*?\$fn\$;/.exec(sql)[0];
  const guard = body.indexOf('ctx:=app_private.hermes_action_guard_v1'), lock = body.indexOf('PERFORM app_private.lock_org_for_decision_v1(v_org);');
  assert.ok(guard > 0 && lock > guard, 'khoá tổ chức ngay sau guard');
  assert.ok(lock < body.indexOf('FROM app_private.hermes_action_receipts r'), 'khoá tổ chức trước khi kiểm biên nhận');
  const rowLocks = [...body.matchAll(/FOR UPDATE/g)].map(match => match.index);
  assert.ok(rowLocks.length >= 2 && rowLocks.every(index => index > lock), 'mọi khoá dòng sau khoá tổ chức');
  assert.equal([...body.matchAll(/IF p_phase='preview' THEN\n\s+SELECT \* INTO (?:c|l) FROM public\.(?:contracts|room_sale_locks) k(?:(?!FOR UPDATE)[^;])*;\n\s+ELSE\n\s+SELECT[^;]*FOR UPDATE;/g)].length, 2,
    'đọc HĐ / khoá tạm: preview không FOR UPDATE, nhánh còn lại có');
}

// Mốc 4 — fixture bổ sung: cột hồ sơ trả phòng, bảng thanh lý cũ, quyền theo toà (can_do_on_building), nợ thực của hoá đơn (port
// hàm dùng chung #267: remaining_amount, ghi đè được để chứng minh lookup đi qua hàm này) và bản port DEFERRED tối giản của hàm ghi
// web confirm_contract_return_v1 (giữ chữ ký, rào, câu lỗi). bad: 'return_money' sinh hoá đơn 1đ, 'return_zero' sinh dòng 0đ (chỉ
// phép ĐẾM bắt), 'return_amount' sửa tiền hoá đơn có sẵn (chỉ phép TỔNG bắt), 'return_status' không đổi HĐ, 'return_case' lưu khoá
// idempotency khác (để thử hậu điều kiện).
const RETURN_SUPPORT = `ALTER TABLE public.contract_exit_cases ADD COLUMN IF NOT EXISTS building_id uuid, ADD COLUMN IF NOT EXISTS actual_move_out_on date,
    ADD COLUMN IF NOT EXISTS initial_kind text, ADD COLUMN IF NOT EXISTS current_kind text, ADD COLUMN IF NOT EXISTS settlement_mode text,
    ADD COLUMN IF NOT EXISTS physical_actor uuid, ADD COLUMN IF NOT EXISTS physical_idempotency_key text, ADD COLUMN IF NOT EXISTS return_note text;
  CREATE TABLE IF NOT EXISTS public.contract_terminations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid UNIQUE,status text);
  CREATE TABLE IF NOT EXISTS public.fixture_outstanding(invoice_id uuid PRIMARY KEY,effective numeric);
  GRANT SELECT ON public.invoices,public.fixture_outstanding TO authenticated;
  CREATE OR REPLACE FUNCTION public.can_do_on_building(_table text,_action text,_building_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ SELECT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission=_table||'.'||_action AND allowed
      AND (org_wide OR _building_id=ANY(building_ids))) $f$;
  CREATE OR REPLACE FUNCTION public.invoice_effective_outstanding_v1(p_invoice_ids uuid[]) RETURNS TABLE(invoice_id uuid,remaining_amount numeric,
    carried_out_amount numeric,carried_in_amount numeric,effective_outstanding numeric,effective_outstanding_at_carrier numeric)
    LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $f$
    SELECT i.id,i.remaining_amount,0::numeric,0::numeric,COALESCE(o.effective,i.remaining_amount),COALESCE(o.effective,i.remaining_amount)
      FROM public.invoices i LEFT JOIN public.fixture_outstanding o ON o.invoice_id=i.id WHERE i.id=ANY(p_invoice_ids) $f$;
  GRANT EXECUTE ON FUNCTION public.can_do_on_building(text,text,uuid),public.invoice_effective_outstanding_v1(uuid[]) TO authenticated;
  CREATE OR REPLACE FUNCTION public.confirm_contract_return_v1(p_organization_id uuid,p_contract_id uuid,p_expected_contract_updated_at timestamptz,
    p_idempotency_key text,p_actual_move_out_on date,p_initial_kind text,p_settlement_mode text,p_settlement jsonb DEFAULT NULL,p_meter_boundary jsonb DEFAULT NULL,
    p_return_note text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $w$
    DECLARE c public.contracts; v_room public.rooms; e public.contract_exit_cases; v_key text:=btrim(p_idempotency_key);
      v_bad text:=(SELECT bad FROM public.fixture_contract_writer);
    BEGIN
      IF NULLIF(btrim(p_return_note),'') IS NULL THEN RAISE EXCEPTION 'Vui lòng nhập nội dung thanh lý để đối chiếu sau này' USING ERRCODE='22023'; END IF;
      IF p_actual_move_out_on IS NULL OR p_initial_kind IS NULL OR p_initial_kind NOT IN ('NATURAL_EXPIRY','EARLY_RETURN','FORFEIT')
        OR p_settlement_mode IS DISTINCT FROM 'DEFERRED' OR p_settlement IS NOT NULL OR v_key IS NULL OR v_key!~'^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
        RAISE EXCEPTION 'Actual date, initial kind, mode and request key are required' USING ERRCODE='22023'; END IF;
      IF (SELECT raise_state FROM public.fixture_contract_writer) IS NOT NULL THEN
        RAISE EXCEPTION 'fixture writer refused' USING ERRCODE=(SELECT raise_state FROM public.fixture_contract_writer); END IF;
      SELECT * INTO c FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Contract not found' USING ERRCODE='42501'; END IF;
      SELECT * INTO v_room FROM public.rooms WHERE id=c.room_id;
      IF NOT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission='contracts.terminate' AND allowed AND (org_wide OR v_room.building_id=ANY(building_ids)))
        THEN RAISE EXCEPTION '[THIEU_QUYEN:contracts.terminate] Bạn không có quyền trả phòng / thanh lý hợp đồng ở toà nhà này.' USING ERRCODE='42501'; END IF;
      PERFORM 1 FROM public.contract_exit_cases WHERE contract_id=p_contract_id;
      IF FOUND THEN RAISE EXCEPTION 'Contract has already been physically returned' USING ERRCODE='PT409'; END IF;
      IF c.updated_at IS DISTINCT FROM p_expected_contract_updated_at THEN RAISE EXCEPTION 'Contract changed; reload before returning' USING ERRCODE='PT409'; END IF;
      IF p_actual_move_out_on>public.org_today_v1(p_organization_id) THEN
        RAISE EXCEPTION 'Actual return date cannot be in the future; use a planned notice' USING ERRCODE='22023'; END IF;
      IF c.status<>'ACTIVE' OR c.actual_end_date IS NOT NULL OR p_actual_move_out_on<c.start_date
        OR EXISTS(SELECT 1 FROM public.contract_terminations t WHERE t.contract_id=c.id) THEN
        RAISE EXCEPTION 'Contract is not eligible for an actual return' USING ERRCODE='55000'; END IF;
      INSERT INTO public.contract_exit_cases(organization_id,building_id,contract_id,actual_move_out_on,initial_kind,current_kind,settlement_mode,state,
        physical_actor,physical_idempotency_key,return_note)
        VALUES(c.organization_id,v_room.building_id,c.id,p_actual_move_out_on,p_initial_kind,p_initial_kind,'DEFERRED','PENDING',auth.uid(),
          CASE WHEN v_bad='return_case' THEN 'khac:'||v_key ELSE v_key END,btrim(p_return_note)) RETURNING * INTO e;
      IF v_bad IS DISTINCT FROM 'return_status' THEN
        UPDATE public.contracts SET status='TERMINATED',actual_end_date=p_actual_move_out_on,updated_at=clock_timestamp() WHERE id=c.id;
        UPDATE public.rooms SET status='AVAILABLE' WHERE id=c.room_id; END IF;
      IF v_bad IN ('return_money','return_zero') THEN INSERT INTO public.invoices(id,organization_id,contract_id,total_amount)
        VALUES(gen_random_uuid(),c.organization_id,c.id,CASE WHEN v_bad='return_money' THEN 1 ELSE 0 END); END IF;
      IF v_bad='return_amount' THEN UPDATE public.invoices SET total_amount=total_amount+1 WHERE contract_id=c.id AND status='PAID'; END IF;
      RETURN jsonb_build_object('id',e.id,'state',e.state,'settlement_mode',e.settlement_mode);
    END $w$;`;

test('trang Hợp đồng — Mốc 4: ghi nhận khách trả phòng, quyết toán sau (20261022061813)', { timeout: 240000 }, async t => {
  const { f, db, call, run, receipts } = await pageSetup(t, { support: RETURN_SUPPORT, migrations: [RETURN_SQL] });
  await db.query(`INSERT INTO public.fixture_acl(permission,building_ids) VALUES('invoices.view',$1)
    ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true`, [[BUILDING, OTHER_BUILDING]]);
  await db.query("UPDATE public.contracts SET deposit_paid=4500000,total_deposit=4500000 WHERE id=$1", [CONTRACT]);
  const inv = n => `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`;
  await db.query(`INSERT INTO public.invoices(id,organization_id,contract_id,status,total_amount,paid_amount) VALUES
    ($1,$4,$5,'APPROVED',1500000,0),($2,$4,$5,'PAID',1000000,1000000),($3,$4,$5,'CANCELLED',500000,0)`, [inv(1), inv(2), inv(3), ORG, CONTRACT]);
  const base = { ...P101, date: '2026-10-20', note: 'Khách trả phòng, bàn giao đủ' };
  const state = async () => (await db.query(`SELECT k.status,k.actual_end_date::text d,(SELECT count(*)::int FROM public.contract_exit_cases x WHERE x.contract_id=k.id) cases
    FROM public.contracts k WHERE k.id=$1`, [CONTRACT])).rows[0];

  await t.test('chính sách: contract.return cùng khoá contracts.terminate, irreversible, luôn xem trước', async () => {
    const caps = await call('SELECT public.hermes_action_capabilities_v1($1::uuid) result', [ORG]);
    assert.deepEqual(caps.actions['contract.return'], { capability: 'contracts.terminate', actionClass: 'irreversible', confirm: 'always', privateOnly: true });
  });

  await t.test('xem trước: nói rõ không lùi được + quyết toán trên web; loại suy từ ngày; cọc + hoá đơn chưa thu qua hàm dùng chung', async () => {
    await f.rollbackCase(async () => {
      const preview = await run('contract.return', 'auto', rid(200), base);
      assert.equal(preview.kind, 'preview', 'irreversible: lượt auto vẫn chỉ xem trước'); assert.equal(preview.confirm, 'required');
      assert.equal(preview.preview.text, 'Sẽ ghi nhận khách TRẢ PHÒNG phòng P101 toà Toà A (HĐ HĐ-THU-001, khách Khách Thử): ngày trả thứ Ba 20/10/2026 ' +
        '(2 ngày trước), loại: trả sớm. Sau khi ghi: HĐ chuyển Đã thanh lý, phòng thành trống, KHÔNG lùi được. Quyết toán (hoàn cọc, trừ tiền, ' +
        'chỉ số chốt) làm trên web. Cọc đã thu 4.500.000đ; hoá đơn chưa thu: 1 hoá đơn, 1.500.000đ; chỉ số điện nước khi trả: chưa ghi. ' +
        'Nội dung thanh lý: "Khách trả phòng, bàn giao đủ".');
      assert.deepEqual([preview.preview.returnDate, preview.preview.kind, preview.preview.depositPaid, preview.preview.unpaidInvoices],
        ['2026-10-20', 'EARLY_RETURN', '4500000', { count: 1, amount: '1500000.00' }]);
      assert.ok(preview.warnings.some(text => /^Trả trước ngày hết hạn HĐ \(28\/02\/2027\) ⇒ loại TRẢ SỚM/.test(text)), JSON.stringify(preview.warnings));
      assert.equal((await receipts()).some(row => row.request_id === rid(200)), false, 'xem trước không mở biên nhận');
      assert.deepEqual(await state(), { status: 'ACTIVE', d: null, cases: 0 });
      // Nợ thực do hàm dùng chung tính (ghi đè ⇒ đổi theo), không đọc remaining_amount trực tiếp.
      await db.query('INSERT INTO public.fixture_outstanding VALUES($1,0)', [inv(1)]);
      assert.match((await run('contract.return', 'preview', rid(201), base)).preview.text, /hoá đơn chưa thu: không có;/);
      // Không có quyền xem hoá đơn ở toà ⇒ không lộ số.
      await db.query("UPDATE public.fixture_acl SET allowed=false WHERE permission='invoices.view'");
      const hidden = await run('contract.return', 'preview', rid(202), base);
      assert.match(hidden.preview.text, /hoá đơn chưa thu: không xem được \(cần quyền xem hoá đơn\);/);
      assert.equal(Object.hasOwn(hidden.preview, 'unpaidInvoices'), false);
    });
    await f.rollbackCase(async () => {
      assert.equal((await run('contract.return', 'preview', rid(203), { ...base, forfeit: true })).preview.kind, 'FORFEIT', 'bỏ cọc chỉ khi người dùng nói');
      assert.equal((await run('contract.return', 'preview', rid(206), { ...base, forfeit: false })).preview.kind, 'EARLY_RETURN', 'forfeit=false không phải bỏ cọc');
      await db.query("UPDATE public.contracts SET end_date='2026-10-15' WHERE id=$1", [CONTRACT]);
      const natural = await run('contract.return', 'preview', rid(204), base);
      assert.deepEqual([natural.preview.kind, natural.warnings.some(text => /TRẢ SỚM/.test(text))], ['NATURAL_EXPIRY', false], 'ngày trả ≥ ngày hết hạn');
      await db.query("UPDATE public.contracts SET expected_move_out_date='2026-10-25' WHERE id=$1", [CONTRACT]);
      assert.ok((await run('contract.return', 'preview', rid(205), base)).warnings.some(text => /^Báo trả trước đó là 25\/10\/2026; ngày trả thực tế ghi 20\/10\/2026\./.test(text)));
    });
  });

  await t.test('rào: ngày tương lai ⇒ báo trả; trước ngày bắt đầu; thiếu nội dung; thanh lý cũ ⇒ already_returned', async () => {
    await f.rollbackCase(async () => {
      assert.deepEqual(await run('contract.return', 'preview', rid(210), { ...base, date: '2026-10-23' }), { kind: 'needs_input', reason: 'return_date_future' });
      assert.deepEqual(await run('contract.return', 'preview', rid(211), { ...base, date: '2026-02-28' }), { kind: 'needs_input', reason: 'date_out_of_range' });
      assert.deepEqual(await run('contract.return', 'preview', rid(212), { ...P101, date: '2026-10-20', note: ' ' }), { kind: 'needs_input', reason: 'invalid_params' });
      assert.deepEqual(await run('contract.return', 'preview', rid(213), { ...base, forfeit: 'có' }), { kind: 'needs_input', reason: 'invalid_params' });
      assert.deepEqual(await run('contract.return', 'preview', rid(214), { ...base, date: '20/10/2026' }), { kind: 'needs_input', reason: 'invalid_params' });
      await db.query("INSERT INTO public.contract_terminations(contract_id,status) VALUES($1,'COMPLETED')", [CONTRACT]);
      assert.deepEqual(await run('contract.return', 'preview', rid(215), base), { kind: 'rejected', reason: 'already_returned' });
    });
  });

  await t.test('ghi: DEFERRED qua hàm web, đúng một hồ sơ PENDING khoá hermes:<requestId>, biên nhận; phát lại; lần sau ⇒ already_returned', async () => {
    await f.rollbackCase(async () => {
      const preview = await run('contract.return', 'preview', rid(220), base);
      const applied = await run('contract.return', 'apply', rid(220), base, preview);
      assert.equal(applied.kind, 'applied'); assert.equal(applied.link, `/contracts/${CONTRACT}`);
      assert.match(applied.result.text, /^Đã ghi nhận khách trả phòng phòng P101 toà Toà A \(HĐ HĐ-THU-001, khách Khách Thử\): ngày trả thứ Ba 20\/10\/2026 \(2 ngày trước\), loại: trả sớm\. HĐ đã chuyển Đã thanh lý, phòng trống\. Quyết toán/);
      assert.deepEqual([applied.result.returnDate, applied.result.kind, applied.result.roomStatus, applied.result.nextStep],
        ['2026-10-20', 'EARLY_RETURN', 'AVAILABLE', `Quyết toán trên web: /contracts/${CONTRACT}`]);
      assert.deepEqual(await state(), { status: 'TERMINATED', d: '2026-10-20', cases: 1 });
      const exit = (await db.query('SELECT id,state,settlement_mode,physical_idempotency_key k,initial_kind FROM public.contract_exit_cases WHERE contract_id=$1', [CONTRACT])).rows[0];
      assert.deepEqual([exit.state, exit.settlement_mode, exit.k, exit.initial_kind, applied.result.exitCaseId], ['PENDING', 'DEFERRED', `hermes:${rid(220)}`, 'EARLY_RETURN', exit.id]);
      assert.deepEqual((await receipts()).filter(row => row.request_id === rid(220)).map(row => row.state), ['applied']);
      assert.equal((await db.query('SELECT count(*)::int n FROM public.invoices WHERE contract_id=$1', [CONTRACT])).rows[0].n, 3, 'không phát sinh hoá đơn');
      assert.deepEqual(await run('contract.return', 'apply', rid(220), base, preview), applied, 'phát lại cùng requestId: không ghi lần hai');
      assert.deepEqual(await run('contract.return', 'preview', rid(221), base), { kind: 'rejected', reason: 'already_returned' }, 'requestId mới');
      assert.deepEqual(await run('contract.notice_set', 'auto', rid(222), { ...P101, date: '2026-10-30' }), { kind: 'rejected', reason: 'already_returned' });
    });
    await f.rollbackCase(async () => {
      // HĐ đổi giữa hai lượt ⇒ state_changed, không ghi.
      const preview = await run('contract.return', 'preview', rid(223), base);
      await db.query("UPDATE public.contracts SET expected_move_out_date='2026-10-30',updated_at=clock_timestamp() WHERE id=$1", [CONTRACT]);
      assert.deepEqual(await run('contract.return', 'apply', rid(223), base, preview), { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual(await state(), { status: 'ACTIVE', d: null, cases: 0 });
    });
  });

  await t.test('hậu điều kiện: hàm ghi sinh tiền / không đổi HĐ / sai khoá ⇒ lùi về savepoint, crm_refused', async () => {
    for (const [index, bad] of ['return_money', 'return_zero', 'return_amount', 'return_status', 'return_case'].entries()) await f.rollbackCase(async () => {
      await db.query('UPDATE public.fixture_contract_writer SET bad=$1', [bad]);
      const preview = await run('contract.return', 'preview', rid(230 + index), base);
      assert.deepEqual(await run('contract.return', 'apply', rid(230 + index), base, preview), { kind: 'rejected', reason: 'crm_refused' }, bad);
      assert.deepEqual(await state(), { status: 'ACTIVE', d: null, cases: 0 }, bad);
      assert.equal((await db.query('SELECT count(*)::int n FROM public.invoices WHERE contract_id=$1', [CONTRACT])).rows[0].n, 3, bad);
      assert.deepEqual((await receipts()).filter(row => row.request_id === rid(230 + index)).map(row => row.state), ['rejected'], bad);
    });
  });

  await t.test('$requires$: thân bước ghi đang chạy khác thân 20261022022951 ⇒ dừng; đúng thân ⇒ nhận (md5 ghim khớp Postgres)', async () => {
    const original = /CREATE OR REPLACE FUNCTION app_private\.hermes_contract_action_step_v1[\s\S]*?END \$fn\$;/.exec(CONTRACT_ACTION_SQL)[0];
    const lookup = /CREATE OR REPLACE FUNCTION public\.hermes_contract_action_lookup_v1[\s\S]*?END \$fn\$;/.exec(CONTRACT_ACTION_SQL)[0];
    await f.rollbackCase(async () => {
      await db.exec(original.replace('-- Lượt preview chỉ đọc', '-- Lượt preview (thân lạ) chỉ đọc')); await db.exec(lookup);
      await assert.rejects(db.exec(plain(RETURN_SQL)), /hermes_contract_return_base_changed/);
    });
    await f.rollbackCase(async () => {
      await db.exec(original); await db.exec(lookup);
      await db.exec(plain(RETURN_SQL));
      assert.match((await db.query("SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure")).rows[0].prosrc, /contract\.return/);
    });
  });
});

// Mốc 5 — fixture bổ sung: cột khách/thành viên HĐ, bảng nháp, bản port tối giản của reconcile_contract_customers_v1 (giữ chữ ký,
// khuôn p_expected, PT409 khi danh sách đổi, quyền contracts.edit theo toà; như web: KHÔNG chặn bỏ người đại diện) và của
// save_contract_draft (allowlist payload, request_id + draft_id bắt buộc, quyền contracts.create theo toà). bad: 'party_rep' hạ cờ
// đại diện, 'party_extra' thêm người lạ, 'draft_contract' sinh HĐ, 'draft_room' đổi trạng thái phòng (để thử hậu điều kiện).
const PARTY_SUPPORT = `ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS id_number text, ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
  ALTER TABLE public.contract_customers ADD COLUMN IF NOT EXISTS notes text;
  CREATE TABLE IF NOT EXISTS public.contract_drafts(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,room_id uuid,payload jsonb,template_id uuid,
    revision integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'EDITABLE',created_by uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE OR REPLACE FUNCTION public.reconcile_contract_customers_v1(p_organization_id uuid,p_contract_id uuid,p_expected jsonb,p_customers jsonb)
    RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $w$
    DECLARE c public.contracts; b uuid; actual jsonb; expected jsonb; desired jsonb; v_bad text:=(SELECT bad FROM public.fixture_contract_writer);
    BEGIN
      SELECT * INTO c FROM public.contracts WHERE id=p_contract_id FOR UPDATE;
      SELECT building_id INTO b FROM public.rooms WHERE id=c.room_id;
      IF c.id IS NULL OR c.organization_id IS DISTINCT FROM p_organization_id OR NOT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission='contracts.edit'
        AND allowed AND (org_wide OR b=ANY(building_ids))) THEN RAISE EXCEPTION 'Không có quyền sửa khách hợp đồng' USING ERRCODE='42501'; END IF;
      IF (SELECT raise_state FROM public.fixture_contract_writer) IS NOT NULL THEN
        RAISE EXCEPTION 'fixture writer refused' USING ERRCODE=(SELECT raise_state FROM public.fixture_contract_writer); END IF;
      IF c.status NOT IN ('ACTIVE','EXTENDED','EXPIRED','DRAFT') THEN RAISE EXCEPTION 'Hợp đồng đã đóng' USING ERRCODE='55000'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_customers) j LEFT JOIN public.customers cu ON cu.id=(j->>'customer_id')::uuid
        WHERE cu.id IS NULL OR cu.organization_id IS DISTINCT FROM p_organization_id) THEN
        RAISE EXCEPTION 'Customer organization mismatch' USING ERRCODE='42501'; END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('customer_id',customer_id,'is_representative',is_representative,'notes',notes) ORDER BY customer_id),'[]')
        INTO actual FROM public.contract_customers WHERE contract_id=p_contract_id;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('customer_id',j->>'customer_id','is_representative',(j->>'is_representative')::boolean,'notes',j->>'notes')
        ORDER BY j->>'customer_id'),'[]') INTO expected FROM jsonb_array_elements(p_expected) j;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('customer_id',j->>'customer_id','is_representative',(j->>'is_representative')::boolean,'notes',j->>'notes')
        ORDER BY j->>'customer_id'),'[]') INTO desired FROM jsonb_array_elements(p_customers) j;
      IF actual=desired THEN RETURN actual; END IF;
      IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Danh sách khách đã thay đổi; tải lại để đối chiếu' USING ERRCODE='PT409'; END IF;
      DELETE FROM public.contract_customers WHERE contract_id=p_contract_id AND customer_id NOT IN (SELECT (j->>'customer_id')::uuid FROM jsonb_array_elements(desired) j);
      INSERT INTO public.contract_customers(contract_id,customer_id,is_representative,notes) SELECT p_contract_id,(j->>'customer_id')::uuid,
        (j->>'is_representative')::boolean,j->>'notes' FROM jsonb_array_elements(desired) j WHERE NOT EXISTS(SELECT 1 FROM public.contract_customers cc
        WHERE cc.contract_id=p_contract_id AND cc.customer_id=(j->>'customer_id')::uuid);
      IF v_bad='party_rep' THEN UPDATE public.contract_customers SET is_representative=false WHERE contract_id=p_contract_id; END IF;
      IF v_bad='party_extra' THEN INSERT INTO public.contract_customers(contract_id,customer_id,is_representative)
        SELECT p_contract_id,cu.id,false FROM public.customers cu WHERE cu.organization_id=p_organization_id AND NOT EXISTS(SELECT 1 FROM public.contract_customers cc
          WHERE cc.contract_id=p_contract_id AND cc.customer_id=cu.id) ORDER BY cu.id LIMIT 1; END IF;
      RETURN desired;
    END $w$;
  CREATE OR REPLACE FUNCTION public.save_contract_draft(p_organization_id uuid,p_building_id uuid,p_room_id uuid,p_payload jsonb,p_template_id uuid DEFAULT NULL,
    p_draft_id uuid DEFAULT NULL,p_expected_revision integer DEFAULT NULL,p_request_id uuid DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $w$
    DECLARE d public.contract_drafts; f jsonb:=p_payload->'form'; v_bad text:=(SELECT bad FROM public.fixture_contract_writer);
    BEGIN
      IF p_request_id IS NULL THEN RAISE EXCEPTION 'Thiếu định danh lần lưu nháp' USING ERRCODE='22023'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission='contracts.create' AND allowed AND (org_wide OR p_building_id=ANY(building_ids)))
        THEN RAISE EXCEPTION 'Không có quyền lưu bản nháp' USING ERRCODE='42501'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=p_room_id AND r.building_id=p_building_id AND r.organization_id=p_organization_id) THEN
        RAISE EXCEPTION 'Phòng không thuộc phạm vi bản nháp' USING ERRCODE='42501'; END IF;
      IF jsonb_typeof(p_payload)<>'object' OR NOT (p_payload ?& ARRAY['form','customers','services','use_custom_services'])
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('form','customers','services','use_custom_services','owner','editor_state'))
        OR (SELECT count(*) FROM jsonb_object_keys(f))<>12 OR NOT (f ?& ARRAY['room_id','signed_date','start_date','end_date','rent_price','total_deposit',
          'payment_cycle','start_billing_date','end_billing_date','notes','discount_months','discount_amount_per_month'])
        OR f->>'room_id' IS DISTINCT FROM p_room_id::text OR f->>'payment_cycle' NOT IN ('MONTHLY','QUARTERLY','SEMI_ANNUAL','ANNUAL')
        OR EXISTS(SELECT 1 FROM unnest(ARRAY['rent_price','total_deposit','discount_months','discount_amount_per_month']) k WHERE jsonb_typeof(f->k)<>'number')
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'customers') j WHERE (SELECT count(*) FROM jsonb_object_keys(j))<>6
          OR jsonb_typeof(j->'full_name')<>'string' OR jsonb_typeof(j->'phone')<>'string' OR jsonb_typeof(j->'is_representative')<>'boolean') THEN
        RAISE EXCEPTION 'Trường nháp không hợp lệ' USING ERRCODE='22023'; END IF;
      IF p_draft_id IS NULL THEN RAISE EXCEPTION 'Thiếu định danh bản nháp' USING ERRCODE='22023'; END IF;
      IF EXISTS(SELECT 1 FROM public.contract_drafts WHERE id=p_draft_id) THEN RAISE EXCEPTION 'Bản nháp đã tồn tại' USING ERRCODE='40001'; END IF;
      INSERT INTO public.contract_drafts(id,organization_id,building_id,room_id,payload,template_id,created_by)
        VALUES(p_draft_id,p_organization_id,p_building_id,p_room_id,p_payload,p_template_id,auth.uid()) RETURNING * INTO d;
      IF v_bad='draft_contract' THEN INSERT INTO public.contracts(id,organization_id,room_id,status,contract_number)
        VALUES(gen_random_uuid(),p_organization_id,p_room_id,'ACTIVE','HĐ-LẠ'); END IF;
      IF v_bad='draft_room' THEN UPDATE public.rooms SET status='RESERVED' WHERE id=p_room_id; END IF;
      RETURN to_jsonb(d);
    END $w$;`;

test('trang Hợp đồng — Mốc 5: thêm / bớt người ở + soạn nháp HĐ (20261022074815)', { timeout: 240000 }, async t => {
  const { f, db, call, run, receipts } = await pageSetup(t, { support: `${RETURN_SUPPORT}\n${PARTY_SUPPORT}`, migrations: [RETURN_SQL, PARTY_SQL] });
  const more = ['contracts.edit', 'contracts.create'];
  await db.query("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=ANY($1) AND mode='action'", [more]);
  for (const permission of more)
    await db.query('INSERT INTO public.fixture_acl(permission,building_ids) VALUES($1,$2) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true',
      [permission, [BUILDING, OTHER_BUILDING]]);
  await db.query('UPDATE app_private.hermes_org_policies SET action_capabilities=action_capabilities||$1::text[]', [more]);
  await db.query('UPDATE app_private.hermes_connections SET action_capabilities=action_capabilities||$1::text[]', [more]);
  const c = n => `00000000-0000-4000-8000-${String(950 + n).padStart(12, '0')}`;
  await db.query(`INSERT INTO public.customers(id,organization_id,full_name,phone,id_number) VALUES
    ($1,$5,'Nguyễn Văn Hai','0912.345.678','079000000002'),($2,$5,'Trần Thị Ba','+84 913 000 003',null),($3,$5,'Nguyễn Văn Hai','0914000004',null),
    ($4,'00000000-0000-4000-8000-0000000000ff','Khách Công Ty Khác','0915000005',null)`, [c(1), c(2), c(3), c(4), ORG]);
  const members = async () => (await db.query('SELECT customer_id::text id,is_representative r FROM public.contract_customers WHERE contract_id=$1 ORDER BY customer_id',
    [CONTRACT])).rows;
  const drafts = async () => (await db.query('SELECT id,room_id,status,payload FROM public.contract_drafts ORDER BY created_at,id')).rows;

  await t.test('chính sách: người ở theo contracts.edit, nháp theo contracts.create, đều ghi thẳng', async () => {
    const caps = await call('SELECT public.hermes_action_capabilities_v1($1::uuid) result', [ORG]);
    for (const [action, capability] of [['contract.occupant_add', 'contracts.edit'], ['contract.occupant_remove', 'contracts.edit'], ['contract.draft', 'contracts.create']])
      assert.deepEqual(caps.actions[action], { capability, actionClass: 'reversible', confirm: 'never', privateOnly: true }, action);
  });

  await t.test('tìm khách dưới RLS: SĐT có dấu / +84 khớp đúng; tên trùng ⇒ hỏi lại có ứng viên; không thấy / không quyền xem khách ⇒ hỏi lại', async () => {
    await f.rollbackCase(async () => {
      const added = await run('contract.occupant_add', 'auto', rid(300), { ...P101, customerPhone: '0912 345 678' });
      assert.equal(added.kind, 'applied', JSON.stringify(added));
      assert.equal(added.result.text, 'Đã thêm người ở Nguyễn Văn Hai vào phòng P101 toà Toà A (HĐ HĐ-THU-001, khách Khách Thử) (không phải người đại diện). HĐ có 2 người ở.');
      assert.deepEqual(await members(), [{ id: CUSTOMER, r: true }, { id: c(1), r: false }].sort((a, b) => a.id.localeCompare(b.id)));
      assert.deepEqual((await receipts()).filter(row => row.request_id === rid(300)).map(row => row.state), ['applied']);
      const again = await run('contract.occupant_add', 'auto', rid(301), { ...P101, customerPhone: '0912345678' });
      assert.deepEqual([again.kind, again.result.changed, again.result.text], ['applied', false, 'Nguyễn Văn Hai đã ở trong phòng P101 toà Toà A (HĐ HĐ-THU-001, khách Khách Thử); không đổi. HĐ có 2 người ở.']);
      assert.equal((await run('contract.occupant_add', 'auto', rid(302), { ...P101, customerPhone: '84913000003' })).kind, 'applied', '+84 ⇒ 0');
      const ambiguous = await run('contract.occupant_add', 'auto', rid(303), { ...P101, customerName: 'nguyen van hai' });
      assert.deepEqual([ambiguous.kind, ambiguous.reason, ambiguous.field, ambiguous.why], ['needs_input', 'name_unresolved', 'customer', 'ambiguous']);
      assert.deepEqual(ambiguous.candidates, [{ name: 'Nguyễn Văn Hai · …678' }, { name: 'Nguyễn Văn Hai · …004' }]);
      assert.equal(JSON.stringify(ambiguous).includes('0912'), false, 'không lộ đủ SĐT');
      const missing = await run('contract.occupant_add', 'auto', rid(304), { ...P101, customerPhone: '0915000005' });
      assert.deepEqual([missing.reason, missing.why, missing.candidates], ['name_unresolved', 'not_visible', []], 'khách công ty khác');
      assert.deepEqual(await run('contract.occupant_add', 'auto', rid(305), P101), { kind: 'needs_input', reason: 'invalid_params' }, 'không nêu khách');
      await db.query("UPDATE public.fixture_acl SET allowed=false WHERE permission='customers.view'");
      assert.equal((await run('contract.occupant_add', 'auto', rid(306), { ...P101, customerPhone: '0914000004' })).why, 'not_visible', 'RLS customers');
    });
  });

  await t.test('bớt người ở: chỉ người trong HĐ; không bỏ người đại diện; phòng trống ⇒ không có HĐ', async () => {
    await f.rollbackCase(async () => {
      await db.query('INSERT INTO public.contract_customers(contract_id,customer_id,is_representative,notes) VALUES($1,$2,false,$3)', [CONTRACT, c(1), 'ở ghép']);
      await db.query('INSERT INTO public.contract_customers(contract_id,customer_id,is_representative) VALUES($1,$2,false)', [CONTRACT, c(2)]);
      const removed = await run('contract.occupant_remove', 'auto', rid(310), { ...P101, customerName: 'Trần Thị Ba' });
      assert.equal(removed.result.text, 'Đã bớt người ở Trần Thị Ba khỏi phòng P101 toà Toà A (HĐ HĐ-THU-001, khách Khách Thử). HĐ có 2 người ở.');
      assert.deepEqual((await db.query('SELECT notes FROM public.contract_customers WHERE contract_id=$1 AND customer_id=$2', [CONTRACT, c(1)])).rows[0].notes, 'ở ghép',
        'ghi chú của người còn lại giữ nguyên');
      assert.deepEqual(await run('contract.occupant_remove', 'auto', rid(311), { ...P101, customerPhone: '0900000001' }),
        { kind: 'rejected', reason: 'cannot_remove_representative' });
      assert.deepEqual(await run('contract.occupant_remove', 'auto', rid(312), { ...P101, customerPhone: '0914000004' }),
        { kind: 'needs_input', reason: 'occupant_not_on_contract' }, 'khách có trong CRM nhưng không ở HĐ này');
      assert.deepEqual(await run('contract.occupant_add', 'auto', rid(313), { buildingName: 'toa a', roomName: 'P102', customerPhone: '0912345678' }),
        { kind: 'needs_input', reason: 'room_has_no_active_contract' });
      assert.ok((await members()).some(row => row.id === CUSTOMER && row.r), 'người đại diện còn nguyên');
    });
  });

  // Mốc 5b (review #277). Overlay của kết nối fixture chỉ phủ toà A ⇒ guard trả buildingIds = [toà A]; khách có HĐ ở toà B.
  const OUT_CONTRACT = '00000000-0000-4000-8000-000000000990';
  const outsideB = async () => {
    await db.query(`INSERT INTO public.customers(id,organization_id,full_name,phone) VALUES($1,$3,'Lê Văn Năm','0916000006'),($2,$3,'Nguyễn Văn Hai','0917000007')`,
      [c(5), c(6), ORG]);
    await db.query(`INSERT INTO public.contracts(id,organization_id,room_id,status,contract_number,start_date,end_date) VALUES($1,$2,$3,'ACTIVE','HĐ-B-001','2026-01-01','2026-12-31')`,
      [OUT_CONTRACT, ORG, OTHER_ROOM]);
    await db.query('INSERT INTO public.contract_customers(contract_id,customer_id,is_representative) VALUES($1,$2,true),($1,$3,false)', [OUT_CONTRACT, c(5), c(6)]);
  };

  await t.test('phạm vi = guard ∩ quyền: khách chỉ có HĐ ở toà ngoài khoá ⇒ outside_scope, không nêu tên; ứng viên chỉ trong phạm vi', async () => {
    await f.rollbackCase(async () => {
      await outsideB();
      const out = await run('contract.occupant_add', 'auto', rid(350), { ...P101, customerPhone: '0916000006' });
      assert.deepEqual(out, { kind: 'needs_input', reason: 'name_unresolved', field: 'customer', wanted: 'SĐT …006', why: 'outside_scope', candidates: [], more: false });
      assert.equal(JSON.stringify(out).includes('Năm'), false, 'không nêu tên khách ngoài phạm vi');
      const ambiguous = await run('contract.occupant_add', 'auto', rid(351), { ...P101, customerName: 'Nguyễn Văn Hai' });
      assert.deepEqual(ambiguous.candidates, [{ name: 'Nguyễn Văn Hai · …678' }, { name: 'Nguyễn Văn Hai · …004' }], 'không có ứng viên toà B');
      // Khách chưa gắn toà nào (vd vừa tạo trên web) vẫn nhận; khoá phủ cả toà B ⇒ khách toà B nhận.
      const fresh = await run('contract.occupant_add', 'auto', rid(352), { ...P101, customerPhone: '0913000003' });
      assert.equal(fresh.kind, 'applied', JSON.stringify(fresh));
      // Khách toà B từng có HĐ (đã kết thúc) ở toà A ⇒ trong phạm vi (như đọc khách theo toà: HĐ mọi trạng thái).
      await db.query('INSERT INTO public.contract_customers(contract_id,customer_id,is_representative) VALUES($1,$2,true)', [OLD_CONTRACT, c(5)]);
      const known = await run('contract.occupant_add', 'auto', rid(353), { ...P101, customerPhone: '0916000006' });
      assert.equal(known.kind, 'applied', JSON.stringify(known));
      assert.deepEqual((await receipts()).filter(row => row.request_id === rid(350) || row.request_id === rid(351)), [], 'hỏi lại không mở biên nhận');
    });
    // RLS giấu HĐ toà B (không contracts.view) ⇒ hàm tra khách tưởng khách chưa gắn toà; bước ghi DEFINER thấy mọi HĐ nên vẫn chặn.
    await f.rollbackCase(async () => {
      await outsideB();
      await db.query("UPDATE public.fixture_acl SET allowed=false WHERE permission='contracts.view'");
      const out = await run('contract.draft', 'auto', rid(354), { buildingName: 'toa a', roomName: 'P102', startDate: '2026-11-01', endDate: '2027-10-31',
        rentPrice: 3000000, deposit: 0, customerPhone: '0916000006' });
      assert.deepEqual([out.kind, out.reason, out.why, out.candidates], ['needs_input', 'name_unresolved', 'outside_scope', []]);
      assert.deepEqual(await drafts(), []);
    });
  });

  await t.test('lượt 2 kiểm lại khách: mất quyền xem / ra ngoài phạm vi / bị xoá ⇒ state_changed, không ghi', async () => {
    for (const [index, change] of [
      () => db.query("UPDATE public.fixture_acl SET allowed=false WHERE permission='customers.view'"),
      async () => { await outsideB();
        await db.query('INSERT INTO public.contract_customers(contract_id,customer_id,is_representative) VALUES($1,$2,false)', [OUT_CONTRACT, c(1)]); },
      () => db.query('UPDATE public.customers SET deleted_at=clock_timestamp() WHERE id=$1', [c(1)]),
    ].entries()) await f.rollbackCase(async () => {
      const preview = await run('contract.occupant_add', 'preview', rid(360 + index), { ...P101, customerPhone: '0912345678' });
      assert.deepEqual([preview.kind, preview.resolved.customerId], ['preview', c(1)]);
      const before = await members();
      await change();
      assert.deepEqual(await run('contract.occupant_add', 'apply', rid(360 + index), { ...P101, customerPhone: '0912345678' }, preview),
        { kind: 'rejected', reason: 'state_changed' }, String(index));
      assert.deepEqual(await members(), before, String(index));
    });
    // Bản đã giải bị đổi sang khách khác ở lượt 2: khách công ty khác ⇒ hàm tra khách không thấy; khách khác thấy được ⇒ basis
    // (gồm khách đã chọn) lệch. Cả hai ⇒ state_changed, không ghi.
    for (const [index, other] of [c(4), c(3)].entries()) await f.rollbackCase(async () => {
      const preview = await run('contract.occupant_add', 'preview', rid(364 + index), { ...P101, customerPhone: '0912345678' });
      const before = await members();
      assert.deepEqual(await run('contract.occupant_add', 'apply', rid(364 + index), { ...P101, customerPhone: '0912345678' },
        { ...preview, resolved: { ...preview.resolved, customerId: other } }), { kind: 'rejected', reason: 'state_changed' }, other);
      assert.deepEqual(await members(), before, other);
    });
  });

  await t.test('basis người ở lệch (danh sách đổi giữa hai lượt) ⇒ state_changed; phát lại cùng requestId ⇒ y nguyên, không ghi chồng', async () => {
    await f.rollbackCase(async () => {
      const preview = await run('contract.occupant_add', 'preview', rid(370), { ...P101, customerPhone: '0912345678' });
      await db.query('INSERT INTO public.contract_customers(contract_id,customer_id,is_representative) VALUES($1,$2,false)', [CONTRACT, c(2)]);
      const before = await members();
      assert.deepEqual(await run('contract.occupant_add', 'apply', rid(370), { ...P101, customerPhone: '0912345678' }, preview),
        { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual(await members(), before);
    });
    await f.rollbackCase(async () => {
      const first = await run('contract.occupant_add', 'auto', rid(371), { ...P101, customerPhone: '0912 345 678' });
      assert.deepEqual([first.kind, first.result.changed], ['applied', true]);
      // Cùng requestId: cùng SĐT (khác cách viết, cùng băm) ⇒ phát lại y nguyên; SĐT khác ⇒ request_conflict. Danh sách không đổi.
      assert.deepEqual(await run('contract.occupant_add', 'auto', rid(371), { ...P101, customerPhone: '0912 345 678' }), first);
      assert.deepEqual(await run('contract.occupant_add', 'auto', rid(371), { ...P101, customerPhone: '+84912345678' }), first);
      assert.deepEqual(await run('contract.occupant_add', 'auto', rid(371), { ...P101, customerPhone: '0913000003' }), { kind: 'rejected', reason: 'request_conflict' });
      assert.equal((await members()).length, 2);
      const removed = await run('contract.occupant_remove', 'auto', rid(372), { ...P101, customerPhone: '0912345678' });
      assert.equal(removed.kind, 'applied');
      assert.deepEqual(await run('contract.occupant_remove', 'auto', rid(372), { ...P101, customerPhone: '0912345678' }), removed, 'phát lại sau khi đã bớt');
      assert.equal((await members()).length, 1);
      // Biên nhận không giữ SĐT dạng chữ.
      const stored = (await db.query("SELECT input::text t FROM app_private.hermes_action_receipts WHERE request_id=ANY($1)", [[rid(371), rid(372)]])).rows;
      assert.equal(stored.length, 2);
      for (const { t: text } of stored) {
        assert.match(text, /"customerPhoneSha256": "[0-9a-f]{64}"/);
        assert.equal(/345.?678/.test(text.replace(/[0-9a-f]{64}/g, '')), false, text);
      }
    });
  });

  await t.test('bớt người có ghi chú ⇒ máy chủ đòi xác nhận, nói ghi chú sẽ mất', async () => {
    await f.rollbackCase(async () => {
      await db.query('INSERT INTO public.contract_customers(contract_id,customer_id,is_representative,notes) VALUES($1,$2,false,$3)', [CONTRACT, c(1), 'ở ghép']);
      const preview = await run('contract.occupant_remove', 'auto', rid(380), { ...P101, customerPhone: '0912345678' });
      assert.deepEqual([preview.kind, preview.confirm], ['preview', 'required']);
      assert.deepEqual(preview.warnings, ['Ghi chú của Nguyễn Văn Hai trên HĐ sẽ mất (thêm lại không khôi phục): "ở ghép".']);
      assert.equal(preview.preview.text, 'Sẽ bớt người ở Nguyễn Văn Hai khỏi phòng P101 toà Toà A (HĐ HĐ-THU-001, khách Khách Thử); xoá cả ghi chú của người này trên HĐ ("ở ghép").');
      assert.equal((await members()).length, 2, 'chưa ghi');
      const applied = await run('contract.occupant_remove', 'apply', rid(380), { ...P101, customerPhone: '0912345678' }, preview);
      assert.equal(applied.result.text, 'Đã bớt người ở Nguyễn Văn Hai khỏi phòng P101 toà Toà A (HĐ HĐ-THU-001, khách Khách Thử); xoá cả ghi chú của người này trên HĐ ("ở ghép"). HĐ có 1 người ở.');
    });
  });

  await t.test('HĐ EXTENDED: nháp cảnh báo phòng còn HĐ như web; thao tác người ở giữ tra cứu ACTIVE của Mốc 2–4', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.contracts SET status='EXTENDED' WHERE id=$1", [CONTRACT]);
      const busy = await run('contract.draft', 'auto', rid(390), { ...P101, startDate: '2026-11-01', endDate: '2027-10-31', rentPrice: 4500000, deposit: 4500000 });
      assert.deepEqual([busy.kind, busy.confirm], ['preview', 'required']);
      assert.deepEqual(busy.warnings, ['Phòng đang có HĐ HĐ-THU-001 tới 28/02/2027, mà nháp bắt đầu 01/11/2026: kiểm lại trước khi ký.']);
      assert.deepEqual(await run('contract.occupant_add', 'auto', rid(391), { ...P101, customerPhone: '0912345678' }),
        { kind: 'needs_input', reason: 'room_has_no_active_contract' });
    });
  });

  await t.test('hậu điều kiện người ở: hàm ghi hạ cờ đại diện / thêm người lạ ⇒ lùi, crm_refused', async () => {
    for (const [index, bad] of ['party_rep', 'party_extra'].entries()) await f.rollbackCase(async () => {
      await db.query('UPDATE public.fixture_contract_writer SET bad=$1', [bad]);
      const before = await members();
      assert.deepEqual(await run('contract.occupant_add', 'auto', rid(320 + index), { ...P101, customerPhone: '0912345678' }),
        { kind: 'rejected', reason: 'crm_refused' }, bad);
      assert.deepEqual(await members(), before, bad);
      assert.deepEqual((await receipts()).filter(row => row.request_id === rid(320 + index)).map(row => row.state), ['rejected'], bad);
    });
  });

  await t.test('nháp: phòng trống ⇒ ghi thẳng đúng allowlist; trùng 24 giờ / phòng còn HĐ ⇒ máy chủ đòi xác nhận; ngày/giá sai', async () => {
    await f.rollbackCase(async () => {
      const P102 = { buildingName: 'toa a', roomName: 'P102' };
      const base = { ...P102, startDate: '2026-11-01', endDate: '2027-10-31', rentPrice: 3200000, deposit: 3200000, customerPhone: '0912345678', note: 'Khách hẹn ký 30/10' };
      const made = await run('contract.draft', 'auto', rid(330), base);
      assert.equal(made.kind, 'applied', JSON.stringify(made)); assert.equal(made.link, '/contracts');
      assert.equal(made.result.text, 'Đã soạn NHÁP HĐ mới phòng P102 toà Toà A: bắt đầu Chủ nhật 01/11/2026 (còn 10 ngày), kết thúc 31/10/2027, giá thuê 3.200.000đ/tháng, ' +
        'cọc 3.200.000đ, kỳ thanh toán hằng tháng; khách: Nguyễn Văn Hai. Nháp KHÔNG giữ phòng, không tạo tiền; dịch vụ theo mặc định của toà khi ký. ' +
        'Mở nháp trên web (Hợp đồng → tab Nháp) để kiểm, xuất và ký.');
      const [draft] = await drafts();
      assert.equal(made.result.draftId, draft.id);
      assert.deepEqual(draft.payload, { form: { room_id: EMPTY_ROOM, signed_date: TODAY, start_date: '2026-11-01', end_date: '2027-10-31', rent_price: 3200000,
        total_deposit: 3200000, payment_cycle: 'MONTHLY', start_billing_date: '', end_billing_date: '', notes: 'Khách hẹn ký 30/10', discount_months: 0,
        discount_amount_per_month: 0 }, customers: [{ id: c(1), full_name: 'Nguyễn Văn Hai', phone: '0912.345.678', id_number: '079000000002',
        is_representative: true, notes: null }], services: [], use_custom_services: false });
      assert.deepEqual(await run('contract.draft', 'auto', rid(330), base), made, 'phát lại cùng requestId');
      // Trùng nháp 24 giờ ⇒ xem trước + xác nhận (dù chính sách ghi thẳng), rồi apply ghi nháp thứ hai.
      const dup = await run('contract.draft', 'auto', rid(331), { ...base, customerPhone: undefined });
      assert.deepEqual([dup.kind, dup.confirm], ['preview', 'required']);
      assert.ok(dup.warnings.some(text => /^Phòng đã có nháp HĐ soạn lúc .* \(chưa ký\); kiểm lại để không soạn trùng\.$/.test(text)), JSON.stringify(dup.warnings));
      assert.match(dup.preview.text, /khách: chưa có \(thêm trên web\)\./);
      const second = await run('contract.draft', 'apply', rid(331), { ...base, customerPhone: undefined }, dup);
      assert.equal(second.kind, 'applied'); assert.equal((await drafts()).length, 2);
      assert.deepEqual((await drafts())[1].payload.customers, [], 'không nêu khách ⇒ nháp chưa có khách');
    });
    await f.rollbackCase(async () => {
      const busy = await run('contract.draft', 'auto', rid(332), { ...P101, startDate: '2026-11-01', endDate: '2027-10-31', rentPrice: 4500000, deposit: 4500000 });
      assert.deepEqual([busy.kind, busy.confirm], ['preview', 'required'], 'phòng còn HĐ tới sau ngày bắt đầu');
      assert.ok(busy.warnings.some(text => text === 'Phòng đang có HĐ HĐ-THU-001 tới 28/02/2027, mà nháp bắt đầu 01/11/2026: kiểm lại trước khi ký.'));
      assert.deepEqual(await drafts(), [], 'chưa ghi');
      const P102 = { buildingName: 'toa a', roomName: 'P102', rentPrice: 3000000, deposit: 0 };
      assert.deepEqual(await run('contract.draft', 'auto', rid(333), { ...P102, startDate: '2026-11-01', endDate: '2026-11-01' }), { kind: 'needs_input', reason: 'date_out_of_range' });
      assert.deepEqual(await run('contract.draft', 'auto', rid(334), { ...P102, startDate: '01/11/2026', endDate: '2027-10-31' }), { kind: 'needs_input', reason: 'invalid_params' });
      assert.deepEqual(await run('contract.draft', 'auto', rid(335), { ...P102, rentPrice: 0, startDate: '2026-11-01', endDate: '2027-10-31' }), { kind: 'needs_input', reason: 'invalid_params' });
      assert.deepEqual(await run('contract.draft', 'auto', rid(336), { ...P102, startDate: '2026-11-01', endDate: '2027-10-31', customerName: 'nguyen van hai' }).then(value => value.why),
        'ambiguous');
    });
  });

  await t.test('hậu điều kiện nháp: hàm ghi sinh HĐ / đổi trạng thái phòng ⇒ lùi, crm_refused', async () => {
    for (const [index, bad] of ['draft_contract', 'draft_room'].entries()) await f.rollbackCase(async () => {
      await db.query('UPDATE public.fixture_contract_writer SET bad=$1', [bad]);
      assert.deepEqual(await run('contract.draft', 'auto', rid(340 + index), { buildingName: 'toa a', roomName: 'P102', startDate: '2026-11-01', endDate: '2027-10-31',
        rentPrice: 3000000, deposit: 0 }), { kind: 'rejected', reason: 'crm_refused' }, bad);
      assert.deepEqual(await drafts(), [], bad);
      assert.equal((await db.query("SELECT status FROM public.rooms WHERE id=$1", [EMPTY_ROOM])).rows[0].status, 'AVAILABLE', bad);
    });
  });

  await t.test('$requires$: thân bước ghi đang chạy khác thân 20261022061813 ⇒ dừng; đúng thân ⇒ nhận (md5 ghim khớp Postgres)', async () => {
    const original = /CREATE OR REPLACE FUNCTION app_private\.hermes_contract_action_step_v1[\s\S]*?END \$fn\$;/.exec(RETURN_SQL)[0];
    await f.rollbackCase(async () => {
      await db.exec(original.replace('-- Lượt preview chỉ đọc', '-- Lượt preview (thân lạ) chỉ đọc'));
      await assert.rejects(db.exec(plain(PARTY_SQL)), /hermes_contract_party_base_changed/);
    });
    await f.rollbackCase(async () => {
      await db.exec(original);
      await db.exec(plain(PARTY_SQL));
      assert.match((await db.query("SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure")).rows[0].prosrc, /contract\.occupant_add/);
    });
  });
});
