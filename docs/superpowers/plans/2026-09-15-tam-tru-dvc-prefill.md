# Điền sẵn hồ sơ Đăng ký tạm trú trên Cổng DVC — kế hoạch thực hiện

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Từ chi tiết khách trên CRM, một nút mở form Đăng ký tạm trú trên `dichvucong.dancuquocgia.gov.vn` và điền đủ chữ + ba loại ảnh đính kèm; người dùng chỉ xem lại, tick chịu trách nhiệm và bấm Nộp.

**Architecture:** CRM giữ dữ liệu và quyền (bảng `residence_dossier_files`, bucket `residence-docs`, bộ dựng `TamTruPayload`); extension Chrome MV3 trong `extensions/tam-tru/` chỉ nhận gói qua `window.postMessage` từ trang CRM, mở cổng và đổ dữ liệu bằng `FormUtil.setObjectToFormV2` của chính cổng. Spec: `docs/superpowers/specs/2026-09-15-tam-tru-dvc-prefill-design.md`.

**Tech Stack:** React 18 + Vite + TypeScript strict, TanStack Query, shadcn/ui, Lucide, Sonner, Supabase (Postgres RLS + Storage), Vitest + Testing Library (jsdom), Chrome Extension MV3 (JS thuần, không build), Playwright (kiểm sống).

## Global Constraints

- Contract: migration đặt tên bằng `node scripts/tao-ten-migration.mjs <slug>`, idempotent, apply qua `npm run migrate:forward -- <file> [--apply]`; `git add` migration TRƯỚC `npm run provenance:generate`.
- Bảng mới có `organization_id` phải có policy `residence_dossier_files_hide_sandbox_admin` RESTRICTIVE với `COALESCE(...,false)`; SECURITY DEFINER tự kiểm quyền qua `can_access_building()`.
- Hàm SECURITY DEFINER: `REVOKE ALL ... FROM PUBLIC, anon, service_role; GRANT EXECUTE ... TO authenticated` (REVOKE FROM PUBLIC không cắt anon).
- Không sửa `src/integrations/supabase/types.ts` bằng tay: chạy `npm run gen:types && npm run types:normalize && npm run types:check` sau khi apply migration.
- File `.ts/.tsx` mới trong `src/` phải thêm vào `tsconfig.strict-islands.json` (`include`) và `tooling/strict-islands-baseline.json` (`islands`), và sạch dưới strict.
- File/media đi qua `uploadFile()` của `src/lib/storage.ts`; hiển thị qua `StorageImage`; ký URL qua `createSignedUrlFromStored`.
- Không thêm quyền mới: CT01/LEASE theo `customers.print`, OWNERSHIP theo `buildings.edit`.
- Quy ước mã: Sonner cho phản hồi, thông báo tiếng Việt, không lộ chi tiết kỹ thuật cho người dùng; commit `feat(scope): …` + trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; chỉ `git add` file cụ thể.
- Test: `npx vitest run <file>`; test file phải nằm dưới `src/` (suite vitest của test-matrix), extension test đặt ở `src/lib/__tests__/` và nạp file extension qua `fs`.
- Trong worktree: `gate:truoc-push -- --khong-dao-strict`; credential lấy từ vault `CLAUDE.local.md` ở checkout chính (copy tạm để chạy `provenance:generate`/`gen:types`, xoá ngay sau).

---

### Task 1: Migration bảng `residence_dossier_files` + bucket `residence-docs`

**Files:**
- Create: `supabase/migrations/<timestamp>_residence_dossier_files.sql` (tên do script cấp)
- Modify (máy sinh): `supabase/migration-provenance.json`, `src/integrations/supabase/types.ts`

**Interfaces:**
- Produces: bảng `public.residence_dossier_files` (cột như dưới), bucket `residence-docs`, hàm `app_private.residence_dossier_can_read_v1(uuid,uuid)`, `app_private.residence_dossier_can_write_v1(text,uuid,uuid,uuid,uuid)`, `app_private.residence_doc_object_can_read_v1(text,text)`.

- [ ] **Step 1: Cấp tên migration**

Run: `node scripts/tao-ten-migration.mjs residence_dossier_files`
Expected: in ra `2026091xxxxxxx_residence_dossier_files.sql`.

- [ ] **Step 2: Viết migration (idempotent)**

```sql
-- Hồ sơ đăng ký tạm trú trên Cổng DVC: ảnh CT01/hợp đồng đã ký theo khách,
-- giấy tờ chứng minh chỗ ở hợp pháp theo toà. Bucket riêng, private, đọc qua
-- signed URL; object chỉ đọc được khi người gọi đọc được dòng bảng tương ứng.
INSERT INTO storage.buckets (id, name, public) VALUES ('residence-docs', 'residence-docs', false)
ON CONFLICT (id) DO UPDATE SET public = false;

CREATE TABLE IF NOT EXISTS public.residence_dossier_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  contract_id uuid REFERENCES public.contracts(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('CT01','LEASE','OWNERSHIP')),
  bucket_id text NOT NULL DEFAULT 'residence-docs' CHECK (bucket_id = 'residence-docs'),
  object_name text NOT NULL CHECK (length(object_name) BETWEEN 3 AND 500 AND object_name NOT LIKE '%..%'),
  file_name text NOT NULL DEFAULT '' CHECK (length(file_name) <= 255),
  content_type text NOT NULL DEFAULT '' CHECK (length(content_type) <= 100),
  size_bytes integer NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT residence_dossier_files_kind_target CHECK (
    (kind = 'OWNERSHIP' AND customer_id IS NULL) OR (kind IN ('CT01','LEASE') AND customer_id IS NOT NULL)),
  CONSTRAINT residence_dossier_files_object_unique UNIQUE (bucket_id, object_name)
);
CREATE INDEX IF NOT EXISTS residence_dossier_files_customer ON public.residence_dossier_files (customer_id, kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS residence_dossier_files_building ON public.residence_dossier_files (building_id, kind) WHERE deleted_at IS NULL;
ALTER TABLE public.residence_dossier_files ENABLE ROW LEVEL SECURITY;

-- Đọc: thấy toà + (in hồ sơ/CT01 hoặc sửa toà). Super admin không thấy org sandbox.
CREATE OR REPLACE FUNCTION app_private.residence_dossier_can_read_v1(p_building_id uuid, p_organization_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT auth.uid() IS NOT NULL
    AND NOT ((SELECT public.is_super_admin()) AND COALESCE(p_organization_id = ANY(public.sandbox_org_ids()), false))
    AND EXISTS (SELECT 1 FROM public.buildings b WHERE b.id = p_building_id
      AND b.organization_id = p_organization_id AND b.deleted_at IS NULL
      AND public.can_access_building(b.id)
      AND (public.can_do_on_building('customers','print',b.id) OR public.can_do_on_building('buildings','edit',b.id)));
$$;
REVOKE ALL ON FUNCTION app_private.residence_dossier_can_read_v1(uuid,uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION app_private.residence_dossier_can_read_v1(uuid,uuid) TO authenticated;

-- Ghi: CT01/LEASE cần customers.print và khách cùng org; OWNERSHIP cần buildings.edit.
CREATE OR REPLACE FUNCTION app_private.residence_dossier_can_write_v1(p_kind text, p_building_id uuid, p_organization_id uuid, p_customer_id uuid, p_contract_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT auth.uid() IS NOT NULL
    AND NOT ((SELECT public.is_super_admin()) AND COALESCE(p_organization_id = ANY(public.sandbox_org_ids()), false))
    AND EXISTS (SELECT 1 FROM public.buildings b WHERE b.id = p_building_id
      AND b.organization_id = p_organization_id AND b.deleted_at IS NULL
      AND public.can_access_building(b.id)
      AND CASE WHEN p_kind = 'OWNERSHIP' THEN public.can_do_on_building('buildings','edit',b.id)
               ELSE public.can_do_on_building('customers','print',b.id) END)
    AND (p_kind = 'OWNERSHIP' OR EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer_id
      AND c.organization_id = p_organization_id AND c.deleted_at IS NULL))
    AND (p_contract_id IS NULL OR EXISTS (SELECT 1 FROM public.contracts ct WHERE ct.id = p_contract_id
      AND ct.organization_id = p_organization_id AND ct.deleted_at IS NULL));
$$;
REVOKE ALL ON FUNCTION app_private.residence_dossier_can_write_v1(text,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION app_private.residence_dossier_can_write_v1(text,uuid,uuid,uuid,uuid) TO authenticated;

DROP POLICY IF EXISTS residence_dossier_files_select ON public.residence_dossier_files;
CREATE POLICY residence_dossier_files_select ON public.residence_dossier_files FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND app_private.residence_dossier_can_read_v1(building_id, organization_id));
DROP POLICY IF EXISTS residence_dossier_files_insert ON public.residence_dossier_files;
CREATE POLICY residence_dossier_files_insert ON public.residence_dossier_files FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND deleted_at IS NULL
    AND object_name LIKE auth.uid()::text || '/%'
    AND app_private.residence_dossier_can_write_v1(kind, building_id, organization_id, customer_id, contract_id));
DROP POLICY IF EXISTS residence_dossier_files_update ON public.residence_dossier_files;
CREATE POLICY residence_dossier_files_update ON public.residence_dossier_files FOR UPDATE TO authenticated
  USING (deleted_at IS NULL AND app_private.residence_dossier_can_write_v1(kind, building_id, organization_id, customer_id, contract_id))
  WITH CHECK (app_private.residence_dossier_can_write_v1(kind, building_id, organization_id, customer_id, contract_id));
DROP POLICY IF EXISTS residence_dossier_files_hide_sandbox_admin ON public.residence_dossier_files;
CREATE POLICY residence_dossier_files_hide_sandbox_admin ON public.residence_dossier_files AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT ((SELECT public.is_super_admin()) AND COALESCE(organization_id = ANY(public.sandbox_org_ids()), false)));
REVOKE ALL ON public.residence_dossier_files FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.residence_dossier_files TO authenticated;

-- Storage: ghi vào thư mục của chính mình; đọc khi có dòng bảng đọc được; xoá object của mình.
CREATE OR REPLACE FUNCTION app_private.residence_doc_object_can_read_v1(p_bucket text, p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private AS $$
  SELECT p_bucket = 'residence-docs' AND EXISTS (SELECT 1 FROM public.residence_dossier_files f
    WHERE f.bucket_id = p_bucket AND f.object_name = p_name AND f.deleted_at IS NULL
      AND app_private.residence_dossier_can_read_v1(f.building_id, f.organization_id));
$$;
REVOKE ALL ON FUNCTION app_private.residence_doc_object_can_read_v1(text,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION app_private.residence_doc_object_can_read_v1(text,text) TO authenticated;
DROP POLICY IF EXISTS residence_docs_insert ON storage.objects;
CREATE POLICY residence_docs_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'residence-docs' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS residence_docs_select ON storage.objects;
CREATE POLICY residence_docs_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'residence-docs' AND app_private.residence_doc_object_can_read_v1(bucket_id, name));
DROP POLICY IF EXISTS residence_docs_delete ON storage.objects;
CREATE POLICY residence_docs_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'residence-docs' AND (storage.foldername(name))[1] = auth.uid()::text);
```

