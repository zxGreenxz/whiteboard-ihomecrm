// @vitest-environment jsdom
// Kiểm bộ điền của extension (extensions/tam-tru/fill-engine.js) trên form giả lập
// theo đúng id/hành vi đo được trên cổng DVC ngày 15/09/2026.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vitest chạy với cwd = gốc repo; trong môi trường jsdom import.meta.url không phải file://.
const ENGINE = readFileSync(resolve(process.cwd(), 'extensions/tam-tru/fill-engine.js'), 'utf8');

interface Engine {
  norm: (s: string) => string;
  findOption: (select: HTMLSelectElement, text: string) => HTMLOptionElement | undefined;
  formObject: (p: unknown) => Record<string, string>;
  run: (payload: unknown, files: unknown[], onProgress?: (p: { step: string; ok: boolean; message?: string; partial?: boolean }) => void) => Promise<void>;
}

const payload = {
  version: 1, createdAt: 'x', customerId: 'c1', buildingName: '950NK', roomNumber: 'MADRID 4',
  receive: { provinceName: 'Thành phố Hồ Chí Minh', wardName: 'Phường Hạnh Thông' },
  person: { fullName: 'Nguyễn Gia Bình', dob: '18/10/2008', genderCode: '2', idNumber: '034208012538', phone: '0843181008', email: '' },
  address: '950/65 Nguyễn Kiệm, Khu Phố 14', household: { relationshipCode: 'CH01' }, tempResidentTo: '15/09/2028',
  attachments: [],
};
const dataUrl = 'data:image/jpeg;base64,' + btoa('anh');
const files = [
  { kind: 'CT01', name: 'nguyengiabinhct011.jpg', type: 'image/jpeg', dataUrl },
  { kind: 'LEASE', name: 'nguyengiabinhhopdong1.jpg', type: 'image/jpeg', dataUrl },
  { kind: 'OWNERSHIP', name: 'chuquyen950nk1.jpg', type: 'image/jpeg', dataUrl },
  { kind: 'OWNERSHIP', name: 'chuquyen950nk2.jpg', type: 'image/jpeg', dataUrl },
];

function opt(v: string, t: string) { return `<option value="${v}">${t}</option>`; }

