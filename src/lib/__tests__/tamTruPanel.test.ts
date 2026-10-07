// @vitest-environment jsdom
// Bảng nổi của extension (extensions/tam-tru/panel.js) với `chrome.runtime` giả: mã thủ tục ghi
// sổ theo ô Thủ tục THẬT trên trang (không theo gói chờ), ngày tạm trú rỗng cho hồ sơ xoá, và
// cảnh báo khi gói chờ khác thủ tục trang đang mở.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(resolve(process.cwd(), 'extensions/tam-tru/panel.js'), 'utf8');

type Tin = { type: string; ketQua?: Record<string, unknown>; url?: string };

const ANH = 'https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/sign/residence-docs/a.jpg?token=x';
const nguoi = { fullName: 'Lê Quốc Duy', dob: '23/05/2006', genderCode: '2', idNumber: '072206008594', phone: '', email: '' };
const chung = {
  createdAt: 'x', customerId: 'c1', buildingId: 'b1', organizationId: 'o1', contractId: 'k1', buildingName: '950NK', roomNumber: 'A1',
  receive: { provinceName: 'Thành phố Hồ Chí Minh', wardName: 'Phường Thông Tây Hội' }, person: nguoi, address: '950 Nguyễn Kiệm',
  household: { relationshipCode: 'CH01' },
};
const goiDangKy = { ...chung, version: 1, tempResidentTo: '06/10/2028', attachments: [{ kind: 'CT01', fileName: 'a.jpg', contentType: 'image/jpeg', url: ANH }] };
const goiXoa = {
  ...chung, version: 2, procedure: 'TAMTRU_06', caseCode: 'TAT-XOA-14',
  attachments: [{ kind: 'CT01_XOA', fileName: 'a.jpg', contentType: 'image/jpeg', url: ANH }],
};

const oThuTuc = (v: string) => `<select id="cboBPROC_TYPE_CODE"><option value="">-- Chọn --</option>`
  + `<option value="TAMTRU_01"${v === 'TAMTRU_01' ? ' selected' : ''}>Đăng ký tạm trú</option>`
  + `<option value="TAMTRU_06"${v === 'TAMTRU_06' ? ' selected' : ''}>Xóa đăng ký tạm trú</option></select>`;

const nhip = () => new Promise((r) => setTimeout(r, 0));

async function napPanel(payload: unknown, html: string) {
  document.body.innerHTML = html;
  const gui: Tin[] = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (msg: Tin, cb: (r: unknown) => void) => {
        gui.push(msg);
        if (msg.type === 'GET_PENDING') cb(payload ? { payload, receivedAt: Date.now() } : null);
        else if (msg.type === 'FETCH_FILE') cb({ ok: true, type: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,YQ==' });
        else cb({ ok: true });
      },
    },
  };
  new Function('chrome', SRC)(chrome);
  await nhip();
  return gui;
}

/** Tin từ chính cửa sổ trang (như submit-watch.js gửi), source = window. */
function tinTuTrang(data: unknown) {
  const ev = new MessageEvent('message', { data });
  Object.defineProperty(ev, 'source', { get: () => window });
  window.dispatchEvent(ev);
}
const tinNop = { type: 'IHOME_TAMTRU_DA_NOP', submCode: 'G01.899.909-261007-890001', receiveOrg: 'Công an Phường Thông Tây Hội',
  tempResidentFrom: '07/10/2026', tempResidentTo: '06/10/2028', submittedAt: '2026-10-07T05:00:00.000Z' };
const ketQuaGui = (gui: Tin[]) => gui.filter((t) => t.type === 'TAM_TRU_DA_NOP').map((t) => t.ketQua!);

