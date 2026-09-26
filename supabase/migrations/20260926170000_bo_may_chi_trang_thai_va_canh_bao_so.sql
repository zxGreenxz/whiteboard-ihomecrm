-- =============================================================================
-- bo_may_chi_trang_thai_va_canh_bao_so — phục vụ màn "Cam kết chi" cho chủ (26/09/2026)
-- =============================================================================
-- VÌ SAO
--   Chủ cần một chỗ nhìn thấy bộ máy chi đang ở chế độ nào (tắt / bóng / áp), máy đã chấm
--   bao nhiêu phiếu, lệch bao nhiêu, và — G6 — bao nhiêu phiếu chi được lập bởi người KHÔNG
--   giữ sổ để chi ("lẽ ra bị chặn"). Plan §6 G6: cảnh báo đủ 7 ngày rồi mới bật chặn.
--
-- LÀM GÌ
--   1. public.get_spend_engine_status_v1(org): tuyến hai cờ, số quyết định bóng 30 ngày
--      (khớp / lệch / đã áp), số ca G6 cảnh báo, lỗi máy 7 ngày, công tắc đang bật, sổ tiêu.
--   2. spend_shadow_report_v1 trả thêm cột cashbook_ok (người lập có giữ sổ để chi không)
--      và fee_categories (khoá phí của các dòng) — đổi kiểu trả về nên DROP rồi CREATE; hàm
--      mới có từ 20260926150000, chưa có caller giao diện nào.
--
-- KHÔNG ĐỤNG
--   Không đổi bộ máy, sổ tiêu, cổng, writer. Chỉ đọc.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_spend_engine_status_v1(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_super_admin()
     OR app_private.ie_actor_is_company_owner_v1(p_organization_id, auth.uid())) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'route', app_private.spend_route_v1(p_organization_id),
    'cashbook_route', app_private.evaluate_feature_route('spend.cashbook_chi.v1', p_organization_id),
    'shadow_since', (SELECT min(d.decided_at) FROM app_private.spend_decisions d
                      WHERE d.organization_id = p_organization_id),
    'decisions_30d', (SELECT count(*) FROM app_private.spend_decisions d
                       WHERE d.organization_id = p_organization_id
                         AND d.decided_at > now() - interval '30 days'),
    'mismatches_30d', (SELECT count(*) FROM app_private.spend_decisions d
                        WHERE d.organization_id = p_organization_id
                          AND d.decided_at > now() - interval '30 days' AND NOT d.match),
    'enforced_30d', (SELECT count(*) FROM app_private.spend_decisions d
                      WHERE d.organization_id = p_organization_id
                        AND d.decided_at > now() - interval '30 days' AND d.enforced),
    'cashbook_warn_30d', (SELECT count(*) FROM app_private.spend_decisions d
                           WHERE d.organization_id = p_organization_id
                             AND d.decided_at > now() - interval '30 days'
                             AND d.direction = 'EXPENSE'
                             AND d.facts->>'actor_cashbook_ok' = 'false'),
    'errors_7d', (SELECT count(*) FROM app_private.spend_engine_errors x
                   WHERE x.organization_id = p_organization_id
                     AND x.at > now() - interval '7 days'),
    'switches_on', (SELECT count(*) FROM app_private.spend_policy_switches s
                     WHERE s.organization_id = p_organization_id AND s.retired_at IS NULL),
    'ledger', COALESCE((SELECT jsonb_object_agg(s.kind, jsonb_build_object('n', s.n, 'amount', s.amount))
                          FROM (SELECT x.kind, count(*) n, sum(x.amount) amount
                                  FROM app_private.spend_commitment_draws x
                                 WHERE x.organization_id = p_organization_id
                                 GROUP BY x.kind) s), '{}'::jsonb));
END
$fn$;

REVOKE ALL ON FUNCTION public.get_spend_engine_status_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_spend_engine_status_v1(uuid) TO authenticated;

DROP FUNCTION IF EXISTS public.spend_shadow_report_v1(uuid, date, date);
CREATE FUNCTION public.spend_shadow_report_v1(
  p_organization_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (voucher_id uuid, code text, voucher_date date, building_name text, writer text,
               amount numeric, birth_status text, engine_status text, engine_reason text,
               match boolean, enforced boolean, route text, decided_at timestamptz,
               cashbook_ok boolean, fee_categories text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_super_admin()
     OR app_private.ie_actor_is_company_owner_v1(p_organization_id, auth.uid())) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT d.income_expense_id, e.code, e.voucher_date, b.name, d.writer, d.amount,
         d.birth_status, d.engine_status, d.engine_reason, d.match, d.enforced, d.route, d.decided_at,
         CASE WHEN d.facts->>'actor_cashbook_ok' IS NULL THEN NULL
              ELSE (d.facts->>'actor_cashbook_ok')::boolean END,
         (SELECT string_agg(DISTINCT l->>'fee_category', ', ')
            FROM jsonb_array_elements(COALESCE(d.facts->'lines', '[]'::jsonb)) l
           WHERE l->>'fee_category' IS NOT NULL)
    FROM app_private.spend_decisions d
    LEFT JOIN public.income_expenses e ON e.id = d.income_expense_id
    LEFT JOIN public.buildings b ON b.id = d.building_id
   WHERE d.organization_id = p_organization_id
     AND (p_from IS NULL OR d.decided_at >= p_from)
     AND (p_to IS NULL OR d.decided_at < p_to + 1)
   ORDER BY d.decided_at DESC
   LIMIT 2000;
END
$fn$;

REVOKE ALL ON FUNCTION public.spend_shadow_report_v1(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.spend_shadow_report_v1(uuid, date, date) TO authenticated;

DO $sau$
BEGIN
  IF has_function_privilege('anon', 'public.get_spend_engine_status_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.spend_shadow_report_v1(uuid,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon còn EXECUTE trên RPC trạng thái bộ máy chi' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;
