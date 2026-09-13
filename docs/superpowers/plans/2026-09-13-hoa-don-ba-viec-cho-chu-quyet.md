# Hoá đơn: ba việc chờ chủ quyết — kế hoạch thực hiện

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bịt lỗ hổng "tạm tính một đằng, dòng một nẻo" ở hai RPC tạo/sửa nháp hoá đơn; cho quản lý tự huỷ hoá đơn Quá hạn chưa thu; báo sớm ở màn Điều chỉnh khi hoá đơn cũ mang nợ nhập tay không nguồn.

**Architecture:** Ba việc độc lập, mỗi việc là một plan con có test riêng và commit riêng. Việc A đổi hàm SQL trên production nên đi lane `migrate:forward` (sao lưu + provenance + review), test bằng PGlite trong vitest theo mẫu `invoiceAdjustmentV2.test.ts`, và diễn tập trên org DEMO trước khi áp. Việc B và C chỉ đổi client, gate bình thường; B đụng luật phân quyền nên mở draft PR.

**Tech Stack:** PostgreSQL/PL-pgSQL (Supabase), vitest + `@electric-sql/pglite`, React/TypeScript, scripts lane `scripts/apply-reviewed-migration.mjs`, `scripts/tao-ten-migration.mjs`.

## Global Constraints

- Không sửa file migration đã merge; chỉ thêm migration mới, tên cấp bằng `node scripts/tao-ten-migration.mjs <slug>`.
- Không dùng PAT ghi thẳng qua Management API; ghi schema production duy nhất qua `npm run migrate:forward -- <file> --apply`.
- Org THẬT chỉ đọc; fixture chỉ ghi vào DEMO `dddd0000-0000-4000-8000-000000000001` và tự dọn.
- Hàm SQL sửa bằng `CREATE OR REPLACE` cùng chữ ký (không đổi tham số) để giữ ACL và tránh overload; so md5 định nghĩa sống trước khi ghi.
- Test khẳng định về hàm SQL phải đo định nghĩa sống (`liveDefinitionOf`), không ghim một file đóng băng.
- Đổi tiền và phân quyền cần draft PR review trước khi vào main (Contract §3). Sau merge: CI xanh → `promote:production --sha <SHA đầy đủ 40 ký tự> --apply` → kiểm Vercel READY.
- Sai số tiền chấp nhận giữa client và server: `< 0.01` đồng.
- Bằng chứng đã rà 13/09/2026: client duy nhất gọi `create_invoice_v1` / `create_invoice_with_credit_v1` / `update_invoice_v1` là `src/hooks/useInvoices.ts` (Tạo lẻ, Excel, Sửa nháp đều qua hook; hook tự tính `amount = unit_price × quantity × coefficient` và `subtotal = Σ amount`). SQL gọi `create_invoice_v1`: `create_invoice_with_credit_v1` (bọc), `create_contract_v1` (legacy, client hiện dùng `create_contract_v2` qua `contractCreateRpc.ts`, ghi invoice_items riêng).

---

## Việc A — Server tự cộng lại dòng ở `create_invoice_v1` và `update_invoice_v1`

### Task A1: Kiểm kê chỉ đọc: hoá đơn hiện có nào lệch tạm tính so với tổng dòng

**Files:**
- Create: `docs/audits/2026-09-13-invoice-subtotal-vs-items.readonly.sql`
- Create: `docs/audits/2026-09-13-invoice-subtotal-vs-items.md` (kết quả)

**Interfaces:**
- Produces: bảng đếm hoá đơn lệch theo org/trạng thái, dùng cho quyết định "có cần backfill không" trước A4.

- [ ] **Step 1: Viết câu truy vấn chỉ đọc**

```sql
-- Chỉ đọc. Không ghi. So tạm tính đã lưu với tổng thành tiền các dòng.
SELECT i.organization_id, i.status, i.kind,
       count(*) AS so_hoa_don,
       count(*) FILTER (WHERE abs(coalesce(i.subtotal,0) - s.sum_amount) >= 0.01) AS lech_tam_tinh,
       count(*) FILTER (WHERE s.bad_lines > 0) AS co_dong_amount_sai
FROM public.invoices i
JOIN LATERAL (
  SELECT coalesce(sum(it.amount),0) AS sum_amount,
         count(*) FILTER (WHERE abs(coalesce(it.amount,0) - coalesce(it.unit_price,0)*coalesce(it.quantity,1)*coalesce(it.coefficient,1)) >= 0.01) AS bad_lines
  FROM public.invoice_items it WHERE it.invoice_id = i.id
) s ON true
WHERE i.deleted_at IS NULL
GROUP BY 1,2,3 ORDER BY 1,2,3;

-- Danh sách chi tiết (tối đa 200) để đối chiếu tay.
SELECT i.invoice_number, i.status, i.subtotal, s.sum_amount, i.subtotal - s.sum_amount AS chenh, s.bad_lines
FROM public.invoices i
JOIN LATERAL (
  SELECT coalesce(sum(it.amount),0) AS sum_amount,
         count(*) FILTER (WHERE abs(coalesce(it.amount,0) - coalesce(it.unit_price,0)*coalesce(it.quantity,1)*coalesce(it.coefficient,1)) >= 0.01) AS bad_lines
  FROM public.invoice_items it WHERE it.invoice_id = i.id
) s ON true
WHERE i.deleted_at IS NULL AND (abs(coalesce(i.subtotal,0) - s.sum_amount) >= 0.01 OR s.bad_lines > 0)
ORDER BY abs(coalesce(i.subtotal,0) - s.sum_amount) DESC LIMIT 200;
```

