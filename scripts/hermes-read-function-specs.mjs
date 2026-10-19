// Reviewed SQL-standard read bodies. These exact source bindings extend the
// existing task extractor and transaction masker without accepting arbitrary
// STABLE/BEGIN ATOMIC functions or dropping their statement boundaries.
export const HERMES_READ_STANDARD_FUNCTIONS = Object.freeze([
  Object.freeze({
    name: 'app_private.hermes_domain_read_rows_fast_v1',
    sourcePath: 'supabase/migrations/20261019040055_crm_shared_read_cores_v1.sql',
    statementSha256: '150d39f60a1c05bcc7d104ea5680b9a843f7528a8e94b82c148f585f6f397c4e',
  }),
  Object.freeze({
    name: 'public.hermes_domain_read_fast_v1',
    sourcePath: 'supabase/migrations/20261019040111_hermes_domain_read_fast_v1.sql',
    statementSha256: 'a82d964cb2abce27b1d5322fa6ae361c86735ebe0e322d699172805b55cc2be5',
  }),
]);
