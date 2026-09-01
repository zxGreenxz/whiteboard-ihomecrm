# PLAN - Hoan thien V5 Collection, va lo hong va port fix ke toan dung

> **[LỊCH SỬ — ĐÃ SHIP]** Tài liệu hiện hành: `docs/he-thong/07-hoa-don-thanh-toan.md` + `08-thu-chi-so-quy.md`. Giữ làm bằng chứng, không cập nhật nữa.

> Ngay cap nhat: 2026-07-22  
> Trang thai: **SAN SANG THUC THI**  
> Muc tieu: hoan thien `invoice.collection.v5` va `invoice.collection.reverse.v5`, giu dung sua loi L03/coc/KQKD, dong thoi port co chon loc cac fix an toan tu `05dce6e` ma khong dua he thong quay lai kien truc V3/V4.

---

## 0. Quyet dinh da chot

Plan nay khong con cho ba lua chon mo. Agent thuc thi theo dung cac quyet dinh sau:

1. Tao **nhanh moi tu `origin/main`**, khong `reset --hard`, khong force-push, khong merge `b449c3c` va khong cherry-pick nguyen commit `05dce6e`.
2. Giu kien truc client **V5 Collection** cua `origin/main`; chi port tung fix ke toan/an toan da duoc chung minh dung tu `05dce6e`.
3. Migration `20260721150500_accounting_scope_narrowing.sql` da chay live la **lich su bat bien**. Phai dua dung nguyen ban file nay vao repo, khong sua noi dung va khong chay lai.
4. Moi thay doi DB tiep theo phai la migration tien toi moi: hardening V5, canary DEMO, sau do moi kich hoat toan cuc.
5. Chi kich hoat hai route core:
   - `invoice.collection.v5`
   - `invoice.collection.reverse.v5`
6. Khong kich hoat trong plan nay:
   - `customer.credit.apply.v1`
   - `shareholder_profit.distribute.v2`
   - payout/profit locking moi
   - form insert payment doc lap co the chen payment gan hoa don
7. Customer credit cu duoc giu de doc/hoan tac. Lua chon `CREDIT` trong V5 phai fail-closed khi feature credit chua `CANONICAL`; khong duoc di vong qua bang `excess_amounts`.
8. Server la nguon phan bo tien co tham quyen. `planInvoiceCollection` tren client chi la preview/validation UX, khong phai nguon so lieu ke toan.

---

## 1. Snapshot su that da kiem chung

Tat ca so lieu duoi day la snapshot ngay 2026-07-22. Phase 0 bat buoc query lai truoc khi sua.

### 1.1 Git

| Ref | Commit | Su that |
|---|---|---|
| `origin/main` | `7b33f8546bc69c1f78dc14ad51f5b199e91c4a60` | Client V5 Collection; chua co migration scope-narrowing trong lich su remote |
| local `release/meter-domain` | `05dce6ec55959b1ed4613c40d23f12a94c0dd0d1` | Chuyen phan lon UI ve V3/V4 va them migration scope-narrowing |
| `origin/release/meter-domain` | `b449c3c7b26736394fc2988d065bd18946f5be2f` | Lich su song song, merge-base voi local la `e8cc059`; khong dung lam nen merge |

Local branch ten `main` khong duoc dung lam moc vi dang cu hon remote. Moi phep so sanh/tao branch trong plan deu phai dung ro `origin/main`. `b449c3c` va `26bf179` patch-equivalent nhung khac parent; day la ly do khong merge nham lich su song song.

Tai `05dce6e`, ban kinh vo build da duoc xac nhan la mot production importer:

- `src/hooks/useDeletePayment.ts` import `reverseInvoicePaymentBySource`.
- `src/lib/paymentRecordRpc.ts` cua `05dce6e` da bi thay bang API V3/V4 va khong export symbol tren.
- Lay nguyen `paymentRecordRpc.ts` cua mot phia se lam vo cac consumer cua phia con lai. Khong sua bang cach chep de nguyen file giua hai kien truc.

Khong duoc suy trang thai Vercel tu commit Git. Phase 0 phai xac nhan deployment commit va build thuc te rieng.

### 1.2 Supabase live

Da query read-only qua Management API:

| Hang muc | Trang thai live |
|---|---|
| `record_invoice_collection_v5(...)` | ton tai |
| `reverse_invoice_collection_v5(...)` | ton tai |
| `record_invoice_payment_v4(...)` semantic | ton tai |
| `undo_invoice_payment_compat_v1(...)` | ton tai |
| `contract.create.v2` | `ON` |
| `invoice.record_payment.v1` | `ON`; public V4 live dang goi legacy writer |
| `invoice.collection.v5` | `SHADOW` |
| `invoice.collection.reverse.v5` | `SHADOW` |
| `customer.credit.apply.v1` | `SHADOW` |
| `customer.credit.reverse.v1` | `ON` de support du lieu cu |
| `shareholder_profit.distribute.v2` | `SHADOW` |
| V5 collections | 1 dong da `REVERSED`, 0 dong `ACTIVE` |
| V5 canonical operations chua hoan tat | 0 |
| `supabase_migrations.schema_migrations` moi nhat | `20260716170000` |

Migration `20260721150500_accounting_scope_narrowing.sql` da the hien tren live DB qua:

- rollout identity `inline-migration-20260721150500`;
- contract V2 `ON`;
- hai route collection V5 `SHADOW`;
- V4 semantic, update-method compat va undo compat cung ton tai.

Do do:

- khong duoc xoa/bo qua migration nay;
- khong duoc sua file roi coi nhu migration chua chay;
- khong duoc tu y backfill `schema_migrations` trong cung thay doi;
- khong duoc chay lai toan bo bundle 20260721 de "dong bo tracking".

**Canh bao P0:** `origin/main` la client V5 direct trong khi live route V5 dang `SHADOW`. Neu Vercel dang deploy dung `7b33f85`, luong thu moi co kha nang fail `55000` ngay tren production. Day khong con la viec don branch don thuan. Phase 0 phai xac minh deployment va mot request DEMO; neu mismatch duoc tai hien, uu tien fast-track `Phase 1 -> Phase 3 toi thieu -> Phase 7 canary/activation` truoc cac refactor report khong chan writer. Khong bat ON mu ma chua harden/canary.

