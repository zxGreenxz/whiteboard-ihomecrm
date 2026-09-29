-- Read the saved return note through the existing refund voucher facts reader.
-- Keep the public RPC and its voucher/building ACL unchanged. No financial data
-- or generated voucher notes are rewritten. Old cases have a NULL return_note.
CREATE OR REPLACE FUNCTION app_private.termination_refund_facts_v1(p_voucher_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
WITH v AS (
  SELECT ie.id, ie.code, ie.contract_id, ie.organization_id, ie.total_amount, ie.voucher_date,
         ie.approval_status, ie.account_id, ie.notes
    FROM public.income_expenses ie
   WHERE ie.id = p_voucher_id
     AND ie.deleted_at IS NULL
     AND ie.system_source = 'termination.refund'
     AND ie.contract_id IS NOT NULL
),
t AS (
  SELECT ct.*
    FROM v
    JOIN public.contract_terminations ct ON ct.contract_id = v.contract_id
   ORDER BY ct.created_at DESC
   LIMIT 1
),
inv AS (
  SELECT i.id
    FROM v
    JOIN public.invoices i ON i.contract_id = v.contract_id
   WHERE i.kind = 'SETTLEMENT'
     AND i.deleted_at IS NULL
     AND i.status::text <> 'CANCELLED'
   ORDER BY i.created_at DESC
   LIMIT 1
),
sitems AS (
  SELECT ii.description, ii.amount, ii.type::text AS type, ii.sort_order, ii.id
    FROM inv
    JOIN public.invoice_items ii ON ii.invoice_id = inv.id
),
ritems AS (
  SELECT it.description,
         COALESCE(it.amount, it.unit_price * it.quantity) AS amount,
         ty.name AS type_name,
         COALESCE(ty.is_deposit, false) AS is_deposit,
         it.created_at, it.id
    FROM v
    JOIN public.income_expense_items it ON it.income_expense_id = v.id
    LEFT JOIN public.income_expense_types ty ON ty.id = it.income_expense_type_id
),
c AS (
  SELECT ct.actual_end_date FROM v JOIN public.contracts ct ON ct.id = v.contract_id
)
SELECT jsonb_build_object(
  'voucher', jsonb_build_object(
    'id', v.id, 'code', v.code, 'total_amount', v.total_amount,
    'voucher_date', v.voucher_date, 'approval_status', v.approval_status,
    'account_id', v.account_id, 'notes', v.notes),
  'contract', app_private.commission_contract_facts_v1(v.contract_id),
  'end_date', COALESCE((SELECT t.actual_move_out_date FROM t),
                       (SELECT c.actual_end_date FROM c),
                       v.voucher_date),
  -- Match the financial audit referenced by the finalized handover, never infer
  -- the note from the voucher text or another organization's exit case.
  'return_note', (
    SELECT e.return_note
      FROM public.contract_exit_cases e
      JOIN t ON t.id = e.legacy_termination_id
     WHERE e.contract_id = v.contract_id
       AND e.organization_id = v.organization_id
       AND e.state = 'FINALIZED'
  ),
  'termination', (SELECT jsonb_build_object(
      'id', t.id, 'termination_date', t.termination_date,
      'actual_move_out_date', t.actual_move_out_date,
      'outstanding_debt', t.outstanding_debt,
      'early_termination_fee', t.early_termination_fee,
      'deposit_used', t.total_deposit,
      'rent_refund_amount', t.rent_refund_amount,
      'total_deductions', t.total_deductions,
      'refund_amount', t.refund_amount,
      'status', t.status, 'notes', t.notes) FROM t),
  'excess_rent', COALESCE((
      SELECT regexp_replace((regexp_match(t.notes, 'Tiền thừa \(credit\) áp dụng: ([0-9.,]+)đ'))[1], '[^0-9]', '', 'g')::numeric
        FROM t WHERE t.notes ~ 'Tiền thừa \(credit\) áp dụng: [0-9.,]+đ'), 0),
  'shortfall_mode', (SELECT CASE
      WHEN t.notes LIKE '%GHI NỢ — chờ thu%' THEN 'DEBT'
      WHEN t.notes LIKE '%đã thu ngay khi thanh lý%' THEN 'PAID'
      END FROM t),
  'settlement_items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('description', s.description, 'amount', s.amount, 'type', s.type)
                       ORDER BY s.sort_order, s.id)
        FROM sitems s), '[]'::jsonb),
  'refund_items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('description', r.description, 'amount', r.amount,
                                          'type_name', r.type_name, 'is_deposit', r.is_deposit)
                       ORDER BY r.created_at, r.id)
        FROM ritems r), '[]'::jsonb)
)
FROM v;
$fn$;

REVOKE ALL ON FUNCTION app_private.termination_refund_facts_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
