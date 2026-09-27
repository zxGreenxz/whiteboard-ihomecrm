-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.update_asset_status_on_contract_change() md5(prosrc)=bbddce36016c3cc58e5a2f7c468d4de1
CREATE OR REPLACE FUNCTION public.update_asset_status_on_contract_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- assets không có status field — trigger này không cần làm gì.
  -- Giữ trigger để không phải drop trigger DDL trên contracts (tránh churn).
  RETURN NEW;
END;
$function$

