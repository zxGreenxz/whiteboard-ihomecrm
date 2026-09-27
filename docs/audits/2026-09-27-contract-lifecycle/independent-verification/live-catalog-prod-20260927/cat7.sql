-- @@ copilot_tables
select table_schema, table_name from information_schema.tables where table_name ~ '^copilot_(action|feature|policy|registry)' order by 1,2
-- @@ copilot_flags
select * from public.copilot_feature_flags order by 1
-- @@ route_flags_contract
select feature_key, mode, force_freeze, ends_at from app_private.server_feature_flags where feature_key ~ '(contract|deposit|reservation|termination|room|income_expense\.posting|create_draft)' order by 1
