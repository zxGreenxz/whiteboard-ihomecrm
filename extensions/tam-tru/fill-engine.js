// Bộ điền form Đăng ký tạm trú (chạy ở MAIN world của trang cổng để dùng jQuery,
// select2 và FormUtil.setObjectToFormV2 của chính cổng). Không bấm Lưu nháp/Nộp.
// Giao tiếp với panel.js qua window.postMessage: IHOME_TAMTRU_RUN → PROGRESS/DONE.
(() => {
  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/^(thanh pho|tp\.?|tinh)\s+/, '').replace(/\s+/g, ' ').trim();

  const findOption = (select, text) => {
    const target = norm(text);
    const options = Array.from(select.options);
    return options.find((o) => norm(o.text) === target)
      || options.find((o) => norm(o.text).includes(target) && target.length >= 4);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(check, what, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = check();
      if (v) return v;
      await sleep(200);
    }
    throw new Error('Chờ quá lâu: ' + what);
  }

  const jq = () => window.jQuery || window.$;
  function fireChange(el) {
    const $ = jq();
    if ($) $(el).trigger('change'); else el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function byId(id, what) {
    const el = document.getElementById(id);
    if (!el) throw new Error('Không thấy ' + (what || id) + ' trên trang');
    return el;
  }
  function setSelect(id, value) { const el = byId(id); el.value = value; fireChange(el); }
  function setText(id, value) { const el = byId(id); el.value = value; fireChange(el); }
  function click(el, what) { if (!el) throw new Error('Không thấy ' + what); el.click(); }

  function dataUrlToFile(f) {
    const comma = f.dataUrl.indexOf(',');
    const meta = f.dataUrl.slice(0, comma);
    const b64 = f.dataUrl.slice(comma + 1);
    const mime = (/data:([^;]+)/.exec(meta) || [])[1] || f.type || 'image/jpeg';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name, { type: mime });
  }

  function attach(inputId, files) {
    const input = byId(inputId, 'ô chọn tệp ' + inputId);
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    // Trang đọc event.target.files trong changeFileNew(this) rồi mới cất vào mảng upload.
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function formObject(p) {
    return {
      FULLNAME: p.person.fullName,
      DATE_FORMAT: 'DDMMYYYY',
      DOB: p.person.dob,
      GENDER_CODE: p.person.genderCode,
      IDENTIFIER_NUMBER: p.person.idNumber,
      PHONE_NUMBER: p.person.phone || '',
      EMAIL: p.person.email || '',
      SUGGEST_ADDRESS: p.address,
      HH_PERSON_FULLNAME: p.person.fullName,
      HH_PERSON_RELATIONSHIP_CODE: p.household.relationshipCode,
      HH_PERSON_IDENTIFIER_NUMBER: p.person.idNumber,
      TEMP_RESIDENT_TO: p.tempResidentTo,
    };
  }

  function setObject(obj) {
    const FU = window.FormUtil;
    if (FU && typeof FU.setObjectToFormV2 === 'function') {
      FU.setObjectToFormV2('Modal_New_DKTT', '', obj);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      const cbo = document.getElementById('cbo' + k);
      const txt = document.getElementById('txt' + k);
      if (cbo) setSelect(cbo.id, v); else if (txt) setText(txt.id, v);
    }
  }

  // Ô ngày PHẢI đặt SAU cùng. setObjectToFormV2 đi theo thứ tự txt → cbo, mà khi
  // cboDATE_FORMAT đổi thì cổng gọi datePickerWithPattern() → `$('#txtDOB').val('')`,
  // tức là xoá trắng đúng ô vừa điền. Chính mã của cổng cũng gán lại txtDOB sau
  // khi gọi setObjectToFormV2 vì lý do này.
  // BẪY THỨ HAI (đo thật 16/09/2026): bootstrap-datepicker của cổng chỉ nghe keyup/paste,
  // KHÔNG nghe change. Đặt value bằng mã thì ô hiện đúng nhưng "ngày nội bộ" của
  // datepicker vẫn là giá trị cũ (rỗng ở txtDOB sau khi cổng xoá; mặc định +2 năm ở
  // txtTEMP_RESIDENT_TO). Người dùng bấm vào ô rồi bấm ra là hide() với forceParse ghi
  // ngày nội bộ đè lên ô: ngày sinh trắng, hạn tạm trú lùi về mặc định. Vì vậy sau khi
  // đặt value phải gọi datepicker('update') — đúng cách chính cổng làm
  // (`.val(x).datepicker("update")`). Trả về false nếu lịch của cổng từ chối ngày đó.
  function dongBoDatepicker(el) {
    const $ = jq();
    if (!$ || !$.fn || typeof $.fn.datepicker !== 'function') return null;
    const dp = $(el).data('datepicker');
    if (!dp) return null;
    $(el).datepicker('update');
    if (dp.dates && typeof dp.dates.length === 'number') return dp.dates.length > 0;
    return true;
  }

  const canhBaoNgay = [];
  function setNgay(id, giaTri) {
    if (!giaTri) return null;
    const el = document.getElementById(id);
    if (!el) return null;
    el.value = giaTri;
    fireChange(el);
    if (el.value !== giaTri) { // datepicker/inputmask từ chối: thử lại sau một nhịp
      el.value = giaTri;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      fireChange(el);
    }
    if (dongBoDatepicker(el) === false) canhBaoNgay.push(id + ' (lịch của cổng không nhận ' + giaTri + ')');
    return el.value;
  }

  /** dd/mm/yyyy còn ở hôm nay trở đi — cổng từ chối mọi ngày tạm trú đã qua. */
  function chuaQua(ngay) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(ngay || ''));
    if (!m) return false;
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    const homNay = new Date();
    homNay.setHours(0, 0, 0, 0);
    return d.getTime() >= homNay.getTime();
  }

  const filesOf = (files, kind) => files.filter((f) => f.kind === kind).map(dataUrlToFile);

  const STEPS = [
    ['Chọn tỉnh và phường nhận hồ sơ', async (p, report) => {
      const city = await waitFor(() => {
        const s = document.getElementById('cboRECEIVE_ADDR_CITY_CODE');
        return s && s.options.length > 1 ? s : null;
      }, 'danh sách tỉnh');
      const opt = findOption(city, p.receive.provinceName);
      if (!opt) throw new Error('Không thấy tỉnh "' + p.receive.provinceName + '" trên cổng');
      setSelect(city.id, opt.value);
      const ward = await waitFor(() => {
        const s = document.getElementById('cboRECEIVE_ADDR_VILLAGE_CODE');
        return s && s.options.length > 1 ? s : null;
      }, 'danh sách phường');
      const w = findOption(ward, p.receive.wardName);
      if (!w) throw new Error('Không thấy phường "' + p.receive.wardName + '" trong danh sách của cổng');
      setSelect(ward.id, w.value);
      const org = await waitFor(() => {
        const el = document.getElementById('txtRECEIVE_ORG_ADDRESS');
        return el && el.value ? el.value : null;
      }, 'cơ quan Công an phường');
      report('Cơ quan thực hiện: ' + org);
    }],
    ['Chọn thủ tục lập hộ mới, khai hộ', async () => {
      await waitFor(() => {
        const s = document.getElementById('cboBPROC_CASE_CODE');
        return s && s.options.length > 0 ? s : null;
      }, 'trường hợp thủ tục');
      const r1 = document.getElementById('chkNEW_REGISTRATION');
      if (r1 && !r1.checked) click(r1, 'lập hộ mới');
      const r2 = document.getElementById('chkIS_NOT_CHANGED_PERSON');
      if (r2 && !r2.checked) click(r2, 'khai hộ');
      await waitFor(() => document.getElementById('txtFULLNAME'), 'khối người đề nghị');
    }],
    ['Điền thông tin người tạm trú và địa chỉ', async (p, report) => {
      setObject(formObject(p));
      await sleep(300);
      const dob = setNgay('txtDOB', p.person.dob);
      // BẪY 1 — cổng CHẶN ngày bắt đầu ở quá khứ:
      //   if (from < new Date() || to < new Date()) → 'Thời hạn tạm trú không được
      //   nhỏ hơn ngày hiện tại'. Hợp đồng ở nhờ thường ký trước ngày nộp vài hôm,
      //   nên chỉ đặt ô này khi ngày ký còn ở hôm nay trở đi; đã qua thì để nguyên
      //   mặc định của cổng (hôm nay) — hạn ĐẾN mới là con số cán bộ đối chiếu.
      // BẪY 2 — đổi ô "từ ngày" thì cổng TỰ GHI ĐÈ ô "đến ngày" thành +2 năm
      //   (datePickerWithPattern → `$('#txtTEMP_RESIDENT_TO').val(mặc định)`).
      //   Vì vậy phải đặt "từ ngày" TRƯỚC rồi mới đặt "đến ngày".
      const tuNgay = chuaQua(p.tempResidentFrom) ? setNgay('txtTEMP_RESIDENT_FROM', p.tempResidentFrom) : null;
      const han = setNgay('txtTEMP_RESIDENT_TO', p.tempResidentTo);
      const note = document.getElementById('txtCHANGED_NOTE');
      if (note && !norm(note.value).includes(norm(p.address))) {
        setText('txtCHANGED_NOTE', 'Đăng ký tạm trú tại ' + p.address + ' - ' + p.receive.wardName + ' - ' + p.receive.provinceName);
      }
      // Kiểm lại từng ô bắt buộc: thà báo đỏ còn hơn để người dùng nộp thiếu.
      const thieu = [];
      const kiem = (id, mong) => {
        const el = document.getElementById(id);
        const co = el ? String(el.value || '').trim() : '';
        if (!el || (mong && co !== String(mong).trim())) thieu.push(id);
      };
      kiem('txtFULLNAME', p.person.fullName);
      kiem('txtDOB', p.person.dob);
      kiem('cboGENDER_CODE', p.person.genderCode);
      kiem('txtIDENTIFIER_NUMBER', p.person.idNumber);
      kiem('txtSUGGEST_ADDRESS', p.address);
      kiem('txtHH_PERSON_IDENTIFIER_NUMBER', p.person.idNumber);
      if (thieu.length) throw new Error('Cổng không nhận các ô: ' + thieu.join(', '));
      report('Ngày sinh ' + dob + ' · tạm trú ' + (tuNgay ? tuNgay + ' → ' : 'đến ') + han
        + (canhBaoNgay.length ? ' · CẦN KIỂM LẠI: ' + canhBaoNgay.splice(0).join('; ') : ''));
    }],
    ['Mở mục đính kèm "do thuê, mượn, ở nhờ"', async () => {
      const link = Array.from(document.querySelectorAll('a')).find((a) => {
        const href = a.getAttribute('href') || '';
        return /load_table_tphs_new\(2\)/.test(href) || /do thue, muon, o nho/.test(norm(a.textContent));
      });
      click(link, 'mục đính kèm "do thuê, mượn, ở nhờ"');
      await waitFor(() => document.querySelector('#tblGiayToDinhKem tbody tr'), 'bảng giấy tờ');
    }],
    ['Gắn ảnh CT01 và hợp đồng', async (p, report, files) => {
      const daGan = [];
      for (const [kind, nhan, i] of [['CT01', 'Tờ khai CT01', 0], ['LEASE', 'Hợp đồng', 1]]) {
        const picked = filesOf(files, kind);
        if (picked.length === 0) throw new Error('Thiếu ảnh ' + nhan);
        const chk = document.getElementById('chkIS_COMPULSORY' + i);
        if (chk && !chk.checked) chk.click();
        const type = document.getElementById('cboFILE_TYPE' + i);
        if (type && type.value !== '1') setSelect(type.id, '1');
        attach('fileUpload' + i, picked);
        daGan.push(nhan + ' ' + picked.map((f) => f.name).join(', '));
      }
      report(daGan.join(' · '));
    }],
    ['Thêm dòng giấy tờ chứng minh chỗ ở hợp pháp', async (p, report, files) => {
      const picked = filesOf(files, 'OWNERSHIP');
      if (picked.length === 0) throw new Error('Thiếu ảnh giấy tờ chỗ ở hợp pháp');
      const before = document.querySelectorAll('#tblGiayToDinhKem tbody tr').length;
      click(document.getElementById('btnDocument'), 'nút Thêm mới giấy tờ');
      await waitFor(() => document.querySelectorAll('#tblGiayToDinhKem tbody tr').length > before, 'dòng giấy tờ mới');
      const i = before;
      setText('lblFILE_TYPE_NAME' + i, 'Giấy tờ, tài liệu chứng minh chỗ ở hợp pháp');
      const chk = document.getElementById('chkIS_COMPULSORY' + i);
      if (chk && !chk.checked) chk.click();
      const type = document.getElementById('cboFILE_TYPE' + i);
      if (type && type.value !== '1') setSelect(type.id, '1');
      attach('fileUpload' + i, picked);
      report(picked.length + ' ảnh: ' + picked.map((f) => f.name).join(', '));
    }],
  ];

  async function run(payload, files, onProgress) {
    const progress = onProgress || (() => {});
    for (const [name, fn] of STEPS) {
      try {
        await fn(payload, (m) => progress({ step: name, ok: true, message: m, partial: true }), files || []);
        progress({ step: name, ok: true });
      } catch (e) {
        progress({ step: name, ok: false, message: String((e && e.message) || e) });
        throw e;
      }
    }
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { /* jsdom không hỗ trợ */ }
  }

  window.__ihomeTamTru = { run, norm, findOption, formObject, STEPS, dataUrlToFile };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.type !== 'IHOME_TAMTRU_RUN') return;
    run(ev.data.payload, ev.data.files || [], (progress) => {
      window.postMessage({ type: 'IHOME_TAMTRU_PROGRESS', ...progress }, location.origin);
    })
      .then(() => window.postMessage({ type: 'IHOME_TAMTRU_DONE', ok: true }, location.origin))
      .catch((e) => window.postMessage({ type: 'IHOME_TAMTRU_DONE', ok: false, message: String((e && e.message) || e) }, location.origin));
  });
})();