- [ ] **Step 3: Stage + provenance + gate**

```bash
git add supabase/migrations/<file>.sql
npm run provenance:generate          # cần PAT vault: copy CLAUDE.local.md tạm, xoá sau
npm run gate:migration-provenance
node scripts/check-stable-fn-locks.mjs
git add supabase/migration-provenance.json
git commit -m "feat(db): bang residence_dossier_files + bucket residence-docs cho ho so tam tru"
```

- [ ] **Step 4: Dry-run rồi apply**

Run: `npm run migrate:forward -- supabase/migrations/<file>.sql` (ROLLBACK) → `... --apply` (lane tự backup + biên nhận). Commit biên nhận/catalog máy sinh nếu lane ghi (`docs/generated/schema-change-evidence/*`, catalog).

- [ ] **Step 5: Kiểm RLS bằng SQL trong ROLLBACK** (qua `dbq.py` hoặc harness JWT): với `SET ROLE authenticated; SET request.jwt.claims` của tài khoản chủ công ty iHome (uid `0520169e-...`) đọc được toà 950NK; với JWT org DEMO không thấy dòng org THẬT; super admin không thấy dòng org sandbox.

- [ ] **Step 6: Sinh types**

```bash
npm run gen:types && npm run types:normalize && npm run types:check
git add src/integrations/supabase/types.ts
git commit -m "chore(types): generated types cho residence_dossier_files"
```

### Task 2: Service `residenceDossierFiles.ts`

**Files:**
- Create: `src/lib/residenceDossierFiles.ts`
- Test: `src/lib/__tests__/residenceDossierFiles.test.ts`

**Interfaces:**
- Consumes: `uploadFile`, `getPublicUrl`, `parseStorageRef`, `sanitizeStorageFileName` từ `@/lib/storage`; `getSessionUser` từ `@/lib/authSession`; `supabase`.
- Produces:
```ts
export type DossierKind = 'CT01' | 'LEASE' | 'OWNERSHIP';
export const RESIDENCE_DOCS_BUCKET = 'residence-docs';
export const DOSSIER_KIND_LABEL: Record<DossierKind, string>;
export interface ResidenceDossierFile { id: string; kind: DossierKind; organization_id: string; building_id: string; customer_id: string | null; contract_id: string | null; bucket_id: string; object_name: string; file_name: string; content_type: string; size_bytes: number; sort_order: number; created_at: string }
export class DossierFileError extends Error {}
export function dossierStorageValue(file: Pick<ResidenceDossierFile,'bucket_id'|'object_name'>): string;
export async function listCustomerDossierFiles(customerId: string): Promise<ResidenceDossierFile[]>;
export async function listBuildingOwnershipFiles(buildingId: string): Promise<ResidenceDossierFile[]>;
export async function uploadDossierFile(input: { kind: DossierKind; buildingId: string; customerId?: string; contractId?: string; file: File }): Promise<ResidenceDossierFile>;
export async function removeDossierFile(id: string): Promise<void>;
```

- [ ] **Step 1: Test thất bại**

```ts
// src/lib/__tests__/residenceDossierFiles.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({
  uploadFile: vi.fn(), getSessionUser: vi.fn(), from: vi.fn(),
}));
vi.mock('@/lib/storage', async () => ({
  uploadFile: boundary.uploadFile,
  getPublicUrl: (b: string, p: string) => `https://x.supabase.co/storage/v1/object/public/${b}/${p}`,
  parseStorageRef: (v: string) => { const m = v.match(/\/object\/public\/([^/]+)\/(.+)$/); return m ? { bucket: m[1], path: m[2] } : null; },
  sanitizeStorageFileName: (n: string) => n.replace(/[^a-zA-Z0-9._-]/g, '_'),
}));
vi.mock('@/lib/authSession', () => ({ getSessionUser: boundary.getSessionUser }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: boundary.from } }));
import { uploadDossierFile, listCustomerDossierFiles, dossierStorageValue, DossierFileError } from '../residenceDossierFiles';

function table(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select','eq','is','in','order','insert','update','single','maybeSingle']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (res: (v: unknown) => void) => res(result);
  return chain;
}

