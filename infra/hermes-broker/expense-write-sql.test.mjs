import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setup, binding, ACTION_PATH, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, CASHBOOK, FOREIGN_CASHBOOK, CATEGORY, ORG, USER } from './finance-fixture.mjs';
import { ACTION_REASON_CODES } from './action-reasons.mjs';

// RPC trang Thu chi (Đợt 2 Mốc 2, THU-CHI-THAO-TAC-GHI.md mục 3) trên PGlite với fixture Hermes của thu chi (binding/phiên/chính
// sách thật của các migration Hermes; quyền CRM giả qua fixture_acl). Hàm ghi web ở đây là BẢN PORT (cùng chữ ký, cùng câu lỗi,
// có dòng hạng mục, bộ đếm mã, quyết định bộ máy chi, thông báo, cam kết) — nó chứng minh logic của bước ghi Hermes (chạy thử
// không để lại dấu vết, lô cả-hoặc-không, basis, lý do, phạm vi), KHÔNG chứng minh hàm ghi thật: phần đó đo ở tầng 2 trên TEST.
const file = slug => { const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name)); assert.equal(found.length, 1, slug);
  return readFileSync(`supabase/migrations/${found[0]}`, 'utf8').replaceAll('\r\n', '\n'); };
const RESOLVE = file('hermes_write_name_resolve_v1'), FOUNDATION = file('hermes_action_foundation_v1');
const RULES = file('ie_quick_entry_shared_rules_v1'), WRITE = file('hermes_expense_write_v1');
// Mốc 3: giải tên nhận toà ảo (v2) + phạm vi = guard ∩ hàm kiểm quyền của hàm ghi web, ghi chú chạy thử.
const RESOLVE2 = file('hermes_name_directory_virtual_v1'), SCOPE_FIX = file('hermes_expense_scope_v1');
const VIRTUAL = '00000000-0000-4000-8000-000000000688';
const rid = n => `00000000-0000-4000-8000-${String(700 + n).padStart(12, '0')}`;
const code = expected => error => error.code === expected;
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [PCCC, WATER, SYSTEM, CB2, STRANGER] = [601, 602, 603, 604, 677].map(uid);
const SUPPORT = `CREATE TABLE IF NOT EXISTS public.building_common_names(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,name text);
  CREATE TABLE IF NOT EXISTS public.job_types(id uuid PRIMARY KEY,organization_id uuid,name text,is_active boolean);
  CREATE TABLE IF NOT EXISTS public.profiles(id uuid PRIMARY KEY,full_name text);
  ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS code text;
  REVOKE USAGE ON SCHEMA app_private FROM authenticated, PUBLIC;
  GRANT SELECT ON public.building_common_names,public.job_types,public.profiles,public.buildings,public.rooms TO authenticated;
  CREATE OR REPLACE FUNCTION app_private.hermes_task_assignee_member_v1(p_user uuid,p_org uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ SELECT p_user=auth.uid() $f$;
  GRANT EXECUTE ON FUNCTION app_private.hermes_task_assignee_member_v1(uuid,uuid) TO authenticated;
  CREATE OR REPLACE FUNCTION app_private.hermes_web_building_ids_v1(p_org uuid) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public,app_private AS $f$
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) FROM public.buildings b
      CROSS JOIN LATERAL (SELECT COALESCE(bool_or(s.org_wide),false) org_wide,COALESCE(array_agg(x),'{}'::uuid[]) ids
        FROM app_private.authorized_scope_v3('buildings.view',p_org) s LEFT JOIN LATERAL unnest(s.building_ids) x ON true) scope
      WHERE p_org IS NOT NULL AND auth.uid() IS NOT NULL AND b.organization_id=p_org AND b.deleted_at IS NULL AND (scope.org_wide OR b.id=ANY(scope.ids)) $f$;
  REVOKE ALL ON FUNCTION app_private.hermes_web_building_ids_v1(uuid) FROM PUBLIC,authenticated;`;
