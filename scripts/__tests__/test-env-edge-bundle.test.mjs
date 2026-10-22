// Gói deploy multipart (scripts/test-env/edge.mjs dungGoiDeploy/formDeploy): hàm import ../_shared phải mang
// theo file _shared, tên file tính từ gốc repo, entrypoint/import map trỏ đúng file đó (quy ước đọc lại từ
// bank-event-* production 22/10). Chỉ đọc file repo hoặc thư mục tạm — không mạng, không vault.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildLifecycleDeployForm } from '../test-env/bootstrap-lifecycle-reminders.mjs';
import { DANH_SACH, dungGoiDeploy, formDeploy, importTuongDoi } from '../test-env/edge.mjs';

const ham = (slug, file) => `supabase/functions/${slug}/${file}`;
const PUSH_DRAIN = 'supabase/functions/_shared/push-drain.ts';
const tenFile = (goi) => goi.files.map((f) => f.path);

describe('dungGoiDeploy trên mã repo thật', () => {
  it('lifecycle-reminders mang _shared/push-drain.ts, entrypoint + import map tính từ gốc repo', () => {
    const goi = dungGoiDeploy('lifecycle-reminders');
    expect(tenFile(goi)).toEqual([
      PUSH_DRAIN,
      ham('lifecycle-reminders', 'deno.json'),
      ham('lifecycle-reminders', 'index.ts'),
      ham('lifecycle-reminders', 'runner.ts'),
    ]);
    expect(goi.metadata).toEqual({
      entrypoint_path: ham('lifecycle-reminders', 'index.ts'),
      import_map_path: ham('lifecycle-reminders', 'deno.json'),
    });
  });

  it('salary-v5-jobs (không deno.json) mang _shared/push-drain.ts, không gửi import map', () => {
    const goi = dungGoiDeploy('salary-v5-jobs');
    expect(tenFile(goi)).toEqual([PUSH_DRAIN, ham('salary-v5-jobs', 'index.ts')]);
    expect(goi.metadata).toEqual({ entrypoint_path: ham('salary-v5-jobs', 'index.ts') });
  });

  it('send-push: index.ts + policy.ts, bỏ policy.test.ts, không có _shared', () => {
    const goi = dungGoiDeploy('send-push');
    expect(tenFile(goi)).toEqual([ham('send-push', 'index.ts'), ham('send-push', 'policy.ts')]);
    expect(goi.metadata).toEqual({ entrypoint_path: ham('send-push', 'index.ts') });
  });

  it('nội dung file là bytes của đúng file trong repo', () => {
    const goi = dungGoiDeploy('salary-v5-jobs');
    const drain = goi.files.find((f) => f.path === PUSH_DRAIN);
    expect(drain.contents.toString('utf8')).toContain('export async function runGenericPushDrain');
  });

  it('lifecycle-reminders nằm trong DANH_SACH deploy TEST', () => {
    expect(DANH_SACH).toContain('lifecycle-reminders');
    expect(DANH_SACH).toContain('salary-v5-jobs');
    expect(DANH_SACH).toContain('send-push');
  });
});

describe('formDeploy / bootstrap lifecycle', () => {
  it('formDeploy: metadata {name, entrypoint, import map, verify_jwt}; mỗi file một phần `file` mang tên từ gốc repo', () => {
    const goi = dungGoiDeploy('salary-v5-jobs');
    const form = formDeploy(goi, { name: 'salary-v5-jobs', verify_jwt: false });
    expect(JSON.parse(form.get('metadata'))).toEqual({
      name: 'salary-v5-jobs', entrypoint_path: ham('salary-v5-jobs', 'index.ts'), verify_jwt: false,
    });
    expect(form.getAll('file').map((f) => f.name)).toEqual([PUSH_DRAIN, ham('salary-v5-jobs', 'index.ts')]);
    expect(() => formDeploy(goi, { name: 'salary-v5-jobs', verify_jwt: undefined })).toThrow(/boolean/);
  });

  it('bootstrap TEST deploy lifecycle-reminders bằng cùng gói, verify_jwt=true, có push-drain.ts', async () => {
    const { repoRoot } = await import('../test-env/lib.mjs');
    const form = await buildLifecycleDeployForm(repoRoot);
    expect(JSON.parse(form.get('metadata'))).toEqual({
      name: 'lifecycle-reminders',
      entrypoint_path: ham('lifecycle-reminders', 'index.ts'),
      import_map_path: ham('lifecycle-reminders', 'deno.json'),
      verify_jwt: true,
    });
    expect(form.getAll('file').map((f) => f.name)).toContain(PUSH_DRAIN);
  });
});