describe('uploadDossierFile', () => {
  beforeEach(() => {
    boundary.getSessionUser.mockResolvedValue({ id: 'user-1' });
    boundary.uploadFile.mockResolvedValue('https://x.supabase.co/storage/v1/object/public/residence-docs/user-1/ct01/1-a.webp');
  });
  it('tải lên thư mục của chính mình rồi ghi dòng bảng', async () => {
    const buildings = table({ data: { organization_id: 'org-1' }, error: null });
    const inserted = { id: 'f1', kind: 'CT01', object_name: 'user-1/ct01/1-a.webp', bucket_id: 'residence-docs' };
    const files = table({ data: inserted, error: null });
    boundary.from.mockImplementation((t: string) => (t === 'buildings' ? buildings : files));
    const out = await uploadDossierFile({ kind: 'CT01', buildingId: 'b1', customerId: 'c1', contractId: 'ct1', file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) });
    expect(boundary.uploadFile.mock.calls[0][0]).toBe('residence-docs');
    expect(boundary.uploadFile.mock.calls[0][1]).toMatch(/^user-1\/ct01\/\d+-a\.jpg$/);
    expect((files.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      kind: 'CT01', building_id: 'b1', organization_id: 'org-1', customer_id: 'c1', contract_id: 'ct1',
      object_name: 'user-1/ct01/1-a.webp', content_type: 'image/webp', created_by: 'user-1',
    });
    expect(out).toEqual(inserted);
  });
  it('từ chối tệp không phải ảnh', async () => {
    await expect(uploadDossierFile({ kind: 'OWNERSHIP', buildingId: 'b1', file: new File(['x'], 'a.pdf', { type: 'application/pdf' }) }))
      .rejects.toBeInstanceOf(DossierFileError);
    expect(boundary.uploadFile).not.toHaveBeenCalled();
  });
});

describe('listCustomerDossierFiles', () => {
  it('trả về dòng chưa xoá theo thứ tự', async () => {
    const rows = [{ id: '1', kind: 'LEASE' }];
    const files = table({ data: rows, error: null });
    boundary.from.mockReturnValue(files);
    expect(await listCustomerDossierFiles('c1')).toEqual(rows);
    expect(files.eq).toHaveBeenCalledWith('customer_id', 'c1');
  });
});

describe('dossierStorageValue', () => {
  it('dựng URL public để StorageImage ký', () => {
    expect(dossierStorageValue({ bucket_id: 'residence-docs', object_name: 'u/x.webp' })).toContain('/object/public/residence-docs/u/x.webp');
  });
});
```

- [ ] **Step 2: Chạy, xác nhận đỏ** — `npx vitest run src/lib/__tests__/residenceDossierFiles.test.ts` → FAIL "Cannot find module".

- [ ] **Step 3: Cài đặt**

```ts
// src/lib/residenceDossierFiles.ts
// Tệp hồ sơ đăng ký tạm trú: ảnh CT01/hợp đồng đã ký (theo khách) và giấy tờ
// chứng minh chỗ ở hợp pháp (theo toà). Lưu ở bucket private residence-docs,
// đọc qua signed URL; quyền do RLS quyết định (customers.print / buildings.edit).
import { supabase } from '@/integrations/supabase/client';
import { getPublicUrl, parseStorageRef, sanitizeStorageFileName, uploadFile } from '@/lib/storage';
import { getSessionUser } from '@/lib/authSession';
import type { Database } from '@/integrations/supabase/types';

export type DossierKind = 'CT01' | 'LEASE' | 'OWNERSHIP';
export const RESIDENCE_DOCS_BUCKET = 'residence-docs';
export const DOSSIER_KIND_LABEL: Record<DossierKind, string> = {
  CT01: 'Tờ khai CT01 đã ký',
  LEASE: 'Hợp đồng thuê đã ký',
  OWNERSHIP: 'Giấy tờ chứng minh chỗ ở hợp pháp',
};
type Row = Database['public']['Tables']['residence_dossier_files']['Row'];
export type ResidenceDossierFile = Pick<Row, 'id' | 'organization_id' | 'building_id' | 'customer_id' | 'contract_id'
  | 'bucket_id' | 'object_name' | 'file_name' | 'content_type' | 'size_bytes' | 'sort_order' | 'created_at'> & { kind: DossierKind };
export class DossierFileError extends Error {}

const COLUMNS = 'id,kind,organization_id,building_id,customer_id,contract_id,bucket_id,object_name,file_name,content_type,size_bytes,sort_order,created_at';
const MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

export function dossierStorageValue(file: Pick<ResidenceDossierFile, 'bucket_id' | 'object_name'>): string {
  return getPublicUrl(file.bucket_id, file.object_name);
}

export async function listCustomerDossierFiles(customerId: string): Promise<ResidenceDossierFile[]> {
  const { data, error } = await supabase.from('residence_dossier_files').select(COLUMNS)
    .eq('customer_id', customerId).is('deleted_at', null).order('kind').order('sort_order').order('created_at');
  if (error) throw new DossierFileError('Không tải được ảnh hồ sơ tạm trú. Vui lòng thử lại.');
  return (data ?? []) as ResidenceDossierFile[];
}

export async function listBuildingOwnershipFiles(buildingId: string): Promise<ResidenceDossierFile[]> {
  const { data, error } = await supabase.from('residence_dossier_files').select(COLUMNS)
    .eq('building_id', buildingId).eq('kind', 'OWNERSHIP').is('deleted_at', null).order('sort_order').order('created_at');
  if (error) throw new DossierFileError('Không tải được giấy tờ chỗ ở hợp pháp. Vui lòng thử lại.');
  return (data ?? []) as ResidenceDossierFile[];
}

function contentTypeOf(objectName: string, original: string): string {
  return /\.webp$/i.test(objectName) ? 'image/webp' : original;
}

export async function uploadDossierFile(input: { kind: DossierKind; buildingId: string; customerId?: string; contractId?: string; file: File }): Promise<ResidenceDossierFile> {
  const { kind, buildingId, customerId, contractId, file } = input;
  if (!IMAGE_TYPES.has(file.type)) throw new DossierFileError('Chỉ nhận ảnh JPG, PNG hoặc WebP.');
  if (file.size > MAX_BYTES) throw new DossierFileError('Ảnh tối đa 15MB.');
  if (kind !== 'OWNERSHIP' && !customerId) throw new DossierFileError('Thiếu khách hàng cho ảnh này.');
  const user = await getSessionUser();
  if (!user) throw new DossierFileError('Bạn cần đăng nhập lại.');
  const { data: building, error: buildingError } = await supabase.from('buildings').select('organization_id').eq('id', buildingId).single();
  if (buildingError || !building?.organization_id) throw new DossierFileError('Không xác định được toà nhà của hồ sơ.');
  const path = `${user.id}/${kind.toLowerCase()}/${Date.now()}-${sanitizeStorageFileName(file.name)}`;
  const stored = await uploadFile(RESIDENCE_DOCS_BUCKET, path, file);
  const ref = parseStorageRef(stored);
  const objectName = ref?.path ?? path;
  const { data, error } = await supabase.from('residence_dossier_files').insert({
    kind, building_id: buildingId, organization_id: building.organization_id,
    customer_id: kind === 'OWNERSHIP' ? null : customerId ?? null, contract_id: contractId ?? null,
    bucket_id: RESIDENCE_DOCS_BUCKET, object_name: objectName, file_name: file.name.slice(0, 255),
    content_type: contentTypeOf(objectName, file.type), size_bytes: file.size, sort_order: Date.now() % 1_000_000_000, created_by: user.id,
  }).select(COLUMNS).single();
  if (error || !data) {
    throw new DossierFileError(error?.code === '42501'
      ? 'Bạn không có quyền lưu ảnh hồ sơ tạm trú.'
      : 'Ảnh đã tải lên nhưng chưa lưu được vào hồ sơ. Vui lòng thử lại.');
  }
  return data as ResidenceDossierFile;
}

export async function removeDossierFile(id: string): Promise<void> {
  const { error } = await supabase.from('residence_dossier_files').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new DossierFileError(error.code === '42501' ? 'Bạn không có quyền xoá ảnh này.' : 'Chưa xoá được ảnh. Vui lòng thử lại.');
}
```

- [ ] **Step 4: Chạy test xanh** — `npx vitest run src/lib/__tests__/residenceDossierFiles.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add src/lib/residenceDossierFiles.ts src/lib/__tests__/residenceDossierFiles.test.ts && git commit -m "feat(residence): service tep ho so tam tru"`.

### Task 3: Bộ dựng `TamTruPayload`

**Files:**
- Create: `src/lib/tamTruPayload.ts`
- Test: `src/lib/__tests__/tamTruPayload.test.ts`

**Interfaces:**
- Produces:
```ts
export interface TamTruAttachment { kind: DossierKind; fileName: string; contentType: string; url: string }
export interface TamTruPayload { version: 1; createdAt: string; customerId: string; buildingName: string; roomNumber: string;
  receive: { provinceName: string; wardName: string }; person: { fullName: string; dob: string; genderCode: '2'|'3'|'4'; idNumber: string; phone: string; email: string };
  address: string; household: { relationshipCode: 'CH01' }; tempResidentTo: string; attachments: TamTruAttachment[] }
