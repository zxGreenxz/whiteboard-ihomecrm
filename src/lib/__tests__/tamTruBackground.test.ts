// @vitest-environment node
// Service worker của extension (extensions/tam-tru/background.js) với `chrome` giả: chỉ nhận
// gói đúng hình dạng (v1 đăng ký / v2 xoá đăng ký), đúng origin CRM, ảnh đúng host Supabase,
// và mở đúng URL thủ tục trên cổng.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(resolve(process.cwd(), 'extensions/tam-tru/background.js'), 'utf8');

const FORM_URL_DANG_KY = 'https://dichvucong.dancuquocgia.gov.vn/portal/p/home/dang-ky-tam-tru.html'
  + '?ma_thu_tuc=1.004194&TT=TAMTRU_01&TT_NAME=%C4%90%C4%83ng%20k%C3%BD%20t%E1%BA%A1m%20tr%C3%BA';
const FORM_URL_XOA = 'https://dichvucong.dancuquocgia.gov.vn/portal/p/home/dang-ky-tam-tru.html'
  + '?ma_thu_tuc=1.004194&TT=TAMTRU_06&TT_NAME=X%C3%B3a%20%C4%91%C4%83ng%20k%C3%BD%20t%E1%BA%A1m%20tr%C3%BA';

type Listener = (msg: unknown, sender: { origin?: string }, sendResponse: (r: unknown) => void) => boolean | undefined;
type KhoGia = Record<string, unknown>;

function khoGia(kho: KhoGia) {
  return {
    get: async (k: string) => ({ [k]: kho[k] }),
    set: async (o: KhoGia) => { Object.assign(kho, o); },
    remove: async (k: string) => { delete kho[k]; },
  };
}

function napBackground() {
  const nghe: { ngoai?: Listener; trong?: Listener } = {};
  const session: KhoGia = {};
  const local: KhoGia = {};
  const tabMo: string[] = [];
  const chrome = {
    runtime: {
      onMessageExternal: { addListener: (f: Listener) => { nghe.ngoai = f; } },
      onMessage: { addListener: (f: Listener) => { nghe.trong = f; } },
    },
    storage: { session: khoGia(session), local: khoGia(local) },
    tabs: {
      create: async ({ url }: { url: string }) => { tabMo.push(url); return { id: 7 }; },
      query: async () => [],
      sendMessage: async () => undefined,
    },
  };
  new Function('chrome', SRC)(chrome);
  const goiNgoai = (msg: unknown, sender: { origin?: string } = { origin: 'https://ptcrm.vercel.app' }) =>
    new Promise<Record<string, unknown>>((done) => { nghe.ngoai!(msg, sender, (r) => done(r as Record<string, unknown>)); });
  return { goiNgoai, tabMo, session };
}

const ANH = 'https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/sign/residence-docs/a.jpg?token=x';
const nguoi = { fullName: 'Lê Quốc Duy', dob: '23/05/2006', genderCode: '2', idNumber: '072206008594', phone: '', email: '' };
const noiNhan = { provinceName: 'Thành phố Hồ Chí Minh', wardName: 'Phường Thông Tây Hội' };
const goiDangKy = {
  version: 1, createdAt: 'x', customerId: 'c1', buildingName: '950NK', roomNumber: 'A1', receive: noiNhan, person: nguoi,
  address: '950 Nguyễn Kiệm', household: { relationshipCode: 'CH01' }, tempResidentTo: '06/10/2028',
  attachments: [{ kind: 'CT01', fileName: 'a.jpg', contentType: 'image/jpeg', url: ANH }],
};
const goiXoa = {
  version: 2, procedure: 'TAMTRU_06', createdAt: 'x', customerId: 'c1', buildingName: '950NK', roomNumber: 'A1',
  receive: noiNhan, person: nguoi, address: '950 Nguyễn Kiệm', household: { relationshipCode: 'CH01' }, caseCode: 'TAT-XOA-14',
  attachments: [
    { kind: 'CT01_XOA', fileName: 'lequocduyct01huy1.jpg', contentType: 'image/jpeg', url: ANH },
    { kind: 'THANH_LY', fileName: 'lequocduythanhly1.jpg', contentType: 'image/jpeg', url: ANH },
  ],
};
const tin = (payload: unknown) => ({ type: 'TAM_TRU_PAYLOAD', payload });