- [ ] **Step 2: Chạy qua harness đọc đã duyệt**

Chạy từ checkout chính (có vault), PowerShell:
```powershell
$root="C:\Users\Nguyen Tam\whiteboard-ihomecrm-main"
$pat=(Select-String -Path "$root\CLAUDE.local.md" -Pattern 'sbp_[0-9a-f]+' | Select-Object -First 1).Matches[0].Value
$ref=(Select-String -Path "$root\.env" -Pattern 'https://([a-z0-9]+)\.supabase\.co' | Select-Object -First 1).Matches[0].Groups[1].Value
$q=Get-Content "$root\docs\audits\2026-09-13-invoice-subtotal-vs-items.readonly.sql" -Raw
$body=@{query=$q}|ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Headers @{Authorization="Bearer $pat";'Content-Type'='application/json'} -Body $body | ConvertTo-Json -Depth 5
```
Lưu ý: phiên agent có thể bị classifier chặn "Production Reads"; khi đó chủ chạy tay lệnh trên và dán kết quả.

- [ ] **Step 3: Ghi kết quả**

Ghi vào `docs/audits/2026-09-13-invoice-subtotal-vs-items.md`: số hoá đơn lệch theo org, danh sách chi tiết, kết luận "đã từng bị lợi dụng hay chưa". Nếu có hoá đơn lệch ở org THẬT: dừng, báo chủ, không tự sửa dữ liệu.

- [ ] **Step 4: Commit**

```bash
git add docs/audits/2026-09-13-invoice-subtotal-vs-items.readonly.sql docs/audits/2026-09-13-invoice-subtotal-vs-items.md
git commit -m "docs(audits): kiểm kê chỉ đọc tạm tính hoá đơn so với tổng dòng"
```

### Task A2: Chốt định nghĩa sống của hai hàm trước khi thay

**Files:**
- Create: `docs/audits/2026-09-13-invoice-writers-live-catalog.json` (chỉ đọc, không commit nếu chứa định nghĩa dài; commit phần md5)

- [ ] **Step 1: Lấy catalog sống (md5 + định nghĩa) của hai hàm**

```bash
cd "C:/Users/Nguyen Tam/whiteboard-ihomecrm-main"
node scripts/test-invoice-deposit-classification.mjs --catalog "$TEMP/invoice-writers-catalog.json"
```
Script này chỉ đọc `pg_get_functiondef` của `create_invoice_v1`, `update_invoice_v1` (và 3 hàm cọc). Cần vault ở checkout chính.

- [ ] **Step 2: So với file migration mới nhất trong repo**

```bash
node -e "
const c=require(process.env.TEMP+'/invoice-writers-catalog.json');
for(const r of c){ if(!/create_invoice_v1|update_invoice_v1/.test(r.proname)) continue; console.log(r.signature, r.definition_md5); }"
```
So từng thân hàm với `supabase/migrations/20260908051659_invoice_deposit_classification.sql` (create) và `supabase/migrations/20260912065909_invoice_adjustment_atomic_revisions.sql` (update). Bỏ khác biệt khoảng trắng. Nếu thân hàm sống KHÁC repo → dừng, báo chủ (ai đó đã sửa ngoài lane).

- [ ] **Step 3: Ghi md5 vào tài liệu audit A1 (mục "Định nghĩa sống trước khi vá")**

### Task A3: Test PGlite đỏ cho guard tạm tính

**Files:**
- Create: `src/lib/__tests__/invoiceWriterSubtotalGuard.test.ts`

**Interfaces:**
- Consumes: định nghĩa sống của `public.create_invoice_v1` và `public.update_invoice_v1` (đọc bằng `liveDefinitionOf` quét toàn bộ `supabase/migrations`, lấy CREATE cuối cùng).
- Produces: mã lỗi `22000` với thông điệp bắt đầu bằng `Tạm tính client` khi Σ dòng ≠ p_subtotal; `22023` với `Thành tiền dòng` khi amount ≠ u×q×c; `22023` với `Giá, số lượng hoặc hệ số` khi âm/NaN.

- [ ] **Step 1: Viết test (đỏ trước khi có migration)**

```ts
// src/lib/__tests__/invoiceWriterSubtotalGuard.test.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stripMigrationTransactionControl } from '../../../scripts/apply-accounting-rollout.mjs';

const MIG_DIR = 'supabase/migrations';
const org = 'dddd0000-0000-4000-8000-000000000001';
const actor = 'dddd0000-0000-4000-8000-0000000000aa';
const building = 'dddd0000-0000-4000-8000-0000000000b1';
const contract = 'dddd0000-0000-4000-8000-0000000000c1';
const room = 'dddd0000-0000-4000-8000-0000000000d1';

/** Định nghĩa SỐNG = CREATE cuối cùng theo thứ tự timestamp (quét toàn bộ migration). */
function liveDefinitionOf(fnName: string): string {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fnName}\\s*\\(`, 'i');
  let hit: string | null = null;
  for (const f of files) {
    const sql = stripMigrationTransactionControl(readFileSync(join(MIG_DIR, f), 'utf8'), f);
    const start = sql.search(re);
    if (start < 0) continue;
    const tail = sql.slice(start);
    const end = tail.indexOf('$function$', tail.indexOf('AS $function$') + 14) + '$function$'.length;
    hit = tail.slice(0, end) + ';';
  }
  if (!hit) throw new Error(`Không tìm thấy public.${fnName}`);
  return hit;
}

