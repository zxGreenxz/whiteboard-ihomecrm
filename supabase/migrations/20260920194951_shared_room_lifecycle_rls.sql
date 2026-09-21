-- Shared room history uses authenticated table policies. No financial writer or payload change.
-- Depends on the T4 shared read role; later room ownership is intentional forward evolution.
BEGIN;
DO $guard$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND rolinherit)
   OR NOT pg_has_role('ie_action_snapshot_reader','authenticated','USAGE')
   OR has_schema_privilege('ie_action_snapshot_reader','public','CREATE')
   OR has_schema_privilege('ie_action_snapshot_reader','app_private','CREATE') THEN RAISE EXCEPTION 'Shared reader role prerequisite/drift'; END IF;
 IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid='ie_action_snapshot_reader'::regrole AND member<>'postgres'::regrole)
 OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='ie_action_snapshot_reader'::regrole AND (roleid<>'authenticated'::regrole OR admin_option)) THEN RAISE EXCEPTION 'Shared reader role membership drift'; END IF;
 IF md5(pg_get_functiondef('public.get_room_cash_lifecycle_v1(uuid,date,date)'::regprocedure)) NOT IN ('2c5c0f54d345ca35c3cac80232c3d837','4219809847a848ab9439ba2eb1a78213')
 OR md5(pg_get_functiondef('public.get_room_residence_segments_v1(uuid[])'::regprocedure)) NOT IN ('8ee45965dbcac4333dfac3a25d662f29','83dd49ab595599c2b8bf5f37bd6cd993') THEN RAISE EXCEPTION 'Room lifecycle definition drift'; END IF;
 IF to_regprocedure('app_private.room_lifecycle_org_visible_v1(uuid)') IS NOT NULL
 AND md5(pg_get_functiondef(to_regprocedure('app_private.room_lifecycle_org_visible_v1(uuid)'))) <> 'bfe10acb39d5df5aa48995a2731532b1' THEN RAISE EXCEPTION 'Room lifecycle scope definition drift'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid IN ('public.get_room_cash_lifecycle_v1(uuid,date,date)'::regprocedure,'public.get_room_residence_segments_v1(uuid[])'::regprocedure)
 AND (p.proowner NOT IN ('postgres'::regrole,'ie_action_snapshot_reader'::regrole) OR a.is_grantable
 OR a.grantee NOT IN ('postgres'::regrole,'ie_action_snapshot_reader'::regrole,'authenticated'::regrole,'service_role'::regrole))) THEN RAISE EXCEPTION 'Room lifecycle ACL/owner drift'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid=to_regprocedure('app_private.room_lifecycle_org_visible_v1(uuid)')
 AND (p.proowner<>'postgres'::regrole OR a.is_grantable OR a.grantee NOT IN ('postgres'::regrole,'ie_action_snapshot_reader'::regrole))) THEN RAISE EXCEPTION 'Room lifecycle scope ACL/owner drift'; END IF;
