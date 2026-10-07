-- Run ONLY through: npm run test-env:thu-sql -- scripts/tests/request-paid-leave.sql
-- The runner verifies the separate TEST project and rolls back every write.
DO $fixture$
DECLARE
  v_user uuid;
  v_owner uuid;
  v_org uuid;
  v_date date := public.vn_local_date(now()) + 1;
BEGIN
  IF to_regclass('test_env.danh_dau') IS NULL THEN
    RAISE EXCEPTION 'Separate TEST database marker required';
  END IF;
  SELECT id INTO STRICT v_user FROM public.profiles WHERE lower(full_name) = 'joey';
  SELECT organization_id INTO STRICT v_org FROM public.organization_memberships
    WHERE user_id = v_user AND status = 'ACTIVE';
  SELECT user_id INTO STRICT v_owner FROM public.super_admins ORDER BY created_at LIMIT 1;
  IF (SELECT count(DISTINCT organization_id) FROM public.organization_memberships
      WHERE user_id = v_owner AND status = 'ACTIVE') < 2 THEN
    RAISE EXCEPTION 'Regression requires a notification recipient in multiple organizations';
  END IF;
  IF extract(dow FROM v_date) = 0 THEN v_date := v_date + 1; END IF;
  -- Reset only the TEST copy, inside the runner's ROLLBACK transaction.
  DELETE FROM public.salary_attendance_day WHERE user_id = v_user
    AND (work_date = v_date OR (status IN ('pending_leave','leave_approved')
      AND extract(year FROM work_date) = extract(year FROM v_date)));
  PERFORM set_config('test.leave_user', v_user::text, true);
  PERFORM set_config('test.leave_owner', v_owner::text, true);
  PERFORM set_config('test.leave_org', v_org::text, true);
  PERFORM set_config('test.leave_date', v_date::text, true);
  PERFORM set_config('test.leave_marker', gen_random_uuid()::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',v_user,'role','authenticated')::text, true);
END $fixture$;
SET LOCAL ROLE authenticated;
DO $request$
DECLARE
  v_date date := current_setting('test.leave_date')::date;
  v_result jsonb;
  v_repeat jsonb;
BEGIN
  v_result := public.request_paid_leave(v_date, current_setting('test.leave_marker'));
  IF v_result->>'status' IS DISTINCT FROM 'pending_leave'
     OR (v_result->>'date')::date IS DISTINCT FROM v_date
     OR (v_result->>'quota_left')::int < 0 THEN
    RAISE EXCEPTION 'Request did not confirm pending leave for the chosen date: %', v_result;
  END IF;
  v_repeat := public.request_paid_leave(v_date, current_setting('test.leave_marker'));
  IF v_repeat->>'status' IS DISTINCT FROM 'pending_leave'
     OR (v_repeat->>'date')::date IS DISTINCT FROM v_date THEN
    RAISE EXCEPTION 'Repeat request did not return the existing leave: %', v_repeat;
  END IF;
END $request$;
RESET ROLE;
DO $assert$
DECLARE
  v_user uuid := current_setting('test.leave_user')::uuid;
  v_org uuid := current_setting('test.leave_org')::uuid;
  v_owner uuid := current_setting('test.leave_owner')::uuid;
  v_date date := current_setting('test.leave_date')::date;
BEGIN
  IF (SELECT count(*) FROM public.salary_attendance_day WHERE user_id = v_user
      AND work_date = v_date AND status = 'pending_leave' AND organization_id = v_org
      AND jsonb_array_length(audit) = 1) <> 1 THEN
    RAISE EXCEPTION 'Expected one pending attendance row in the requester organization';
  END IF;
  IF (SELECT count(*) FROM public.notifications
      WHERE content LIKE '%' || current_setting('test.leave_marker') || '%') <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one leave notification after repeated submission';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notifications
      WHERE content LIKE '%' || current_setting('test.leave_marker') || '%'
        AND user_id = v_owner AND organization_id = v_org
        AND metadata->>'staff_id' = v_user::text AND metadata->>'date' = v_date::text) THEN
    RAISE EXCEPTION 'Leave notification did not inherit the attendance organization';
  END IF;
  IF has_function_privilege('anon', 'public.request_paid_leave(date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous callers must not request paid leave';
  END IF;
  RAISE NOTICE 'PASS: authenticated request, correct organization, idempotent retry, one notification, anon denied';
END $assert$;