const db = new PGlite();
const line = (price: number, qty = 1, coef = 1, extra: Record<string, unknown> = {}) => ({
  type: 'RENT', accounting_class: 'REVENUE', description: 'Rent', unit_price: price, quantity: qty, coefficient: coef,
  amount: price * qty * coef, ...extra,
});

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES ('${actor}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE TYPE invoice_status AS ENUM ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIAL_PAID','PAID','OVERDUE','CANCELLED');
    CREATE TYPE invoice_item_type AS ENUM ('RENT','SERVICE','PENALTY','DISCOUNT','OTHER');
    CREATE TABLE organizations(id uuid PRIMARY KEY, status text DEFAULT 'ACTIVE'); INSERT INTO organizations(id) VALUES ('${org}');
    CREATE TABLE buildings(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz); INSERT INTO buildings VALUES ('${building}','${org}',NULL);
    CREATE TABLE contracts(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz); INSERT INTO contracts VALUES ('${contract}','${org}',NULL);
    CREATE TABLE rooms(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, deleted_at timestamptz); INSERT INTO rooms VALUES ('${room}','${org}','${building}',NULL);
    CREATE TABLE organization_invoice_settings(organization_id uuid PRIMARY KEY, auto_approve_invoice boolean); INSERT INTO organization_invoice_settings VALUES ('${org}', false);
    CREATE TABLE app_private.canonical_write_operations(id uuid DEFAULT gen_random_uuid(), organization_id uuid, operation text, subject_scope text, actor_id uuid, idempotency_key text, payload_hash text, subject_id uuid, completed_at timestamptz, response_payload jsonb, UNIQUE(organization_id,operation,subject_scope,actor_id,idempotency_key));
    CREATE SEQUENCE invoice_seq;
    CREATE TABLE invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text DEFAULT ('INV-'||nextval('invoice_seq')), user_id uuid, organization_id uuid, contract_id uuid, building_id uuid, room_id uuid,
      billing_month text, issue_date date, due_date date, kind text DEFAULT 'MONTHLY', status invoice_status DEFAULT 'DRAFT', subtotal numeric, discount_amount numeric DEFAULT 0, discount_notes text,
      electricity_prev_overridden boolean DEFAULT false, total_amount numeric, prepaid_amount numeric DEFAULT 0, paid_amount numeric DEFAULT 0, previous_debt numeric DEFAULT 0,
      previous_debt_sources jsonb DEFAULT '[]', notes text, template_id uuid, creator_name text, approved_by uuid, approved_at timestamptz, adjustment_revision int DEFAULT 0, deleted_at timestamptz);
    CREATE TABLE invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid REFERENCES invoices, organization_id uuid, service_id uuid, type invoice_item_type, description text,
      unit_price numeric, quantity numeric, coefficient numeric, amount numeric, previous_reading numeric, current_reading numeric, from_date date, to_date date, sort_order int, accounting_class text);
    CREATE TABLE excess_amounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, organization_id uuid, contract_id uuid, amount numeric, description text, source_invoice_id uuid, source_payment_id uuid);
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION app_private.evaluate_feature_route(text,uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'CANONICAL' $$;
    CREATE FUNCTION app_private.can_edit_invoice_building_v1(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    -- Cùng luật với roundInvoiceTotal ở client: phần lẻ <900 xuống, >=900 lên.
    CREATE FUNCTION app_private.round_invoice_total_v1(t numeric) RETURNS numeric LANGUAGE sql AS $$
      SELECT CASE WHEN t <= 0 THEN t WHEN mod(t,1000)=0 THEN t WHEN mod(t,1000) >= 900 THEN ceil(t/1000)*1000 ELSE floor(t/1000)*1000 END $$;
  `);
  await db.exec(liveDefinitionOf('create_invoice_v1'));
  await db.exec(liveDefinitionOf('update_invoice_v1'));
}, 30000);
afterAll(async () => { await db.close(); });

async function create(items: unknown[], subtotal: number, total: number, key = 'guard-test-0001') {
  return db.query(`SELECT public.create_invoice_v1($1,$2,$3,'2094-09','2094-09-01','2094-09-10','MONTHLY',$4,0,$5,0,$6::jsonb,$7) AS r`,
    [contract, building, room, subtotal, total, JSON.stringify(items), key]);
}
async function scenario(fn: () => Promise<void>) { await db.exec('BEGIN'); try { await fn(); } finally { await db.exec('ROLLBACK'); } }
const codeOf = (e: unknown) => (e as { code?: string; message?: string });

describe('create_invoice_v1 tự cộng lại dòng', () => {
  it('nhận đúng khi tạm tính = Σ đơn giá × số lượng × hệ số', () => scenario(async () => {
    const r = await create([line(5_000_000), line(100_000, 3)], 5_300_000, 5_300_000);
    expect((r.rows[0] as { r: { status: string } }).r.status).toBe('DRAFT');
    const saved = await db.query<{ subtotal: string; sum: string }>(`SELECT i.subtotal, (SELECT sum(amount) FROM invoice_items WHERE invoice_id=i.id) AS sum FROM invoices i`);
    expect(Number(saved.rows[0].subtotal)).toBe(Number(saved.rows[0].sum));
  }));
  it('từ chối khi tạm tính client nhỏ hơn tổng dòng (dòng 5.5tr, tạm tính 1.5tr)', () => scenario(async () => {
    await expect(create([line(5_000_000), line(300_000), line(200_000)], 1_500_000, 1_500_000)).rejects.toMatchObject({ code: '22000' });
    await expect(create([line(5_000_000), line(300_000), line(200_000)], 1_500_000, 1_500_000)).rejects.toSatisfy((e: unknown) => /Tạm tính client/.test(codeOf(e).message ?? ''));
  }));
  it('từ chối khi thành tiền dòng không bằng đơn giá × số lượng × hệ số', () => scenario(async () => {
    await expect(create([line(5_000_000, 1, 1, { amount: 1_000_000 })], 1_000_000, 1_000_000)).rejects.toMatchObject({ code: '22023' });
  }));
  it('từ chối đơn giá / số lượng / hệ số âm hoặc NaN', () => scenario(async () => {
    await expect(create([line(-5_000_000)], -5_000_000, 0)).rejects.toMatchObject({ code: '22023' });
    await expect(create([{ ...line(100), quantity: 'NaN' }], 100, 0)).rejects.toMatchObject({ code: '22023' });
  }));
  it('chấp nhận dòng client cũ không gửi amount (server tự tính) và sai số dưới 0,01', () => scenario(async () => {
    const noAmount = { type: 'SERVICE', accounting_class: 'REVENUE', description: 'Nước', unit_price: 33333.333333, quantity: 3, coefficient: 1 };
    const r = await create([noAmount], 100_000, 100_000);
    expect((r.rows[0] as { r: { status: string } }).r.status).toBe('DRAFT');
  }));
});

describe('update_invoice_v1 tự cộng lại dòng', () => {
  async function draft() {
    await create([line(5_000_000)], 5_000_000, 5_000_000, 'guard-upd-0001');
    return (await db.query<{ id: string }>('SELECT id FROM invoices LIMIT 1')).rows[0].id;
  }
  const update = (id: string, items: unknown[], subtotal: number, total: number) =>
    db.query(`SELECT public.update_invoice_v1($1,$2,$3,$4,'2094-09','2094-09-01','2094-09-10',$5,0,$6,0,$7::jsonb) AS r`,
      [id, contract, building, room, subtotal, total, JSON.stringify(items)]);
  it('từ chối tạm tính lệch tổng dòng', () => scenario(async () => {
    const id = await draft();
    await expect(update(id, [line(5_000_000), line(300_000)], 5_000_000, 5_000_000)).rejects.toMatchObject({ code: '22000' });
  }));
  it('nhận khi khớp và ghi subtotal = Σ dòng', () => scenario(async () => {
    const id = await draft();
    await update(id, [line(5_000_000), line(300_000)], 5_300_000, 5_300_000);
    const saved = await db.query<{ subtotal: string }>(`SELECT subtotal FROM invoices WHERE id=$1`, [id]);
    expect(Number(saved.rows[0].subtotal)).toBe(5_300_000);
  }));
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ đúng lý do**

```bash
npx vitest run src/lib/__tests__/invoiceWriterSubtotalGuard.test.ts
```
Kỳ vọng: 2 ca "nhận đúng" xanh; các ca "từ chối" ĐỎ vì hàm hiện tại không ném (`resolves` thay vì `rejects`). Nếu fixture thiếu bảng/hàm (lỗi `relation ... does not exist`), bổ sung stub trong `beforeAll` — không nới test.

- [ ] **Step 3: Commit test đỏ**

```bash
git add src/lib/__tests__/invoiceWriterSubtotalGuard.test.ts
git commit -m "test(invoices): guard tạm tính = tổng dòng cho create/update_invoice_v1 (đỏ trước migration)"
```

### Task A4: Migration vá hai hàm

**Files:**
- Create: `supabase/migrations/<timestamp>_invoice_writers_recompute_subtotal.sql` (tên lấy từ `node scripts/tao-ten-migration.mjs invoice_writers_recompute_subtotal`)
- Modify: `docs/he-thong/07-hoa-don-thanh-toan.md` (thêm 1 dòng luật)

**Interfaces:**
- Produces: `public.create_invoice_v1` và `public.update_invoice_v1` cùng chữ ký cũ, thêm khối kiểm dòng.

- [ ] **Step 1: Cấp tên file**

```bash
node scripts/tao-ten-migration.mjs invoice_writers_recompute_subtotal
```

- [ ] **Step 2: Viết migration**

Nội dung = `BEGIN;` + `CREATE OR REPLACE FUNCTION public.create_invoice_v1(...)` chép NGUYÊN thân sống (đã chốt md5 ở A2) và chèn khối dưới đây ngay SAU vòng `FOR it IN ... accounting_class không hợp lệ ... END LOOP;` (trước `select b.organization_id into v_org`); tương tự cho `update_invoice_v1` chèn ngay SAU vòng chuẩn hoá `v_normalized_items` (trước `-- recalc total + assert`), thay `p_items` bằng `v_normalized_items` trong khối. Khai báo thêm `v_line_sum numeric := 0; v_price numeric; v_qty numeric; v_coef numeric; v_amount numeric;` trong `declare`.

```sql
  -- ---- Guard 13/09/2026: server tự cộng lại dòng, không tin p_subtotal ----
  -- Cùng luật với app_private.normalize_invoice_adjustment_items_v2 (adjust_invoice_v2):
  -- giá/số lượng/hệ số không âm, không NaN; amount (nếu gửi) phải = u×q×c; Σ dòng = tạm tính.
  v_line_sum := 0;
  FOR it IN SELECT value FROM jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) LOOP
    BEGIN
      v_price := coalesce((it->>'unit_price')::numeric, 0);
      v_qty   := coalesce((it->>'quantity')::numeric, 1);
      v_coef  := coalesce((it->>'coefficient')::numeric, 1);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Giá, số lượng hoặc hệ số hạng mục không hợp lệ' USING ERRCODE='22023';
    END;
    IF v_price < 0 OR v_qty < 0 OR v_coef < 0
       OR v_price::text IN ('NaN','Infinity','-Infinity')
       OR v_qty::text   IN ('NaN','Infinity','-Infinity')
       OR v_coef::text  IN ('NaN','Infinity','-Infinity')
       OR v_price*v_qty*v_coef >= 10000000000000 THEN
      RAISE EXCEPTION 'Giá, số lượng hoặc hệ số hạng mục không hợp lệ' USING ERRCODE='22023';
    END IF;
    v_amount := round(v_price*v_qty*v_coef, 2);
    IF it ? 'amount' AND (it->>'amount') IS NOT NULL
       AND abs(coalesce((it->>'amount')::numeric,0) - v_amount) >= 0.01 THEN
      RAISE EXCEPTION 'Thành tiền dòng "%" (%) không bằng đơn giá × số lượng × hệ số (%)',
        coalesce(it->>'description',''), (it->>'amount')::numeric, v_amount USING ERRCODE='22023';
    END IF;
    v_line_sum := v_line_sum + v_amount;
  END LOOP;
  IF abs(v_line_sum - coalesce(p_subtotal,0)) >= 0.01 THEN
    RAISE EXCEPTION 'Tạm tính client (%) khác tổng các dòng do server cộng lại (%)',
      coalesce(p_subtotal,0), v_line_sum USING ERRCODE='22000';
  END IF;
```
Ghi chú trong file: giữ nguyên toàn bộ phần còn lại; không đổi chữ ký, không đổi ACL (CREATE OR REPLACE giữ quyền hiện có). Kết `COMMIT;`.

- [ ] **Step 3: Chạy test A3 → phải XANH**

```bash
npx vitest run src/lib/__tests__/invoiceWriterSubtotalGuard.test.ts
```

- [ ] **Step 4: Chạy các test SQL hiện có có gọi hai hàm này**

```bash
npx vitest run src/lib/__tests__/invoiceAdjustmentV2.test.ts src/lib/__tests__/customerCreditMigration.test.ts src/lib/__tests__/customerCreditRpc.test.ts src/lib/__tests__/copilotActionsL4Migration.test.ts src/components/invoices/__tests__ src/lib/__tests__/invoiceEntry.test.ts src/lib/__tests__/invoiceAdjustmentEntry.test.ts
```
Kỳ vọng: xanh hết. `scripts/test-invoice-deposit-classification.mjs` và `scripts/test-accounting-chain.mjs` cần DB thật (DEMO, rollback) — chạy ở A6.

- [ ] **Step 5: Cập nhật tài liệu**

Thêm vào `docs/he-thong/07-hoa-don-thanh-toan.md`, ngay sau dòng 56 (`useInvoices thử writer canonical ...`):
```
- Từ 13/09/2026 `create_invoice_v1` và `update_invoice_v1` tự cộng lại các dòng: mọi dòng phải có giá/số lượng/hệ số không âm, `amount` (nếu gửi) = đơn giá × số lượng × hệ số, và Σ dòng phải bằng `p_subtotal` (sai số < 0,01 đ); lệch thì lỗi `22000`/`22023`, cùng luật với `adjust_invoice_v2`.
```

- [ ] **Step 6: Stage migration + sinh provenance + gate**

```bash
git add supabase/migrations/<timestamp>_invoice_writers_recompute_subtotal.sql docs/he-thong/07-hoa-don-thanh-toan.md
npm run provenance:generate
npm run gate:migration-provenance
node scripts/check-stable-fn-locks.mjs
node scripts/check-migration-test-liveness.mjs
npm run gate:truoc-push
```
Kỳ vọng: tất cả xanh. `check-migration-test-liveness` không được tăng số test ghim file (test A3 dùng `liveDefinitionOf`).

- [ ] **Step 7: Commit**

```bash
git add -u supabase/migration-provenance.json
git commit -m "feat(invoices): create/update_invoice_v1 tự cộng lại dòng, từ chối tạm tính lệch"
```

### Task A5: Diễn tập trên DEMO (dry-run lane + thử thật + thử gian lận)

**Files:** không tạo file mới; ghi kết quả vào `docs/audits/2026-09-13-invoice-subtotal-vs-items.md` mục "Diễn tập DEMO".

- [ ] **Step 1: Dry-run lane (mặc định không ghi)**

```bash
npm run migrate:forward -- supabase/migrations/<timestamp>_invoice_writers_recompute_subtotal.sql
```
Kỳ vọng: preflight đạt (version > cutoff, provenance khớp, đích đúng project).

- [ ] **Step 2: Bổ sung cấu hình DEMO còn thiếu (fixture DEMO, được phép ghi)**

Org DEMO chưa có `organization_invoice_settings` nên `create_invoice_v1` trả 55000 "Thiếu cấu hình auto_approve_invoice" (đo 12/09). Chạy qua harness đã duyệt trong một giao dịch COMMIT:
```sql
INSERT INTO public.organization_invoice_settings(organization_id, auto_approve_invoice)
VALUES ('dddd0000-0000-4000-8000-000000000001', true)
ON CONFLICT (organization_id) DO NOTHING;
```

- [ ] **Step 3: Áp migration**

```bash
npm run migrate:forward -- supabase/migrations/<timestamp>_invoice_writers_recompute_subtotal.sql --apply
```
Lane tự backup và phát biên nhận. Ghi SHA review, digest, tên bản dump vào tài liệu audit.

- [ ] **Step 4: Thử thật trên DEMO bằng app**

Đăng nhập `demo.chunha` (mật khẩu `FLEET_PASS_CHUNHA` trong vault) → /invoices → Tạo hoá đơn lẻ cho hợp đồng DEMO ở kỳ chưa có hoá đơn (vd 2026-10) → Tạo. Kỳ vọng: tạo thành công, tạm tính = tổng dòng. Sau đó huỷ hoá đơn thử để dọn (chủ nhà DEMO huỷ được vì Đã duyệt chưa thu).

- [ ] **Step 5: Thử gian lận qua REST (phải bị từ chối)**

Lấy token bằng đăng nhập password của tài khoản DEMO rồi gọi RPC với dòng 5.500.000 nhưng `p_subtotal` 1.500.000:
```bash
URL=$(grep -o 'https://[a-z0-9]*\.supabase\.co' .env | head -1); KEY=$(grep -E '^VITE_SUPABASE_(ANON|PUBLISHABLE)_KEY' .env | head -1 | cut -d= -f2 | tr -d '"')
TOKEN=$(curl -s -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $KEY" -H "Content-Type: application/json" -d '{"email":"demo.chunha@username.ihomecrm.local","password":"<FLEET_PASS_CHUNHA>"}' | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s -X POST "$URL/rest/v1/rpc/create_invoice_v1" -H "apikey: $KEY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Content-Profile: public" \
  -d '{"p_contract_id":"<HĐ DEMO>","p_building_id":"<toà DEMO>","p_room_id":"<phòng DEMO>","p_billing_month":"2026-11","p_issue_date":"2026-09-13","p_due_date":"2026-10-13","p_kind":"MONTHLY","p_subtotal":1500000,"p_discount_amount":0,"p_total_amount":1500000,"p_previous_debt":0,"p_items":[{"type":"RENT","accounting_class":"REVENUE","description":"Tiền thuê","unit_price":5000000,"quantity":1,"coefficient":1,"amount":5000000},{"type":"SERVICE","accounting_class":"REVENUE","description":"Điện","unit_price":300000,"quantity":1,"coefficient":1,"amount":300000},{"type":"SERVICE","accounting_class":"REVENUE","description":"Nước","unit_price":200000,"quantity":1,"coefficient":1,"amount":200000}],"p_idempotency_key":"fraud-probe-0001"}'
```
Kỳ vọng: HTTP 4xx với `code: "22000"` và message bắt đầu "Tạm tính client (1500000) khác tổng các dòng do server cộng lại (5500000)". Không có hoá đơn nào được tạo (kiểm bằng GET invoices?billing_month=eq.2026-11).

- [ ] **Step 6: Chạy hai script DB có sẵn (rollback)**

```bash
node scripts/test-invoice-deposit-classification.mjs supabase/migrations/<timestamp>_invoice_writers_recompute_subtotal.sql
node scripts/test-accounting-chain.mjs
```
Kỳ vọng: PASS (script tự ROLLBACK). Nếu script đầu đỏ vì fixture gửi `amount` lệch, sửa fixture của script (không nới guard).

### Task A6: Draft PR, review, promote

- [ ] **Step 1: Đẩy nhánh và mở draft PR** (nội dung: mục đích, luật mới, kết quả A1, md5 sống A2, test A3, diễn tập A5 kèm mã lỗi 22000 chụp được).
- [ ] **Step 2: Chủ review → merge fast-forward vào main.**
- [ ] **Step 3:** `npm run promote:production -- --sha <SHA đầy đủ> --apply` sau khi CI Gates main xanh; kiểm Vercel READY (client không đổi nhưng giữ quy trình).
- [ ] **Step 4: Ghi memory:** lỗ hổng đã vá ngày nào, guard nằm ở đâu, DEMO đã có `organization_invoice_settings`.

---

## Việc B — Quản lý tự huỷ hoá đơn Quá hạn chưa thu

### Task B1: Đổi luật `canCancelInvoice` (test trước)

**Files:**
- Modify: `src/lib/invoiceUtils.ts:140-149`
- Test: `src/lib/__tests__/invoiceAdjustmentEditor.test.ts:60-70` (đã có 2 assert về canCancelInvoice) — thêm ca mới vào cùng khối.

**Interfaces:**
- Produces: `canCancelInvoice(invoice, opts)` trả `true` cho `{ status: 'OVERDUE', paid_amount: 0 }` với user thường; vẫn `false` cho `OVERDUE` đã thu, `PAID`, `PARTIAL_PAID`, đã soft-delete.

- [ ] **Step 1: Thêm test đỏ**

```ts
// trong describe đang chứa expect(canCancelInvoice({ status: 'APPROVED', paid_amount: 0 })).toBe(true);
it('quản lý huỷ được hoá đơn Quá hạn khi chưa thu đồng nào, không huỷ được khi đã thu', () => {
  expect(canCancelInvoice({ status: 'OVERDUE', paid_amount: 0 })).toBe(true);
  expect(canCancelInvoice({ status: 'OVERDUE', paid_amount: 1 })).toBe(false);
  expect(canCancelInvoice({ status: 'PARTIAL_PAID', paid_amount: 0 })).toBe(false);
  expect(canCancelInvoice({ status: 'OVERDUE', paid_amount: 0, deleted_at: '2026-09-01' })).toBe(false);
});
```

- [ ] **Step 2: Chạy test → đỏ ở dòng OVERDUE/0**

```bash
npx vitest run src/lib/__tests__/invoiceAdjustmentEditor.test.ts
```

- [ ] **Step 3: Sửa luật**

```ts
export function canCancelInvoice(
  invoice: InvoiceLike,
  opts?: { isSuper?: boolean },
): boolean {
  if (invoice.deleted_at != null) return false;
  if (opts?.isSuper) {
    return invoice.status !== 'CANCELLED';
  }
  // 13/09/2026: Quá hạn nhưng chưa thu đồng nào giống Đã duyệt chưa thu —
  // quản lý tự huỷ được, không cần super admin. Có tiền đã thu vẫn chặn.
  if (invoice.status === 'OVERDUE') return (invoice.paid_amount ?? 0) === 0;
  return canEditInvoice(invoice);
}
```
Cập nhật chú thích khối `Quy tắc HỦY` phía trên hàm: thêm dòng "OVERDUE chưa thu: user thường huỷ được (13/09/2026)".

- [ ] **Step 4: Chạy lại test → xanh; chạy các test phụ thuộc**

```bash
npx vitest run src/lib/__tests__/invoiceAdjustmentEditor.test.ts src/components/invoices/__tests__ src/hooks
```
Ba nơi gọi (`InvoiceListTable.tsx:336`, `InvoiceDetailView.tsx:223`, `useInvoices.ts:1035` huỷ hàng loạt và `:1751` huỷ đơn) đều đi qua hàm này nên nút Huỷ sẽ tự hiện; RPC `cancel_invoice_with_credit_v1` không guard trạng thái, không cần đổi SQL. Phục hồi: `restore_invoice_with_credit_v1` đưa về APPROVED rồi hệ tự tính lại thành Quá hạn nếu đã qua hạn — hành vi này có sẵn.

- [ ] **Step 5: Cập nhật tài liệu + memory**

`docs/he-thong/07-hoa-don-thanh-toan.md`: tìm đoạn mô tả luật huỷ, thêm "Quá hạn chưa thu: quản lý huỷ được (13/09/2026)". Memory `gom-nut-xoa-hoa-don-ve-nut-huy.md`: cập nhật cùng ý.

- [ ] **Step 6: Commit, draft PR (đụng phân quyền), merge, promote**

```bash
git add src/lib/invoiceUtils.ts src/lib/__tests__/invoiceAdjustmentEditor.test.ts docs/he-thong/07-hoa-don-thanh-toan.md
git commit -m "feat(invoices): quản lý huỷ được hoá đơn Quá hạn khi chưa thu đồng nào"
```
Sau merge: CI xanh → `promote:production --sha <SHA đầy đủ> --apply` → Vercel READY → thử trên DEMO bằng `demo.chunha` với một hoá đơn Quá hạn chưa thu (nếu không có, không tạo giả; chỉ kiểm nút hiện đúng qua fixture jsdom).

---

## Việc C — Báo sớm ở màn Điều chỉnh khi nợ cũ không khớp nguồn

### Task C1: Hàm thuần + test

**Files:**
- Modify: `src/lib/invoiceAdjustmentEntry.ts` (thêm `adjustmentReconcileBlocker`)
- Test: `src/lib/__tests__/invoiceAdjustmentEntry.test.ts`

**Interfaces:**
- Produces: `adjustmentReconcileBlocker(invoice: Pick<InvoiceWithRelations,'kind'|'previous_debt'|'previous_debt_sources'>): string | null` — trả câu báo tiếng Việt khi server sẽ đánh ANOMALY, `null` khi ổn. Cùng luật với `app_private.sync_finance_invoice_components_v1`: hoá đơn THANH LÝ bỏ qua; nguồn hợp lệ là `type` ∈ {invoice, deposit} và `amount` là số ≥ 0; |Σ nguồn − nợ cũ| < 0,01.

- [ ] **Step 1: Thêm test đỏ vào `invoiceAdjustmentEntry.test.ts`**

```ts
import { adjustmentReconcileBlocker, buildAdjustmentItems, pricingFromInvoice } from '@/lib/invoiceAdjustmentEntry';

describe('adjustmentReconcileBlocker', () => {
  it('chặn khi nợ cũ nhập tay không có nguồn khớp', () => {
    expect(adjustmentReconcileBlocker({ kind: 'MONTHLY', previous_debt: 100_000, previous_debt_sources: [] })).toMatch(/không khớp nguồn đối chiếu \(0 đ\)/);
    expect(adjustmentReconcileBlocker({ kind: 'MONTHLY', previous_debt: 100_000, previous_debt_sources: [{ type: 'invoice', id: 'x', amount: 60_000, label: 'a' }] })).toMatch(/60.000 đ/);
  });
  it('cho qua khi nợ khớp nguồn, nợ bằng 0, hoặc hoá đơn thanh lý', () => {
    expect(adjustmentReconcileBlocker({ kind: 'MONTHLY', previous_debt: 100_000, previous_debt_sources: [{ type: 'invoice', id: 'x', amount: 40_000, label: 'a' }, { type: 'deposit', contract_id: 'c', amount: 60_000, label: 'b' }] })).toBeNull();
    expect(adjustmentReconcileBlocker({ kind: 'MONTHLY', previous_debt: 0, previous_debt_sources: [] })).toBeNull();
    expect(adjustmentReconcileBlocker({ kind: 'SETTLEMENT', previous_debt: 100_000, previous_debt_sources: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: Chạy → đỏ (hàm chưa có)**

```bash
npx vitest run src/lib/__tests__/invoiceAdjustmentEntry.test.ts
```

- [ ] **Step 3: Viết hàm (thêm vào đầu `invoiceAdjustmentEntry.ts`, sau các import)**

```ts
import type { InvoiceWithRelations } from '@/types/invoice';

const fmtVnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))} đ`;
const reconcileMessage = (debt: number, sourced: number) =>
  `Nợ cũ ${fmtVnd(debt)} không khớp nguồn đối chiếu (${fmtVnd(sourced)}) — máy chủ sẽ từ chối điều chỉnh hoá đơn này cho tới khi kế toán đối soát nợ cũ.`;

/**
 * Lý do máy chủ sẽ từ chối điều chỉnh vì cơ cấu hoá đơn không đối soát được
 * (cùng luật với app_private.sync_finance_invoice_components_v1), hoặc null.
 */
export function adjustmentReconcileBlocker(
  invoice: Pick<InvoiceWithRelations, 'kind' | 'previous_debt' | 'previous_debt_sources'>,
): string | null {
  if (invoice.kind === 'SETTLEMENT') return null;
  const debt = Number(invoice.previous_debt) || 0;
  const sources = Array.isArray(invoice.previous_debt_sources) ? invoice.previous_debt_sources : null;
  if (!sources) return debt > 0 ? reconcileMessage(debt, 0) : null;
  let total = 0;
  for (const s of sources as Array<{ type?: string; amount?: unknown }>) {
    const amount = Number(s?.amount);
    if ((s?.type !== 'invoice' && s?.type !== 'deposit') || !Number.isFinite(amount) || amount < 0) {
      return `Nợ cũ ${fmtVnd(debt)} có nguồn không hợp lệ nên máy chủ không đối soát được cơ cấu hoá đơn — cần kế toán sửa nguồn nợ trước khi điều chỉnh.`;
    }
    total += amount;
  }
  return Math.abs(total - debt) >= 0.01 ? reconcileMessage(debt, total) : null;
}
```

- [ ] **Step 4: Chạy → xanh. Commit**

```bash
git add src/lib/invoiceAdjustmentEntry.ts src/lib/__tests__/invoiceAdjustmentEntry.test.ts
git commit -m "feat(invoices): nhận diện sớm nợ cũ không khớp nguồn trước khi điều chỉnh"
```

### Task C2: Nối vào màn Điều chỉnh

**Files:**
- Modify: `src/components/invoices/IssuedInvoiceEditor.tsx` (import, tính `reconcileBlocker`, truyền `validationError`, khoá submit)
- Test: `src/components/invoices/__tests__/IssuedInvoiceEditor.test.tsx`

**Interfaces:**
- Consumes: `adjustmentReconcileBlocker` (C1); prop `validationError` và `submit.disabled` của `InvoiceEntryShell` (đã có).

- [ ] **Step 1: Test đỏ (thêm vào cuối file test)**

```ts
it('khoá Lưu và báo rõ khi hoá đơn mang nợ cũ nhập tay không nguồn', () => {
  render(<IssuedInvoiceEditor invoice={{ ...invoice, kind: 'MONTHLY', previous_debt: 100000, previous_debt_sources: [] }} onOpenChange={() => {}} />);
  expect(screen.getByRole('alert').textContent).toMatch(/Nợ cũ 100.000 đ không khớp nguồn đối chiếu/);
  expect((screen.getByRole('button', { name: 'Lưu điều chỉnh' }) as HTMLButtonElement).disabled).toBe(true);
});
```

- [ ] **Step 2: Chạy → đỏ**

```bash
npx vitest run src/components/invoices/__tests__/IssuedInvoiceEditor.test.tsx
```

- [ ] **Step 3: Sửa component**

Trong `IssuedInvoiceEditor.tsx`:
```ts
import { adjustmentReconcileBlocker, buildAdjustmentItems, pricingFromInvoice } from '@/lib/invoiceAdjustmentEntry';
// ...
const src = opened.invoice;
const reconcileBlocker = adjustmentReconcileBlocker(src);
// ...
validationError={firstEntryError(errors) ?? reconcileBlocker}
// ...
submit={{ label: 'Lưu điều chỉnh', pendingLabel: 'Đang lưu…', pending: busy || mutation.isPending, disabled: stale || !!reconcileBlocker }}
```

- [ ] **Step 4: Chạy → xanh; chạy cả bộ hoá đơn; commit**

```bash
npx vitest run src/components/invoices/__tests__ src/lib/__tests__/invoiceAdjustmentEntry.test.ts
git add src/components/invoices/IssuedInvoiceEditor.tsx src/components/invoices/__tests__/IssuedInvoiceEditor.test.tsx
git commit -m "feat(invoices): màn Điều chỉnh báo sớm và khoá Lưu khi nợ cũ không khớp nguồn"
```

- [ ] **Step 5: Gate, push, CI, promote** — như Việc B (không đụng tiền/phân quyền → được push thẳng main sau `gate:truoc-push` xanh).

---

## Thứ tự và phụ thuộc

- C độc lập, nhanh nhất (mã đã dựng sẵn ở `scratchpad/patch_debtcheck.py` phiên 13/09), có thể làm trước.
- B độc lập, nhỏ, cần draft PR vì đổi luật phân quyền.
- A: A1 → A2 → A3 → A4 → A5 → A6 tuần tự. A1 quyết định có cần việc phụ "xử lý hoá đơn đã lệch" hay không; nếu có, đó là plan riêng, không gộp vào A.

## Self-review

- Spec: A (server tự cộng dòng, rà callers, test kỹ) → A1–A6; B (quản lý huỷ Quá hạn chưa thu) → B1; C (báo sớm nợ không nguồn) → C1–C2. Đủ.
- Không placeholder: mỗi bước có mã/lệnh cụ thể; giá trị `<timestamp>` lấy từ lệnh cấp tên ở A4 bước 1; `<HĐ DEMO>` lấy từ danh sách hợp đồng DEMO khi diễn tập.
- Tên/kiểu nhất quán: `adjustmentReconcileBlocker` (C1, C2); `canCancelInvoice(invoice, opts)` (B1); mã lỗi `22000`/`22023` (A3, A4, A5).