### 1.3 Ke toan live

Audit read-only da pass schema integrity va xac nhan case L03:

- tong hoa don: `4,816,667`;
- coc: `2,000,000`;
- doanh thu/KQKD: `2,816,667`;
- `posted_pnl = 2,816,667`, khong bao gom coc.

Profit distribution **chua san sang kich hoat**: 52 dong locked unsafe (42 stale persisted, 10 hash drift). Day la ly do route payout/profit distribution phai tiep tuc `SHADOW` va nam ngoai pham vi plan.

---

## 2. Dinh nghia pham vi

### 2.1 Trong pham vi

- Thu mot hoa don bang mot hoac nhieu tender TM/TK/TT trong mot collection atomic.
- Thu mot phan, thu du va `REFUND`, lam tron co kiem soat.
- Phan bo server-side thanh `PNL`, `DEPOSIT`, `INTERNAL`; `CUSTOMER_CREDIT` chi duoc tao khi flag credit rieng cho phep.
- Hoan tac toan bo collection bang but toan doi ung.
- Hoan tac payment V3/V4 lich su qua compatibility RPC da review.
- Hop dong va hoa don dau tien L03: item coc tach khoi doanh thu ngay khi sinh hoa don.
- Bao cao loi nhuan/KQKD lay so theo accounting class/item, khong lay gross receipt.
- Giu nguyen semantics profit-close V3 trong `20260721110000_profit_unallocated_integrity_v3.sql`; khong rollback migration nay chi vi payout/distribution van ngoai pham vi.
- Tenant/account scope, real-vs-virtual account, idempotency, retry, concurrency va deadlock safety.
- Dong bo migration history trong repo, generated Supabase types, rollout/audit scripts va test.

### 2.2 Ngoai pham vi

- Kich hoat ap dung customer credit vao hoa don moi.
- Kich hoat chia loi nhuan/payout reservation/profit locking moi.
- Sua du lieu profit locked dang stale.
- Thiet ke lai module Thu/Chi chung.
- Cho phep form payment doc lap ghi truc tiep payment co `invoice_id`.
- Merge toan bo `05dce6e`, `b449c3c` hoac port UI V4 fallback vao flow V5.

### 2.3 Quy tac khi gap pham vi giao nhau

- Credit: giu read/reverse compatibility, khoa forward apply va khoa `overpay_action=CREDIT` neu flag credit khong `CANONICAL`.
- Payout: giu schema/guards lich su; khong doi flag, khong wire them UI.
- V4: giu lam compatibility cho du lieu cu va support; UI thu hoa don moi khong route sang V4 sau khi V5 duoc kich hoat.
- Generic payment: neu hook/form con ton tai, runtime va type phai cam `invoice_id`; invoice-linked write chi di qua V5.

---

## 3. Nguyen tac an toan bat buoc

1. Khong sua tren local branch `05dce6e`; tao branch sach tu `origin/main`.
2. Khong dung `git reset --hard`, `git checkout --`, force-push hoac rewrite history.
3. Khong sua migration da apply. Moi fix DB la file timestamp moi.
4. Khong apply migration neu worktree/commit SHA chua duoc ghi lai va review.
5. Khong in PAT/password/token ra console. Dung loader san co tu `CLAUDE.local.md`.
6. Chi ghi fixture vao DEMO org `dddd0000-0000-4000-8000-000000000001`; org that `aaaa0000-0000-4000-8000-000000000001` chi doc.
7. Khong dua hai write-agent sua chong cung file. DB va client duoc lam theo commit rieng.
8. Khong push `main` voi `[skip actions]`. Phai thay build CI/Vercel thuc su xanh.
9. Bat ky thay doi VIEW nao cung phai chay `node scripts/check-view-invoker.mjs`.
10. Bat ky thay doi money path nao cung phai chay `node scripts/reconcile-money.mjs` cho cac thang lien quan.

---

## 4. To chuc agent va quyen so huu file

Main agent so huu decomposition, integration, generated types, commit va rollout. Su dung custom agents theo `AGENTS.md`:

| Agent | Nhiem vu | Quyen sua |
|---|---|---|
| `architect` | Chot lock order, migration/deploy/rollback va invariant | read-only |
| `scout_mini` | Trace callgraph, diff `7b33f85..05dce6e`, DB-to-code matrix | read-only |
| `implementer-db` | Migration moi, rollout/audit scripts, migration tests | `supabase/migrations/`, `scripts/`, test migration |
| `implementer-client` | V5 RPC client, hooks, dialogs, unit tests | `src/lib/payment*`, `src/hooks/`, payment UI |
| `implementer-report` | KQKD/profit query va report tests | report/query files; chay sau client neu co file giao nhau |
| `reviewer` | Review doc lap, findings theo severity | read-only |

Chi mot write-agent duoc sua mot nhom file tai mot thoi diem. Main agent phai kiem tra diff sau moi worker va dung ngay neu thay thay doi khong mong doi.

---

## 5. Phase 0 - Preflight va tao nhanh an toan

### 5.1 Lenh preflight

```powershell
git fetch origin --prune
git status --short --branch
git rev-parse origin/main
git rev-parse 05dce6e
git ls-remote origin refs/heads/main refs/heads/release/meter-domain
```

Dieu kien:

- Neu `origin/main` khong con o `7b33f85`, dung va re-audit diff tu commit moi; khong tiep tuc theo hash cu.
- Neu co thay doi user ngoai file plan, dung va bao user; khong stash/revert tu dong.
- Xac nhan Vercel deployment commit rieng; khong ghi "production build xanh" neu chua thay deployment.
- Neu deployment commit la `7b33f85`, tai hien mot lan thu tren DEMO va ghi ma loi. Neu la `55000` do V5 `SHADOW`, mo incident P0 va chuyen sang fast-track: Phase 1 -> Phase 3 toi thieu -> canary/activation DB -> quay lai hoan thien client/report.

Tao archive ref va branch lam viec khong pha huy:

