# Authorization tranche `<ID>` — `<title>`

> Trạng thái: `IN_DESIGN | PREPARED | APPLIED | VERIFIED | BLOCKED`  
> Production mutation: **không được phép** nếu thiếu một trường bắt buộc bên dưới.

## 1. Scope và dependency

- Deliverable/tranche ID:
- Domain:
- Normative plan section:
- Dependencies và trạng thái:
- In scope:
- Out of scope:
- Business behavior trước thay đổi:
- Business behavior sau thay đổi:
- Ảnh hưởng nghiệp vụ/người dùng:

## 2. Immutable release identity

- Full commit SHA:
- Exact migration path/signature:
- Migration SHA-256:
- Generated-types SHA-256:
- Deployed frontend SHA:
- Recovery certification ID (`VERIFIED`):
- Maintenance-window ID:
- Operator:
- Reviewer:
- Owner approval reference:

Không dùng branch name, “latest”, glob migration hoặc broad `db push` làm release identity.

## 3. Live precheck

- UTC/local start time:
- Exact live signatures/owners/search paths/grants:
- Active callers/writers:
- Migration-ledger state:
- Pre-state table/object/count/hash:
- Financial reconciliation baseline:
- Browser/runtime baseline:
- Monitoring healthy:
- Managed backup reference:

## 4. Change contract

- Server-derived organization/actor/resources:
- Exact permission and resource scope:
- State/version/CAS rules:
- Lock order:
- Idempotency scope, canonical payload hash và conflict behavior:
- Atomic effects:
- Audit/provenance:
- External outbox/side effects:
- Forward-fix/reversal behavior:
- Feature flag default:

## 5. Test evidence trước production

- Project restore/staging ID:
- Unit/property tests:
- Direct JWT REST/RPC matrix:
- Cross-org/foreign-resource tests:
- Concurrent/retry/rollback-injection tests:
- `npm run typecheck:baseline`:
- `npx tsc --noEmit -p tsconfig.app.json`:
- Related/full Vitest:
- `npm run lint` / `npm run build`:
- `node scripts/check-definer-acl.mjs`:
- `node scripts/check-view-invoker.mjs` (nếu đụng VIEW):
- Generated Supabase type drift:
- Full money reconciliation (nếu đụng tiền):
- Browser happy/edge/deny và console/network:
- Reviewer verdict:

## 6. Canary và production gate

- Canary organization/users:
- Transaction count cap:
- VND cap:
- Observation interval:
- Expansion approval:
- Old writer drain proof:
- Exact revoke/policy/signature:

Default nếu chưa được owner chốt: canary count = `0`, VND cap = `0`, flag = `OFF`, không apply/flip.

## 7. Mandatory abort

Abort ngay khi có một trong các điều kiện:

- unauthorized hoặc cross-org success;
- financial drift khác 0;
- duplicate payment/posting/reversal;
- orphan/split operation;
- unexpected legacy writer;
- backup/object hash mismatch;
- canary happy path bị deny không giải thích;
- 3 RPC failure liên tiếp hoặc >1% trong 5 phút;
- p95 >2× baseline trong 10 phút;
- mất monitoring/backup/audit telemetry.

Khi abort: disable canary, freeze domain, giữ evidence; không xóa/sửa row tiền để rollback. Reconcile, forward-fix và tạo compensating reversal khi cần.

## 8. Post-apply evidence

- Apply start/end UTC:
- Catalog/signature/grant pre/post diff:
- Direct API deny/allow result:
- Browser result:
- Reconciliation delta:
- Runtime error/latency/deny metrics:
- Hidden caller/legacy writer result:
- Observation completed at:
- Final reviewer:
- Final state (`APPLIED` hoặc `VERIFIED`):
- Tracker update commit:

Evidence không được chứa credential, JWT, signed URL, private object path hoặc PII.