END
$guard$;
CREATE OR REPLACE FUNCTION app_private.room_lifecycle_org_visible_v1(p_organization_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, app_private
AS $scope$
BEGIN
 PERFORM app_private.income_expense_action_scope_v1(p_organization_id);
 RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END
$scope$;
ALTER FUNCTION app_private.room_lifecycle_org_visible_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.room_lifecycle_org_visible_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_private.room_lifecycle_org_visible_v1(uuid) TO ie_action_snapshot_reader;
CREATE OR REPLACE FUNCTION public.get_room_residence_segments_v1(p_contract_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(contract_id uuid, contract_number text, seg_index integer, room_id uuid, room_name text, from_date date, to_date date, source_path text, transfer_id uuid, trusted boolean, diagnostic text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
 SET row_security TO 'on'
AS $function$
  WITH c AS (
    SELECT ct.id, ct.contract_number, ct.room_id AS cur_room,
           ct.start_date, ct.status::text AS c_status, ct.parent_contract_id
      FROM contracts ct
      LEFT JOIN rooms r ON r.id = ct.room_id
     WHERE ct.deleted_at IS NULL
       AND (p_contract_ids IS NULL OR ct.id = ANY(p_contract_ids))
       -- Cổng quyền: không có quyền trên toà ⇒ không thấy gì. Segments là tiện
       -- ích đọc, KHÔNG được thành kênh soi lịch sử toà mình không được xem.
       AND r.id IS NOT NULL
       AND app_private.room_lifecycle_org_visible_v1(ct.organization_id)
       AND (public.can_access_building(r.building_id) OR public.ie_all_buildings_scope(r.building_id))
  ),
  -- Bước chuyển hợp lệ. CỐ Ý loại TENANT_CHANGE (đổi người, không đổi phòng),
  -- DRAFT (chưa duyệt) và CANCELLED (đã bỏ) — chúng KHÔNG cắt đoạn phòng.
  t AS (
    SELECT tr.contract_id,
           tr.id            AS transfer_id,
           tr.old_room_id,
           tr.new_room_id,
           COALESCE(tr.move_out_date, tr.transfer_date) AS eff_out,
           COALESCE(tr.move_in_date,  tr.transfer_date) AS eff_in,
           tr.transfer_date,
           CASE tr.status WHEN 'COMPLETED' THEN 'TRANSFER_ROOM_COMPLETED'
                          WHEN 'APPROVED'  THEN 'TRIGGER_APPROVED'
                          ELSE 'UNKNOWN' END AS source_path,
           row_number() OVER (PARTITION BY tr.contract_id
                              ORDER BY COALESCE(tr.move_in_date, tr.transfer_date),
                                       tr.transfer_date, tr.id) AS rn,
           count(*)    OVER (PARTITION BY tr.contract_id) AS n_tr
      FROM contract_transfers tr
      JOIN c ON c.id = tr.contract_id
     WHERE tr.transfer_type IN ('ROOM_CHANGE','BOTH_CHANGE')
       AND tr.status IN ('COMPLETED','APPROVED')
  ),
  -- Chẩn đoán ở mức HỢP ĐỒNG. Bất kỳ mâu thuẫn nào ⇒ cả chuỗi mất tin cậy.
  diag AS (
    SELECT c.id AS contract_id,
           CASE
             -- Có bằng chứng từng chuyển (dữ liệu lịch sử đường B) mà không có dòng nào
             WHEN (c.c_status = 'TRANSFERRED' OR c.parent_contract_id IS NOT NULL)
                  AND NOT EXISTS (SELECT 1 FROM t WHERE t.contract_id = c.id)
               THEN 'SEGMENT_HISTORY_INCOMPLETE: hợp đồng mang dấu vết đã chuyển (status/parent) nhưng không có dòng contract_transfers nào'
             -- Bước chuyển đầu tiên thiếu phòng cũ ⇒ không neo được đoạn đầu
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id AND t.rn=1 AND t.old_room_id IS NULL)
               THEN 'SEGMENT_HISTORY_INCOMPLETE: bước chuyển đầu tiên thiếu old_room_id'
             -- Thiếu mốc ngày
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id
                            AND (t.eff_in IS NULL OR t.eff_out IS NULL))
               THEN 'SEGMENT_HISTORY_INCOMPLETE: có bước chuyển thiếu mốc ngày (move_in/move_out/transfer_date đều rỗng)'
             -- Thiếu phòng mới
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id AND t.new_room_id IS NULL)
               THEN 'SEGMENT_HISTORY_INCOMPLETE: có bước chuyển thiếu new_room_id'
             -- ⚠ THỨ TỰ HAI PHÉP KIỂM DƯỚI ĐÂY LÀ CÓ CHỦ Ý — tôi từng để ngược và
             -- test bắt được: khi hai bước chuyển TRÙNG NGÀY hiệu lực thì
             -- row_number() xếp chúng theo `(eff_in, transfer_date, id)`, mà id là
             -- tuỳ ý ⇒ THỨ TỰ đã không đáng tin. Mọi kết luận của phép kiểm
             -- "chuỗi có nối" đều dựa trên thứ tự đó, nên nếu chạy trước nó sẽ báo
             -- "chuỗi không nối" — đúng là AMBIGUOUS nhưng SAI NGUYÊN NHÂN, khiến
             -- người rà tay đi tìm lỗi nối trong khi lỗi thật là trùng ngày.
             -- Chẩn đoán gốc phải nói trước.
             WHEN EXISTS (
               SELECT 1 FROM t a JOIN t b
                 ON b.contract_id=a.contract_id AND b.transfer_id <> a.transfer_id
                AND b.eff_in = a.eff_in
                WHERE a.contract_id=c.id)
               THEN 'SEGMENT_HISTORY_AMBIGUOUS: hai bước chuyển cùng ngày hiệu lực — không xác định được thứ tự'
             -- Chuỗi không nối: phòng cũ của bước n phải là phòng mới của bước n−1
             WHEN EXISTS (
               SELECT 1 FROM t a JOIN t b ON b.contract_id=a.contract_id AND b.rn=a.rn-1
                WHERE a.contract_id=c.id AND a.old_room_id IS DISTINCT FROM b.new_room_id)
               THEN 'SEGMENT_HISTORY_AMBIGUOUS: chuỗi chuyển phòng không nối (phòng cũ của bước sau khác phòng mới của bước trước)'
             -- Phòng hiện tại phải bằng phòng mới của bước cuối
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id)
                  AND c.cur_room IS DISTINCT FROM
                      (SELECT t2.new_room_id FROM t t2
                        WHERE t2.contract_id=c.id ORDER BY t2.rn DESC LIMIT 1)
               THEN 'SEGMENT_HISTORY_AMBIGUOUS: contracts.room_id không khớp phòng cuối chuỗi chuyển'
             ELSE NULL
           END AS diagnostic
      FROM c
  ),
  -- Đoạn ĐẦU = phòng cũ của bước chuyển thứ nhất; nếu không có transfer thì là
  -- phòng hiện tại.
  head AS (
    SELECT c.id AS contract_id, c.contract_number, 0 AS seg_index,
           COALESCE((SELECT t.old_room_id FROM t WHERE t.contract_id=c.id AND t.rn=1),
                    c.cur_room) AS room_id,
           -- Step 4: CHỈ tin start_date khi hợp đồng không có transfer và không
           -- mang dấu vết đã chuyển. Ngược lại trả NULL = "chưa biết", KHÔNG bịa.
           CASE WHEN NOT EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id)
                     AND c.c_status <> 'TRANSFERRED'
                     AND c.parent_contract_id IS NULL
                THEN c.start_date ELSE NULL END AS from_date,
           (SELECT t.eff_out FROM t WHERE t.contract_id=c.id AND t.rn=1) AS to_date,
           'CONTRACT_START'::text AS source_path,
           NULL::uuid AS transfer_id
      FROM c
  ),
  -- Mỗi bước chuyển mở một đoạn mới ở phòng mới.
  tail AS (
    SELECT t.contract_id, c.contract_number, t.rn::int AS seg_index,
           t.new_room_id AS room_id,
           t.eff_in AS from_date,
           (SELECT n.eff_out FROM t n
             WHERE n.contract_id=t.contract_id AND n.rn=t.rn+1) AS to_date,
           t.source_path, t.transfer_id
      FROM t JOIN c ON c.id = t.contract_id
  ),
  allseg AS (SELECT * FROM head UNION ALL SELECT * FROM tail)
  SELECT s.contract_id, s.contract_number, s.seg_index, s.room_id,
         r.name AS room_name, s.from_date, s.to_date, s.source_path, s.transfer_id,
         (d.diagnostic IS NULL) AS trusted,
         d.diagnostic
    FROM allseg s
    JOIN diag d ON d.contract_id = s.contract_id
    LEFT JOIN rooms r ON r.id = s.room_id
   ORDER BY s.contract_number NULLS LAST, s.contract_id, s.seg_index;