// Bảng/hàm web mà hai migration Thu chi đòi, bản fixture. Hàm ghi port: thang sinh (người lập có quyền duyệt ⇒ duyệt; hạng mục bắt
// buộc duyệt / từ ngưỡng ⇒ chờ; cam kết: vượt phần còn lại ⇒ chờ), phiếu đã duyệt ⇒ POSTED (cầu a85), mã PC từ bảng đếm, dòng hạng
// mục có kỳ, quyết định bộ máy chi, thông báo cho phiếu chờ; fixture_writer.reject_name / reject_message / reject_state giả lập lỗi.
const WEB = `ALTER TABLE public.income_expense_types ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}',ADD COLUMN IF NOT EXISTS rule_key text,
    ADD COLUMN IF NOT EXISTS fee_category text,ADD COLUMN IF NOT EXISTS sort_order integer,ADD COLUMN IF NOT EXISTS category text,
    ADD COLUMN IF NOT EXISTS force_approval boolean DEFAULT false;
  ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS quick_default_building_id uuid,ADD COLUMN IF NOT EXISTS is_default boolean DEFAULT false;
  ALTER TABLE public.income_expenses ADD COLUMN IF NOT EXISTS posting_status text,ADD COLUMN IF NOT EXISTS system_source text,
    ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT clock_timestamp();
  ALTER TABLE public.fixture_writer ADD COLUMN IF NOT EXISTS reject_name text,ADD COLUMN IF NOT EXISTS reject_state text;
  GRANT SELECT ON public.income_expense_types,public.accounts,public.income_expenses TO authenticated;
  CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),income_expense_id uuid,income_expense_type_id uuid,amount numeric,start_date date,end_date date);
  CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),voucher_id uuid);
  CREATE TABLE public.fixture_code_counter(organization_id uuid PRIMARY KEY,last_value int);
  CREATE TABLE public.fixture_supplements(voucher_id uuid,note text,idempotency_key text PRIMARY KEY);
  CREATE TABLE app_private.spend_decisions(income_expense_id uuid PRIMARY KEY,engine_reason text,enforced boolean,match boolean);
  CREATE TABLE app_private.ie_auto_approve_config(organization_id uuid PRIMARY KEY,threshold numeric);
  CREATE TABLE public.fixture_commitments(building_id uuid,fee_category text,period_month date,amount numeric);
  INSERT INTO app_private.ie_auto_approve_config VALUES('${ORG}',600000);
  -- Mốc 3: quyền tạo phiếu của hàm ghi web THEO MÔ HÌNH CŨ (staff_assignments) — tách khỏi quyền v3 của guard (fixture_acl) như production;
  -- hàm ghi port gọi đúng hàm này với app_private.current_uid_v1() như create_income_expense_v1 thật.
  CREATE TABLE public.fixture_staff_assignments(user_id uuid,building_id uuid);
  INSERT INTO public.fixture_staff_assignments VALUES('${USER}','${BUILDING}');
  CREATE FUNCTION app_private.current_uid_v1() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT auth.uid() $f$;
  CREATE FUNCTION app_private.authorize_income_expense_on_building(p_actor uuid,p_organization_id uuid,p_action text,p_building_id uuid) RETURNS boolean
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    SELECT p_action IN ('create','restricted_create') AND EXISTS(SELECT 1 FROM public.fixture_staff_assignments s JOIN public.buildings b ON b.id=s.building_id
      WHERE s.user_id=p_actor AND b.organization_id=p_organization_id AND (s.building_id=p_building_id OR s.building_id IS NULL)) $f$;
  REVOKE ALL ON FUNCTION app_private.authorize_income_expense_on_building(uuid,uuid,text,uuid) FROM PUBLIC;
  CREATE FUNCTION public.list_cashbooks_for_expense_v2() RETURNS TABLE(id uuid,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
    AS $f$ SELECT a.id,a.name FROM public.accounts a WHERE a.user_id=auth.uid() AND a.deleted_at IS NULL ORDER BY a.name $f$;
  GRANT EXECUTE ON FUNCTION public.list_cashbooks_for_expense_v2() TO authenticated;
  CREATE FUNCTION app_private.commitment_for_v1(p_building uuid,p_fee_category text,p_period date) RETURNS TABLE(commitment_id uuid,amount numeric,remaining numeric)
    LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $f$
    SELECT gen_random_uuid(),c.amount,c.amount-COALESCE((SELECT sum(it.amount) FROM public.income_expense_items it JOIN public.income_expenses ie ON ie.id=it.income_expense_id
      JOIN public.income_expense_types t ON t.id=it.income_expense_type_id WHERE ie.building_id=p_building AND t.fee_category=p_fee_category AND ie.approval_status<>'CANCELLED'
      AND date_trunc('month',it.start_date)=date_trunc('month',p_period)),0)
    FROM public.fixture_commitments c WHERE c.building_id=p_building AND c.fee_category=p_fee_category AND c.period_month=date_trunc('month',p_period)::date $f$;
  CREATE FUNCTION public.get_voucher_slot_warning_v1(p_building_id uuid,p_type_ids uuid[],p_start date,p_end date,p_type text DEFAULT 'EXPENSE',p_exclude_id uuid DEFAULT NULL)
    RETURNS TABLE(voucher_id uuid,code text,voucher_name text,total_amount numeric,matched_amount numeric,voucher_date date,approval_status text,created_at timestamptz,
      creator_name text,type_names text,same_amount boolean) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    SELECT ie.id,ie.code,ie.name,ie.total_amount,sum(it.amount),ie.voucher_date,ie.approval_status,ie.created_at,NULL,NULL,false
      FROM public.income_expense_items it JOIN public.income_expenses ie ON ie.id=it.income_expense_id
     WHERE ie.building_id=p_building_id AND ie.type=p_type AND ie.deleted_at IS NULL AND ie.approval_status<>'CANCELLED' AND (p_exclude_id IS NULL OR ie.id<>p_exclude_id)
       AND it.income_expense_type_id=ANY(p_type_ids) AND it.start_date<=p_end AND it.end_date>=p_start
     GROUP BY ie.id,ie.code,ie.name,ie.total_amount,ie.voucher_date,ie.approval_status,ie.created_at $f$;
  CREATE FUNCTION public.append_income_expense_supplement_v1(p_voucher uuid,p_note text DEFAULT NULL,p_attachments jsonb DEFAULT '[]',p_idempotency_key text DEFAULT NULL)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    DECLARE v public.fixture_supplements;
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM public.income_expenses ie WHERE ie.id=p_voucher AND ie.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'Không có quyền bổ sung phiếu này' USING ERRCODE='42501'; END IF;
      SELECT * INTO v FROM public.fixture_supplements WHERE idempotency_key=p_idempotency_key;
      IF FOUND AND v.note IS DISTINCT FROM p_note THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng với nội dung khác' USING ERRCODE='23505'; END IF;
      IF NOT FOUND THEN INSERT INTO public.fixture_supplements VALUES(p_voucher,p_note,p_idempotency_key); END IF;
      RETURN jsonb_build_object('ok',true);
    END $f$;
  CREATE OR REPLACE FUNCTION public.create_income_expense_v1(p_type text,p_name text,p_building_id uuid,p_room_id uuid,p_tenant_id uuid,p_contract_id uuid,
    p_payer_name text,p_receive_bank_account text,p_receive_bank_name text,p_account_id uuid,p_attachments jsonb,p_business_result_accounting boolean,p_notes text,
    p_voucher_date date,p_items jsonb,p_idempotency_key text) RETURNS public.income_expenses LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $w$
    DECLARE v_org uuid; v_row public.income_expenses; v_total numeric; v_hash text; v_op public.fixture_canonical_ops; w public.fixture_writer; v_type uuid;
      v_force boolean; v_fee text; v_threshold numeric; v_status text; v_reason text; v_next int; v_remaining numeric; v_start date;
    BEGIN
      IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
      SELECT organization_id INTO v_org FROM public.buildings WHERE id=p_building_id AND deleted_at IS NULL;
      IF v_org IS NULL OR NOT app_private.authorize_income_expense_on_building(app_private.current_uid_v1(),v_org,'create',p_building_id)
        THEN RAISE EXCEPTION 'Không có quyền tạo phiếu thu/chi cho toà này' USING ERRCODE='42501'; END IF;
      IF p_voucher_date NOT BETWEEN '2000-01-01' AND '2100-12-31' THEN RAISE EXCEPTION 'Ngày phiếu phải nằm trong khoảng 2000-01-01 đến 2100-12-31'; END IF;
      IF p_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=p_account_id AND a.organization_id=v_org AND a.user_id=auth.uid())
        THEN RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này' USING ERRCODE='42501'; END IF;
      SELECT * INTO w FROM public.fixture_writer;
      IF w.rejected_message IS NOT NULL AND (w.reject_name IS NULL OR w.reject_name=p_name) THEN
        RAISE EXCEPTION '%',w.rejected_message USING ERRCODE=COALESCE(w.reject_state,'P0001'); END IF;
      v_type:=(p_items->0->>'income_expense_type_id')::uuid; v_start:=(p_items->0->>'start_date')::date;
      SELECT COALESCE(t.force_approval,false),t.fee_category INTO v_force,v_fee FROM public.income_expense_types t WHERE t.id=v_type;
      SELECT COALESCE(sum((it->>'quantity')::numeric*(it->>'unit_price')::numeric),0) INTO v_total FROM jsonb_array_elements(p_items) it;
      v_hash:=md5(jsonb_build_array(p_type,p_name,p_building_id,p_room_id,p_account_id,p_voucher_date,p_items,p_payer_name)::text);
      SELECT * INTO v_op FROM public.fixture_canonical_ops WHERE idempotency_key=p_idempotency_key AND actor=auth.uid();
      IF FOUND THEN
        IF v_op.payload_hash<>v_hash THEN RAISE EXCEPTION 'idempotency_key đã được dùng với payload khác' USING ERRCODE='23505'; END IF;
        SELECT * INTO v_row FROM public.income_expenses WHERE id=v_op.voucher_id; RETURN v_row;
      END IF;
      SELECT threshold INTO v_threshold FROM app_private.ie_auto_approve_config WHERE organization_id=v_org;
      SELECT c.remaining INTO v_remaining FROM app_private.commitment_for_v1(p_building_id,v_fee,v_start) c;
      IF app_private.can_v3('income_expenses.approve',p_building_id) THEN v_status:='APPROVED'; v_reason:='SELF_APPROVER';
      ELSIF v_remaining IS NOT NULL THEN v_status:=CASE WHEN v_total<=v_remaining THEN 'APPROVED' ELSE 'UNAPPROVED' END;
        v_reason:=CASE WHEN v_total<=v_remaining THEN 'WITHIN_COMMITMENT' ELSE 'OVER_COMMITMENT' END;
      ELSIF v_force THEN v_status:='UNAPPROVED'; v_reason:='FORCE_APPROVAL';
      ELSIF v_threshold IS NOT NULL AND v_total>=v_threshold THEN v_status:='UNAPPROVED'; v_reason:='OVER_THRESHOLD';
      ELSE v_status:='APPROVED'; v_reason:='UNDER_THRESHOLD'; END IF;
      INSERT INTO public.fixture_code_counter VALUES(v_org,0) ON CONFLICT DO NOTHING;
      UPDATE public.fixture_code_counter SET last_value=last_value+1 WHERE organization_id=v_org RETURNING last_value INTO v_next;
      INSERT INTO public.income_expenses(organization_id,user_id,code,type,name,building_id,room_id,account_id,voucher_date,total_amount,approval_status,payer_name,kqkd_amount,posting_status)
        VALUES(v_org,auth.uid(),'PC2610'||lpad(v_next::text,3,'0'),p_type,p_name,p_building_id,p_room_id,p_account_id,p_voucher_date,v_total,v_status,p_payer_name,v_total,
          CASE WHEN v_status='APPROVED' THEN 'POSTED' ELSE 'UNPOSTED' END) RETURNING * INTO v_row;
      INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,start_date,end_date)
        SELECT v_row.id,(it->>'income_expense_type_id')::uuid,(it->>'quantity')::numeric*(it->>'unit_price')::numeric,(it->>'start_date')::date,(it->>'end_date')::date
        FROM jsonb_array_elements(p_items) it;
      INSERT INTO app_private.spend_decisions VALUES(v_row.id,v_reason,true,true);
      IF v_status='UNAPPROVED' THEN INSERT INTO public.notifications(voucher_id) VALUES(v_row.id); END IF;
      INSERT INTO public.fixture_canonical_ops VALUES(p_idempotency_key,auth.uid(),v_hash,v_row.id);
      RETURN v_row;
    END $w$;
  UPDATE public.income_expense_types SET sort_order=10,category='Sửa chữa' WHERE id='${CATEGORY}';
  INSERT INTO public.income_expense_types(id,organization_id,type,name,rule_key,keywords,fee_category,force_approval,sort_order) VALUES
    ('${PCCC}','${ORG}','expense','PCCC','pccc',ARRAY['pccc'],NULL,false,20),('${WATER}','${ORG}','expense','Đóng tiền nước','nuoc',ARRAY['tiền nước'],'nuoc',true,30);
  INSERT INTO public.income_expense_types(id,organization_id,type,name,system_only) VALUES('${SYSTEM}','${ORG}','expense','Hoa hồng môi giới',true);
  INSERT INTO public.accounts VALUES('${CB2}','${ORG}','${USER}','Tiền mặt toà A','',false,null,'${BUILDING}',false);`;

