// @vitest-environment jsdom
// Luồng XOÁ đăng ký tạm trú của extensions/tam-tru/fill-engine.js trên form giả lập theo
// đúng id/hành vi đo được trên cổng DVC ngày 07/10/2026. Luật của chủ: chỉ thao tác như
// người dùng (bấm, gõ, dán, chọn), không gọi hàm nội bộ của cổng, không đụng ô ẩn/khoá.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENGINE = readFileSync(resolve(process.cwd(), 'extensions/tam-tru/fill-engine.js'), 'utf8');

type Progress = { step: string; ok: boolean; message?: string; partial?: boolean };
interface Engine {
  run: (payload: unknown, files: unknown[], onProgress?: (p: Progress) => void) => Promise<void>;
  STEPS: [string, unknown][];
  STEPS_XOA: [string, unknown][];
}

const payload = {
  version: 2, procedure: 'TAMTRU_06', createdAt: 'x', customerId: 'c1', buildingName: '950NK', roomNumber: 'MADRID 4',
  receive: { provinceName: 'Thành phố Hồ Chí Minh', wardName: 'Phường Thông Tây Hội' },
  person: { fullName: 'Lê Quốc Duy', dob: '23/05/2006', genderCode: '2', idNumber: '072206008594', phone: '0919859134', email: '' },
  address: '950/65 Nguyễn Kiệm', household: { relationshipCode: 'CH01' }, caseCode: 'TAT-XOA-14', attachments: [],
};
const dataUrl = 'data:image/png;base64,' + btoa('anh');
const files = [
  { kind: 'CT01_XOA', name: 'lequocduyct01huy1.png', type: 'image/png', dataUrl },
  { kind: 'THANH_LY', name: 'lequocduythanhly1.png', type: 'image/png', dataUrl },
];

const opt = (v: string, t: string, sel = false) => `<option value="${v}"${sel ? ' selected' : ''}>${t}</option>`;
const byId = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
// BẪY ĐO THẬT: cổng lưu "Phường" ở dạng TÁCH DẤU (ơ U+01A1 + U+0300).
const PHUONG_TACH_DAU = 'Phường';

/** Bỏ dấu kiểu select2: chỉ bảng chữ DỰNG SẴN → chữ gốc; dấu tổ hợp rời giữ nguyên. */
const boDauSelect2 = (s: string) => Array.from(s).map((c) => { const d = c.normalize('NFD'); return d.length > 1 ? d[0] : c; })
  .join('').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase();

/** select2 rút gọn: giấu <select>, khung hiển thị, mousedown mở danh sách gắn vào body, ô tìm lọc
 * theo luật bỏ dấu của select2, nhả chuột (mouseup) lên mục thì chọn và phát change. */
function lamSelect2(sel: HTMLSelectElement, coTim: boolean, fx: { moSelect2: Record<string, number>; timDaGo: Record<string, string> }) {
  sel.classList.add('select2-hidden-accessible');
  const wrap = document.createElement('span');
  wrap.className = 'select2 select2-container select2-container--default';
  wrap.innerHTML = `<span class="selection"><span class="select2-selection select2-selection--single" role="combobox">`
    + `<span class="select2-selection__rendered" id="select2-${sel.id}-container"></span></span></span>`;
  sel.after(wrap);
  const rendered = wrap.querySelector('.select2-selection__rendered')!;
  const capNhat = () => { rendered.textContent = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : ''; };
  sel.addEventListener('change', capNhat);
  capNhat();
  let drop: HTMLElement | null = null;
  const dong = () => { drop?.remove(); drop = null; wrap.classList.remove('select2-container--open'); };
  const ve = (term: string) => {
    const ul = drop!.querySelector('ul')!;
    ul.innerHTML = '';
    const t = boDauSelect2(term);
    Array.from(sel.options).filter((o) => o.value !== '').forEach((o) => {
      if (t && !boDauSelect2(o.text).includes(t)) return;
      const li = document.createElement('li');
      li.className = 'select2-results__option';
      li.setAttribute('aria-selected', String(o.selected));
      li.textContent = o.text;
      li.addEventListener('mouseup', () => { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); dong(); });
      ul.appendChild(li);
    });
    if (!ul.children.length) ul.innerHTML = '<li class="select2-results__option select2-results__message">No results found</li>';
  };
  wrap.querySelector('.select2-selection')!.addEventListener('mousedown', (e) => {
    if ((e as MouseEvent).button !== 0) return;
    if (drop) { dong(); return; }
    fx.moSelect2[sel.id] = (fx.moSelect2[sel.id] ?? 0) + 1;
    drop = document.createElement('span');
    drop.className = 'select2-container select2-container--default select2-container--open';
    drop.innerHTML = `<span class="select2-dropdown">${coTim ? '<span class="select2-search"><input class="select2-search__field" type="search" /></span>' : ''}`
      + `<span class="select2-results"><ul class="select2-results__options" id="select2-${sel.id}-results"></ul></span></span>`;
    document.body.appendChild(drop);
    wrap.classList.add('select2-container--open');
    const tim = drop.querySelector('input');
    tim?.addEventListener('input', () => { fx.timDaGo[sel.id] = tim.value; ve(tim.value); });
    ve('');
  });
  document.addEventListener('mousedown', (e) => {
    if (drop && !drop.contains(e.target as Node) && !wrap.contains(e.target as Node)) dong();
  });
}