export class TamTruInputError extends Error {}
export function normalizeProvinceName(raw: string): string;
export function splitBuildingAddress(streetAddress: string): { address: string; wardName: string | null };
export function genderCode(raw: string | null | undefined): '2' | '3' | '4' | null;
export function tempResidentTo(now: Date, months: 12 | 24): string;
export function buildTamTruPayload(input: { customer: Pick<Customer,'id'|'full_name'|'date_of_birth'|'gender'|'id_number'|'phone'|'email'>;
  building: { name: string; street_address: string | null; province: string }; roomNumber: string; durationMonths: 12 | 24; attachments: TamTruAttachment[]; now?: Date }): TamTruPayload;
```

- [ ] **Step 1: Test thất bại**

```ts
// src/lib/__tests__/tamTruPayload.test.ts
import { describe, expect, it } from 'vitest';
import { buildTamTruPayload, genderCode, normalizeProvinceName, splitBuildingAddress, tempResidentTo, TamTruInputError } from '../tamTruPayload';

const customer = { id: 'c1', full_name: ' Nguyễn Gia Bình ', date_of_birth: '2008-10-18', gender: 'Nam', id_number: '034208012538', phone: '0843181008', email: '' };
const building = { name: '950NK', street_address: '950/65 Nguyễn Kiệm, Khu Phố 14 , Phường Hạnh Thông, TP Hồ Chí Minh', province: 'Thành phố Hồ Chí Minh' };
const att = [{ kind: 'CT01', fileName: 'a.webp', contentType: 'image/webp', url: 'https://s/1' },
  { kind: 'LEASE', fileName: 'b.webp', contentType: 'image/webp', url: 'https://s/2' },
  { kind: 'OWNERSHIP', fileName: 'c.webp', contentType: 'image/webp', url: 'https://s/3' }] as const;

describe('normalizeProvinceName', () => {
  it('quy về tên đầy đủ cho các cách viết TP.HCM', () => {
    for (const raw of ['Hồ Chí Minh', 'TP Hồ Chí Minh', 'TP. Hồ Chí Minh', 'Thành phố Hồ Chí Minh', 'thành phố hồ chí minh'])
      expect(normalizeProvinceName(raw)).toBe('Thành phố Hồ Chí Minh');
  });
  it('tỉnh thường thêm tiền tố Tỉnh', () => { expect(normalizeProvinceName('Đồng Nai')).toBe('Tỉnh Đồng Nai'); expect(normalizeProvinceName('Tỉnh Đồng Nai')).toBe('Tỉnh Đồng Nai'); });
});

describe('splitBuildingAddress', () => {
  it('tách phường mới và phần địa chỉ đứng trước', () => {
    expect(splitBuildingAddress(building.street_address)).toEqual({ address: '950/65 Nguyễn Kiệm, Khu Phố 14', wardName: 'Phường Hạnh Thông' });
  });
  it('không có phường ⇒ wardName null', () => { expect(splitBuildingAddress('1392 Quang Trung')).toEqual({ address: '1392 Quang Trung', wardName: null }); });
  it('nhận Xã/Thị trấn/Đặc khu', () => { expect(splitBuildingAddress('Ấp 3, Xã Bình Mỹ, TP Hồ Chí Minh').wardName).toBe('Xã Bình Mỹ'); });
});

describe('genderCode', () => {
  it.each([['Nam', '2'], ['MALE', '2'], ['Nữ', '3'], ['FEMALE', '3'], ['Khác', '4'], ['OTHER', '4'], ['', null], [null, null]])('%s → %s', (raw, code) => {
    expect(genderCode(raw as string | null)).toBe(code);
  });
});

describe('tempResidentTo', () => {
  it('cộng 24 tháng theo giờ Việt Nam', () => { expect(tempResidentTo(new Date('2026-09-15T02:00:00Z'), 24)).toBe('15/09/2028'); });
  it('kẹp 29/02', () => { expect(tempResidentTo(new Date('2028-02-29T05:00:00Z'), 12)).toBe('28/02/2029'); });
});

describe('buildTamTruPayload', () => {
  it('dựng gói đúng từ dữ liệu CRM', () => {
    const p = buildTamTruPayload({ customer, building, roomNumber: 'MADRID 4', durationMonths: 24, attachments: [...att], now: new Date('2026-09-15T02:00:00Z') });
    expect(p.receive).toEqual({ provinceName: 'Thành phố Hồ Chí Minh', wardName: 'Phường Hạnh Thông' });
    expect(p.person).toEqual({ fullName: 'Nguyễn Gia Bình', dob: '18/10/2008', genderCode: '2', idNumber: '034208012538', phone: '0843181008', email: '' });
    expect(p.address).toBe('950/65 Nguyễn Kiệm, Khu Phố 14');
    expect(p.household).toEqual({ relationshipCode: 'CH01' });
    expect(p.tempResidentTo).toBe('15/09/2028');
    expect(p.attachments).toHaveLength(3);
  });
  it.each([
    ['CCCD sai', { ...customer, id_number: '12345' }, building, [...att], /CCCD/],
    ['thiếu ngày sinh', { ...customer, date_of_birth: null }, building, [...att], /ngày sinh/i],
    ['thiếu giới tính', { ...customer, gender: null }, building, [...att], /giới tính/i],
    ['toà thiếu phường', customer, { ...building, street_address: '1392 Quang Trung' }, [...att], /phường/i],
    ['thiếu ảnh chủ quyền', customer, building, att.slice(0, 2), /chỗ ở hợp pháp/i],
    ['thiếu ảnh CT01', customer, building, att.slice(1), /CT01/],
  ])('báo lỗi rõ khi %s', (_n, c, b, a, re) => {
    expect(() => buildTamTruPayload({ customer: c as typeof customer, building: b, roomNumber: 'P1', durationMonths: 24, attachments: [...a] })).toThrowError(re);
    expect(() => buildTamTruPayload({ customer: c as typeof customer, building: b, roomNumber: 'P1', durationMonths: 24, attachments: [...a] })).toThrow(TamTruInputError);
  });
});
```

- [ ] **Step 2: Chạy, đỏ.**
- [ ] **Step 3: Cài đặt**

```ts
// src/lib/tamTruPayload.ts
// Gói dữ liệu điền form Đăng ký tạm trú trên Cổng DVC Bộ Công an. Thuần, không I/O.
// Cổng dùng đơn vị hành chính MỚI (tỉnh → phường, không quận) nên phường lấy từ
// địa chỉ chi tiết của toà (cùng luật với buildCT01Data), không dùng cột ward cũ.
import type { DossierKind } from './residenceDossierFiles';

export interface TamTruAttachment { kind: DossierKind; fileName: string; contentType: string; url: string }
export interface TamTruPayload {
  version: 1; createdAt: string; customerId: string; buildingName: string; roomNumber: string;
  receive: { provinceName: string; wardName: string };
  person: { fullName: string; dob: string; genderCode: '2' | '3' | '4'; idNumber: string; phone: string; email: string };
  address: string; household: { relationshipCode: 'CH01' }; tempResidentTo: string; attachments: TamTruAttachment[];
}
export class TamTruInputError extends Error {}

const CENTRAL_CITIES = ['hồ chí minh', 'hà nội', 'đà nẵng', 'hải phòng', 'cần thơ', 'huế'];
const LOCALITY = /^(phường|xã|thị trấn|đặc khu)\s+\S/i;