```powershell
git branch archive/accounting-scope-narrowing-05dce6e 05dce6e
git switch -c fix/v5-collection-completion-20260722 origin/main
```

Khong merge `origin/release/meter-domain`. Khong revert `05dce6e` tren branch moi vi commit nay khong nam trong ancestry cua branch moi.

### 5.2 Baseline source

Truoc khi sua:

```powershell
npm run typecheck:baseline
npx vitest run src/lib/__tests__/paymentRecordRpc.test.ts src/hooks/__tests__/useDeletePayment.sources.test.ts
npm run build
```

Mac dinh, neu baseline `origin/main` khong build/test duoc thi ghi ro loi va dung Phase 0; khong tron baseline failure vao implementation V5.

Ngoai le duy nhat cho incident lane:

- neu loi baseline la frontend pre-existing/khong lien quan den payment writer, DB-only hardening + compile-rollback + DEMO canary van duoc phep tiep tuc de xu ly mismatch production;
- incident lane phai co gate DB rieng o Phase 3/6 va khong duoc push frontend `main`;
- neu loi cham V5 contract, payment callgraph, generated types hoac migration, dung ca incident lane;
- moi baseline regression van phai duoc giai quyet truoc final push.

### 5.3 Baseline live DB read-only

Query va luu vao execution report:

- exact RPC signatures;
- owner, `prosecdef`, `proconfig/search_path`, ACL;
- feature mode, `force_freeze`, canary org, rollout identity;
- active/reversed collection count;
- incomplete canonical operations;
- latest tracked migration;
- hash/definition cua V5 functions va cac VIEW lien quan;
- audit L03 va profit activation readiness.

**STOP** neu live state khac snapshot ma chua giai thich duoc.

Deliverable Phase 0: bang facts co command/query va timestamp; khong sua source.

---

## 6. Phase 1 - Dong bo lich su DB da live vao repo

`origin/main` thieu migration da apply. Phai bo sung truoc moi fix moi.

### 6.1 Port nguyen ban bat bien

Them dung blob tu `05dce6e`:

- `supabase/migrations/20260721150500_accounting_scope_narrowing.sql`

Artifact duoc phe duyet la:

- Git blob: `e5175538a116d5b4d274ac7cd4e285032b1a43c3`;
- normalized SHA-256: `a07fac74bb3e9a51e3e4df38ad559fe21d32435d4ce133cc520f8041880f8753`.

Khong sua comment, digest, commit identity, function body hoac newline tuy tien. Xac minh file moi trung artifact tren. Day la bang chung provenance duoc phe duyet; khong tuyen bo co the suy byte-for-byte source chi tu live DB postconditions.

Port/adapt chi phan provenance va security tu:

- `scripts/apply-accounting-rollout.mjs`
- `scripts/audit-accounting-rollout.mjs`
- `scripts/validate-accounting-migrations.mjs`
- `scripts/__tests__/accounting-rollout-scripts.test.mjs`
- `.github/workflows/supabase-migrate.yml`
- `src/lib/__tests__/accountingScopeNarrowingMigration.test.ts`
- phan lien quan trong `src/lib/__tests__/accountingCompatibilityGuardsMigration.test.ts`

Muc tieu la scripts biet live bundle co 14 migration va audit dung postcondition live. Khong de apply script re-run 14 migration vao production.

Workflow hien tai tu dong chay `supabase db push` khi `main` co thay doi trong `supabase/migrations/**`. Vi migration ledger live dung o `20260716170000`, day la nguy co replay hang loat file. Truoc khi push bat ky migration moi len `main`, phai sua workflow theo mot trong hai cach da review:

1. chuyen migration apply sang `workflow_dispatch` co confirm va chi apply file forward duoc chi dinh; hoac
2. tren push chi chay validation/audit read-only, con apply production do rollout script PAT thuc hien truoc.

Khong dung `[skip actions]` de che rui ro nay, vi se bo luon bang chung CI. Khong giu `supabase db push` auto-trigger khi tracking chua duoc giai quyet.

Ket thuc cua plan nay **khong** la backfill ledger. Chien luoc tracking duoc chot:

- manifest migration da apply trong rollout/audit scripts + hash la provenance canonical tam thoi;
- CI co guard vinh vien chan `supabase db push` khi `schema_migrations` khong khop manifest;
- ledger repair neu can la project rieng, can doi chieu tung hash/object va review rieng;
- DoD cua V5 yeu cau workflow an toan + manifest day du, khong yeu cau ledger live bang repo.

### 6.2 Khong port trong Phase 1

- `paymentScopeNarrowing.test.ts` neu no bat client phai dung V4.
- ban V3/V4 cua `paymentRecordRpc.ts`.
- viec xoa `customerCreditRpc.ts`.
- UI bi thu hep ve single-payment V4.
- bat/tat payout hoac profit UI.

### 6.3 Gate Phase 1

```powershell
npx vitest run src/lib/__tests__/accountingScopeNarrowingMigration.test.ts src/lib/__tests__/accountingCompatibilityGuardsMigration.test.ts scripts/__tests__/accounting-rollout-scripts.test.mjs
node scripts/validate-accounting-migrations.mjs
node scripts/audit-accounting-rollout.mjs
```

Commit rieng goi y:

```text
chore(accounting): dong bo migration scope narrowing da live
```

Migration file trong commit nay phai trung Git blob va normalized SHA-256 cua artifact `05dce6e` da phe duyet.

---

## 7. Phase 2 - Lap ma tran port fix `05dce6e` len nen V5

Khong code truoc khi hoan tat ma tran `KEEP / PORT / REJECT / FOLLOW-UP` cho toan bo `git diff --name-status 7b33f85..05dce6e`.

### 7.1 Ma tran bat buoc

