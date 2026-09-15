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
    ['Điền thông tin người tạm trú và địa chỉ', async (p) => {
      setObject(formObject(p));
      await sleep(300);
      const note = document.getElementById('txtCHANGED_NOTE');
      if (note && !norm(note.value).includes(norm(p.address))) {
        setText('txtCHANGED_NOTE', 'Đăng ký tạm trú tại ' + p.address + ' - ' + p.receive.wardName + ' - ' + p.receive.provinceName);
      }
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
      for (const [kind, i] of [['CT01', 0], ['LEASE', 1]]) {
        const picked = filesOf(files, kind);
        if (picked.length === 0) throw new Error('Thiếu ảnh ' + kind);
        const chk = document.getElementById('chkIS_COMPULSORY' + i);
        if (chk && !chk.checked) chk.click();
        const type = document.getElementById('cboFILE_TYPE' + i);
        if (type && type.value !== '1') setSelect(type.id, '1');
        attach('fileUpload' + i, picked);
        report(kind + ': ' + picked.length + ' ảnh');
      }
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
      report('Chỗ ở hợp pháp: ' + picked.length + ' ảnh');
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
