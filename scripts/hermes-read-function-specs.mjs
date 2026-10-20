// Reviewed SQL-standard read bodies. These exact source bindings extend the
// existing task extractor and transaction masker without accepting arbitrary
// STABLE/BEGIN ATOMIC functions or dropping their statement boundaries.
export const HERMES_READ_STANDARD_FUNCTIONS = Object.freeze([
  Object.freeze({
    name: 'app_private.hermes_domain_read_rows_fast_v1',
    sourcePath: 'supabase/migrations/20261019040055_crm_shared_read_cores_v1.sql',
    statementSha256: '150d39f60a1c05bcc7d104ea5680b9a843f7528a8e94b82c148f585f6f397c4e',
  }),
  // B2 (20261020101836): the same reader gains the receivables branch. The
  // applied 20261019040055 body above stays pinned: that file is immutable and
  // its statement must still verify when the forward lane replays history.
  Object.freeze({
    name: 'app_private.hermes_domain_read_rows_fast_v1',
    sourcePath: 'supabase/migrations/20261020101836_hermes_domain_read_fast_receivables_v1.sql',
    statementSha256: '3f9edcfa3895ee8c3884079889def27d15f41db7cfca2179fab3165dcc383ecd',
  }),
  Object.freeze({
    name: 'public.hermes_domain_read_fast_v1',
    sourcePath: 'supabase/migrations/20261019040111_hermes_domain_read_fast_v1.sql',
    statementSha256: 'a82d964cb2abce27b1d5322fa6ae361c86735ebe0e322d699172805b55cc2be5',
  }),
]);