| Nhom thay doi tu `05dce6e` | Quyet dinh mac dinh |
|---|---|
| Migration scope-narrowing da live | `KEEP EXACT` trong lich su; khong chay lai |
| V4 semantic writer/compat DB | `KEEP` de support lich su; khong dung lam writer UI moi |
| `paymentRecordRpc.ts` V3/V4 | `REJECT WHOLESALE`; giu V5 exports va chi them compat reversal can thiet |
| `useDeletePayment` | `PORT SEMANTIC`: collection -> reverse V5; legacy -> `undo_invoice_payment_compat_v1` |
| Account co `organization_id`, loc theo org | `PORT` ca type, query, UI va server validation |
| Real receiving account / virtual metadata account | `PORT` va test cross-tenant |
| Stable idempotency key/fingerprint qua retry | `PORT`; khong tao key moi sau timeout |
| Generic payment form | `PORT GUARD`: cam invoice-linked direct insert; khong mo rong feature |
| Active/reversed payment filtering | `PORT` de report/UI khong tinh dong reversed |
| Force cancel invoice khong hard-delete payment | `PORT` phan non-destructive; khong keo credit forward flow |
| Customer credit forward apply/UI | `REJECT ACTIVATION`; chi giu read/reverse va fail-closed |
| Profit payout/distribution compatibility UX | `OUT OF SCOPE`; DB route van `SHADOW` |
| UI V4 fallback va `recordInvoicePaymentWithFallback` | `REJECT` cho flow thu hoa don moi |

### 7.2 Cac diem phai trace den tan cung

1. Tat ca call site cua `recordInvoiceCollectionV5`, `planInvoiceCollection`, `deriveInvoiceDepositDue`.
2. Tat ca call site thu don, thu nhanh, thu hang loat va form payment chung.
3. Tat ca call site hoan tac/xoa/sua phuong thuc thanh toan.
4. Tat ca noi tinh `paid_amount`, payment methods active va voucher total.
5. Tat ca report/KQKD doc `total_amount`, `kqkd_amount`, `accounting_class`, `is_deposit`.
6. Tat ca call path customer credit co the tao forward write khi flag dang `SHADOW`.

Deliverable Phase 2: ma tran file/symbol, ly do port/khong port va test bao ve tung quyet dinh.

---

## 8. Phase 3 - Va MANG B o DB V5

Tao migration timestamp moi, vi du:

- `20260722HHMM_invoice_collection_v5_hardening.sql`
- `20260722HHMM_invoice_collection_v5_canary.sql`
- `20260722HHMM_invoice_collection_v5_activate.sql`

Dung timestamp thuc te chua ton tai. Migration hardening **khong tu dong bat ON toan cuc**.

### B1. Contract cua RPC

Giu on dinh signatures public:

```text
record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)
reverse_invoice_collection_v5(uuid,date,text,text)
undo_invoice_payment_compat_v1(uuid,text,text)
```

Voi tung RPC, assert:

- owner la migration/DB owner duoc phep theo pattern repo;
- `SECURITY DEFINER` neu writer can bypass RLS co kiem soat;
- `SET search_path = pg_catalog, public, app_private` hoac chat hon neu function khong can `public`;
- `REVOKE ALL` tu `PUBLIC`, `anon`, `service_role` theo pattern live;
- chi `GRANT EXECUTE` cho role duoc review;
- trigger/helper noi bo khong con implicit PUBLIC EXECUTE;
- khong nhan `organization_id` tu client; org phai suy ra tu invoice/building.

Them migration test doc source va live postcondition test cho owner/ACL/search_path. Khong chi regex source SQL.

### B2. Invariant tien

DB phai tu tinh va assert voi tolerance nho hon `0.01`:

```text
gross_amount = applied_amount + change_amount + credit_amount
retained_amount = applied_amount + credit_amount
applied_amount = PNL + DEPOSIT + INTERNAL
sum(tender.*) = collection.*
sum(allocation theo tender) = tender.applied_amount + tender.credit_amount
```

Quy tac:

- khong NaN, khong am, toi da 2 so le;
- `change` va `credit` chi phan bo tu TM neu business rule hien tai yeu cau;
- receiving account phai la so that cung org;
- change/rounding account phai la so ao cung org;
- khong tu tao income type o org khac;
- rounding khong lam tang cash va khong duoc che phan coc con thieu;
- server tu doc invoice items va payment history active de tinh semantic; client khong gui `revenue_amount`/`deposit_amount` lam su that.

### B3. L03 va thu tu phan bo

Contract V2 phai tao hop dong + first invoice atomically va snapshot item:

- tien phong/dich vu -> `PNL`;
- tien coc -> `DEPOSIT`;
- khoan ngoai KQKD -> `NON_PNL`/`INTERNAL` theo mapping DB hien tai.

V5 collection phai co ket qua giong semantic V4 da review, nhung van giu collection/tender architecture. Can test ro:

- hoa don dau co coc thu du: P&L chi bang phan `PNL`;
- thu mot phan truoc/sau khong phan bo vuot due cua tung class;
- residual thuoc coc khong duoc rounding thanh doanh thu;
- previous debt source loai `deposit` khong bi tinh vao doanh thu;
- reverse tra lai `paid_amount` va deposit-paid state dung.

### B4. Idempotency va retry

- Payload hash bao gom moi truong lam thay doi y nghia tien, nhung khong bao gom metadata khong on dinh neu server khong dung.
- Cung key + cung payload: tra lai cung response, khong them payment/voucher/allocation.
- Cung key + payload khac: fail `23505`/domain error ro rang.
- Timeout sau khi commit: client retry dung **chinh key va fingerprint cu**.
- UI edit payload sau mot attempt khong ro ket qua: bat reload/reconcile, khong phat key moi va ghi de.
- Bulk: moi invoice co mot key on dinh; khong dung chung key giua invoice.
- Record va compat writer khong duoc cung hoan tat mot key o hai route.

### B5. Concurrency va lock order

Architect phai chot mot thu tu lock duy nhat cho record, reverse va compat, vi du:

```text
organization decision lock -> invoice -> collection -> tender -> voucher/payment -> canonical operation
```

Khong chap nhan hai function lock invoice/collection nguoc thu tu. Them integration test hai session:

- hai collection dong thoi cung invoice: toi da mot ket qua hop le theo expected paid amount;
- record va reverse dong thoi: khong deadlock, khong am paid amount, khong collection nua ACTIVE nua REVERSED;
- hai reverse dong thoi: mot ket qua canonical/idempotent, khong hai bo but toan doi ung;
- timeout/serialization error co ma de client reload/retry an toan.