function stripProvincePrefix(raw: string): string {
  return raw.trim().replace(/^(thành phố|tp\.?|tỉnh)\s+/i, '').trim();
}
function titleCaseVi(s: string): string {
  return s.split(/\s+/).map(w => w.charAt(0).toLocaleUpperCase('vi') + w.slice(1).toLocaleLowerCase('vi')).join(' ');
}
export function normalizeProvinceName(raw: string): string {
  const core = titleCaseVi(stripProvincePrefix(raw));
  return CENTRAL_CITIES.includes(core.toLocaleLowerCase('vi')) ? `Thành phố ${core}` : `Tỉnh ${core}`;
}
export function splitBuildingAddress(streetAddress: string): { address: string; wardName: string | null } {
  const parts = streetAddress.split(',').map(p => p.trim()).filter(Boolean);
  const idx = parts.findIndex(p => LOCALITY.test(p));
  if (idx < 0) return { address: parts.join(', '), wardName: null };
  return { address: parts.slice(0, idx).join(', '), wardName: parts[idx] };
}
export function genderCode(raw: string | null | undefined): '2' | '3' | '4' | null {
  const v = (raw ?? '').trim().toLocaleLowerCase('vi');
  if (v === 'nam' || v === 'male') return '2';
  if (v === 'nữ' || v === 'female') return '3';
  if (v === 'khác' || v === 'other') return '4';
  return null;
}
function vnParts(now: Date): { day: number; month: number; year: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === t)?.value ?? 0);
  return { day: get('day'), month: get('month'), year: get('year') };
}
const pad = (n: number) => String(n).padStart(2, '0');
export function tempResidentTo(now: Date, months: 12 | 24): string {
  const { day, month, year } = vnParts(now);
  const endYear = year + months / 12;
  const lastDay = new Date(Date.UTC(endYear, month, 0)).getUTCDate();
  return `${pad(Math.min(day, lastDay))}/${pad(month)}/${endYear}`;
}
function dobOf(value: string | null | undefined): string | null {
  const m = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

export function buildTamTruPayload(input: {
  customer: { id: string; full_name: string; date_of_birth: string | null; gender: string | null; id_number: string | null; phone: string | null; email: string | null };
  building: { name: string; street_address: string | null; province: string };
  roomNumber: string; durationMonths: 12 | 24; attachments: TamTruAttachment[]; now?: Date;
}): TamTruPayload {
  const { customer, building, attachments } = input;
  const now = input.now ?? new Date();
  const fullName = customer.full_name.trim();
  if (!fullName) throw new TamTruInputError('Khách chưa có họ tên.');
  const dob = dobOf(customer.date_of_birth);
  if (!dob) throw new TamTruInputError('Khách chưa có ngày sinh. Vui lòng cập nhật hồ sơ khách.');
  const gender = genderCode(customer.gender);
  if (!gender) throw new TamTruInputError('Khách chưa có giới tính. Vui lòng cập nhật hồ sơ khách.');
  const idNumber = (customer.id_number ?? '').trim();
  if (!/^\d{12}$/.test(idNumber)) throw new TamTruInputError('Số CCCD của khách phải đủ 12 số. Vui lòng kiểm tra hồ sơ khách.');
  if (!building.street_address?.trim()) throw new TamTruInputError('Toà nhà chưa có địa chỉ chi tiết. Vui lòng cập nhật toà nhà.');
  const { address, wardName } = splitBuildingAddress(building.street_address);
  if (!wardName) throw new TamTruInputError('Địa chỉ chi tiết của toà chưa có phường/xã mới (ví dụ "…, Phường Hạnh Thông, …"). Vui lòng cập nhật toà nhà.');
  if (!address) throw new TamTruInputError('Địa chỉ chi tiết của toà thiếu số nhà, đường phố trước phần phường.');
  const has = (k: DossierKind) => attachments.some(a => a.kind === k);
  if (!has('CT01')) throw new TamTruInputError('Chưa có ảnh tờ khai CT01 đã ký của khách.');
  if (!has('LEASE')) throw new TamTruInputError('Chưa có ảnh hợp đồng thuê đã ký của khách.');
  if (!has('OWNERSHIP')) throw new TamTruInputError('Toà nhà chưa có ảnh giấy tờ chứng minh chỗ ở hợp pháp. Bổ sung trong chỉnh sửa toà nhà.');
  return {
    version: 1, createdAt: now.toISOString(), customerId: customer.id, buildingName: building.name, roomNumber: input.roomNumber,
    receive: { provinceName: normalizeProvinceName(building.province), wardName },
    person: { fullName, dob, genderCode: gender, idNumber, phone: (customer.phone ?? '').trim(), email: (customer.email ?? '').trim() },
    address, household: { relationshipCode: 'CH01' }, tempResidentTo: tempResidentTo(now, input.durationMonths),
    attachments: [...attachments].sort((a, b) => ['CT01', 'LEASE', 'OWNERSHIP'].indexOf(a.kind) - ['CT01', 'LEASE', 'OWNERSHIP'].indexOf(b.kind)),
  };
}
```

- [ ] **Step 4: Xanh.** **Step 5: Commit** `feat(residence): bo dung TamTruPayload`.

### Task 4: Cầu nối extension phía CRM

**Files:**
- Create: `src/lib/tamTruBridge.ts`
- Test: `src/lib/__tests__/tamTruBridge.test.ts`

**Interfaces:**
- Produces:
```ts
export const TAM_TRU_EXT_ATTR = 'data-ihome-tamtru-ext';
export const TAM_TRU_MESSAGE_SOURCE = 'ihome-crm';
export function detectTamTruExtension(doc?: Document): string | null;   // version hoặc null
export function sendTamTruPayload(payload: TamTruPayload, win?: Window, timeoutMs?: number): Promise<void>; // reject khi không có ACK
```
- Giao thức: CRM gửi `{ source: 'ihome-crm', type: 'TAM_TRU_PAYLOAD', requestId, payload }` với `targetOrigin = win.location.origin`; extension trả `{ source: 'ihome-tamtru-ext', type: 'TAM_TRU_ACK', requestId, ok: boolean, error?: string }`.

- [ ] **Step 1: Test thất bại**

```ts
// src/lib/__tests__/tamTruBridge.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { detectTamTruExtension, sendTamTruPayload, TAM_TRU_EXT_ATTR } from '../tamTruBridge';
const payload = { version: 1 as const, createdAt: 'x', customerId: 'c', buildingName: 'b', roomNumber: '1', receive: { provinceName: 'p', wardName: 'w' },
  person: { fullName: 'n', dob: '01/01/2000', genderCode: '2' as const, idNumber: '000000000000', phone: '', email: '' }, address: 'a', household: { relationshipCode: 'CH01' as const }, tempResidentTo: '01/01/2028', attachments: [] };

describe('detectTamTruExtension', () => {
  it('đọc phiên bản từ thuộc tính do extension đặt', () => {
    expect(detectTamTruExtension()).toBeNull();
    document.documentElement.setAttribute(TAM_TRU_EXT_ATTR, '1.0.0');
    expect(detectTamTruExtension()).toBe('1.0.0');
  });
});
describe('sendTamTruPayload', () => {
  it('gửi postMessage và chờ ACK', async () => {
    window.addEventListener('message', (e) => {
      if (e.data?.source === 'ihome-crm' && e.data.type === 'TAM_TRU_PAYLOAD')
        window.postMessage({ source: 'ihome-tamtru-ext', type: 'TAM_TRU_ACK', requestId: e.data.requestId, ok: true }, '*');
    });
    await expect(sendTamTruPayload(payload, window, 500)).resolves.toBeUndefined();
  });
  it('báo lỗi khi extension không trả lời', async () => {
    await expect(sendTamTruPayload(payload, window, 50)).rejects.toThrow(/không phản hồi/i);
  });
});
```

- [ ] **Step 2: Đỏ.** **Step 3: Cài đặt**

```ts
// src/lib/tamTruBridge.ts
// Cầu nối tới extension "iHome Tạm trú": CRM chỉ postMessage gói dữ liệu, extension
// mở cổng DVC và điền. Không có credential nào đi qua kênh này.
import type { TamTruPayload } from './tamTruPayload';

export const TAM_TRU_EXT_ATTR = 'data-ihome-tamtru-ext';
export const TAM_TRU_MESSAGE_SOURCE = 'ihome-crm';
export const TAM_TRU_EXT_SOURCE = 'ihome-tamtru-ext';

export function detectTamTruExtension(doc: Document = document): string | null {
  const v = doc.documentElement.getAttribute(TAM_TRU_EXT_ATTR);
  return v && v.trim() ? v.trim() : null;
}

export function sendTamTruPayload(payload: TamTruPayload, win: Window = window, timeoutMs = 3000): Promise<void> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<void>((resolve, reject) => {
    const timer = win.setTimeout(() => { cleanup(); reject(new Error('Extension iHome Tạm trú không phản hồi. Kiểm tra extension đã bật chưa rồi thử lại.')); }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; requestId?: string; ok?: boolean; error?: string } | null;
      if (event.source !== win || !data || data.source !== TAM_TRU_EXT_SOURCE || data.type !== 'TAM_TRU_ACK' || data.requestId !== requestId) return;
      cleanup();
      if (data.ok) resolve(); else reject(new Error(data.error || 'Extension từ chối gói dữ liệu.'));
    };
    const cleanup = () => { win.clearTimeout(timer); win.removeEventListener('message', onMessage); };
    win.addEventListener('message', onMessage);
    win.postMessage({ source: TAM_TRU_MESSAGE_SOURCE, type: 'TAM_TRU_PAYLOAD', requestId, payload }, win.location.origin);
  });
}
```

- [ ] **Step 4: Xanh.** **Step 5: Commit** `feat(residence): cau noi extension tam tru`.

### Task 5: Hook dữ liệu + `loadCT01Tenancies` trả `contractId`

**Files:**
- Modify: `src/lib/ct01DownloadService.ts` (thêm `contractId` vào `CT01Tenancy`, select `id` của contract)
- Create: `src/hooks/useResidenceDossierFiles.ts`
- Test: `src/hooks/__tests__/useResidenceDossierFiles.test.tsx`

**Interfaces:**
- Produces:
```ts
export const residenceDossierKeys = { customer: (id: string) => ['residence-dossier-files', 'customer', id] as const, building: (id: string) => ['residence-dossier-files', 'building', id] as const };
export function useCustomerDossierFiles(customerId: string | undefined): UseQueryResult<ResidenceDossierFile[]>;
export function useBuildingOwnershipFiles(buildingId: string | undefined): UseQueryResult<ResidenceDossierFile[]>;
export function useDossierFileMutations(scope: { customerId?: string; buildingId: string }): { upload: UseMutationResult<ResidenceDossierFile, Error, { kind: DossierKind; contractId?: string; file: File }>; remove: UseMutationResult<void, Error, string> };
export interface CT01Tenancy { roomId: string; roomNumber: string; contractId: string; building: CT01Building }
```
- Mutations invalidate cả hai key (customer + building) và toast lỗi bằng `error.message` (DossierFileError đã là tiếng Việt).

- [ ] **Step 1: Test** (renderHook với QueryClientProvider; mock `@/lib/residenceDossierFiles`): upload gọi `uploadDossierFile` với `{kind, buildingId, customerId, contractId, file}` và invalidate; remove gọi `removeDossierFile(id)`.
- [ ] **Step 2–4: Đỏ → cài đặt → xanh.** Cập nhật test có sẵn của `ct01DownloadService` nếu có.
- [ ] **Step 5: Commit** `feat(residence): hook tep ho so tam tru + contractId cho tenancy`.

### Task 6: Component `DossierImageUploader`

**Files:**
- Create: `src/components/residence/DossierImageUploader.tsx`
- Test: `src/components/residence/__tests__/DossierImageUploader.test.tsx`

**Interfaces:**
- Props: `{ kind: DossierKind; buildingId: string; customerId?: string; contractId?: string; files: ResidenceDossierFile[]; canEdit: boolean; onUpload: (input: { kind: DossierKind; contractId?: string; file: File }) => Promise<unknown>; onRemove: (id: string) => Promise<unknown>; busy?: boolean }`.
- UI: tiêu đề `DOSSIER_KIND_LABEL[kind]` + số ảnh; lưới thumbnail (`StorageImage value={dossierStorageValue(f)}`) với nút xoá (`aria-label="Xoá ảnh"`); hai nút: **Chụp ảnh** (input `accept="image/*" capture="environment"`) và **Chọn tệp** (input `accept="image/png,image/jpeg,image/jpg,image/webp" multiple`); tuần tự gọi `onUpload` cho từng tệp; disable khi `!canEdit || busy`.
- Test: click "Chọn tệp" với 2 file ⇒ `onUpload` gọi 2 lần với đúng kind/contractId; input chụp có thuộc tính `capture="environment"`; `canEdit=false` ⇒ không có nút.
- [ ] Commit `feat(residence): uploader anh ho so tam tru (chup/chon tep)`.

### Task 7: Nút "Đăng ký tạm trú trên DVC" + khối trong chi tiết khách

**Files:**
- Create: `src/components/residence/TamTruDvcButton.tsx`, `src/components/residence/TamTruInstallDialog.tsx`, `src/components/residence/ResidenceDossierSection.tsx`
- Modify: `src/components/customers/CustomerDetailModal.tsx:274` (thêm `<ResidenceDossierSection customer={customer} />` sau `CT01DownloadButton`)
- Test: `src/components/residence/__tests__/TamTruDvcButton.test.tsx`

**Behavior:**
- `ResidenceDossierSection`: dùng `loadCT01Tenancies(customer.id)` (qua `useQuery`), chọn tenancy (1 ⇒ tự chọn; nhiều ⇒ `<select>`), `useCustomerDossierFiles`, `useBuildingOwnershipFiles(tenancy.building.id)`; hai `DossierImageUploader` (CT01, LEASE) với `canEdit = canUse(permissions,'customers','print')`; dòng trạng thái ảnh chủ quyền của toà ("3 ảnh" hoặc cảnh báo "chưa có, bổ sung trong Sửa toà nhà"); rồi `TamTruDvcButton`.
- `TamTruDvcButton`: select thời hạn 12/24 (mặc định 24); khi bấm: nếu `!detectTamTruExtension()` ⇒ mở `TamTruInstallDialog`; ngược lại ký URL các tệp (`createSignedUrlFromStored(dossierStorageValue(f))`) cho CT01/LEASE của khách (ưu tiên `contract_id === tenancy.contractId`, nếu không có thì mọi tệp của khách) + OWNERSHIP của toà, gọi `buildTamTruPayload`, `sendTamTruPayload`; toast thành công "Đã mở Cổng DVC, kiểm tra tab mới"; lỗi `TamTruInputError` ⇒ `toast.error(message)`.
- `TamTruInstallDialog`: hướng dẫn 4 bước cài unpacked từ thư mục `extensions/tam-tru` (đường dẫn hiển thị), nút "Tôi đã cài, thử lại".
- Test: extension chưa cài ⇒ hiện hộp thoại; đã cài (đặt attribute) ⇒ gọi `sendTamTruPayload` với payload có `person.idNumber` đúng; thiếu ảnh ⇒ toast lỗi, không gửi.
- [ ] Commit `feat(customers): khoi Ho so tam tru va nut dang ky tam tru tren DVC`.

### Task 8: Ảnh chủ quyền trong Sửa toà nhà

**Files:**
- Modify: `src/components/buildings/BuildingFormDialog.tsx:543` — sau `<BuildingLegalOwnerFields {...owner} />`, khi `isEditMode && building` render `<BuildingOwnershipDocs buildingId={building.id} />`.
- Create: `src/components/residence/BuildingOwnershipDocs.tsx` (dùng `useBuildingOwnershipFiles` + `useDossierFileMutations({ buildingId })` + `DossierImageUploader kind="OWNERSHIP"`, `canEdit = canUse(permissions,'buildings','edit')`), chú thích "Tải một lần, dùng cho mọi hồ sơ tạm trú của toà".
- Test: `src/components/residence/__tests__/BuildingOwnershipDocs.test.tsx` (render với files giả, kiểm nhãn + nút).
- [ ] Commit `feat(buildings): anh giay to cho o hop phap dung cho tam tru`.

### Task 9: Extension Chrome `extensions/tam-tru/`

**Files:**
- Create: `extensions/tam-tru/manifest.json`, `bridge.js`, `background.js`, `panel.js`, `panel.css`, `fill-engine.js`, `icons/icon128.png` (PNG 128×128 đơn giản sinh bằng script), `README.md`
- Test: `src/lib/__tests__/tamTruFillEngine.test.ts` (jsdom, nạp `extensions/tam-tru/fill-engine.js` bằng `fs` + `new Function`)

**manifest.json**
```json
{
  "manifest_version": 3, "name": "iHome Tạm trú", "version": "1.0.0",
  "description": "Điền sẵn hồ sơ Đăng ký tạm trú trên Cổng DVC Bộ Công an từ dữ liệu iHome CRM.",
  "permissions": ["storage", "tabs"],
  "host_permissions": ["https://tryymsxyyckgbrmmvozx.supabase.co/*"],
  "background": { "service_worker": "background.js" },
  "icons": { "128": "icons/icon128.png" },
  "content_scripts": [
    { "matches": ["https://ptcrm.vercel.app/*", "http://localhost/*", "http://localhost:*/*"], "js": ["bridge.js"], "run_at": "document_start" },
    { "matches": ["https://dichvucong.dancuquocgia.gov.vn/portal/p/home/dang-ky-tam-tru.html*"], "js": ["fill-engine.js"], "run_at": "document_idle", "world": "MAIN" },
    { "matches": ["https://dichvucong.dancuquocgia.gov.vn/portal/p/home/dang-ky-tam-tru.html*"], "js": ["panel.js"], "css": ["panel.css"], "run_at": "document_idle" }
  ]
}
```

**bridge.js** (CRM): đặt `document.documentElement.setAttribute('data-ihome-tamtru-ext', chrome.runtime.getManifest().version)`; nghe `message` với `event.source === window && event.origin === location.origin && data.source === 'ihome-crm' && data.type === 'TAM_TRU_PAYLOAD'`; `chrome.runtime.sendMessage({ type: 'TAM_TRU_PAYLOAD', payload })` rồi `window.postMessage({ source: 'ihome-tamtru-ext', type: 'TAM_TRU_ACK', requestId, ok, error }, location.origin)`.

**background.js**: `onMessage` `TAM_TRU_PAYLOAD` ⇒ `chrome.storage.session.set({ pending: { payload, receivedAt } })`, mở `chrome.tabs.create({ url: FORM_URL })` (FORM_URL = `https://dichvucong.dancuquocgia.gov.vn/portal/p/home/dang-ky-tam-tru.html?ma_thu_tuc=1.004194&TT=TAMTRU_01&TT_NAME=%C4%90%C4%83ng%20k%C3%BD%20t%E1%BA%A1m%20tr%C3%BA`), trả `{ ok: true }`; `FETCH_FILE {url}` ⇒ `fetch(url)` → base64 data URL trả về; `CLEAR_PENDING`.

