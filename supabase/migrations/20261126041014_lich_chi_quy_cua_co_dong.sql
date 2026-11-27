BEGIN;

-- R2 resolves the signed-in shareholder before adding their own fund payment lines.
DO $migration$
DECLARE
  original text := pg_get_functiondef('public.shareholder_profit_my_position_v1(uuid)'::regprocedure);
  anchor constant text := 'RETURN doc||jsonb_build_object(''house_pool'',own_position);';
  replacement constant text := $new$IF to_regclass('app_private.house_pool_expense_status') IS NOT NULL THEN
    doc := doc || jsonb_build_object('fund_charges', (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',e.voucher_id,'code',e.code,'date',e.voucher_date,'amount',s.amount,'live',e.live)
      ORDER BY e.voucher_date DESC,e.voucher_id),'[]'::jsonb)
      FROM app_private.house_pool_expense_status e
      CROSS JOIN LATERAL (VALUES (e.first_holder,e.first_amount),(e.second_holder,e.amount-e.first_amount)) s(holder,amount)
      WHERE e.organization_id=p_organization_id AND s.holder=(doc->'shareholder'->>'id')::uuid));
  END IF;
  RETURN doc || jsonb_build_object('house_pool',own_position,'fund_payments',
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'date',b.voucher_date,
       'code',v.code,'state',b.state,'amount',l.amount) ORDER BY b.voucher_date DESC,b.id),'[]'::jsonb)
       FROM app_private.house_pool_return_lines l
       JOIN app_private.house_pool_batch_status b ON b.id=l.batch_id AND b.organization_id=l.organization_id
       JOIN public.income_expenses v ON v.id=b.voucher_id AND v.organization_id=b.organization_id
       WHERE l.organization_id=p_organization_id AND l.shareholder_id=(doc->'shareholder'->>'id')::uuid));$new$;
BEGIN
  IF strpos(original,replacement)=0 THEN
    IF strpos(original,anchor)=0 THEN RAISE EXCEPTION 'Hàm đọc vị thế cá nhân đã đổi'; END IF;
    EXECUTE replace(original,anchor,replacement);
  END IF;
END $migration$;

-- E2 already verified the viewer, company and shareholder before constructing this response.
DO $migration$
DECLARE
  original text := pg_get_functiondef('public.shareholder_profit_ledger_entries_v1(uuid,uuid)'::regprocedure);
  anchor constant text := '  RETURN jsonb_build_object(';
  replacement constant text := $new$  RETURN jsonb_build_object('settlement_periods',(
    SELECT coalesce(jsonb_agg(jsonb_build_object('voucher_id',s.cash_voucher_id,'month',s.through_month)),'[]'::jsonb)
    FROM app_private.profit_ledger_payout_settlements s WHERE s.organization_id=p_organization_id AND s.shareholder_id=v_sh.id
      AND s.cash_voucher_id IS NOT NULL AND app_private.profit_ledger_settlement_live_v1(s.id)),'historical_advances',(
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'period_month',r.period_month,'amount',r.amount,
      'external_profit',r.external_profit,'evidence',r.evidence,'sources',app_private.shareholder_receipt_sources_v1(r.id),'code','TU-LS-' || to_char(r.period_month,'YYYYMM') || '-' || left(r.id::text,8))
      ORDER BY r.period_month),'[]'::jsonb)
    FROM app_private.shareholder_opening_advance_receipts r JOIN app_private.shareholder_profit_openings o ON o.id=r.opening_id
    WHERE o.organization_id=p_organization_id AND o.shareholder_id=v_sh.id),$new$;
BEGIN
  IF strpos(original,replacement)=0 THEN
    IF (length(original)-length(replace(original,anchor,'')))<>length(anchor) THEN RAISE EXCEPTION 'Hàm đọc sổ cổ đông đã đổi'; END IF;
    EXECUTE replace(original,anchor,replacement);
  END IF;
END $migration$;
-- Only the owner state can expose a cash voucher for a referenced company fund debit.
DO $migration$
DECLARE
  original text := pg_get_functiondef('public.shared_fund_state_v1(uuid)'::regprocedure);
  anchor constant text := '''has_opening'',';
  replacement constant text := $new$'expense_vouchers', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'source_id',e.id,'code',v.code,'date',v.voucher_date,
      'amount',v.total_amount,'name',v.name,'account',a.name,'status',v.approval_status,'posting',v.posting_status)
      ORDER BY v.voucher_date DESC,v.id),'[]'::jsonb)
    FROM app_private.shared_fund_entries e JOIN public.income_expenses v ON v.organization_id=e.organization_id
      AND (v.id::text=btrim(e.reference) OR lower(v.code)=lower(btrim(e.reference)))
      AND v.total_amount=e.amount AND v.type='EXPENSE' AND v.deleted_at IS NULL
    LEFT JOIN public.accounts a ON a.id=v.account_id AND a.organization_id=e.organization_id
    WHERE e.organization_id=p_organization_id AND e.kind='DEBIT'), 'has_opening',$new$;
BEGIN
  IF strpos(original,replacement)=0 THEN
    IF (length(original)-length(replace(original,anchor,'')))<>length(anchor) THEN RAISE EXCEPTION 'Hàm đọc quỹ chung đã đổi'; END IF;
    EXECUTE replace(original,anchor,replacement);
  END IF;
END $migration$;
COMMIT;