### B6. Reversal va du lieu lich su

Routing bat buoc:

- co `collection_id` -> `reverse_invoice_collection_v5` cho **toan bo collection**, khong reverse tung payment tender;
- khong co collection -> `undo_invoice_payment_compat_v1`;
- compat RPC tu chon reverse V3 thong thuong hay cleanup historical split shape;
- khong fallback sang hard delete khi permission/flag/RPC loi;
- reversed source va reversal voucher deu giu tenant/accounting links dung;
- payment/report query chi tinh active source, khong tinh kep source + reversal.

Rollback sau khi da co collection ACTIVE:

- khoa/freeze route record de dung write moi;
- **giu route reverse CANONICAL** cho den khi tat ca collection active duoc unwind;
- khong set ca record va reverse ve `SHADOW` cung luc neu con collection active;
- khong xoa collection/tender/allocation history.

### B6a. Public V4 la compatibility ingress, khong phai client fallback

De client cu khong tiep tuc tao legacy payment sau cutover, migration forward phai review va khoi phuc semantics adapter cua public `record_invoice_payment_v4`:

- neu `invoice.collection.v5` la `CANONICAL`, chuyen mot payment V4 thanh **mot V5 collection co mot tender**;
- neu V5 chua canonical, dung private `_record_invoice_payment_v4_legacy` cua migration narrowing;
- UI/client moi van goi V5 truc tiep; tuyet doi khong them fallback V5 -> V4 o client;
- replay completed operation o ca namespace `invoice.record_payment.v1` va `invoice.collection.compat.v4` truoc balance check;
- cung key/payload qua cutover khong double-pay;
- permission, tenant, validation va business error khong duoc coi la tin hieu fallback;
- response phai ghi ro writer thuc te la `V5_COLLECTION` hay `LEGACY_V4`, khong gan nhan "CANONICAL" cho legacy writer.

Them smoke/integration test cho old-client V4 truoc va sau khi hai flag V5 chuyen canary/ON.

### B7. Customer credit la gate rieng

V5 record hien co the nhan `overpay_action=CREDIT`. Hardening phai them server gate:

- chi cho CREDIT khi `customer.credit.apply.v1` evaluate thanh `CANONICAL` cho org;
- neu flag `SHADOW/FROZEN/LEGACY`, fail truoc khi tao collection/lot/excess row;
- `REJECT` va `REFUND` van hoat dong doc lap voi credit flag `SHADOW`;
- UI an/disable "giu lam credit" va hien thong bao ro, khong fallback insert `excess_amounts`;
- `customer.credit.reverse.v1` tiep tuc ON cho du lieu cu;
- khong thay doi mode credit trong migration activate V5 core.

### B8. Tenant isolation

Them negative tests:

- account cua org B khong the dung cho invoice org A;
- virtual/real account sai loai bi tu choi;
- payment/collection/tender/voucher FK composite khong cross-org;
- user co quyen o building A khong ghi duoc building B;
- ID ton tai nhung thuoc org khac khong duoc lo thong tin qua error.

### B9. Migration hygiene

- Hardening migration idempotent o muc object creation, nhung apply moi production chi mot lan.
- Migration canary lock ca hai flag record/reverse theo thu tu co dinh.
- Canary chi them DEMO org va co cap/identity day du.
- Activation migration assert canary evidence, 0 incomplete operation va postcondition an toan truoc khi `ON`.
- Khong sua/backfill `supabase_migrations.schema_migrations` trong cac file nay.
- Them guard/audit that bai ro rang neu ai co gang dung `supabase db push` trong khi ledger chua reconciled.
- Neu dung `CREATE OR REPLACE VIEW`, dat lai `security_invoker=true` va chay script check.
- Neu tao/thay public RPC, phat `NOTIFY pgrst, 'reload schema'` trong transaction va verify PostgREST thay signature sau commit.
- Chuan bi SQL/command rollback freeze record truoc khi apply activation; khong doi y tuong rollback sau su co.

---

## 9. Phase 4 - Hoan thien client V5

### 9.1 `paymentRecordRpc.ts`

Giu mot public surface V5 nhat quan:

- `recordInvoiceCollectionV5`
- `planInvoiceCollection`
- `deriveInvoiceDepositDue`
- `reverseInvoicePaymentBySource`

Khong dua `recordInvoicePaymentWithFallback` vao flow thu hoa don moi. Neu can legacy helper, dat ten/scope ro va chi dung cho historical reversal.

`reverseInvoicePaymentBySource` phai goi:

- `reverse_invoice_collection_v5` cho collection;
- `undo_invoice_payment_compat_v1` cho payment legacy.

Type `PaymentRpcError` giu `code`, `message`, `details`, `hint` de phan loai retry/constraint dung; khong swallow loi rollout, permission hoac tenant.

### 9.2 Stable attempt tren moi entry point

Audit va sua tung entry point:

- `RecordPaymentDialog`
- `CollectPaymentDialog`
- `BulkRecordPaymentDialog`
- `useInvoicePayments`
- `useBulkRecordPayment`
- `useQuickCollect`
- `CollectDrawer`

Moi submit phai:

1. tao fingerprint deterministic tu payload money;
2. tao idempotency key mot lan;
3. giu key qua upload/retry/timeout;
4. xoa attempt cache chi khi thanh cong chac chan hoac user reset co xac nhan;
5. khong retry bang fallback writer khac.

### 9.3 Account scope

- Them `organization_id` vao type account/invoice can thiet.
- Loc danh sach so theo organization cua building/invoice truoc khi hien UI.
- Receiving options chi real accounts; change/rounding options chi virtual accounts.
- Khi doi building/org, clear account selection khong con hop le.
- Server van validate lai; UI filter khong thay the authorization.

### 9.4 Generic payment isolation

- Invoice-linked write chi qua V5 RPC.
- Hook/form payment doc lap neu con ton tai phai reject `invoice_id` o type va runtime.
- Khong direct insert `payments` roi update invoice/insert voucher o client.
- Neu khong co production caller, xoa dead path co test callgraph; khong tao feature moi de thay the.

### 9.5 Delete/reverse/cancel/update method