**panel.js** (isolated): nếu URL có `?id=` ⇒ không làm gì. Đọc `chrome.storage.session.get('pending')`; nếu có, chèn `<div id="ihome-tamtru-panel">` góc phải dưới: "Điền hồ sơ tạm trú cho **{fullName}** — {buildingName} / {roomNumber}" + nút **Điền ngay**, **Bỏ**. Điền: với mỗi attachment gọi background `FETCH_FILE` (fallback `fetch` trực tiếp nếu CORS cho phép) → `{ name, type, dataUrl }`; `window.postMessage({ type: 'IHOME_TAMTRU_RUN', payload, files }, location.origin)`; nghe `IHOME_TAMTRU_PROGRESS {step, ok, message}` để cập nhật danh sách bước; khi xong hiện "Đã điền. Kiểm tra lại, tick chịu trách nhiệm rồi bấm Nộp hồ sơ." và `CLEAR_PENDING`.

**fill-engine.js** (MAIN world, không phụ thuộc module):
```js
(() => {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/^(thanh pho|tp\.?|tinh)\s+/, '').replace(/\s+/g, ' ').trim();
  const findOption = (select, text) => Array.from(select.options).find((o) => norm(o.text) === norm(text))
    || Array.from(select.options).find((o) => norm(o.text).includes(norm(text)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(check, what, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { const v = check(); if (v) return v; await sleep(200); }
    throw new Error('Chờ quá lâu: ' + what);
  }
  const jq = () => window.jQuery || window.$;
  function setSelect(id, value) {
    const el = document.getElementById(id); if (!el) throw new Error('Không thấy ô ' + id);
    el.value = value; const $ = jq(); if ($) $(el).trigger('change'); else el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setText(id, value) {
    const el = document.getElementById(id); if (!el) throw new Error('Không thấy ô ' + id);
    el.value = value; const $ = jq(); if ($) $(el).trigger('change'); else el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function click(el, what) { if (!el) throw new Error('Không thấy ' + what); el.click(); }
  function dataUrlToFile(f) {
    const [meta, b64] = f.dataUrl.split(','); const mime = /data:([^;]+)/.exec(meta)?.[1] || f.type || 'image/jpeg';
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name, { type: mime });
  }
  function attach(inputId, files) {
    const input = document.getElementById(inputId); if (!input) throw new Error('Không thấy ô tệp ' + inputId);
    const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f)); input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function formObject(p) {
    return { FULLNAME: p.person.fullName, DATE_FORMAT: 'DDMMYYYY', DOB: p.person.dob, GENDER_CODE: p.person.genderCode,
      IDENTIFIER_NUMBER: p.person.idNumber, PHONE_NUMBER: p.person.phone, EMAIL: p.person.email, SUGGEST_ADDRESS: p.address,
      HH_PERSON_FULLNAME: p.person.fullName, HH_PERSON_RELATIONSHIP_CODE: p.household.relationshipCode,
      HH_PERSON_IDENTIFIER_NUMBER: p.person.idNumber, TEMP_RESIDENT_TO: p.tempResidentTo };
  }
  function setObject(obj) {
    const FU = window.FormUtil;
    if (FU && typeof FU.setObjectToFormV2 === 'function') { FU.setObjectToFormV2('Modal_New_DKTT', '', obj); return; }
    for (const [k, v] of Object.entries(obj)) { const txt = document.getElementById('txt' + k); const cbo = document.getElementById('cbo' + k);
      if (cbo) setSelect(cbo.id, v); else if (txt) setText(txt.id, v); }
  }
  const STEPS = [
    ['Chọn tỉnh và phường nhận hồ sơ', async (p, report) => {
      const city = await waitFor(() => { const s = document.getElementById('cboRECEIVE_ADDR_CITY_CODE'); return s && s.options.length > 1 ? s : null; }, 'danh sách tỉnh');
      const opt = findOption(city, p.receive.provinceName); if (!opt) throw new Error('Không thấy tỉnh "' + p.receive.provinceName + '" trên cổng');
      setSelect(city.id, opt.value);
      const ward = await waitFor(() => { const s = document.getElementById('cboRECEIVE_ADDR_VILLAGE_CODE'); return s && s.options.length > 1 ? s : null; }, 'danh sách phường');
      const w = findOption(ward, p.receive.wardName); if (!w) throw new Error('Không thấy phường "' + p.receive.wardName + '" trên cổng');
      setSelect(ward.id, w.value);
      await waitFor(() => (document.getElementById('txtRECEIVE_ORG_ADDRESS') || {}).value, 'cơ quan Công an phường');
      report('Công an: ' + document.getElementById('txtRECEIVE_ORG_ADDRESS').value);
    }],
    ['Chọn thủ tục lập hộ mới, khai hộ', async () => {
      await waitFor(() => { const s = document.getElementById('cboBPROC_CASE_CODE'); return s && s.options.length > 0 ? s : null; }, 'trường hợp thủ tục');
      const r1 = document.getElementById('chkNEW_REGISTRATION'); if (r1 && !r1.checked) click(r1, 'lập hộ mới');
      const r2 = document.getElementById('chkIS_NOT_CHANGED_PERSON'); if (r2 && !r2.checked) click(r2, 'khai hộ');
      await waitFor(() => document.getElementById('txtFULLNAME'), 'khối người đề nghị');
    }],
    ['Điền thông tin người tạm trú và địa chỉ', async (p) => {
      setObject(formObject(p));
      await sleep(300);
      const note = document.getElementById('txtCHANGED_NOTE');
      if (note && !norm(note.value).includes(norm(p.address))) setText('txtCHANGED_NOTE', `Đăng ký tạm trú tại ${p.address} - ${p.receive.wardName} - ${p.receive.provinceName}`);
    }],
    ['Mở mục đính kèm "do thuê, mượn, ở nhờ"', async () => {
      const link = Array.from(document.querySelectorAll('a')).find((a) => /do thu[eê],? m[uư][oợ]n,? [oở] nh[oờ]/i.test(norm(a.textContent)) || /load_table_tphs_new\(2\)/.test(a.getAttribute('href') || ''));
      click(link, 'mục đính kèm do thuê, mượn, ở nhờ');
      await waitFor(() => document.querySelector('#tblGiayToDinhKem tbody tr'), 'bảng giấy tờ');
    }],
    ['Gắn ảnh CT01 và hợp đồng', async (p, report, files) => {
      const rows = { CT01: 0, LEASE: 1 };
      for (const kind of ['CT01', 'LEASE']) {
        const i = rows[kind]; const chk = document.getElementById('chkIS_COMPULSORY' + i); if (chk && !chk.checked) chk.click();
        const type = document.getElementById('cboFILE_TYPE' + i); if (type && type.value !== '1') setSelect(type.id, '1');
        attach('fileUpload' + i, files.filter((f) => f.kind === kind).map(dataUrlToFile));
        report(`${kind}: ${files.filter((f) => f.kind === kind).length} ảnh`);
      }
    }],
    ['Thêm dòng giấy tờ chỗ ở hợp pháp', async (p, report, files) => {
      const before = document.querySelectorAll('#tblGiayToDinhKem tbody tr').length;
      const add = Array.from(document.querySelectorAll('button, a')).find((b) => /^\+?\s*th[eê]m m[oớ]i$/i.test(norm(b.textContent)) && b.closest('#tphs_new_2, .tphs_new, form, body'));
      click(add, 'nút Thêm mới');
      await waitFor(() => document.querySelectorAll('#tblGiayToDinhKem tbody tr').length > before, 'dòng giấy tờ mới');
      const i = before; setText('lblFILE_TYPE_NAME' + i, 'Giấy tờ, tài liệu chứng minh chỗ ở hợp pháp');
      const chk = document.getElementById('chkIS_COMPULSORY' + i); if (chk && !chk.checked) chk.click();
      const type = document.getElementById('cboFILE_TYPE' + i); if (type && type.value !== '1') setSelect(type.id, '1');
      attach('fileUpload' + i, files.filter((f) => f.kind === 'OWNERSHIP').map(dataUrlToFile));
      report(`Chỗ ở hợp pháp: ${files.filter((f) => f.kind === 'OWNERSHIP').length} ảnh`);
    }],
  ];
  async function run(payload, files, onProgress) {
    for (const [name, fn] of STEPS) {
      try { await fn(payload, (m) => onProgress({ step: name, ok: true, message: m }), files); onProgress({ step: name, ok: true }); }
      catch (e) { onProgress({ step: name, ok: false, message: String(e && e.message || e) }); throw e; }
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  window.__ihomeTamTru = { run, norm, findOption, formObject, STEPS };
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.type !== 'IHOME_TAMTRU_RUN') return;
    run(ev.data.payload, ev.data.files || [], (progress) => window.postMessage({ type: 'IHOME_TAMTRU_PROGRESS', ...progress }, location.origin))
      .then(() => window.postMessage({ type: 'IHOME_TAMTRU_DONE', ok: true }, location.origin))
      .catch((e) => window.postMessage({ type: 'IHOME_TAMTRU_DONE', ok: false, message: String(e && e.message || e) }, location.origin));
  });
})();
```