function mountFixture() {
  document.body.innerHTML = `
    <div id="Modal_New_DKTT">
      <select id="cboRECEIVE_ADDR_CITY_CODE">${opt('', 'Chọn')}${opt('01', 'Thành phố Hà Nội')}${opt('79', 'Thành phố Hồ Chí Minh')}</select>
      <select id="cboRECEIVE_ADDR_VILLAGE_CODE">${opt('', 'Chọn')}</select>
      <input id="txtRECEIVE_ORG_ADDRESS" disabled />
      <select id="cboBPROC_TYPE_CODE">${opt('', '-- Chọn thủ tục --')}${opt('TAMTRU_01', 'Đăng ký tạm trú')}${opt('TAMTRU_06', 'Xóa đăng ký tạm trú')}</select>
      <select id="cboBPROC_CASE_CODE"></select>
      <input type="radio" id="chkIS_REPORTER" name="radIsChangePerson" checked />
      <input type="radio" id="chkIS_NOT_CHANGED_PERSON" name="radIsChangePerson" />
      <div id="khoiNguoi" style="display:none">
        <input id="txtFULLNAME" />
        <select id="cboDATE_FORMAT">${opt('DDMMYYYY', 'Ngày tháng năm')}${opt('YYYY', 'Năm', true)}</select>
        <input id="txtDOB" />
        <select id="cboGENDER_CODE">${opt('', '')}${opt('2', 'Nam')}${opt('3', 'Nữ')}${opt('4', 'Khác')}</select>
        <input id="txtIDENTIFIER_NUMBER" maxlength="12" />
        <input id="txtPHONE_NUMBER" /><input id="txtEMAIL" />
        <span id="boxHHName"><input id="txtHH_PERSON_FULLNAME" /></span>
        <select id="cboHH_PERSON_RELATIONSHIP_CODE">${opt('', '')}${opt('09', 'Anh')}${opt('CH01', 'Chủ hộ')}</select>
        <span id="boxHHId"><input id="txtHH_PERSON_IDENTIFIER_NUMBER" /></span>
        <input type="hidden" id="txtCITIZEN_SECRET" value="" />
      </div>
      <table id="tblGiayToDinhKem"><tbody></tbody></table>
      <input type="file" id="FileUpload" />
      <input type="checkbox" id="chkCHECK_LIABILITY" />
      <button type="button" id="btn-save">Lưu nháp</button><button type="button" id="btn-save-send">Nộp hồ sơ</button>
    </div>`;
  const fx = {
    moSelect2: {} as Record<string, number>,
    timDaGo: {} as Record<string, string>,
    tempTotalFileArr: {} as Record<string, string[]>,
    napHoChuTaiKhoan: false,
    bamNut: [] as string[],
    thuTuFocus: [] as string[],
    dp: { dates: [] as string[], shown: false },
    setObjectToFormV2: vi.fn(),
    jq: Object.assign(vi.fn(), { fn: { datepicker: vi.fn() } }),
  };
  const city = byId<HTMLSelectElement>('cboRECEIVE_ADDR_CITY_CODE');
  const ward = byId<HTMLSelectElement>('cboRECEIVE_ADDR_VILLAGE_CODE');
  const type = byId<HTMLSelectElement>('cboBPROC_TYPE_CODE');
  const kase = byId<HTMLSelectElement>('cboBPROC_CASE_CODE');
  // Cổng thật: tỉnh, phường, trường hợp, giới tính, quan hệ là select2; thủ tục là <select> thường.
  lamSelect2(city, true, fx);
  lamSelect2(ward, true, fx);
  lamSelect2(kase, true, fx);
  lamSelect2(byId<HTMLSelectElement>('cboGENDER_CODE'), false, fx); // giới tính: không có ô tìm
  lamSelect2(byId<HTMLSelectElement>('cboHH_PERSON_RELATIONSHIP_CODE'), true, fx);

  city.addEventListener('change', () => {
    ward.innerHTML = city.value === '79'
      ? opt('', 'Chọn') + opt('26866', PHUONG_TACH_DAU + ' An Phú Đông') + opt('26898', PHUONG_TACH_DAU + ' Thông Tây Hội') + opt('26890', PHUONG_TACH_DAU + ' Hạnh Thông')
      : opt('', 'Chọn');
  });
  ward.addEventListener('change', () => {
    byId('txtRECEIVE_ORG_ADDRESS').value = ward.value === '26898' ? 'Công an Phường Thông Tây Hội' : '';
  });
  type.addEventListener('change', () => {
    kase.innerHTML = type.value === 'TAMTRU_06'
      ? opt('', '') + opt('TAT-XOA-13', 'Cá nhân do không còn chỗ ở hợp pháp') + opt('TAT-XOA-14', 'Cả hộ do không còn chỗ ở hợp pháp')
        + opt('TAT-XOA-15', 'Cá nhân do vắng mặt liên tục')
      : opt('TAT-DKTT-THUONG', 'Đăng ký tạm trú (nhân khẩu, hộ)');
  });
  kase.addEventListener('change', () => {
    // BẪY THẬT: người khai là CHÍNH CHỦ TÀI KHOẢN + TAT-XOA-14 → cổng nạp hộ của chủ tài khoản.
    if (byId('chkIS_REPORTER').checked && kase.value === 'TAT-XOA-14') fx.napHoChuTaiKhoan = true;
    byId('khoiNguoi').style.display = '';
    const tbody = document.querySelector('#tblGiayToDinhKem tbody')!;
    tbody.innerHTML = '';
    // Thứ tự dòng ĐẢO so với ghi chú đo thật: engine phải tìm dòng theo NHÃN chứ không theo chỉ số.
    tbody.appendChild(dongGiayTo(0, 'Giấy tờ chứng minh về việc không còn chỗ ở hợp pháp', '2'));
    tbody.appendChild(dongGiayTo(1, 'Tờ khai thay đổi thông tin cư trú', '1'));
  });
  // BẪY THẬT: đổi "định dạng ngày" thì cổng xoá trắng ô ngày sinh.
  byId<HTMLSelectElement>('cboDATE_FORMAT').addEventListener('change', () => { byId('txtDOB').value = ''; fx.dp.dates = []; });

  // Ô ngày: inputmask giành phím (phím giả không vào ô) + xoá ô chưa đủ ngày khi rời ô;
  // bootstrap-datepicker nhận ngày khi DÁN, đóng khi bấm ra ngoài và ghi ngày NỘI BỘ đè lên ô.
  const dob = byId('txtDOB');
  const duNgay = (v: string) => /^\d{2}\/\d{2}\/\d{4}$/.test(v);
  dob.addEventListener('keypress', (e) => e.preventDefault());
  dob.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = (e as ClipboardEvent).clipboardData!.getData('text/plain');
    if (duNgay(t)) { dob.value = t; fx.dp.dates = [t]; }
  });
  dob.addEventListener('keyup', () => { fx.dp.dates = duNgay(dob.value) ? [dob.value] : []; });
  dob.addEventListener('focus', () => { fx.dp.shown = true; });
  dob.addEventListener('blur', () => { if (!duNgay(dob.value)) dob.value = ''; });
  document.body.addEventListener('mousedown', (e) => {
    if (!dob.isConnected || !fx.dp.shown || e.target === dob) return;
    fx.dp.shown = false;
    if (dob.value) dob.value = fx.dp.dates.join('');
  });
  // Ô số định danh: setInputFilter của cổng trả lại giá trị cũ nếu có ký tự không phải số.
  for (const id of ['txtIDENTIFIER_NUMBER', 'txtHH_PERSON_IDENTIFIER_NUMBER']) {
    const el = byId(id);
    let cu = '';
    for (const ev of ['input', 'keydown', 'keyup']) el.addEventListener(ev, () => { if (/^\d*$/.test(el.value)) cu = el.value; else el.value = cu; });
  }
  document.addEventListener('focusin', (e) => { const t = e.target as HTMLElement; if (t.isConnected && t.tagName === 'INPUT') fx.thuTuFocus.push(t.id); });
  for (const id of ['btn-save', 'btn-save-send']) byId(id).addEventListener('click', () => fx.bamNut.push(id));

  function dongGiayTo(i: number, nhan: string, kieu: string) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i + 1}</td><td>${nhan}</td><td><input type="checkbox" id="chkIS_COMPULSORY${i}" /></td>`
      + `<td><select id="cboFILE_TYPE${i}">${opt('1', 'Bản gốc', kieu === '1')}${opt('2', 'Bản sao', kieu === '2')}</select></td>`
      + `<td class="f"></td>`;
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'fileUpload' + i;
    Object.defineProperty(input, 'files', { writable: true, value: [] });
    const ds = document.createElement('div');
    ds.id = 'file-contains' + i;
    // changeFileNew rút gọn: chỉ nhận pdf/jpg/jpeg/tiff/png, cất vào mảng upload, hiện tên ở dòng.
    input.addEventListener('change', (e) => {
      const fl = (e.target as unknown as { files: File[] }).files;
      if (!Array.from(fl).every((f) => /\.(pdf|jpe?g|tiff|png)$/i.test(f.name))) return;
      fx.tempTotalFileArr[i] = [...(fx.tempTotalFileArr[i] ?? []), ...Array.from(fl).map((f) => f.name)];
      ds.textContent = fx.tempTotalFileArr[i].join(', ');
    });
    tr.querySelector('td.f')!.append(input, ds);
    return tr;
  }

  (window as unknown as { FormUtil: unknown }).FormUtil = { setObjectToFormV2: fx.setObjectToFormV2 };
  (window as unknown as { jQuery: unknown; $: unknown }).jQuery = fx.jq;
  (window as unknown as { $: unknown }).$ = fx.jq;
  (window as unknown as { DataTransfer: unknown }).DataTransfer = class {
    _files: File[] = [];
    _data: Record<string, string> = {};
    items = { add: (f: File) => { this._files.push(f); } };
    get files() { return this._files; }
    setData(t: string, v: string) { this._data[t] = v; }
    getData(t: string) { return this._data[t] ?? ''; }
    get types() { return Object.keys(this._data); }
  };
  return fx;
}

function loadEngine(): Engine {
  new Function(ENGINE)();
  return (window as unknown as { __ihomeTamTru: Engine }).__ihomeTamTru;
}

/** Chạy engine với đồng hồ giả, đẩy thời gian từng nhịp cho tới khi xong (engine chờ bằng setTimeout). */
async function chay(p: Promise<void>): Promise<void> {
  let xong = false;
  p.then(() => { xong = true; }, () => { xong = true; });
  while (!xong) await vi.advanceTimersByTimeAsync(100);
  return p;
}

describe('fill-engine — xoá đăng ký tạm trú (TAMTRU_06)', () => {
  let fx: ReturnType<typeof mountFixture>;
  beforeEach(() => { vi.useFakeTimers(); fx = mountFixture(); });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { jQuery?: unknown }).jQuery;
    delete (window as unknown as { $?: unknown }).$;
  });

  it('điền đủ 4 bước chỉ bằng thao tác người dùng, ảnh vào đúng dòng theo nhãn, không đụng Nộp/cam kết', async () => {
    const e = loadEngine();
    const progress: Progress[] = [];
    await chay(e.run(payload, files, (p) => progress.push(p)));

    const val = (id: string) => byId(id).value;
    expect(val('cboRECEIVE_ADDR_CITY_CODE')).toBe('79');
    expect(val('cboRECEIVE_ADDR_VILLAGE_CODE')).toBe('26898');
    expect(val('txtRECEIVE_ORG_ADDRESS')).toBe('Công an Phường Thông Tây Hội');
    expect(val('cboBPROC_TYPE_CODE')).toBe('TAMTRU_06');
    expect(val('cboBPROC_CASE_CODE')).toBe('TAT-XOA-14');
    expect(byId('chkIS_NOT_CHANGED_PERSON').checked).toBe(true);
    expect(byId('chkIS_REPORTER').checked).toBe(false);
    // Khai hộ được chọn TRƯỚC trường hợp nên cổng không nạp hộ của chủ tài khoản.
    expect(fx.napHoChuTaiKhoan).toBe(false);

    expect(val('txtFULLNAME')).toBe('Lê Quốc Duy');
    expect(val('cboDATE_FORMAT')).toBe('DDMMYYYY');
    expect(val('txtDOB')).toBe('23/05/2006');
    expect(fx.dp.dates).toEqual(['23/05/2006']); // lịch tự nhận ngày từ lượt DÁN
    expect(val('cboGENDER_CODE')).toBe('2');
    expect(val('txtIDENTIFIER_NUMBER')).toBe('072206008594');
    expect(val('txtPHONE_NUMBER')).toBe('0919859134');
    expect(val('txtEMAIL')).toBe('');
    expect(val('txtHH_PERSON_FULLNAME')).toBe('Lê Quốc Duy');
    expect(val('cboHH_PERSON_RELATIONSHIP_CODE')).toBe('CH01');
    expect(val('txtHH_PERSON_IDENTIFIER_NUMBER')).toBe('072206008594');

    // Ngày sinh làm SAU CÙNG trong các ô chữ (đổi định dạng ngày xoá ô ngày sinh).
    const oChu = fx.thuTuFocus.filter((id) => id.startsWith('txt'));
    expect(oChu.at(-1)).toBe('txtDOB');

    // KHÔNG gọi hàm nội bộ của cổng; select2 được MỞ bằng chuột chứ không bị gán thẳng.
    expect(fx.setObjectToFormV2).not.toHaveBeenCalled();
    expect(fx.jq).not.toHaveBeenCalled();
    expect(fx.jq.fn.datepicker).not.toHaveBeenCalled();
    for (const id of ['cboRECEIVE_ADDR_CITY_CODE', 'cboRECEIVE_ADDR_VILLAGE_CODE', 'cboBPROC_CASE_CODE', 'cboGENDER_CODE', 'cboHH_PERSON_RELATIONSHIP_CODE']) {
      expect(fx.moSelect2[id], id).toBeGreaterThanOrEqual(1);
    }
    // Gõ chữ KHÔNG DẤU, bỏ tiền tố vào ô tìm (cổng lưu "Phường" tách dấu).
    expect(fx.timDaGo.cboRECEIVE_ADDR_VILLAGE_CODE).toBe('thong tay hoi');
    expect(fx.timDaGo.cboRECEIVE_ADDR_CITY_CODE).toBe('ho chi minh');
    expect(fx.timDaGo.cboHH_PERSON_RELATIONSHIP_CODE).toBe('chu ho');
    expect(progress.map((p) => p.message || '').join(' | ')).not.toContain('chọn thẳng ô');

    // Dòng 1 là "Tờ khai thay đổi thông tin cư trú", dòng 0 là "không còn chỗ ở hợp pháp".
    expect(fx.tempTotalFileArr).toEqual({ 1: ['lequocduyct01huy1.png'], 0: ['lequocduythanhly1.png'] });
    expect(byId('chkIS_COMPULSORY0').checked).toBe(true);
    expect(byId('chkIS_COMPULSORY1').checked).toBe(true);
    expect(val('cboFILE_TYPE0')).toBe('1');
    expect(val('cboFILE_TYPE1')).toBe('1');
    expect((byId('FileUpload') as HTMLInputElement).files?.length ?? 0).toBe(0); // #FileUpload ngoài bảng: không đụng

    expect(byId('chkCHECK_LIABILITY').checked).toBe(false);
    expect(fx.bamNut).toEqual([]);
    expect(progress.filter((p) => !p.partial).map((p) => [p.step, p.ok])).toEqual(e.STEPS_XOA.map(([n]) => [n, true]));
    const thongBao = progress.map((p) => p.message || '').join(' | ');
    expect(thongBao).toContain('lequocduyct01huy1.png');
    expect(thongBao).toContain('lequocduythanhly1.png');
    expect(thongBao).toContain('23/05/2006');
    expect(thongBao).not.toContain('CẦN KIỂM LẠI');
  });

  it('ô bị ẩn thì báo lỗi rõ và KHÔNG gán vào ô đó', async () => {
    const e = loadEngine();
    byId('boxHHId').style.display = 'none';
    await expect(chay(e.run(payload, files))).rejects.toThrow(/Số định danh chủ hộ đang ẩn hoặc bị khoá/);
    expect(byId('txtHH_PERSON_IDENTIFIER_NUMBER').value).toBe('');
    expect(byId('txtFULLNAME').value).toBe('Lê Quốc Duy'); // các ô khác vẫn điền
    expect(fx.tempTotalFileArr).toEqual({}); // dừng trước bước gắn ảnh
  });

  it('ô bị khoá thì báo lỗi rõ và KHÔNG gán vào ô đó', async () => {
    const e = loadEngine();
    byId('txtPHONE_NUMBER').disabled = true;
    await expect(chay(e.run(payload, files))).rejects.toThrow(/Số điện thoại đang ẩn hoặc bị khoá/);
    expect(byId('txtPHONE_NUMBER').value).toBe('');
  });

  it('cổng không nhận ngày sinh thì báo đỏ ô txtDOB', async () => {
    const e = loadEngine();
    // Giả lập lịch của cổng từ chối mọi lượt dán.
    byId('txtDOB').addEventListener('paste', (ev) => { ev.preventDefault(); ev.stopImmediatePropagation(); }, { capture: true });
    await expect(chay(e.run(payload, files))).rejects.toThrow(/Cổng không nhận các ô: txtDOB/);
  });

  it('thiếu ảnh biên bản thanh lý thì dừng, không gắn ảnh nào', async () => {
    const e = loadEngine();
    await expect(chay(e.run(payload, files.filter((f) => f.kind !== 'THANH_LY')))).rejects.toThrow(/Thiếu ảnh Biên bản thanh lý/);
    expect(fx.tempTotalFileArr).toEqual({});
  });

  it('thiếu ảnh tờ khai CT01 huỷ thì báo đúng tên', async () => {
    const e = loadEngine();
    await expect(chay(e.run(payload, files.filter((f) => f.kind !== 'CT01_XOA')))).rejects.toThrow(/Thiếu ảnh Tờ khai CT01 huỷ tạm trú/);
  });

  it('không thấy dòng giấy tờ theo nhãn thì báo rõ dòng nào', async () => {
    const e = loadEngine();
    byId<HTMLSelectElement>('cboBPROC_CASE_CODE').addEventListener('change', () => {
      document.querySelector('#tblGiayToDinhKem tbody tr')!.remove(); // mất dòng "không còn chỗ ở hợp pháp"
    });
    await expect(chay(e.run(payload, files))).rejects.toThrow(/Không thấy dòng giấy tờ cho "Biên bản thanh lý"/);
    expect(fx.tempTotalFileArr).toEqual({});
  });

  it('chỉ nhận trường hợp TAT-XOA-14', async () => {
    const e = loadEngine();
    await expect(chay(e.run({ ...payload, caseCode: 'TAT-XOA-13' }, files))).rejects.toThrow(/Chưa hỗ trợ trường hợp TAT-XOA-13/);
    expect(byId('cboBPROC_TYPE_CODE').value).toBe('');
  });

  it('gói đăng ký (version 1, không có procedure) vẫn đi các bước đăng ký cũ', async () => {
    const e = loadEngine();
    delete (window as unknown as { jQuery?: unknown }).jQuery;
    delete (window as unknown as { $?: unknown }).$;
    const progress: Progress[] = [];
    const v1 = { ...payload, version: 1, procedure: undefined, caseCode: undefined, tempResidentTo: '15/09/2028' };
    // Form giả lập là trang xoá nên luồng đăng ký dừng ở bước 2 — chỉ cần thấy đúng TÊN bước đăng ký.
    await chay(e.run(v1, files, (p) => progress.push(p))).catch(() => {});
    const buoc = [...new Set(progress.map((p) => p.step))];
    expect(buoc[0]).toBe(e.STEPS[0][0]);
    expect(buoc[1]).toBe(e.STEPS[1][0]);
    expect(buoc).not.toContain(e.STEPS_XOA[1][0]);
  });
});