- `useDeletePayment`: source-aware, collection-first, legacy compat, khong destructive fallback.
- `useUpdatePaymentMethod`: payment co collection thi bat reverse + recollect; payment legacy thi goi `update_invoice_payment_method_v1`, khong update hai bang truc tiep tu client.
- Super-admin cancel invoice: khong hard-delete payment/ledger; bat hoan tac active receipts truoc.
- Query active methods/payment summary loai reversed rows va khong tinh reversal hai lan.

### 9.6 UI credit containment

Khi credit apply flag chua duoc kich hoat:

- khong cho chon `CREDIT` trong collection;
- khong cho create/apply credit bang raw table fallback;
- van hien balance/history cu neu read path an toan;
- thong bao ro "chua kich hoat" thay vi fallback am tham.

---

## 10. Phase 5 - Bao cao loi nhuan va L03

### 10.1 Nguon so lieu

Moi report P&L/KQKD phai dung:

- `income_expense_items.accounting_class = 'PNL'`, hoac
- `kqkd_amount` do DB tinh tu item classes.

Khong dung truc tiep:

- `payments.amount`;
- `payments.received_amount`;
- collection `gross_amount`/`retained_amount`;
- voucher `total_amount` cho mixed voucher;
- heuristic theo ten "tien coc" neu accounting class da co.

`DEPOSIT`, `CUSTOMER_CREDIT`, `INTERNAL` mac dinh ngoai P&L. Toggle "gom khoan coc" chi thay doi hien thi bao cao thu/chi, khong thay doi so P&L canonical.

### 10.2 Files can audit

- `src/hooks/income-expenses/queries.ts`
- `src/hooks/income-expenses/accountingClass.ts`
- `src/hooks/useDashboard.ts`
- `src/hooks/useProfitVerification.ts`
- `src/lib/profitVerification.ts`
- `src/pages/reports/finance/ProfitDistributionReport.tsx`
- `src/pages/reports/finance/ProfitDistributionMobile.tsx`
- SQL/RPC/view cap `kqkd_amount`, active payment va profit preview.

Display note "thieu/thua so voi hoa don" co the dung tong hoa don va deposit detail de ghi chu, nhung khong duoc ghi de amount P&L da tinh tu item.

### 10.3 Acceptance case L03

Fixture DEMO phai chung minh:

1. Tao hop dong co rent/service va deposit.
2. First invoice sinh cung transaction, item classes dung.
3. Thu du hoa don bang V5, co the multi-tender.
4. Tong cash/collection bang tong khach dua sau change.
5. P&L chi bang tong `PNL`; deposit khong nam trong doanh thu.
6. Dashboard, report desktop, report mobile va profit verification cho cung ket qua.
7. Reverse collection co acceptance tach theo basis:
   - cash/receipt mode: active receipt ve 0 hoac net voi but toan reversal, khong double-count source + reversal;
   - accrual mode: doanh thu invoice van con neu invoice van hop le; reverse receipt chi thay doi thu tien/cong no, khong tu dong xoa doanh thu don tich;
   - chi khi invoice bi cancel/reclassify dung nghiep vu thi accrual P&L moi thay doi.

Doc read-only case live L03 van phai cho:

```text
4,816,667 total - 2,000,000 deposit = 2,816,667 P&L
```

Khong sua fixture/live row nay.

---

## 11. Phase 6 - Test matrix va gate ky thuat

### 11.1 Unit/property/migration tests

Toi thieu:

```powershell
npx vitest run src/lib/__tests__/paymentRecordRpc.test.ts
npx vitest run src/hooks/__tests__/useDeletePayment.sources.test.ts
npx vitest run src/hooks/__tests__/useInvoices.activeMethods.test.ts src/hooks/__tests__/usePayments.active.test.ts
npx vitest run src/hooks/__tests__/useDashboard.moneyViews.test.ts src/hooks/income-expenses/accountingClass.test.ts
npx vitest run src/lib/__tests__/contractCreateRpc.test.ts src/lib/__tests__/firstInvoiceBilling.test.ts
npx vitest run src/lib/__tests__/activePaymentsReporting.test.ts
npx vitest run src/lib/__tests__/accountingScopeNarrowingMigration.test.ts
npx vitest run src/lib/__tests__/accountingCompatibilityGuardsMigration.test.ts
npx vitest run scripts/__tests__/accounting-rollout-scripts.test.mjs
```

Bo sung test V5 cho:

- partial payment;
- TM/TK/TT multi-tender;
- overpay REJECT/REFUND;
- CREDIT bi chan khi flag credit `SHADOW`;
- rounding va residual coc;
- same key/same payload;
- same key/different payload;
- retry sau timeout;
- concurrent record/reverse;
- legacy V3/V4 reversal compat;
- cross-tenant account;
- reverse collection co nhieu tender;
- P&L excludes deposit/credit/internal.

Static/Vitest test khong du de chung minh transaction/concurrency live. Implementer phai them hoac mo rong cac script exit-code gate sau:

```powershell
node scripts/test-accounting-chain.mjs
node scripts/test-invoice-collection-v5.mjs
node scripts/test-invoice-collection-v5-concurrency.mjs
node scripts/test-invoice-collection-v5-rollback.mjs
```

Yeu cau:

- `test-invoice-collection-v5.mjs`: direct V5, old-client V4 ingress, retry, payload mismatch, credit rejection, tenant/account negative cases va cleanup DEMO;
- `test-invoice-collection-v5-concurrency.mjs`: it nhat hai authenticated session/process dong thoi cho record-record, record-reverse va reverse-reverse; khong mo phong concurrency trong mot transaction duy nhat;
- `test-invoice-collection-v5-rollback.mjs`: rehearsal CAS/freeze/re-enable tren DEMO hoac transaction rollback, assert postconditions;
- moi script exit `1` neu skip mot scenario bat buoc, fixture con sot, deadlock/timeout khong dung loai hoac invariant lech;
- `scripts/test-accounting-chain.mjs` tiep tuc chay full chain trong transaction va rollback, khong thay the cac two-session test.

### 11.2 Type/build/static gates