/** Form giả lập: id đúng như cổng; đổi tỉnh nạp phường; đổi phường điền cơ quan. */
function mountFixture() {
  document.body.innerHTML = `
    <div id="Modal_New_DKTT">
      <select id="cboRECEIVE_ADDR_CITY_CODE">${opt('', 'Chọn')}${opt('01', 'Thành phố Hà Nội')}${opt('79', 'Thành phố Hồ Chí Minh')}</select>
      <select id="cboRECEIVE_ADDR_VILLAGE_CODE">${opt('', 'Chọn')}</select>
      <input id="txtRECEIVE_ORG_ADDRESS" disabled />
      <select id="cboBPROC_CASE_CODE"></select>
      <input type="radio" id="chkNEW_REGISTRATION" name="radIsHouseHold" />
      <input type="radio" id="chkNOT_NEW_REGISTRATION" name="radIsHouseHold" checked />
      <input type="radio" id="chkIS_REPORTER" name="radIsChangePerson" />
      <input type="radio" id="chkIS_NOT_CHANGED_PERSON" name="radIsChangePerson" checked />
      <div id="check_frm_reporter">
        <input id="txtFULLNAME" />
        <select id="cboDATE_FORMAT">${opt('DDMMYYYY', 'Ngày tháng năm')}${opt('YYYY', 'Năm')}</select>
        <input id="txtDOB" />
        <select id="cboGENDER_CODE">${opt('', '')}${opt('1', 'Chưa có thông tin')}${opt('2', 'Nam')}${opt('3', 'Nữ')}</select>
        <input id="txtIDENTIFIER_NUMBER" maxlength="12" />
        <input id="txtPHONE_NUMBER" /><input id="txtEMAIL" />
      </div>
      <input id="txtSUGGEST_ADDRESS" />
      <input id="txtHH_PERSON_FULLNAME" />
      <select id="cboHH_PERSON_RELATIONSHIP_CODE">${opt('', '')}${opt('09', 'Anh')}${opt('CH01', 'Chủ hộ')}</select>
      <input id="txtHH_PERSON_IDENTIFIER_NUMBER" />
      <textarea id="txtCHANGED_NOTE"></textarea>
      <input id="txtTEMP_RESIDENT_FROM" value="16/09/2026" />
      <input id="txtTEMP_RESIDENT_TO" value="16/09/2028" />
      <a href="javascript:load_table_tphs_new(1);">- Đăng ký tạm trú tại chỗ ở hợp pháp thuộc quyền sở hữu của mình</a>
      <a id="lnk2" href="javascript:load_table_tphs_new(2);">- Đăng ký tạm trú tại chỗ ở hợp pháp do thuê, mượn, ở nhờ</a>
      <div id="tphs_new_2"></div>
    </div>`;
  const city = document.getElementById('cboRECEIVE_ADDR_CITY_CODE') as HTMLSelectElement;
  const ward = document.getElementById('cboRECEIVE_ADDR_VILLAGE_CODE') as HTMLSelectElement;
  const org = document.getElementById('txtRECEIVE_ORG_ADDRESS') as HTMLInputElement;
  const bproc = document.getElementById('cboBPROC_CASE_CODE') as HTMLSelectElement;
  // BẪY THẬT CỦA CỔNG: đổi cboDATE_FORMAT thì datePickerWithPattern() xoá trắng txtDOB.
  // setObjectToFormV2 đặt txt trước cbo, nên ngày sinh vừa điền bị xoá ngay sau đó.
  document.getElementById('cboDATE_FORMAT')!.addEventListener('change', () => {
    (document.getElementById('txtDOB') as HTMLInputElement).value = '';
  });
  // BẪY THẬT: đổi ô "từ ngày" thì cổng tự đặt lại ô "đến ngày" thành +2 năm.
  document.getElementById('txtTEMP_RESIDENT_FROM')!.addEventListener('change', (e) => {
    const [d, m, y] = (e.target as HTMLInputElement).value.split('/');
    if (d && m && y) (document.getElementById('txtTEMP_RESIDENT_TO') as HTMLInputElement).value = `${d}/${m}/${Number(y) + 2}`;
  });
  city.addEventListener('change', () => {
    ward.innerHTML = city.value === '79'
      ? opt('', 'Chọn') + opt('26866', 'Phường An Phú Đông') + opt('26890', 'Phường Hạnh Thông')
      : opt('', 'Chọn');
  });
  ward.addEventListener('change', () => {
    org.value = ward.value === '26890' ? 'Công an Phường Hạnh Thông' : '';
    bproc.innerHTML = opt('TAT-DKTT-THUONG', 'Đăng ký tạm trú (nhân khẩu, hộ)');
  });
  (document.getElementById('txtSUGGEST_ADDRESS') as HTMLInputElement).addEventListener('change', (e) => {
    (document.getElementById('txtCHANGED_NOTE') as HTMLTextAreaElement).value =
      'Đăng ký tạm trú tại ' + (e.target as HTMLInputElement).value + ' - Phường Hạnh Thông - Thành phố Hồ Chí Minh';
  });

  const fileCounts: Record<string, number> = {};
  const fileInput = (i: number) => {
    const input = document.createElement('input');
    input.type = 'file'; input.id = 'fileUpload' + i;
    Object.defineProperty(input, 'files', { writable: true, value: [] });
    input.addEventListener('change', (e) => { fileCounts[input.id] = ((e.target as HTMLInputElement).files as unknown as File[]).length; });
    return input;
  };
  const row = (i: number, name: string, custom: boolean) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i + 1}</td><td><input type="checkbox" id="chkIS_COMPULSORY${i}" name="FILE_IS_COMPULSORY" /></td>
      <td>${custom ? `<input id="lblFILE_TYPE_NAME${i}" name="FILE_TYPE_NAME" />` : name}</td>
      <td><select id="cboFILE_TYPE${i}">${opt('1', 'Bản gốc')}${opt('2', 'Bản sao')}</select></td><td class="f"></td>`;
    tr.querySelector('td.f')!.appendChild(fileInput(i));
    return tr;
  };
  document.getElementById('lnk2')!.addEventListener('click', (e) => {
    e.preventDefault();
    const host = document.getElementById('tphs_new_2')!;
    host.innerHTML = '<table id="tblGiayToDinhKem"><tbody></tbody></table><button type="button" id="btnDocument">+ Thêm mới</button>';
    const tbody = host.querySelector('tbody')!;
    tbody.appendChild(row(0, 'Tờ khai thay đổi thông tin cư trú', false));
    tbody.appendChild(row(1, 'Hợp đồng cho thuê, cho mượn, cho ở nhờ', false));
    host.querySelector('#btnDocument')!.addEventListener('click', () => {
      tbody.appendChild(row(tbody.children.length, '', true));
    });
  });
  // FormUtil rút gọn theo đúng luật của cổng: tìm input/select có id bắt đầu bằng txt/cbo/chk.
  const calls: unknown[] = [];
  (window as unknown as { FormUtil: unknown }).FormUtil = {
    setObjectToFormV2(containerId: string, prefix: string, obj: Record<string, string>) {
      calls.push([containerId, prefix, obj]);
      const container = document.getElementById(containerId)!;
      for (const type of ['txt', 'cbo', 'chk']) {
        container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`input[id^='${prefix}${type}'],textarea[id^='${prefix}${type}'],select[id^='${prefix}${type}']`).forEach((ctl) => {
          const key = ctl.id.slice((prefix + type).length).toUpperCase();
          if (key in obj && obj[key] != null) { ctl.value = obj[key]; ctl.dispatchEvent(new Event('change', { bubbles: true })); }
        });
      }
    },
  };
  (window as unknown as { DataTransfer: unknown }).DataTransfer = class {
    _files: File[] = [];
    items = { add: (f: File) => { this._files.push(f); } };
    get files() { return this._files; }
  };
  return { fileCounts, calls };
}

function loadEngine(): Engine {
  new Function(ENGINE)();
  return (window as unknown as { __ihomeTamTru: Engine }).__ihomeTamTru;
}

describe('fill-engine helpers', () => {
  it('norm bỏ dấu và tiền tố hành chính', () => {
    const e = loadEngine();
    expect(e.norm('Thành phố Hồ Chí Minh')).toBe('ho chi minh');
    expect(e.norm('TP. Hồ Chí Minh')).toBe('ho chi minh');
    expect(e.norm('Phường Hạnh Thông')).toBe('phuong hanh thong');
  });
  it('findOption khớp không dấu, ưu tiên khớp trọn', () => {
    const e = loadEngine();
    const s = document.createElement('select');
    s.innerHTML = opt('1', 'Phường Hạnh Thông Tây') + opt('2', 'Phường Hạnh Thông');
    expect(e.findOption(s, 'phuong hanh thong')?.value).toBe('2');
    expect(e.findOption(s, 'Không có')).toBeUndefined();
  });
  it('formObject đủ 12 khoá theo id của cổng', () => {
    const e = loadEngine();
    const o = e.formObject(payload);
    expect(Object.keys(o).sort()).toEqual(['DATE_FORMAT', 'DOB', 'EMAIL', 'FULLNAME', 'GENDER_CODE', 'HH_PERSON_FULLNAME', 'HH_PERSON_IDENTIFIER_NUMBER',
      'HH_PERSON_RELATIONSHIP_CODE', 'IDENTIFIER_NUMBER', 'PHONE_NUMBER', 'SUGGEST_ADDRESS', 'TEMP_RESIDENT_TO']);
    expect(o.HH_PERSON_RELATIONSHIP_CODE).toBe('CH01');
  });

  it('không đổ ô "từ ngày" theo lượt chung vì cổng ghi đè ô "đến ngày" khi nó đổi', () => {
    const e = loadEngine();
    expect('TEMP_RESIDENT_FROM' in e.formObject({ ...payload, tempResidentFrom: '14/09/2026' })).toBe(false);
  });
});

describe('fill-engine run', () => {
  let fx: ReturnType<typeof mountFixture>;
  beforeEach(() => { fx = mountFixture(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('điền đủ các bước trên form giả lập, không đụng nút Nộp', async () => {
    const e = loadEngine();
    const progress: { step: string; ok: boolean; partial?: boolean; message?: string }[] = [];
    await e.run(payload, files, (p) => progress.push(p));

    const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    expect(val('cboRECEIVE_ADDR_CITY_CODE')).toBe('79');
    expect(val('cboRECEIVE_ADDR_VILLAGE_CODE')).toBe('26890');
    expect(val('txtRECEIVE_ORG_ADDRESS')).toBe('Công an Phường Hạnh Thông');
    expect((document.getElementById('chkNEW_REGISTRATION') as HTMLInputElement).checked).toBe(true);
    expect(val('txtFULLNAME')).toBe('Nguyễn Gia Bình');
    expect(val('txtDOB')).toBe('18/10/2008');
    expect(val('cboGENDER_CODE')).toBe('2');
    expect(val('txtIDENTIFIER_NUMBER')).toBe('034208012538');
    expect(val('txtSUGGEST_ADDRESS')).toBe('950/65 Nguyễn Kiệm, Khu Phố 14');
    expect(val('cboHH_PERSON_RELATIONSHIP_CODE')).toBe('CH01');
    expect(val('txtHH_PERSON_IDENTIFIER_NUMBER')).toBe('034208012538');
    expect(val('txtCHANGED_NOTE')).toContain('950/65 Nguyễn Kiệm');
    expect(fx.calls[0]).toEqual(['Modal_New_DKTT', '', e.formObject(payload)]);

    expect(document.querySelectorAll('#tblGiayToDinhKem tbody tr')).toHaveLength(3);
    expect((document.getElementById('chkIS_COMPULSORY0') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('chkIS_COMPULSORY2') as HTMLInputElement).checked).toBe(true);
    expect(val('lblFILE_TYPE_NAME2')).toBe('Giấy tờ, tài liệu chứng minh chỗ ở hợp pháp');
    expect(fx.fileCounts).toEqual({ fileUpload0: 1, fileUpload1: 1, fileUpload2: 2 });
    expect(progress.filter(p => !p.partial).map(p => p.ok)).toEqual([true, true, true, true, true, true]);
    // Người dùng phải đọc được TÊN ảnh nào đã gắn vào đâu, không chỉ số lượng.
    const loi = progress.map(p => p.message || '').join(' | ');
    expect(loi).toContain('chuquyen950nk1.jpg, chuquyen950nk2.jpg');
    expect(loi).toContain('nguyengiabinhct011.jpg');
    expect(loi).toContain('18/10/2008');
  });

  it('giữ được ngày sinh dù cổng xoá ô khi đổi định dạng ngày', async () => {
    const e = loadEngine();
    await e.run(payload, files);
    expect((document.getElementById('txtDOB') as HTMLInputElement).value).toBe('18/10/2008');
    expect((document.getElementById('txtTEMP_RESIDENT_TO') as HTMLInputElement).value).toBe('15/09/2028');
  });

  it('đồng bộ ngày vào bootstrap-datepicker của cổng, bấm vào ô rồi bấm ra không mất ngày', async () => {
    // bootstrap-datepicker rút gọn theo hành vi đo thật 16/09/2026: chỉ nghe keyup/paste
    // (KHÔNG nghe change); hide() với forceParse ghi ngày NỘI BỘ đè lên ô. Không đồng bộ
    // thì ngày sinh trắng và hạn tạm trú lùi về mặc định ngay khi người dùng bấm vào ô.
    const dpOf = new WeakMap<Element, { dates: string[] }>();
    const wrap = (el: HTMLInputElement) => ({
      trigger: (ev: string) => { el.dispatchEvent(new Event(ev, { bubbles: true })); },
      data: (k: string) => (k === 'datepicker' ? dpOf.get(el) : undefined),
      datepicker: (cmd: string) => { const dp = dpOf.get(el); if (dp && cmd === 'update') dp.dates = el.value ? [el.value] : []; },
    });
    const fakeJq = Object.assign((el: HTMLInputElement) => wrap(el), { fn: { datepicker() { /* plugin có mặt */ } } });
    (window as unknown as { jQuery: unknown }).jQuery = fakeJq;
    const hide = (el: HTMLInputElement) => { if (el.value) el.value = (dpOf.get(el)?.dates ?? []).join(''); };
    const dob = document.getElementById('txtDOB') as HTMLInputElement;
    const han = document.getElementById('txtTEMP_RESIDENT_TO') as HTMLInputElement;
    dpOf.set(dob, { dates: [] }); // cổng vừa xoá trắng ô ngày sinh
    dpOf.set(han, { dates: ['15/09/2028'] }); // mặc định +2 năm của cổng
    try {
      const e = loadEngine();
      await e.run({ ...payload, tempResidentTo: '16/09/2028' }, files);
      expect(dob.value).toBe('18/10/2008');
      expect(han.value).toBe('16/09/2028');
      hide(dob); hide(han); // người dùng bấm vào ô rồi bấm ra ngoài
      expect(dob.value).toBe('18/10/2008');
      expect(han.value).toBe('16/09/2028');
    } finally {
      delete (window as unknown as { jQuery?: unknown }).jQuery;
    }
  });

  it('bỏ qua ngày bắt đầu đã qua (cổng chặn) nhưng vẫn giữ đúng hạn trên giấy', async () => {
    const e = loadEngine();
    vi.setSystemTime(new Date('2026-09-16T03:00:00Z'));
    await e.run({ ...payload, tempResidentFrom: '14/09/2026', tempResidentTo: '14/09/2028' }, files);
    // Cổng báo "Thời hạn tạm trú không được nhỏ hơn ngày hiện tại" nếu đặt ngày đã qua.
    expect((document.getElementById('txtTEMP_RESIDENT_FROM') as HTMLInputElement).value).toBe('16/09/2026');
    expect((document.getElementById('txtTEMP_RESIDENT_TO') as HTMLInputElement).value).toBe('14/09/2028');
  });

  it('ngày bắt đầu từ hôm nay trở đi thì đặt, và đặt TRƯỚC ô hạn để không bị ghi đè', async () => {
    const e = loadEngine();
    vi.setSystemTime(new Date('2026-09-16T03:00:00Z'));
    await e.run({ ...payload, tempResidentFrom: '20/09/2026', tempResidentTo: '20/09/2028' }, files);
    expect((document.getElementById('txtTEMP_RESIDENT_FROM') as HTMLInputElement).value).toBe('20/09/2026');
    expect((document.getElementById('txtTEMP_RESIDENT_TO') as HTMLInputElement).value).toBe('20/09/2028');
  });

  it('báo đỏ nếu cổng không nhận một ô bắt buộc', async () => {
    const e = loadEngine();
    // Giả lập cổng khoá cứng ô CCCD: mọi giá trị đặt vào đều bị xoá.
    const cccd = document.getElementById('txtIDENTIFIER_NUMBER') as HTMLInputElement;
    cccd.addEventListener('change', () => { cccd.value = ''; });
    await expect(e.run(payload, files)).rejects.toThrow(/txtIDENTIFIER_NUMBER/);
  });

  it('phường không có trong danh sách thì dừng ở bước 1 với thông báo rõ', async () => {
    const e = loadEngine();
    const progress: { step: string; ok: boolean; message?: string }[] = [];
    await expect(e.run({ ...payload, receive: { provinceName: 'Thành phố Hồ Chí Minh', wardName: 'Phường Không Có' } }, files, (p) => progress.push(p)))
      .rejects.toThrow(/phường "Phường Không Có"/);
    expect(progress.at(-1)).toMatchObject({ ok: false });
    expect((document.getElementById('txtFULLNAME') as HTMLInputElement).value).toBe('');
  });

  it('thiếu ảnh CT01 thì báo và không thêm dòng chỗ ở hợp pháp', async () => {
    const e = loadEngine();
    await expect(e.run(payload, files.filter(f => f.kind !== 'CT01'))).rejects.toThrow(/Thiếu ảnh Tờ khai CT01/);
    expect(document.querySelectorAll('#tblGiayToDinhKem tbody tr')).toHaveLength(2);
  });
});