test('hermes_expense_write_v1: chạy thử không để lại dấu vết, lô cả-hoặc-không, basis, lý do, phạm vi, ghi chú', { timeout: 240000 }, async t => {
  const f = await setup(t, { action: `${readFileSync(ACTION_PATH, 'utf8')}\n${SUPPORT}\n${RESOLVE}` });
  const { db, call } = f;
  await db.exec(FOUNDATION); await db.exec(WEB);
  await db.exec(RULES); await db.exec(RULES); await db.exec(WRITE); await db.exec(WRITE); // Idempotent.
  await db.exec(RESOLVE2); await db.exec(RESOLVE2); await db.exec(SCOPE_FIX); await db.exec(SCOPE_FIX);
  await db.query("INSERT INTO public.fixture_acl(permission,building_ids) VALUES('buildings.view',$1) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true", [[BUILDING, OTHER_BUILDING]]);
  const run = (action, phase, requestId, params, extra = {}) => call(
    'SELECT public.hermes_expense_write_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result',
    [JSON.stringify(binding), action, phase, requestId, JSON.stringify(params), extra.resolved ? JSON.stringify(extra.resolved) : null, extra.basis ?? null]);
  const trace = async () => (await db.query(`SELECT (SELECT count(*)::int FROM public.income_expenses) vouchers,(SELECT count(*)::int FROM public.income_expense_items) items,
    (SELECT count(*)::int FROM app_private.spend_decisions) decisions,(SELECT count(*)::int FROM public.notifications) notifications,
    (SELECT COALESCE(max(last_value),0)::int FROM public.fixture_code_counter) counter,(SELECT count(*)::int FROM app_private.hermes_action_receipts) receipts,
    (SELECT count(*)::int FROM public.fixture_canonical_ops) ops`)).rows[0];
  const item = (extra = {}) => ({ buildingName: 'toa a', roomName: 'P101', amount: 350000, content: 'mua vòi nước', category: 'sửa chữa', payee: 'anh thợ', ...extra });
  const applyWith = (requestId, params, preview) => run('expense.create', 'apply', requestId, params, { resolved: preview.resolved, basis: preview.basis });

  await t.test('xem trước = chạy thử hàm ghi rồi lùi: nói đúng "vào sổ ngay", không để lại phiếu, dòng, quyết định, thông báo, mã, biên nhận', async () => {
    const before = await trace();
    const preview = await run('expense.create', 'preview', rid(1), { items: [item()] });
    assert.equal(preview.kind, 'preview'); assert.equal(preview.confirm, 'required');
    assert.match(preview.preview.items[0].willBe, /^VÀO SỔ NGAY khi ghi \(dưới ngưỡng tự duyệt 600\.000đ\) — trừ sổ /);
    assert.deepEqual([preview.preview.items[0].building, preview.preview.items[0].room, preview.preview.items[0].category, preview.preview.items[0].amount],
      ['Toà A', 'P101', 'Sửa chữa', '350.000đ']);
    assert.equal(preview.preview.summary, 'Ghi 1 phiếu chi, tổng 350.000đ.');
    assert.deepEqual(preview.resolved.items[0].buildingId, BUILDING);
    assert.deepEqual(await trace(), before, 'chạy thử không để lại gì, kể cả bộ đếm mã phiếu');
    // Lượt 2: ghi đúng bản đã xem; phát lại cùng requestId.
    const applied = await applyWith(rid(1), { items: [item()] }, preview);
    assert.equal(applied.kind, 'applied');
    const voucher = applied.result.vouchers[0];
    assert.deepEqual([voucher.code, voucher.approvalStatus, voucher.postingStatus, voucher.amountText], ['PC2610001', 'APPROVED', 'POSTED', '350.000đ']);
    assert.match(applied.link, /^\/income-expense\/voucher\/[0-9a-f-]{36}$/);
    const after = await trace();
    assert.deepEqual([after.vouchers - before.vouchers, after.receipts - before.receipts, after.counter], [1, 1, 1], 'mã đầu tiên là 001: lần chạy thử không làm nhảy số');
    assert.deepEqual(await applyWith(rid(1), { items: [item()] }, preview), applied, 'phát lại y nguyên');
    assert.equal((await trace()).vouchers, after.vouchers);
  });

  await t.test('lô 2 khoản: một lần đồng ý; khoản vượt ngưỡng nói "chờ duyệt vì …"; trùng trong lô và trùng phiếu đã có được cảnh báo', async () => {
    const params = { items: [item({ amount: 1200000, content: 'sửa máy lạnh' }), item({ amount: 350000 })] };
    const preview = await run('expense.create', 'preview', rid(2), params);
    assert.match(preview.preview.items[0].willBe, /^CHỜ DUYỆT: từ ngưỡng tự duyệt 600\.000đ trở lên/);
    assert.match(preview.preview.items[1].willBe, /^VÀO SỔ NGAY/);
    assert.ok(preview.warnings.some(w => /^Khoản 2: đã có phiếu PC2610001 ngày .* — CÙNG SỐ TIỀN, có thể ghi trùng$/.test(w)), preview.warnings.join('\n'));
    assert.ok(preview.warnings.some(w => /^Khoản 2: trùng toà, hạng mục, kỳ với một khoản khác trong lần ghi này$/.test(w)), preview.warnings.join('\n'));
    const before = await trace();
    const applied = await applyWith(rid(2), params, preview);
    assert.deepEqual(applied.result.vouchers.map(v => [v.code, v.approvalStatus]), [['PC2610002', 'UNAPPROVED'], ['PC2610003', 'APPROVED']]);
    assert.equal(applied.link, '/income-expense');
    assert.equal((await trace()).notifications - before.notifications, 1, 'thông báo người duyệt cho phiếu chờ');
  });

  await t.test('TC3: lệch bản đã xem hay một khoản lỗi ở lượt 2 ⇒ lùi cả lô và biên nhận, state_changed', async () => {
    const params = { items: [item({ content: 'khoản một' }), item({ content: 'khoản hai', amount: 450000 })] };
    const preview = await run('expense.create', 'preview', rid(3), params);
    // Ngưỡng đổi giữa hai lượt ⇒ khoản hai thành chờ duyệt ⇒ basis lệch.
    await db.query("UPDATE app_private.ie_auto_approve_config SET threshold=400000");
    const before = await trace();
    assert.deepEqual(await applyWith(rid(3), params, preview), { kind: 'rejected', reason: 'state_changed' });
    assert.deepEqual(await trace(), before, 'không phiếu, không biên nhận, không nhảy mã');
    await db.query("UPDATE app_private.ie_auto_approve_config SET threshold=600000");
    // Hàm ghi từ chối khoản hai ở lượt 2 (sau khi lượt 1 chạy thử qua) ⇒ khoản một cũng không được ghi.
    const fresh = await run('expense.create', 'preview', rid(4), params);
    await db.query("UPDATE public.fixture_writer SET rejected_message='[PROFIT_LOCKED] tháng đã chốt',reject_name='khoản hai'");
    assert.deepEqual(await applyWith(rid(4), params, fresh), { kind: 'rejected', reason: 'state_changed' });
    assert.deepEqual(await trace(), before);
    // Xem trước lại thấy đúng lý do từ chối (chạy thử bắt sớm).
    assert.deepEqual(await run('expense.create', 'preview', rid(5), params), { kind: 'rejected', reason: 'period_locked' });
    await db.query("UPDATE public.fixture_writer SET rejected_message=NULL,reject_name=NULL,reject_state=NULL");
  });

  await t.test('lỗi hàm ghi ở lượt 1 ⇒ lý do đóng của trang; lỗi tạm không bị nuốt', async () => {
    for (const [message, state, reason] of [['[NOT_MANUAL] Phiếu do hệ thống sinh (x) — xử lý ở luồng nguồn.', '42501', 'system_voucher'],
      ['Hạng mục "X" chỉ được sinh từ hệ thống (hợp đồng/cọc/thanh lý/hoa hồng), không tạo tay từ màn Thu/Chi', '0A000', 'system_voucher'],
      ['Sổ quỹ đã khoá tại ngày phiếu', 'P0001', 'period_locked'], ['Quyền sử dụng sổ quỹ đã bị thu hồi', '42501', 'cashbook_not_held'],
      ['Không có quyền tạo phiếu thu/chi cho toà này', '42501', 'not_allowed'], ['lỗi lạ', 'XX000', 'crm_refused']]) {
      await db.query('UPDATE public.fixture_writer SET rejected_message=$1,reject_state=$2', [message, state]);
      const got = await run('expense.create', 'preview', rid(6), { items: [item()] });
      assert.deepEqual(got, { kind: 'rejected', reason }, message);
      assert.ok(ACTION_REASON_CODES.includes(reason));
    }
    await db.query("UPDATE public.fixture_writer SET rejected_message='canceling statement due to lock timeout',reject_state='55P03'");
    await assert.rejects(run('expense.create', 'preview', rid(7), { items: [item()] }), code('55P03'));
    await db.query("UPDATE public.fixture_writer SET rejected_message=NULL,reject_state=NULL");
    const mapped = async (sqlstate, message) => (await db.query('SELECT app_private.hermes_expense_reason_v1($1,$2) r', [sqlstate, message])).rows[0].r;
    for (const [sqlstate, message, expected] of [['55000', 'finance_v2_post_manual_voucher: at least one FINALIZED evidence is required', 'evidence_required'],
      ['42501', 'approve_and_post_income_expense_v2: no CUSTODIAN possession of cashbook x', 'cashbook_not_held'],
      ['55000', 'approve_income_expense_v2: voucher not in an approvable state (APPROVED, x)', 'not_pending'], ['P0002', 'Phiếu không tồn tại', 'not_found'],
      ['P0001', 'Ngày phiếu phải nằm trong khoảng 2000-01-01 đến 2100-12-31', 'date_out_of_range'], ['55000', '[STRICT_MODE] chặn', 'strict_mode'],
      ['P0001', '[HANDOVER_LOCKED] Phiếu nằm trong phiên bàn giao', 'period_locked'], ['22023', 'Phải ghi lý do huỷ (ít nhất 8 ký tự)', 'reason_required'],
      ['54000', 'Số tiền vượt cap canary cho một phiếu', 'amount_out_of_range'], ['55000', 'Đã hết số lượt canary', 'quota_exceeded']])
      assert.equal(await mapped(sqlstate, message), expected, message);
  });

  await t.test('giải tên: hạng mục tự chọn khi khoá cứng; mơ hồ/không chắc ⇒ needs_input có ứng viên; sổ; phạm vi toà', async () => {
    const auto = await run('expense.create', 'preview', rid(8), { items: [item({ category: undefined, content: 'in phương án pccc' })] });
    assert.deepEqual([auto.preview.items[0].category, auto.preview.items[0].categoryAuto], ['PCCC', 'tự chọn theo nội dung — sửa nếu sai']);
    // Gợi ý KHÔNG khoá cứng (trùng chữ tên "sửa") ⇒ không tự nhận; hỏi lại, gợi ý đứng đầu ứng viên.
    const weak = await run('expense.create', 'preview', rid(17), { items: [item({ category: undefined, content: 'sửa vòi' })] });
    assert.deepEqual([weak.kind, weak.field, weak.candidates[0]?.name], ['needs_input', 'category', 'Sửa chữa']);
    const vague = await run('expense.create', 'preview', rid(9), { items: [item({ category: undefined, content: 'đồ lặt vặt' })] });
    assert.deepEqual([vague.kind, vague.field, vague.why], ['needs_input', 'category', 'ambiguous']);
    assert.ok(vague.candidates.length > 0 && !vague.candidates.some(c => c.name === 'Hoa hồng môi giới'), 'không đề xuất hạng mục hệ thống');
    assert.deepEqual(await run('expense.create', 'preview', rid(10), { items: [item({ category: 'hoa hồng' })] }),
      { kind: 'needs_input', reason: 'name_unresolved', field: 'category', wanted: 'hoa hồng', why: 'not_visible', candidates: [], more: false });
    assert.deepEqual(await run('expense.create', 'preview', rid(11), { items: [item({ buildingName: 'Toà B' })] }),
      { kind: 'needs_input', reason: 'name_unresolved', field: 'building', wanted: 'Toà B', why: 'outside_scope', candidates: [], more: false });
    assert.deepEqual(await run('expense.create', 'preview', rid(12), { items: [item({ cashbook: 'quỹ người khác' })] }), { kind: 'rejected', reason: 'cashbook_not_held' });
    const named = await run('expense.create', 'preview', rid(13), { items: [item({ cashbook: 'tiền mặt' })] });
    assert.equal(named.preview.items[0].cashbook, 'Tiền mặt toà A');
    const defaulted = await run('expense.create', 'preview', rid(14), { items: [item()] });
    assert.equal(defaulted.resolved.items[0].cashbookId, CB2, 'sổ gắn toà thắng sổ dùng lần trước');
    // Kỳ của khoản cam kết + hạng mục bắt buộc duyệt (Q12).
    await db.query("INSERT INTO public.fixture_commitments VALUES($1,'nuoc','2026-10-01',3000000)", [BUILDING]);
    const water = await run('expense.create', 'preview', rid(15), { items: [item({ category: 'đóng tiền nước', content: 'tiền nước tháng 10', amount: 3200000, period: '2026-10', roomName: undefined })] });
    assert.match(water.preview.items[0].willBe, /^CHỜ DUYỆT: vượt cam kết chi còn lại của kỳ/);
    assert.ok(water.warnings.some(w => w === 'Khoản 1: cam kết "Đóng tiền nước" tháng 10/2026 là 3.000.000đ, còn 3.000.000đ trước khoản này — khoản này VƯỢT phần còn lại'), water.warnings.join('\n'));
    assert.equal(water.preview.items[0].period, 'tháng 10/2026');
  });

  await t.test('lượt 2 đưa bản đã giải ngoài phạm vi ⇒ not_allowed, không mở biên nhận', async () => {
    const preview = await run('expense.create', 'preview', rid(16), { items: [item()] });
    const before = await trace();
    const strip = ({ roomId, roomName, ...rest }) => rest; // eslint-disable-line no-unused-vars
    for (const forged of [strip({ ...preview.resolved.items[0], buildingId: OTHER_BUILDING }), { ...preview.resolved.items[0], roomId: OTHER_ROOM },
      { ...preview.resolved.items[0], typeId: SYSTEM }])
      assert.deepEqual(await run('expense.create', 'apply', rid(16), { items: [item()] }, { resolved: { items: [forged] }, basis: preview.basis }),
        { kind: 'rejected', reason: 'not_allowed' }, JSON.stringify(forged));
    assert.deepEqual(await run('expense.create', 'apply', rid(16), { items: [item()] }, { resolved: { items: [{ ...preview.resolved.items[0], cashbookId: FOREIGN_CASHBOOK }] }, basis: preview.basis }),
      { kind: 'rejected', reason: 'cashbook_not_held' });
    assert.deepEqual(await trace(), before);
    await assert.rejects(run('expense.create', 'apply', rid(16), { items: [item()] }, { resolved: preview.resolved, basis: null }), code('22023'));
  });

  await t.test('expense.note: ghi thẳng (chính sách never), phát lại, lỗi cuối được chốt; mã phiếu ngoài phạm vi / không thấy ⇒ hỏi lại', async () => {
    const noted = await run('expense.note', 'auto', rid(20), { voucherCode: 'pc2610001', note: 'đã lấy hoá đơn đỏ' });
    assert.deepEqual([noted.kind, noted.result], ['applied', { code: 'PC2610001', noted: true }]);
    assert.deepEqual(await run('expense.note', 'auto', rid(20), { voucherCode: 'pc2610001', note: 'đã lấy hoá đơn đỏ' }), noted);
    assert.equal((await db.query("SELECT count(*)::int n FROM public.fixture_supplements")).rows[0].n, 1);
    assert.deepEqual(await run('expense.note', 'auto', rid(21), { voucherCode: 'PC9999999', note: 'x' }),
      { kind: 'needs_input', reason: 'name_unresolved', field: 'voucher', wanted: 'PC9999999', why: 'not_visible', candidates: [], more: false });
    await db.query("INSERT INTO public.income_expenses(organization_id,user_id,code,type,name,building_id,voucher_date) VALUES($1,$2,'PC2610999','EXPENSE','toà B',$3,'2026-10-01')", [ORG, USER, OTHER_BUILDING]);
    assert.equal((await run('expense.note', 'auto', rid(22), { voucherCode: 'PC2610999', note: 'x' })).why, 'outside_scope');
    // Phiếu của người khác: hàm bổ sung từ chối 42501 ⇒ lý do cuối, chốt và phát lại.
    await db.query("UPDATE public.income_expenses SET user_id=$1 WHERE code='PC2610003'", [STRANGER]);
    assert.deepEqual(await run('expense.note', 'auto', rid(23), { voucherCode: 'PC2610003', note: 'x' }), { kind: 'rejected', reason: 'not_allowed' });
    assert.deepEqual((await db.query('SELECT state,sqlstate FROM app_private.hermes_action_receipts WHERE request_id=$1', [rid(23)])).rows, [{ state: 'rejected', sqlstate: '42501' }]);
    // Chính sách siết thành always ⇒ ghi chú cũng xem trước.
    await db.query("UPDATE app_private.hermes_action_policies SET confirm='always' WHERE action='expense.note'");
    const strict = await run('expense.note', 'auto', rid(24), { voucherCode: 'PC2610001', note: 'ghi thêm' });
    assert.deepEqual([strict.kind, strict.confirm, strict.preview.summary], ['preview', 'required', 'Ghi chú vào phiếu PC2610001: "ghi thêm"']);
    await db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action='expense.note'");
  });

  await t.test('Mốc 3: phạm vi = guard ∩ hàm kiểm quyền của hàm ghi web — không bao giờ xem trước "được" rồi ghi "không được"; toà ảo; ghi chú chạy thử', async () => {
    // Overlay của kết nối thành Toàn tổ chức ⇒ guard (v3: fixture_acl toà A + B) cho cả toà B; hàm ghi web (staff_assignments) chỉ toà A.
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.authorization_scopes SET scope_type='ORGANIZATION',building_id=NULL WHERE organization_id=$1 AND scope_type='BUILDING'", [ORG]);
      const before = await trace();
      // Trước Mốc 3: tên giải được, chạy thử 42501 ⇒ rejected not_allowed ở bản xem trước. Nay: toà B ngoài phạm vi ngay khi giải tên.
      assert.deepEqual(await run('expense.create', 'preview', rid(40), { items: [item({ buildingName: 'Toà B', roomName: undefined })] }),
        { kind: 'needs_input', reason: 'name_unresolved', field: 'building', wanted: 'Toà B', why: 'outside_scope', candidates: [], more: false });
      const ok = await run('expense.create', 'preview', rid(41), { items: [item()] });
      assert.equal(ok.kind, 'preview', 'toà A: cả guard lẫn hàm ghi cho');
      // Lượt 2 đưa bản đã giải sang toà B (guard cho, hàm ghi không) ⇒ not_allowed TRƯỚC biên nhận, không chạy hàm ghi.
      const { roomId, roomName, ...toB } = ok.resolved.items[0]; // eslint-disable-line no-unused-vars
      assert.deepEqual(await run('expense.create', 'apply', rid(41), { items: [item()] }, { resolved: { items: [{ ...toB, buildingId: OTHER_BUILDING }] }, basis: ok.basis }),
        { kind: 'rejected', reason: 'not_allowed' });
      // Ngược lại: hàm ghi cho toà B (phân công) nhưng v3 của khoá không có ⇒ ngoài phạm vi ở CẢ hai lượt (cùng một tập toà).
      await db.query("INSERT INTO public.fixture_staff_assignments VALUES($1,$2)", [USER, OTHER_BUILDING]);
      await db.query("UPDATE public.fixture_acl SET building_ids=$1 WHERE permission='income_expenses.create'", [[BUILDING]]);
      assert.equal((await run('expense.create', 'preview', rid(42), { items: [item({ buildingName: 'Toà B', roomName: undefined })] })).why, 'outside_scope');
      assert.deepEqual(await trace(), before, 'không phiếu, không biên nhận');
    });
    // Chủ có role_bindings nhưng KHÔNG có staff_assignments (tài khoản TEST 068a3985…, 22/10): hàm ghi web từ chối mọi toà ⇒ mọi toà ngoài
    // phạm vi ngay ở bản xem trước, không bao giờ "xem trước được".
    await f.rollbackCase(async () => {
      await db.query('DELETE FROM public.fixture_staff_assignments WHERE user_id=$1', [USER]);
      assert.equal((await run('expense.create', 'preview', rid(43), { items: [item()] })).why, 'outside_scope');
      assert.deepEqual(await run('expense.create', 'preview', rid(44), { items: [item({ buildingName: 'nhà không có' })] }),
        { kind: 'needs_input', reason: 'name_unresolved', field: 'building', wanted: 'nhà không có', why: 'not_visible', candidates: [], more: false });
    });
    // Toà ảo (chi phí chung): web Thu chi ghi được ⇒ Hermes giải được tên và lập được phiếu ở đó.
    await f.rollbackCase(async () => {
      await db.query("INSERT INTO public.buildings VALUES($1,$2,'Kho Văn Phòng Chung',true,null)", [VIRTUAL, ORG]);
      await db.query("INSERT INTO public.fixture_building_access VALUES($1)", [VIRTUAL]);
      await db.query("INSERT INTO public.fixture_staff_assignments VALUES($1,$2)", [USER, VIRTUAL]);
      for (const permission of ['income_expenses.create', 'buildings.view'])
        await db.query("UPDATE public.fixture_acl SET building_ids=building_ids||$1::uuid WHERE permission=$2", [VIRTUAL, permission]);
      await db.query("UPDATE public.authorization_scopes SET scope_type='ORGANIZATION',building_id=NULL WHERE organization_id=$1 AND scope_type='BUILDING'", [ORG]);
      const params = { items: [item({ buildingName: 'kho van phong chung', roomName: undefined, content: 'văn phòng phẩm' })] };
      const preview = await run('expense.create', 'preview', rid(45), params);
      assert.deepEqual([preview.kind, preview.resolved.items[0].buildingId, preview.preview.items[0].building], ['preview', VIRTUAL, 'Kho Văn Phòng Chung']);
      const applied = await applyWith(rid(45), params, preview);
      assert.deepEqual([applied.kind, applied.result.vouchers[0].building], ['applied', 'Kho Văn Phòng Chung']);
    });
    // Ghi chú khi phải xem trước (chính sách always): CHẠY THỬ hàm bổ sung — phiếu người khác ⇒ từ chối ngay ở bản xem trước (trước Mốc 3:
    // xem trước "được" rồi ghi 42501); phiếu của mình ⇒ xem trước, không để lại dòng bổ sung nào.
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_action_policies SET confirm='always' WHERE action='expense.note'");
      assert.deepEqual(await run('expense.note', 'preview', rid(46), { voucherCode: 'PC2610003', note: 'x' }), { kind: 'rejected', reason: 'not_allowed' });
      const supplements = async () => (await db.query('SELECT count(*)::int n FROM public.fixture_supplements')).rows[0].n;
      const count = await supplements();
      assert.equal((await run('expense.note', 'preview', rid(47), { voucherCode: 'PC2610001', note: 'thêm' })).kind, 'preview');
      assert.equal(await supplements(), count, 'chạy thử không để lại dòng bổ sung');
    });
  });

  await t.test('rào: sàn money không nới được; action/phase NULL; catalog và quyền thực thi', async () => {
    await assert.rejects(db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action='expense.create'"), code('23514'));
    for (const phase of [null, 'write']) await assert.rejects(run('expense.create', phase, rid(30), { items: [item()] }), code('22023'));
    await assert.rejects(run(null, 'preview', rid(31), { items: [item()] }), code('42501'));
    await assert.rejects(run('expense.edit', 'preview', rid(32), { voucherCode: 'PC2610001' }), code('42501'), 'chưa có dòng chính sách ⇒ không tồn tại');
    // Khoá tắt (trạng thái production, Q4) ⇒ guard từ chối trước khi giải tên.
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='income_expenses.create'");
      await assert.rejects(run('expense.create', 'preview', rid(33), { items: [item()] }), code('42501'));
    });
    const acl = (await db.query(`SELECT p.oid::regprocedure::text fn,p.prosecdef,p.prosqlbody IS NOT NULL standard,has_function_privilege('authenticated',p.oid,'EXECUTE') auth,
      has_function_privilege('anon',p.oid,'EXECUTE') anon FROM pg_proc p WHERE p.proname LIKE 'hermes_expense_%' AND p.proname NOT IN ('hermes_expense_action_v1','hermes_expense_capabilities_v1',
      'hermes_expense_category_ok_v1','hermes_expense_cashbook_ok_v1') ORDER BY 1`)).rows;
    assert.deepEqual(acl.map(r => [r.fn.replace(/\(.*/, ''), r.prosecdef, r.standard, r.auth, r.anon]), [
      ['app_private.hermes_expense_create_run_v1', true, false, false, false], ['app_private.hermes_expense_reason_v1', false, false, false, false],
      ['app_private.hermes_expense_resolve_core_v1', false, false, true, false], ['app_private.hermes_expense_scope_v1', true, false, true, false],
      ['app_private.hermes_expense_write_step_v1', true, false, true, false], ['hermes_expense_write_v1', false, true, true, false]]);
  });
});