```powershell
npx tsc --noEmit -p tsconfig.app.json
npm run typecheck:baseline
npm run build
node scripts/validate-accounting-migrations.mjs
node scripts/check-view-invoker.mjs
```

`npx tsc --noEmit -p tsconfig.app.json` la diagnostic day du va co the van hien baseline loi pre-existing da ghi trong repo. Release gate bat buoc la `npm run typecheck:baseline`: so loi khong duoc tang va khong con regression moi. Khong duoc tuyen bo raw `tsc` xanh neu no khong xanh.

Sau khi apply migration schema moi:

```powershell
npm run gen:types > src/integrations/supabase/types.ts
```

Them lai comment header dau file, sau do chay lai typecheck/test/build. Khong de migration moi di truoc generated types.

### 11.3 Reconcile money

Chay read-only it nhat:

```powershell
node scripts/reconcile-money.mjs 2026-05
node scripts/reconcile-money.mjs 2026-06
node scripts/reconcile-money.mjs 2026-07
```

Bat ky lech nao giua SQL aggregate, RPC va FE paginated sum la **STOP**, ke ca build/test khac dang xanh.

### 11.4 Headless E2E

Them/hoan thien spec chuyen biet `invoice-collection-v5.spec.ts`, sau do chay cung fleet hien co:

```powershell
Set-Location .e2e-fleet
$env:FLEET_WORKERS=8
npx playwright test specs/invoice-collection-v5.spec.ts specs/accounting-chain.spec.ts
```

`specs/accounting-admin.ts` la helper duoc import, khong phai spec de truyen truc tiep cho Playwright.

Truoc canary/activation, **bat buoc** chay fleet tren preview hoac local build cua dung feature commit:

- pin `FLEET_BASE_URL` vao deployment URL cu the;
- xac minh Git SHA cua deployment bang Vercel deployment metadata/CLI/API khop HEAD feature branch;
- khong de fleet dung default production URL trong canary pre-activation;
- neu khong tao/xac minh duoc preview dung SHA, STOP activation.

Sau push `main`, doi `FLEET_BASE_URL` sang production URL va chay lai cung specs.

Bat buoc:

- chi ghi DEMO org;
- fixture tu cleanup trong `finally`;
- check console errors;
- happy path + edge cases;
- khong mo browser headed neu user khong yeu cau;
- chup/log ID collection/payment/voucher phuc vu audit, khong log secret.

---

## 12. Phase 7 - Rollout DB theo canary, DB truoc frontend

### 12.1 Chuan bi

Truoc apply:

- tat ca commit implementation da nam tren feature branch remote;
- feature preview/local build cua dung commit SHA da san sang cho fleet; URL va SHA duoc ghi vao report;
- migration digest va commit SHA da duoc review;
- hardening migration dry-run thanh cong;
- rollback freeze SQL/script da san sang;
- workflow migration khong con auto-run `supabase db push` tren push `main`;
- live query xac nhan khong co unexpected active/incomplete operation;
- `contract.create.v2` van `CANONICAL`;
- profit/credit/payout flags khong bi thay doi ngoai y muon.

Tao script apply rieng cho migration moi. Khong sua script de replay toan bo 14 migration cu. Script phai co lock timeout, statement timeout, redact PAT va in postcondition khong in secret.

### 12.2 Hardening + DEMO canary

1. Apply hardening trong transaction; hai route V5 van `SHADOW` hoac chi chuyen `CANARY` trong migration canary ke tiep.
2. Regen types va commit neu schema thay doi.
3. Apply canary migration:
   - lock ca hai feature rows;
   - set record/reverse cung mot mode canary;
   - canary org duy nhat la DEMO;
   - rollout identity/caps day du;
   - credit apply va profit distribution van `SHADOW`.
4. Chay RPC integration + headless E2E tren DEMO.
   - direct V5 client tao/retry/reverse collection;
   - old-client V4 adapter tao mot one-tender V5 collection khi route canonical;
   - `CREDIT` bi server reject va khong tao lot/excess row.
   - fleet dung `FLEET_BASE_URL` pin vao preview dung feature SHA, khong dung production default.
5. Query invariant truc tiep sau fixture va cleanup.

Neu canary fail:

- chay rollback script CAS: freeze record ngay, giu reverse canonical neu reverse engine an toan va co collection active;
- cleanup fixture bang reversal, khong hard delete ledger;
- viet forward fix moi, khong sua migration da apply.

### 12.3 Activate core V5

Chi apply activation migration khi:

- canary xanh;
- reconcile xanh;
- 0 incomplete operation;
- 0 integrity exception lien quan V5;
- reviewer khong con finding High/Critical;
- rollback procedure da rehearsal tren DEMO.

Activation chi set hai route core `ON`. Khong sua credit apply/profit distribution.

Sau activation:

- chay audit read-only;
- doc org that de xac nhan route/state, khong ghi fixture;
- chay E2E DEMO lan nua;
- theo doi error rate/idempotency/integrity truoc khi push main.

### 12.4 Rollback contract cu the

Chuan bi `scripts/freeze-v5-collection-rollout.mjs` truoc activation. Script phai:

1. doc va ghi lai `mode`, `force_freeze`, `config_version`, rollout identity cua hai feature rows;
2. bat dau transaction va lock rows theo `feature_key` tang dan;
3. dung compare-and-set `WHERE config_version = <expected>`; neu row count khong dung thi rollback va exit `1`;
4. voi su co record/client: giu `mode` hien tai hop le (`OFF/SHADOW/CANARY/ON`), set `force_freeze=true` cho `invoice.collection.v5`, tang `config_version`; assert `evaluate_feature_route(...) = 'FROZEN'`; khong doi reverse neu con ACTIVE collection;
5. voi defect nam trong reverse engine: giu mode hop le va set `force_freeze=true` cho reverse de chan hu hong, ghi danh sach ACTIVE collection, apply forward repair, sau do bo force-freeze/mo lai reverse va unwind; khong manual delete/update ledger;
6. khong xoa canary/attestation cho den khi audit xong; moi thay doi phai co reason/approval/maintenance identity;
7. assert postcondition bang `evaluate_feature_route`, active collection count va incomplete operation count;
8. phat schema/config reload neu can va in report da redact.

