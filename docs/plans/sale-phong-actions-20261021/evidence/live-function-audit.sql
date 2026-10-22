SELECT p.proname AS routine,
       pg_get_function_identity_arguments(p.oid) AS signature,
       p.prosecdef AS security_definer,
       md5(p.prosrc) AS body_md5,
       pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'upsert_room_pass_listing',
    'set_reservation_hold_terms_v1',
    'create_room_reservation_v1',
    'update_room_reservation_v1'
  )
ORDER BY p.proname, signature