describe('panel.js — ghi mã hồ sơ đã nộp', () => {
  it('trang đang là TAMTRU_06 thì ghi TAMTRU_06 và ngày rỗng, kể cả khi gói chờ là đăng ký', async () => {
    const gui = await napPanel(goiDangKy, oThuTuc('TAMTRU_06'));
    tinTuTrang(tinNop);
    expect(ketQuaGui(gui)).toEqual([expect.objectContaining({
      submCode: tinNop.submCode, procedureCode: 'TAMTRU_06', tempResidentFrom: '', tempResidentTo: '', customerId: 'c1',
    })]);
  });

  it('trang đang là TAMTRU_01 thì ghi TAMTRU_01 kèm ngày của request, kể cả khi gói chờ là xoá', async () => {
    const gui = await napPanel(goiXoa, oThuTuc('TAMTRU_01'));
    tinTuTrang(tinNop);
    expect(ketQuaGui(gui)).toEqual([expect.objectContaining({
      procedureCode: 'TAMTRU_01', tempResidentFrom: '07/10/2026', tempResidentTo: '06/10/2028',
    })]);
  });

  it('không đọc được ô Thủ tục thì mới rơi về thủ tục của gói', async () => {
    let gui = await napPanel(goiXoa, '<div></div>');
    tinTuTrang(tinNop);
    expect(ketQuaGui(gui)).toEqual([expect.objectContaining({ procedureCode: 'TAMTRU_06', tempResidentFrom: '', tempResidentTo: '' })]);

    gui = await napPanel(goiXoa, oThuTuc(''));
    tinTuTrang(tinNop);
    expect(ketQuaGui(gui)).toEqual([expect.objectContaining({ procedureCode: 'TAMTRU_06', tempResidentFrom: '', tempResidentTo: '' })]);

    gui = await napPanel(goiDangKy, '<div></div>');
    tinTuTrang({ ...tinNop, tempResidentTo: '' });
    expect(ketQuaGui(gui)).toEqual([expect.objectContaining({ procedureCode: 'TAMTRU_01', tempResidentFrom: '07/10/2026', tempResidentTo: '06/10/2028' })]);
  });

  it('bỏ qua tin không đến từ chính cửa sổ trang', async () => {
    const gui = await napPanel(goiXoa, oThuTuc('TAMTRU_06'));
    window.dispatchEvent(new MessageEvent('message', { data: tinNop }));
    expect(ketQuaGui(gui)).toEqual([]);
  });
});

describe('panel.js — gói chờ khác thủ tục trang đang mở', () => {
  const bang = () => document.getElementById('ihome-tamtru-panel')!;
  const nutDien = () => Array.from(bang().querySelectorAll('button')).find((b) => b.className === 'ihome-tamtru-primary')!;

  it('gói đăng ký trên trang xoá: báo rõ đây là gói gì, lần bấm đầu không điền', async () => {
    const gui = await napPanel(goiDangKy, oThuTuc('TAMTRU_06'));
    expect(bang().textContent).toContain('Gói đang chờ là "Đăng ký tạm trú" cho khách Lê Quốc Duy');
    expect(bang().textContent).toContain('đang mở thủ tục "Xóa đăng ký tạm trú"');
    nutDien().click();
    await nhip();
    expect(gui.some((t) => t.type === 'FETCH_FILE')).toBe(false);
    expect(nutDien().textContent).toBe('Vẫn điền gói này');
    nutDien().click(); // người dùng đã thấy cảnh báo và vẫn muốn điền
    await nhip();
    expect(gui.some((t) => t.type === 'FETCH_FILE')).toBe(true);
  });

  it('gói xoá trên trang đăng ký cũng báo', async () => {
    await napPanel(goiXoa, oThuTuc('TAMTRU_01'));
    expect(bang().textContent).toContain('Gói đang chờ là "Huỷ (xoá) đăng ký tạm trú"');
    expect(bang().querySelector('strong')!.textContent).toBe('iHome Tạm trú · Huỷ đăng ký');
  });

  it('đúng thủ tục (hoặc trang chưa chọn) thì không báo và điền ngay', async () => {
    const gui = await napPanel(goiXoa, oThuTuc('TAMTRU_06'));
    expect(bang().textContent).not.toContain('Gói đang chờ là');
    expect(bang().textContent).toContain('Huỷ đăng ký tạm trú (cả hộ, không còn chỗ ở hợp pháp)');
    expect(bang().textContent).not.toContain('Hạn tạm trú');
    nutDien().click();
    await nhip();
    expect(gui.some((t) => t.type === 'FETCH_FILE')).toBe(true);

    await napPanel(goiDangKy, oThuTuc(''));
    expect(bang().textContent).not.toContain('Gói đang chờ là');
  });
});
