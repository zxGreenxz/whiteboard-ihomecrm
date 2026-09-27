-- PUBLICATION REDACTION: historical TEST-clone row IDs removed.
-- Original SHA-256: see ../publication-redaction-manifest.json.
-- Query template: supply private probe_voucher_prefix and probe_contract_prefix as psql variables.
-- @@ voucher_absent
select count(*) as vouchers_with_probe_prefix from public.income_expenses where id::text like (:'probe_voucher_prefix' || '%');
-- @@ termination_absent
select count(*) as terminations_for_probe_contract from public.contract_terminations where contract_id::text like (:'probe_contract_prefix' || '%');
-- @@ contract_still_active
select c.status, r.status room_status from public.contracts c join public.rooms r on r.id=c.room_id where c.id::text like (:'probe_contract_prefix' || '%');