describe('dungGoiDeploy trên cây giả', () => {
  let goc;
  const viet = (duongDan, noiDung) => {
    const tuyetDoi = join(goc, ...duongDan.split('/'));
    mkdirSync(dirname(tuyetDoi), { recursive: true });
    writeFileSync(tuyetDoi, noiDung);
  };
  const moi = () => { goc = mkdtempSync(join(tmpdir(), 'edge-bundle-')); };
  afterEach(() => { if (goc) rmSync(goc, { recursive: true, force: true }); goc = undefined; });

  it('bao đóng import bắc cầu (_shared → _shared), export-from, import type, import() — bỏ import trong chú thích/chuỗi', () => {
    moi();
    viet('supabase/functions/fn/index.ts', [
      "import { a } from '../_shared/a.ts';",
      "import type { T } from './types.ts';",
      "export { b } from './b.ts';",
      "const lazy = () => import('../_shared/lazy.ts');",
      "// import { ghost } from '../_shared/ghost.ts';",
      "const s = \"from '../_shared/ghost2.ts'\";",
      "import { createClient } from 'npm:@supabase/supabase-js@2';",
    ].join('\n'));
    viet('supabase/functions/fn/types.ts', 'export type T = 1;');
    viet('supabase/functions/fn/b.ts', 'export const b = 1;');
    viet('supabase/functions/fn/index.test.ts', "import '../_shared/test-only.ts';");
    viet('supabase/functions/_shared/a.ts', "import { c } from './c.ts';\nexport const a = c;");
    viet('supabase/functions/_shared/c.ts', 'export const c = 1;');
    viet('supabase/functions/_shared/lazy.ts', 'export const l = 1;');
    viet('supabase/functions/_shared/khong-dung.ts', 'export const x = 1;');
    const goi = dungGoiDeploy('fn', { goc });
    expect(tenFile(goi)).toEqual([
      'supabase/functions/_shared/a.ts',
      'supabase/functions/_shared/c.ts',
      'supabase/functions/_shared/lazy.ts',
      'supabase/functions/fn/b.ts',
      'supabase/functions/fn/index.ts',
      'supabase/functions/fn/types.ts',
    ]);
    expect(goi.metadata).toEqual({ entrypoint_path: 'supabase/functions/fn/index.ts' });
  });

  it('import thiếu file / ra ngoài supabase/functions / vào file test ⇒ ném, không âm thầm bỏ', () => {
    moi();
    viet('supabase/functions/fn/index.ts', "import { a } from '../_shared/missing.ts';");
    expect(() => dungGoiDeploy('fn', { goc })).toThrow(/không có file supabase\/functions\/_shared\/missing\.ts/);
    viet('supabase/functions/fn/index.ts', "import { a } from '../../../src/lib/x.ts';");
    expect(() => dungGoiDeploy('fn', { goc })).toThrow(/ra ngoài supabase\/functions/);
    viet('supabase/functions/fn/index.ts', "import { a } from '../_shared/a.test.ts';");
    viet('supabase/functions/_shared/a.test.ts', 'export const a = 1;');
    expect(() => dungGoiDeploy('fn', { goc })).toThrow(/file test/);
  });

  it('deno.json: có ⇒ import_map_path trỏ nó (kể cả chỉ compilerOptions); "importMap" file riêng ⇒ ném; thiếu index.ts ⇒ ném', () => {
    moi();
    viet('supabase/functions/fn/index.ts', 'export {};');
    viet('supabase/functions/fn/deno.json', '{"compilerOptions":{"strict":true}}');
    viet('supabase/functions/fn/deno.lock', '{}');
    const goi = dungGoiDeploy('fn', { goc });
    expect(goi.metadata.import_map_path).toBe('supabase/functions/fn/deno.json');
    expect(tenFile(goi)).toContain('supabase/functions/fn/deno.lock');
    viet('supabase/functions/fn/deno.json', '{"importMap":"./import_map.json"}');
    expect(() => dungGoiDeploy('fn', { goc })).toThrow(/importMap/);
    viet('supabase/functions/gn/main.ts', 'export {};');
    expect(() => dungGoiDeploy('gn', { goc })).toThrow(/thiếu supabase\/functions\/gn\/index\.ts/);
    expect(() => dungGoiDeploy('../x', { goc })).toThrow(/Slug/);
  });

  it('importTuongDoi chỉ trả specifier ./ và ../', () => {
    expect(importTuongDoi("import a from 'https://esm.sh/x';\nimport b from './b.ts';\nimport c from 'npm:c';")).toEqual(['./b.ts']);
  });
});