$function$
;
CREATE OR REPLACE FUNCTION public.get_room_cash_lifecycle_v1(p_room_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_room  record;
  v_ids   uuid[];
  v_out   jsonb;
  -- "Hôm nay" phải là ngày của TỔ CHỨC, không phải ngày của phiên Postgres
  -- (phiên chạy TimeZone=UTC nên từ 00:00 đến 07:00 giờ VN nó còn là hôm qua).
  v_today date;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT r.id, r.name, r.building_id, b.name AS building_name,
         b.organization_id
    INTO v_room
    FROM rooms r JOIN buildings b ON b.id = r.building_id
   WHERE r.id = p_room_id AND r.deleted_at IS NULL AND b.deleted_at IS NULL
     AND r.organization_id = b.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Room is not available in the current scope' USING ERRCODE='42501';
  END IF;

  PERFORM app_private.income_expense_action_scope_v1(v_room.organization_id);
  v_today := public.org_today_v1(v_room.organization_id);

  IF NOT (public.can_access_building(v_room.building_id)
          OR public.ie_all_buildings_scope(v_room.building_id)
) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem toà này' USING ERRCODE='42501';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT c.id), '{}') INTO v_ids
    FROM contracts c
   WHERE c.deleted_at IS NULL AND c.organization_id = v_room.organization_id
     AND (c.room_id = p_room_id
          OR EXISTS (SELECT 1 FROM contract_transfers tr
                      WHERE tr.contract_id = c.id
                        AND tr.status IN ('COMPLETED','APPROVED')
                        AND (tr.old_room_id = p_room_id OR tr.new_room_id = p_room_id)));

  WITH seg_raw AS (
    -- Thanh cư trú trên phòng này. to_date NULL từ projection nghĩa là "không
    -- có mốc chuyển đi" — hợp đồng đã kết thúc thì đóng tại ngày kết thúc.
    SELECT s.contract_id, s.contract_number, s.seg_index, s.from_date,
           CASE
             WHEN s.to_date IS NOT NULL THEN s.to_date
             ELSE COALESCE(c.actual_end_date::date,
                    CASE WHEN c.status::text IN ('TERMINATED','EXPIRED')
                         THEN c.end_date::date END)
           END AS to_date,
           s.source_path, s.trusted, s.diagnostic
      FROM public.get_room_residence_segments_v1(v_ids) s
      JOIN contracts c ON c.id = s.contract_id
     WHERE s.room_id = p_room_id
  ),
  seg AS (
    -- Mốc đóng SỚM HƠN mốc mở = dữ liệu bẩn (hợp đồng rác kết thúc trước khi
    -- bắt đầu — có thật trên prod, phòng 401). Kẹp 0 ngày + hạ trusted + gắn
    -- diagnostic: UI vẽ thanh cảnh báo, vacancy bỏ qua.
    SELECT r.contract_id, r.contract_number, r.seg_index, r.from_date,
           CASE WHEN r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                     AND r.to_date < r.from_date
                THEN r.from_date ELSE r.to_date END AS to_date,
           r.source_path,
           (r.trusted AND NOT (r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                               AND r.to_date < r.from_date)) AS trusted,
           CASE WHEN r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                     AND r.to_date < r.from_date
                THEN 'SEGMENT_END_BEFORE_START' ELSE r.diagnostic END AS diagnostic
      FROM seg_raw r
  ),
  hd AS (
    SELECT c.id, c.contract_number, c.status::text AS status,
           c.signed_date, c.start_date, c.end_date, c.actual_end_date,
           c.rent_price, c.total_deposit,
           t.full_name AS tenant_name
      FROM contracts c
      LEFT JOIN tenants t ON t.id = c.tenant_id
     WHERE c.id = ANY(v_ids)
  ),
  ev AS (
    SELECT 'CONTRACT_OPENED' AS type, s.from_date AS date, s.contract_id,
           NULL::numeric AS amount, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path) AS meta
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index = 0
    UNION ALL
    SELECT 'ROOM_CHANGED_IN', s.from_date, s.contract_id, NULL, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path)
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index > 0
    UNION ALL
    SELECT CASE WHEN tr.id IS NOT NULL THEN 'ROOM_CHANGED_OUT' ELSE 'CONTRACT_CLOSED' END,
           s.to_date, s.contract_id, NULL, s.trusted,
           jsonb_build_object('segIndex', s.seg_index)
      FROM seg s
      LEFT JOIN contract_transfers tr
        ON tr.contract_id = s.contract_id AND tr.old_room_id = p_room_id
       AND tr.status IN ('COMPLETED','APPROVED')
       AND COALESCE(tr.move_out_date, tr.transfer_date) = s.to_date
     WHERE s.to_date IS NOT NULL
    UNION ALL
    SELECT 'DEPOSIT_RECEIVED', ie.voucher_date, ie.contract_id, ie.total_amount,
           (ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL),
           jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.organization_id = v_room.organization_id AND ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source IN ('contract.deposit','deposit.reservation')
       AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'INVOICE_ISSUED', COALESCE(i.issue_date::date, (i.billing_month || '-01')::date),
           i.contract_id, i.total_amount, true,
           jsonb_build_object('billingMonth', i.billing_month, 'status', i.status)
      FROM invoices i
     WHERE i.organization_id = v_room.organization_id AND i.contract_id = ANY(v_ids) AND i.room_id = p_room_id
       AND i.deleted_at IS NULL AND i.status NOT IN ('CANCELLED','DRAFT')
    UNION ALL
    SELECT 'INVOICE_COLLECTION_POSTED', COALESCE(i.paid_date::date, i.updated_at::date),
           i.contract_id, i.paid_amount, true,
           jsonb_build_object('billingMonth', i.billing_month)
      FROM invoices i
     WHERE i.organization_id = v_room.organization_id AND i.contract_id = ANY(v_ids) AND i.room_id = p_room_id
       AND i.deleted_at IS NULL AND i.status IN ('PAID','PARTIAL_PAID')
       AND COALESCE(i.paid_amount,0) > 0
    UNION ALL
    SELECT 'TERMINATION_REQUESTED', COALESCE(t.termination_date::date, t.created_at::date),
           t.contract_id, t.refund_amount,
           (t.status IN ('APPROVED','COMPLETED')),
           jsonb_build_object('status', t.status, 'type', t.termination_type)
      FROM contract_terminations t
     WHERE t.organization_id = v_room.organization_id AND t.contract_id = ANY(v_ids)
    UNION ALL
    SELECT 'SETTLEMENT_OFFSET_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.organization_id = v_room.organization_id AND ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'DEPOSIT_FORFEIT_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.organization_id = v_room.organization_id AND ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.forfeit_offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'DEPOSIT_REFUND_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.organization_id = v_room.organization_id AND ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.refund' AND ie.approval_status = 'APPROVED'
       AND ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL
    UNION ALL
    SELECT 'COMMISSION_PAID', ie.voucher_date, ie.contract_id, ie.total_amount,
           (ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL),
           jsonb_build_object('code', ie.code, 'name', ie.name)
      FROM income_expenses ie
     WHERE ie.organization_id = v_room.organization_id AND ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'contract.commission' AND ie.approval_status = 'APPROVED'
  ),
  ev_loc AS (
    SELECT * FROM ev
     WHERE date IS NOT NULL
       AND (p_from IS NULL OR date >= p_from)
       AND (p_to   IS NULL OR date <= p_to)
  ),
  -- Vacancy theo chuẩn island (fix #2): running max của to_date đã thấy, NULL
  -- (đang ở) coi là infinity — sau một segment mở thì không bao giờ còn gap.
  seg_sorted AS (
    SELECT s.from_date, s.to_date,
           max(COALESCE(s.to_date, 'infinity'::date)) OVER (
             ORDER BY s.from_date NULLS FIRST
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run_max_to,
           lead(s.from_date) OVER (ORDER BY s.from_date NULLS FIRST) AS next_from
      FROM seg s WHERE s.trusted
  ),
  vac AS (
    SELECT DISTINCT ss.run_max_to AS from_date, ss.next_from AS to_date,
           (ss.next_from - ss.run_max_to) AS days
      FROM seg_sorted ss
     WHERE ss.next_from IS NOT NULL
       AND ss.run_max_to <> 'infinity'::date
       AND ss.next_from > ss.run_max_to
    UNION ALL
    -- Đuôi mở: mọi segment tin cậy đều đã đóng ⇒ phòng trống từ mốc đóng muộn
    -- nhất tới hôm nay (chỉ khi thật sự đã qua ngày đó)
    SELECT max(s.to_date), NULL, (v_today - max(s.to_date))
      FROM seg s
     WHERE s.trusted
    HAVING count(*) > 0
       AND bool_and(s.to_date IS NOT NULL)
       AND max(s.to_date) < v_today
  )
  SELECT jsonb_build_object(
    'room', jsonb_build_object(
      'id', v_room.id, 'name', v_room.name,
      'buildingId', v_room.building_id, 'buildingName', v_room.building_name),
    'organizationId', v_room.organization_id, 'today', v_today,
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'contracts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', h.id, 'number', h.contract_number, 'status', h.status,
        'signedDate', h.signed_date, 'startDate', h.start_date, 'endDate', h.end_date,
        'actualEndDate', h.actual_end_date,
        'rentPrice', h.rent_price, 'totalDeposit', h.total_deposit,
        'tenantName', h.tenant_name) ORDER BY h.start_date)
      FROM hd h), '[]'::jsonb),
    'segments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'contractId', s.contract_id, 'contractNumber', s.contract_number,
        'segIndex', s.seg_index, 'fromDate', s.from_date, 'toDate', s.to_date,
        'sourcePath', s.source_path, 'trusted', s.trusted, 'diagnostic', s.diagnostic)
        ORDER BY s.from_date NULLS FIRST, s.seg_index)
      FROM seg s), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'type', e.type, 'date', e.date, 'contractId', e.contract_id,
        'amount', e.amount, 'trusted', e.trusted, 'meta', e.meta)
        ORDER BY e.date, e.type)
      FROM ev_loc e), '[]'::jsonb),
    'vacancies', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'fromDate', v.from_date, 'toDate', v.to_date, 'days', v.days)
        ORDER BY v.from_date)
      FROM vac v), '[]'::jsonb),
    'generatedAt', now()
  ) INTO v_out;

  RETURN v_out;
END;
$function$
;
GRANT CREATE ON SCHEMA public TO ie_action_snapshot_reader;
ALTER FUNCTION public.get_room_cash_lifecycle_v1(uuid,date,date) OWNER TO ie_action_snapshot_reader;
ALTER FUNCTION public.get_room_residence_segments_v1(uuid[]) OWNER TO ie_action_snapshot_reader;
REVOKE CREATE ON SCHEMA public FROM ie_action_snapshot_reader;
REVOKE ALL ON FUNCTION public.get_room_cash_lifecycle_v1(uuid,date,date) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.get_room_residence_segments_v1(uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.get_room_cash_lifecycle_v1(uuid,date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_room_residence_segments_v1(uuid[]) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