describe('background.js — nhận gói từ CRM', () => {
  it('gói đăng ký (version 1) mở form TT=TAMTRU_01 và giữ gói chờ', async () => {
    const bg = napBackground();
    expect(await bg.goiNgoai(tin(goiDangKy))).toEqual({ ok: true, tabId: 7 });
    expect(bg.tabMo).toEqual([FORM_URL_DANG_KY]);
    expect((bg.session.pending as { payload: unknown }).payload).toEqual(goiDangKy);
  });

  it('gói đăng ký ghi rõ procedure TAMTRU_01 vẫn được nhận', async () => {
    const bg = napBackground();
    expect(await bg.goiNgoai(tin({ ...goiDangKy, procedure: 'TAMTRU_01' }))).toMatchObject({ ok: true });
    expect(bg.tabMo).toEqual([FORM_URL_DANG_KY]);
  });

  it('gói xoá đăng ký (version 2) mở form TT=TAMTRU_06', async () => {
    const bg = napBackground();
    expect(await bg.goiNgoai(tin(goiXoa))).toEqual({ ok: true, tabId: 7 });
    expect(bg.tabMo).toEqual([FORM_URL_XOA]);
    expect((bg.session.pending as { payload: unknown }).payload).toEqual(goiXoa);
  });

  it.each([
    ['v2 sai trường hợp', { ...goiXoa, caseCode: 'TAT-XOA-13' }],
    ['v2 thiếu trường hợp', { ...goiXoa, caseCode: undefined }],
    ['v2 sai thủ tục', { ...goiXoa, procedure: 'TAMTRU_01' }],
    ['v2 thiếu thủ tục', { ...goiXoa, procedure: undefined }],
    ['v1 mang thủ tục lạ', { ...goiDangKy, procedure: 'TAMTRU_06' }],
    ['version 3', { ...goiXoa, version: 3 }],
    ['thiếu version', { ...goiDangKy, version: undefined }],
    ['thiếu người', { ...goiXoa, person: undefined }],
    ['thiếu nơi nhận', { ...goiDangKy, receive: undefined }],
  ])('%s → "Gói dữ liệu không hợp lệ." và không mở tab', async (_ten, goi) => {
    const bg = napBackground();
    expect(await bg.goiNgoai(tin(goi))).toEqual({ ok: false, error: 'Gói dữ liệu không hợp lệ.' });
    expect(bg.tabMo).toEqual([]);
    expect(bg.session.pending).toBeUndefined();
  });

  it('từ chối trang gửi lạ, nhận localhost khi chạy thử', async () => {
    const bg = napBackground();
    const tuChoi = { ok: false, error: 'Trang gửi không được phép.' };
    expect(await bg.goiNgoai(tin(goiXoa), { origin: 'https://evil.example' })).toEqual(tuChoi);
    expect(await bg.goiNgoai(tin(goiXoa), { origin: 'https://ptcrm.vercel.app.evil.example' })).toEqual(tuChoi);
    expect(await bg.goiNgoai(tin(goiXoa), { origin: 'http://localhost.evil.example' })).toEqual(tuChoi);
    expect(await bg.goiNgoai(tin(goiXoa), {})).toEqual(tuChoi); // không có origin
    expect(bg.tabMo).toEqual([]);
    expect(await bg.goiNgoai(tin(goiXoa), { origin: 'http://localhost:5173' })).toMatchObject({ ok: true });
  });

  it('từ chối URL ảnh ngoài kho Supabase của dự án', async () => {
    const bg = napBackground();
    const sai = (url: string) => ({ ...goiXoa, attachments: [{ ...goiXoa.attachments[0], url }, goiXoa.attachments[1]] });
    const loi = { ok: false, error: 'Đường dẫn ảnh không thuộc kho của CRM.' };
    expect(await bg.goiNgoai(tin(sai('https://evil.supabase.co/x.jpg')))).toEqual(loi);
    expect(await bg.goiNgoai(tin(sai('http://tryymsxyyckgbrmmvozx.supabase.co/x.jpg')))).toEqual(loi); // không https
    expect(await bg.goiNgoai(tin(sai('không phải url')))).toEqual(loi);
    expect(bg.tabMo).toEqual([]);
  });

  it('từ chối gói không có ảnh hoặc quá 30 ảnh', async () => {
    const bg = napBackground();
    expect(await bg.goiNgoai(tin({ ...goiXoa, attachments: [] }))).toEqual({ ok: false, error: 'Gói dữ liệu thiếu ảnh đính kèm.' });
    const nhieu = Array.from({ length: 31 }, () => goiXoa.attachments[0]);
    expect(await bg.goiNgoai(tin({ ...goiXoa, attachments: nhieu }))).toEqual({ ok: false, error: 'Gói dữ liệu có quá nhiều ảnh.' });
    expect(bg.tabMo).toEqual([]);
  });

  it('tin không phải gói thì báo tin không hợp lệ', async () => {
    const bg = napBackground();
    expect(await bg.goiNgoai({ type: 'KHAC' })).toEqual({ ok: false, error: 'Tin không hợp lệ.' });
  });
});