- Test (jsdom): `norm('Thành phố Hồ Chí Minh') === 'ho chi minh'`; `findOption` khớp không dấu và khớp một phần; `formObject(payload)` đúng 12 khoá; `run` trên fixture HTML tối giản (select tỉnh với option "Thành phố Hồ Chí Minh", select phường được đổ khi tỉnh đổi qua listener `change`, input `txtRECEIVE_ORG_ADDRESS`, radio, các ô txt/cbo, link đính kèm, bảng 2 dòng + nút Thêm mới tạo dòng 3) với `DataTransfer` stub ⇒ mọi bước ok, `txtFULLNAME` = tên, `fileUpload0.files.length` = 1.
- README.md: cách cài (chrome://extensions → Developer mode → Load unpacked → chọn thư mục), cách dùng, giới hạn, cách gỡ.
- [ ] Commit `feat(extension): iHome Tam tru — dien san form dang ky tam tru tren DVC`.

### Task 10: Kiểm sống trên cổng thật + trên CRM

**Files:**
- Create: `extensions/tam-tru/test/live-fill.mjs` (Node, nối Chrome đang chạy qua CDP `http://127.0.0.1:9333` của `~/tamtru-recorder`, mở form, nạp `fill-engine.js` bằng `page.addScriptTag`, gọi `run` với payload thật của khách Gia Bình và 3 ảnh mẫu đọc từ đĩa, chụp `full page`, in giá trị 12 ô; KHÔNG bấm Lưu nháp/Nộp).

- [ ] Chạy: `node extensions/tam-tru/test/live-fill.mjs` → mọi bước ok, ảnh chụp khớp mẫu SUBM_DATA (tỉnh 79, phường 26890, họ tên, CCCD, địa chỉ, ngày hết hạn), bảng giấy tờ 3 dòng đủ tệp. Tải lại trang để huỷ.
- [ ] CRM: `npm run dev` + Playwright headless (đăng nhập tài khoản hệ thống, mở khách DEMO), tải ảnh CT01 ở org DEMO, xoá, kiểm console không lỗi; dọn fixture DEMO.
- [ ] Extension end-to-end thủ công: cài unpacked, bấm nút trên CRM ⇒ tab cổng mở, bảng nổi hiện, Điền ngay chạy hết. Ghi kết quả vào báo cáo.

### Task 11: Tài liệu, gate, phát hành

**Files:**
- Create: `docs/huong-dan-su-dung/03-quan-ly-van-hanh/dang-ky-tam-tru-dvc/index.md` (quy trình 4 bước, ảnh chụp màn hình), khai `docs/he-thong/manifest.json` nếu corpus yêu cầu (`npm run gate:copilot-docs`).
- Modify: `tsconfig.strict-islands.json`, `tooling/strict-islands-baseline.json` (thêm mọi file `.ts/.tsx` mới), `docs/he-thong/03-khach-hang-lead-ho-so.md` (một đoạn về Hồ sơ tạm trú).

- [ ] `npm run gate:new-modules-strict`, `npx tsc --noEmit -p tsconfig.app.json`, `npm run typecheck:baseline`, `npx vitest run src/lib src/components/residence src/hooks`, `npm run lint`, `npm run build` + `npm run gate:bundle`.
- [ ] Stage file cụ thể → `npm run gate:truoc-push -- --khong-dao-strict` → kiểm `git diff --cached --name-only` → commit.
- [ ] Chạy tay khối security gate (`gate:definer-acl`, `gate:sandbox-leak`, `gate:rpc-cast`, `gate:route-guards`, `gate:doc-counts`, `gate:test-matrix`, `gate:copilot-docs`).
- [ ] `git fetch && git rebase origin/main` (giải file máy sinh bằng generator), `git merge-base --is-ancestor origin/main HEAD`, `git push origin HEAD:main`.
- [ ] Theo dõi CI đúng SHA 40 ký tự (`npm run promote:production -- --sha <sha>`), xanh ⇒ `--apply`, kiểm Vercel deploy READY.
