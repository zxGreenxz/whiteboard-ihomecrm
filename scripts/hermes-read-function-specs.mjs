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
  // B5c (20261020171321): the receivables branch also names the building
  // (buildingName/buildingCode). The B2 body above stays pinned for the same
  // reason as the 20261019040055 one.
  Object.freeze({
    name: 'app_private.hermes_domain_read_rows_fast_v1',
    sourcePath: 'supabase/migrations/20261020171321_hermes_receivables_building_name_v1.sql',
    statementSha256: '193af7b6a9f640514f9cc3b856d04bc62efecb789f5737034214c74b91e64a30',
  }),
  // B5c step 2 (20261020173818): customers, contracts and invoices rows name their
  // building/room too. Earlier bodies stay pinned for the same reason.
  Object.freeze({
    name: 'app_private.hermes_domain_read_rows_fast_v1',
    sourcePath: 'supabase/migrations/20261020173818_hermes_domain_reads_building_name_v1.sql',
    statementSha256: 'e6604edd92a995b8cf823e3785e8f730fa179a5d03e65e0872a7534e23374326',
  }),
  // R2a (20261020233934): every list domain of the reader carries the summary of the
  // whole filtered set (receivables recomputed under RLS; customers/invoices/contracts
  // from the core totals). Earlier bodies stay pinned for the same reason.
  Object.freeze({
    name: 'app_private.hermes_domain_read_rows_fast_v1',
    sourcePath: 'supabase/migrations/20261020233934_hermes_domain_summary_v1.sql',
    statementSha256: '79cf9b42a5233cc9971e00331dd370e581b12013fd06c5eeb0160d6053c2b953',
  }),
  // R2c part 2 (20261021044801): the customers summary counts the contract status
  // (customers.status_v2) of the core's set under the asker's RLS. Earlier bodies stay
  // pinned for the same reason.
  Object.freeze({
    name: 'app_private.hermes_domain_read_rows_fast_v1',
    sourcePath: 'supabase/migrations/20261021044801_hermes_domain_customer_status_asset_created_v1.sql',
    statementSha256: '729dd8b9a53073c7a552202a40da781c74a067c06f61a69752abf2d00f669631',
  }),
  // R2d (20261021063452): the customers summary adds withoutContract, counted by the
  // private DEFINER helper the body binds. Earlier bodies stay pinned for the same reason.
  Object.freeze({
    name: 'app_private.hermes_domain_read_rows_fast_v1',
    sourcePath: 'supabase/migrations/20261021063452_hermes_domain_without_contract_latest_count_v1.sql',
    statementSha256: '193528a3d333798560c15e7e9d1647a3bb4aec886f247aba52489995d722bc45',
  }),
  // Nền chung thao tác ghi (M5, 20261021132433): vỏ giải tên INVOKER gắn OID lõi app_private và
  // hàm thành viên lúc tạo, nên chạy được khi authenticated không có USAGE app_private.
  Object.freeze({
    name: 'public.hermes_write_name_resolve_v1',
    sourcePath: 'supabase/migrations/20261021132433_hermes_write_name_resolve_v1.sql',
    statementSha256: '0f05b8b4cd418bac3450f4ab830dddf98a3511df81be2be40499c5bb4dab8899',
  }),
  Object.freeze({
    name: 'public.hermes_domain_read_fast_v1',
    sourcePath: 'supabase/migrations/20261019040111_hermes_domain_read_fast_v1.sql',
    statementSha256: 'a82d964cb2abce27b1d5322fa6ae361c86735ebe0e322d699172805b55cc2be5',
  }),
]);
