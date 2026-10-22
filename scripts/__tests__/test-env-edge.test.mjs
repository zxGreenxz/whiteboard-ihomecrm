// scripts/test-env/edge.mjs: project TEST cầm VAPID_* hay TUYA_* thì dừng TRƯỚC khi deploy function nào (và vẫn
// kiểm lại sau khi nạp secret). Credential, Management API, fetch deploy, vault và log đều giả — không gọi mạng,
// không đọc vault.
import { describe, expect, it } from 'vitest';

import { CHUA_CO_O_PRODUCTION, chanSecretCam, DANH_SACH, main, tepFunction } from '../test-env/edge.mjs';

const REF = 'abcdefghijklmnopqrst';
const SECRETS_SACH = ['OPENROUTER_API_KEY', 'CRON_SECRET', 'DEMO_RESET_SECRET', 'SUPABASE_URL'];

function gia({ truoc = SECRETS_SACH, sau = truoc } = {}) {
  const thuTu = [];
  const deploy = [];
  let lanDocSecret = 0;
  const goiMgmt = async (pat, method, path) => {
    expect(pat).toBe('fake-test-pat');
    thuTu.push(`${method} ${path}`);
    if (method === 'GET' && path === `/v1/projects/${REF}/secrets`) {
      return (lanDocSecret++ === 0 ? truoc : sau).map((name) => ({ name }));
    }
    if (method === 'GET' && path.endsWith('/functions')) return [];
    if (method === 'POST' && path.endsWith('/secrets')) return {};
    throw new Error(`mgmt lạ: ${method} ${path}`);
  };
  const guiDeploy = async (url, init) => {
    thuTu.push(`DEPLOY ${new URL(url).searchParams.get('slug')}`);
    deploy.push({ url, init });
    return new Response(JSON.stringify({ version: 1, verify_jwt: true }), { status: 201 });
  };
  const phuThuoc = {
    layCredential: () => ({ testPat: 'fake-test-pat', testRef: REF }),
    goiMgmt,
    guiDeploy,
    docKhoa: () => '',
    log: () => undefined,
  };
  return { phuThuoc, thuTu, deploy };
}

const argv = (...slugs) => ['node', 'scripts/test-env/edge.mjs', ...slugs];

describe('test-env edge: secret cấm trên TEST', () => {
  it('chanSecretCam bắt VAPID_* và TUYA_*, cho qua tên khác', () => {
    expect(() => chanSecretCam(['TUYA_ACCESS_ID'], 'x')).toThrow(/TUYA_/);
    expect(() => chanSecretCam(['TUYA_ACCESS_SECRET'], 'x')).toThrow(/mở cửa thật/);
    expect(() => chanSecretCam(['VAPID_PRIVATE_KEY'], 'x')).toThrow(/VAPID/);
    expect(() => chanSecretCam([...SECRETS_SACH, 'DOOR_ACCESS_MODE', 'DOOR_ACCESS_ORG_ID', 'MY_TUYA_NOTE'], 'x')).not.toThrow();
  });

  it('door-access nằm trong danh sách deploy TEST với verify_jwt khai sẵn', () => {
    expect(DANH_SACH).toContain('door-access');
    expect(CHUA_CO_O_PRODUCTION['door-access']).toEqual({ verify_jwt: true });
  });

  for (const cam of ['TUYA_ACCESS_ID', 'TUYA_BASE_URL', 'VAPID_PRIVATE_KEY']) {
    it(`${cam} có sẵn trên TEST ⇒ dừng TRƯỚC khi deploy, không đọc production, không nạp secret`, async () => {
      const { phuThuoc, thuTu, deploy } = gia({ truoc: [...SECRETS_SACH, cam] });
      await expect(main(argv('door-access'), phuThuoc)).rejects.toThrow(/trước khi deploy/);
      expect(deploy).toHaveLength(0);
      expect(thuTu).toEqual([`GET /v1/projects/${REF}/secrets`]);
    });
  }

  it('TEST sạch ⇒ kiểm secret trước, rồi deploy, rồi kiểm lại sau', async () => {
    const { phuThuoc, thuTu, deploy } = gia();
    await expect(main(argv('door-access'), phuThuoc)).resolves.toBe(0);
    expect(thuTu).toEqual([
      `GET /v1/projects/${REF}/secrets`,
      'GET /v1/projects/tryymsxyyckgbrmmvozx/functions',
      'DEPLOY door-access',
      `GET /v1/projects/${REF}/secrets`,
      `GET /v1/projects/${REF}/secrets`,
    ]);
    const form = deploy[0].init.body;
    expect(JSON.parse(form.get('metadata'))).toEqual({
      name: 'door-access',
      entrypoint_path: 'index.ts',
      verify_jwt: true,
      import_map_path: 'deno.json',
    });
    const names = form.getAll('file').map((f) => f.name).sort();
    expect(names).toEqual(tepFunction('door-access').map((f) => f.path));
    expect(names).toContain('index.ts');
    expect(names.some((n) => n.endsWith('.test.ts'))).toBe(false);
  });

  it('TUYA_* xuất hiện sau khi deploy ⇒ vẫn dừng đỏ ở lần kiểm sau', async () => {
    const { phuThuoc, deploy } = gia({ sau: [...SECRETS_SACH, 'TUYA_ACCESS_SECRET'] });
    await expect(main(argv('door-access'), phuThuoc)).rejects.toThrow(/sau khi deploy/);
    expect(deploy).toHaveLength(1);
  });

  it('slug ngoài danh sách ⇒ dừng trước mọi lời gọi', async () => {
    const { phuThuoc, thuTu } = gia();
    await expect(main(argv('network-center-worker'), phuThuoc)).rejects.toThrow(/không nằm trong danh sách/);
    expect(thuTu).toEqual([]);
  });
});
