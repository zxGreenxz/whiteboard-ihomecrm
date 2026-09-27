-- @@ policy_permissive
select tablename, policyname, permissive, cmd from pg_policies where tablename in ('contracts','rooms','jobs','room_reservation_holds','contract_terminations') order by 1,2
-- @@ fn_bodies
select n.nspname||'.'||p.proname as name, pg_get_function_identity_arguments(p.oid) args, md5(p.prosrc) src_md5, pg_get_functiondef(p.oid) def
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where (n.nspname, p.proname) in (
 ('public','update_room_status_on_contract_change'),('public','trg_room_status_reconcile'),('public','recompute_room_reservation'),
 ('public','update_asset_status_on_contract_change'),('public','trg_contract_link_orphan_deposits'),('public','update_contract_on_termination_approved'),
 ('public','guard_contract_termination_settlement'),('public','create_contract_v2'),('public','create_contract_v1'),('public','create_reservation_deposit_v1'),
 ('public','room_has_holding_deposit'),('public','get_public_available_rooms'),('public','get_my_available_rooms'),('public','set_reservation_hold_terms_v1'),
 ('public','set_reservation_hold_deadline_v1'),
 ('public','terminate_contract_move_out_with_credit_v1'),('public','terminate_contract_move_out'),('public','terminate_contract_move_out_impl'),
 ('public','terminate_contract_forfeit_with_credit_v1'),('public','terminate_contract_forfeit'),('public','terminate_contract_forfeit_impl'),
 ('public','_termination_apply_extra_charges'),('public','renew_contract'),('public','renew_contract_impl'),('public','transfer_room'),
 ('public','transfer_contract'),('public','transfer_contract_impl'),('public','apply_contract_transfer'),('app_private','lock_org_for_decision_v1'),
 ('public','v5_tick_from_job'),('public','award_job_bonus'),('public','approve_contract_termination_v1'),('public','org_today_v1'),
 ('app_private','guard_canonical_write_operation'),('public','guard_contract_deposit_paid_derived'),('public','generate_contract_number'),
 ('public','copilot_available_rooms_v1'),('app_private','reservation_room_blockers_v1'),('public','settle_reservation_deposit_v1'),
 ('app_private','apply_customer_credit_fifo_v1'),('public','log_contract_price_history'),('public','set_contract_public_code'),
 ('public','jobs_stamp_completion_time'),('app_private','notify_job_assigned_v1'),('public','auto_calculate_termination_financials')
)
order by 1,2
-- @@ fn_callers_of_create_contract_v1
select count(*) from pg_proc p where p.prosrc ilike '%create_contract_v1%' and p.proname <> 'create_contract_v1'
-- @@ server_flags
select * from app_private.server_feature_flags order by 1