Rehearsal bat buoc:

```powershell
node scripts/test-invoice-collection-v5-rollback.mjs
```

Test phai chung minh CAS conflict fail-closed, record bi chan, reverse van dung duoc khi duoc giu canonical, va co the khoi phuc canary mode dung expected `config_version`.

---

## 13. Phase 8 - Commit, review va push main

### 13.1 Commit boundaries

Khuyen nghi cac commit doc lap:

1. `chore(accounting): dong bo migration scope narrowing da live`
2. `test(accounting): khoa invariant V5 collection va L03`
3. `fix(accounting): harden collection V5 va rollout canary`
4. `fix(payments): dong bo client V5 va legacy reversal compat`
5. `fix(reports): loai coc va non-PNL khoi doanh thu`
6. `test(accounting): bo sung reconcile va E2E V5 collection`

Moi commit stage file cu the; khong `git add -A`. Them trailer:

```text
Co-Authored-By: Codex <noreply@openai.com>
```

### 13.2 Independent review

`reviewer` phai kiem tra toi thieu:

- khong co file V4 client bi port nham;
- migration 150500 giong nguyen ban da live;
- new migrations khong sua flags credit/payout;
- owner/ACL/search_path dung;
- lock order khong deadlock;
- retry dung stable key;
- legacy reversal goi compat RPC;
- report dung PNL item, khong gross receipt;
- rollback giu reverse mo khi con active collection;
- tests thuc su exercise DB/browser, khong chi regex.

Khong push main khi con finding Critical/High hoac Medium lien quan mat tien/tenant/idempotency.

### 13.3 Push

Ngay truoc push:

```powershell
git fetch origin
git rev-parse origin/main
git status --short
```

Neu `origin/main` da tien, dung va rebase/cherry-pick co kiem soat; khong force.

Khi tat ca gate xanh:

```powershell
git push origin HEAD:main
```

Sau push:

- xac nhan Vercel build commit dung HEAD;
- xac nhan deploy thanh cong, khong chi Git push thanh cong;
- chay smoke/E2E headless DEMO;
- chay live audit va reconcile lan cuoi;
- ghi lai migration SHA, commit SHA, deployment URL/id va thoi diem.

---

## 14. Stop gates

Agent phai dung ngay va bao cao, khong "tu linh hoat" neu gap mot trong cac dieu sau:

1. `origin/main`/live DB khac snapshot ma khong co commit/migration giai thich.
2. Migration 150500 trong repo khong trung Git blob/normalized SHA-256 cua artifact da phe duyet.
3. Co active collection hoac incomplete operation truoc thao tac quarantine/rollback khong tuong thich.
4. RPC live sai signature/owner/ACL/search_path so voi migration du kien.
5. Cross-tenant account/link co the tao thanh cong.
6. Same idempotency key ghi duoc hai payload khac nhau.
7. Concurrent test deadlock, double-write hoac paid amount am.
8. L03 P&L khac `total - deposit - non-PNL`.
9. Reconcile money lech o bat ky thang nao.
10. VIEW security check fail.
11. Credit apply hoac profit distribution bi kich hoat ngoai pham vi.
12. Xuat hien thay doi user/agent khac khong du kien trong worktree.
13. Vercel build/deployment khong tro dung commit da push.
14. Workflow push migration van co the tu dong chay `supabase db push` voi ledger live dang lech.
15. Canary fleet khong duoc pin vao preview/local build co SHA trung feature HEAD.
16. DB integration/two-session/rollback script skip scenario hoac khong exit fail khi invariant sai.

---

## 15. Definition of Done

Chi danh dau hoan thanh khi tat ca dieu kien sau dung:

- [ ] Branch duoc tao tu `origin/main`, khong rewrite history.
- [ ] Migration scope-narrowing da live co trong repo va trung artifact hash da pin.
- [ ] Client V5 build duoc; khong con API surface nua V5 nua V4.
- [ ] Record V5 ho tro single/multi-tender, partial, refund, rounding dung.
- [ ] CREDIT fail-closed khi credit flag chua canonical.
- [ ] Server allocation va DB constraints can bang.
- [ ] L03/first invoice tach coc khoi P&L tren DB, dashboard va ca hai report UI.
- [ ] V5 reversal hoan tac ca collection; legacy reversal qua compat RPC.
- [ ] Generic payment khong the bypass invoice writer.
- [ ] Stable idempotency qua retry/timeout; payload mismatch bi tu choi.
- [ ] Concurrency tests khong deadlock/double-write.
- [ ] DB integration, two-session concurrency va rollback rehearsal scripts deu exit 0, khong skip.
- [ ] Tenant/account scope tests xanh.
- [ ] Types duoc regen sau schema change.
- [ ] `typecheck:baseline` khong regression; raw `tsc` diagnostic duoc ghi trung thuc; unit/property, migration validation va build xanh.
- [ ] View security va reconcile 2026-05/06/07 xanh.
- [ ] Headless E2E DEMO xanh, cleanup va console clean.
- [ ] Canary E2E chay tren preview/local build dung SHA; post-deploy E2E chay lai tren production.
- [ ] Canary thanh cong; chi hai route V5 core duoc ON.
- [ ] Credit apply va profit distribution van SHADOW.
- [ ] Migration workflow khong con auto `db push`; manifest/hash audit la provenance canonical cho den khi co ledger-repair project rieng.
- [ ] Reviewer khong con finding chan release.
- [ ] Push `main`, Vercel deploy dung commit va post-deploy audit xanh.

---

## 16. Execution report bat buoc

Agent thuc thi phai cap nhat mot report kem:

- base/HEAD/remote commit;
- bang file da port va file da tu choi port;
- migration filenames + SHA-256 + apply timestamp;
- feature flags truoc/canary/sau activation;
- test commands va exit code;
- reconcile totals theo thang;
- E2E fixture IDs va cleanup status;
- reviewer findings va resolution;
- Vercel deployment commit;
- rollback command/procedure da rehearsal.

Khong dung cum "da kiem tra toan bo" neu thieu bat ky bang chung nao o danh sach tren.
