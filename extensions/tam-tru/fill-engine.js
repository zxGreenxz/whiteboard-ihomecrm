// Bộ điền form Đăng ký tạm trú / Xoá đăng ký tạm trú (chạy ở MAIN world của trang cổng).
// Đăng ký (STEPS) dùng jQuery, select2 và FormUtil.setObjectToFormV2 của chính cổng; xoá
// (STEPS_XOA) chỉ thao tác như người dùng. Không bấm Lưu nháp/Nộp/In, không tick ô cam kết.
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

  // ───────────────────────── Luồng XOÁ ĐĂNG KÝ TẠM TRÚ (TAMTRU_06) ─────────────────────────
  // LUẬT CỦA CHỦ DỰ ÁN (07/10/2026): luồng xoá "chỉ điền các ô nhập có sẵn trên trang, thao
  // tác như chính người dùng nhập liệu, không can thiệp vào trang". Vì vậy mọi bước dưới đây
  // KHÔNG gọi FormUtil.setObjectToFormV2, KHÔNG gọi jQuery/select2/datepicker hay hàm/biến nội
  // bộ nào của cổng, KHÔNG gán vào ô ẩn/khoá. Chỉ phát đúng chuỗi sự kiện chuột/bàn phím/dán
  // mà trình duyệt phát khi người dùng bấm, gõ, chọn — trang tự xử lý như với người thật. Ô nào
  // không hiện hoặc bị khoá thì báo lỗi để người dùng tự xem, KHÔNG lách vào.
  // Cách thao tác dưới đây là cách đã ĐO CHẠY ĐƯỢC trên trang xoá thật ngày 07/10/2026.
  // (Luồng đăng ký phía trên giữ nguyên cách cũ cho tới khi chủ quyết.)

  const TRUONG_HOP_XOA = 'TAT-XOA-14'; // chủ chốt: "Cả hộ do không còn chỗ ở hợp pháp", cố định

  /** Ô có hiện trên màn hình không (người dùng nhìn thấy và bấm được vào). */
  function hien(el) {
    if (!el || el.type === 'hidden' || el.hidden) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0;
    }
    // Môi trường không có bố cục (jsdom khi chạy test): soi display/visibility từng tầng cha.
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return false;
      const cs = window.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  }
  const dungDuoc = (el) => hien(el) && !el.matches(':disabled') && !el.readOnly;

  /** Chữ để GÕ vào ô tìm của select2: bỏ dấu, bỏ tiền tố hành chính.
   * BẪY ĐO THẬT 07/10: cổng lưu vài chữ ở dạng TÁCH DẤU ("Phường" = ơ + U+0300) còn bàn phím
   * gõ dạng dựng sẵn (ờ U+1EDD) → bộ lọc của select2 báo "No results found". Gõ không dấu và
   * bỏ tiền tố ("thong tay hoi", "ho chi minh", "chu ho") thì lọc ra đúng mục. */
  const chuGo = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(thanh pho|tp|tinh|phuong|xa|dac khu|thi tran)\s+/, '');

  /** Mã phím cũ (keyCode) như trình duyệt gán cho phím của ký tự đó trên bàn phím US. */
  function maPhim(ch) {
    if (/^[0-9]$/.test(ch)) return ch.charCodeAt(0);
    if (/^[a-z]$/i.test(ch)) return ch.toUpperCase().charCodeAt(0);
    return { ' ': 32, '/': 191, '.': 190, '-': 189, '_': 189, '@': 50 }[ch] || 229; // 229 = gõ qua bộ gõ (tiếng Việt)
  }

  /** Phát một sự kiện phím; trả false nếu trang chặn (preventDefault) như với phím thật. */
  function phim(el, type, key, code) {
    const init = { key, bubbles: true, cancelable: true, keyCode: code, which: code, charCode: type === 'keypress' ? code : 0 };
    const ev = new KeyboardEvent(type, init);
    // keyCode/which/charCode là thuộc tính cũ, có trình duyệt bỏ qua trong init: gán lại trên
    // chính sự kiện của mình (không đụng gì của trang) để thư viện đọc e.which thấy đúng phím.
    for (const k of ['keyCode', 'which', 'charCode']) {
      if (ev[k] !== init[k]) { try { Object.defineProperty(ev, k, { get: () => init[k] }); } catch (e) { /* bỏ qua */ } }
    }
    return el.dispatchEvent(ev);
  }

  function nhapVao(el, type, inputType, data) {
    const init = { bubbles: true, cancelable: type === 'beforeinput', inputType, data };
    return el.dispatchEvent(typeof InputEvent === 'function' ? new InputEvent(type, init) : new Event(type, init));
  }

  function chuot(el, type) {
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, button: 0, buttons: type === 'mousedown' ? 1 : 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    let ev;
    try { ev = new MouseEvent(type, { ...init, view: window }); } catch (e) { ev = new MouseEvent(type, init); } // jsdom từ chối view
    return el.dispatchEvent(ev);
  }

  // Đặt chữ bằng setter GỐC của trình duyệt, không qua `el.value = …`: thư viện mặt nạ nhập
  // (inputmask) vá lại thuộc tính value của từng ô; phím thật đi thẳng vào trình duyệt chứ
  // không đi qua bản vá đó, nên setter gốc mới đúng là "trình duyệt tự chèn chữ".
  function datGiaTri(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
  }

  /** Việc mặc định của trình duyệt khi phím/dán không bị trang chặn: chèn vào chỗ con trỏ. */
  function chenChu(el, chu) {
    const v = String(el.value || '');
    let s = v.length;
    let e = v.length;
    try { if (typeof el.selectionStart === 'number') { s = el.selectionStart; e = el.selectionEnd; } } catch (x) { /* ô email không có con trỏ */ }
    let them = chu;
    if (el.maxLength > 0) them = them.slice(0, Math.max(0, el.maxLength - (v.length - (e - s)))); // trình duyệt cũng cắt như vậy
    if (!them) return false;
    datGiaTri(el, v.slice(0, s) + them + v.slice(e));
    try { el.setSelectionRange(s + them.length, s + them.length); } catch (x) { /* như trên */ }
    return true;
  }

  // Gõ một ký tự đúng trình tự của trình duyệt: keydown → keypress → beforeinput → (chèn) →
  // input → keyup. Thư viện nào tự chặn phím rồi tự chèn chữ của nó thì ta KHÔNG chèn thêm,
  // đúng như trình duyệt. Trả true nếu chữ do "trình duyệt" (tức là ta) chèn.
  function goPhim(el, ch) {
    const ma = maPhim(ch);
    let chen = false;
    if (phim(el, 'keydown', ch, ma) && phim(el, 'keypress', ch, ch.charCodeAt(0)) && nhapVao(el, 'beforeinput', 'insertText', ch)) {
      chen = chenChu(el, ch);
      if (chen) nhapVao(el, 'input', 'insertText', ch);
    }
    phim(el, 'keyup', ch, ma);
    return chen;
  }

  /** Chọn hết rồi bấm Backspace, như người dùng xoá chữ cũ trước khi gõ. */
  function xoaHet(el) {
    try { el.select(); } catch (e) { /* bỏ qua */ }
    let xoa = false;
    if (phim(el, 'keydown', 'Backspace', 8) && nhapVao(el, 'beforeinput', 'deleteContentBackward', null)) {
      datGiaTri(el, '');
      nhapVao(el, 'input', 'deleteContentBackward', null);
      xoa = true;
    }
    phim(el, 'keyup', 'Backspace', 8);
    return xoa;
  }

  // focus()/blur() của trình duyệt không phát sự kiện khi cửa sổ không giữ tiêu điểm (tab nền
  // do CDP điều khiển). Khi đó tự phát focus/blur để trang thấy đúng như người dùng bấm vào ô.
  function lamFocus(el) {
    if (document.activeElement === el) return;
    let co = false;
    const nghe = () => { co = true; };
    el.addEventListener('focus', nghe);
    el.focus();
    el.removeEventListener('focus', nghe);
    if (!co) { el.dispatchEvent(new FocusEvent('focus')); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); }
  }
  function boFocus(el) {
    let co = false;
    const nghe = () => { co = true; };
    el.addEventListener('blur', nghe);
    el.blur();
    el.removeEventListener('blur', nghe);
    if (!co) { el.dispatchEvent(new FocusEvent('blur')); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); }
  }

  /** Bấm chuột vào ô (mousedown → focus → mouseup → click). */
  function vaoO(el) {
    chuot(el, 'mousedown');
    lamFocus(el);
    chuot(el, 'mouseup');
    chuot(el, 'click');
  }

  // Rời ô bằng cách bấm ra vùng trống của trang: mousedown ngoài ô → (change nếu trình duyệt
  // đã sửa chữ) → blur → mouseup. Lịch ngày của cổng cũng tự đóng khi bấm ra ngoài như vậy.
  function roiO(el, daSua) {
    chuot(document.body, 'mousedown');
    if (daSua) el.dispatchEvent(new Event('change', { bubbles: true }));
    boFocus(el);
    chuot(document.body, 'mouseup');
  }

  /** Gõ cả chuỗi vào một ô chữ như người dùng. Ô đã đúng thì để nguyên. */
  async function goNhuNguoi(el, text, what) {
    const muc = String(text == null ? '' : text);
    if (String(el.value || '') === muc) return;
    if (!dungDuoc(el)) throw new Error((what || el.id) + ' đang ẩn hoặc bị khoá trên trang');
    vaoO(el);
    let daSua = el.value ? xoaHet(el) : false;
    for (const ch of Array.from(muc)) daSua = goPhim(el, ch) || daSua;
    roiO(el, daSua);
    await sleep(120);
  }

  // DÁN thay vì gõ cho ô ngày. ĐO THẬT 07/10: ô ngày sinh có inputmask + bootstrap-datepicker
  // (forceParse); gõ phím giả lập thì inputmask không nhận và lúc rời ô xoá trắng ô. Người dùng
  // dán "23/05/2006" thì cả inputmask lẫn lịch đều tự xử lý sự kiện paste → ô giữ đúng ngày và
  // lịch có đúng một ngày nội bộ, không cần gọi hàm nào của lịch.
  async function danNhuNguoi(el, text, what) {
    const muc = String(text == null ? '' : text);
    if (String(el.value || '') === muc) return;
    if (!dungDuoc(el)) throw new Error((what || el.id) + ' đang ẩn hoặc bị khoá trên trang');
    vaoO(el);
    await sleep(150);
    try { if (el.value) el.select(); } catch (e) { /* dán đè lên phần đang chọn */ }
    const dt = new DataTransfer();
    dt.setData('text/plain', muc);
    let ev;
    try { ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }); } catch (e) { ev = null; }
    if (!ev) ev = new Event('paste', { bubbles: true, cancelable: true });
    if (ev.clipboardData !== dt) { try { Object.defineProperty(ev, 'clipboardData', { get: () => dt }); } catch (e) { /* bỏ qua */ } }
    let daSua = false;
    // Không ai chặn sự kiện dán thì trình duyệt tự chèn chữ vào ô.
    if (el.dispatchEvent(ev) && nhapVao(el, 'beforeinput', 'insertFromPaste', muc)) {
      daSua = chenChu(el, muc);
      if (daSua) nhapVao(el, 'input', 'insertFromPaste', muc);
    }
    await sleep(300);
    roiO(el, daSua);
    await sleep(300);
  }

  /** Khung hiển thị select2 bọc một <select> (select2 giấu <select> gốc khỏi màn hình). */
  function khungSelect2(sel) {
    const sau = sel.nextElementSibling;
    if (sau && sau.classList.contains('select2-container')) return sau.querySelector('.select2-selection');
    const r = document.getElementById('select2-' + sel.id + '-container');
    return (r && r.closest('.select2-selection')) || null;
  }

  function dongSelect2() {
    // Còn danh sách select2 nào mở từ lần trước: bấm Escape ở ô tìm, rồi bấm ra ngoài — như người dùng.
    const tim = document.querySelector('.select2-container--open .select2-search__field');
    if (tim) phim(tim, 'keydown', 'Escape', 27);
    if (document.querySelector('.select2-container--open')) { chuot(document.body, 'mousedown'); chuot(document.body, 'mouseup'); }
  }

  /** Mở danh sách select2, gõ chữ không dấu vào ô tìm (nếu có) rồi nhả chuột lên đúng mục. */
  async function chonQuaSelect2(sel, khung, opt) {
    // Chỉ tin danh sách đang MỞ (select2 có bản tháo khỏi trang khi đóng, có bản giữ lại).
    const ds = () => {
      const ul = document.getElementById('select2-' + sel.id + '-results');
      if (ul && ul.closest('.select2-container--open')) return ul;
      return document.querySelector('.select2-container--open .select2-results__options');
    };
    const mucKhop = () => {
      const ul = ds();
      if (!ul) return null;
      return Array.from(ul.querySelectorAll('.select2-results__option')).find((li) =>
        li.getAttribute('aria-disabled') !== 'true' && norm(li.textContent) === norm(opt.text)) || null;
    };
    chuot(khung, 'mousedown'); // select2 mở danh sách khi bấm (mousedown) vào khung
    chuot(khung, 'mouseup');
    try { await waitFor(ds, 'danh sách chọn', 3000); } catch (e) { return false; }
    const tim = document.querySelector('.select2-container--open .select2-search__field');
    let li = null;
    if (tim && hien(tim)) {
      for (const ch of Array.from(chuGo(opt.text))) goPhim(tim, ch);
      try { li = await waitFor(mucKhop, 'mục khớp', 2000); } catch (e) { li = null; }
      if (!li) { // gõ không ra (chữ tách dấu kiểu khác): xoá ô tìm, tìm trong cả danh sách
        xoaHet(tim);
        try { li = await waitFor(mucKhop, 'mục khớp', 2000); } catch (e) { li = null; }
      }
    } else {
      try { li = await waitFor(mucKhop, 'mục khớp', 2000); } catch (e) { li = null; }
    }
    if (!li) return false;
    try { li.scrollIntoView({ block: 'nearest' }); } catch (e) { /* jsdom */ }
    // Rê chuột vào mục (select2 tô sáng) rồi bấm; select2 chọn ở mouseup, tự đặt <select> và phát change.
    chuot(li, 'mouseenter');
    chuot(li, 'mouseover');
    chuot(li, 'mousemove');
    chuot(li, 'mousedown');
    chuot(li, 'mouseup');
    try { await waitFor(() => sel.value === opt.value, 'giá trị sau khi chọn', 2000); } catch (e) { return false; }
    await sleep(250);
    return true;
  }

  /** Chọn một mục (theo value) của ô chọn như người dùng chọn trong danh sách thả xuống. */
  async function chonO(sel, value, what) {
    const ten = what || sel.id;
    if (sel.value === value) return;
    const opt = Array.from(sel.options).find((o) => o.value === value);
    if (!opt) throw new Error('Không có lựa chọn "' + value + '" ở ' + ten);
    if (sel.matches(':disabled')) throw new Error(ten + ' đang bị khoá trên trang');
    const khung = khungSelect2(sel);
    if (khung) {
      if (!hien(khung)) throw new Error(ten + ' không hiện trên trang');
      // <select> gốc đã bị select2 giấu khỏi màn hình: CHỈ chọn qua danh sách hiện ra (gõ không
      // dấu vào ô tìm, rồi duyệt cả danh sách). Không chọn được thì dừng để người dùng chọn tay —
      // TUYỆT ĐỐI không gán thẳng vào <select> ẩn (luật của chủ: không gán vào ô ẩn).
      if (await chonQuaSelect2(sel, khung, opt)) return;
      dongSelect2();
      throw new Error('Không chọn được "' + opt.text.normalize('NFC') + '" trong ô ' + ten.replace(/^Ô\s+/, '')
        + '; hãy chọn tay rồi bấm Điền lại');
    }
    if (!hien(sel)) throw new Error(ten + ' không hiện trên trang');
    // <select> THƯỜNG đang hiện trên trang (vd ô Thủ tục khi mở URL trơn) — không phải ô ẩn:
    // người dùng bấm vào ô, chọn trong danh sách của chính trình duyệt (trình duyệt đặt value
    // rồi phát input + change), rồi rời ô. Ta làm đúng chuỗi đó.
    vaoO(sel);
    sel.value = value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    boFocus(sel);
    if (sel.value !== value) throw new Error('Cổng không nhận lựa chọn "' + opt.text + '" ở ' + ten);
    await sleep(200);
  }

  /** Bấm một radio/checkbox như người dùng; ô bị giấu sau nhãn thì bấm vào nhãn. */
  function bamO(el, what) {
    if (dungDuoc(el)) { el.click(); return; }
    const nhan = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
    if (nhan && hien(nhan) && !el.matches(':disabled')) { nhan.click(); return; }
    throw new Error(what + ' đang ẩn hoặc bị khoá trên trang');
  }

  const coLuaChon = (id, value) => {
    const s = document.getElementById(id);
    return s && Array.from(s.options).some((o) => o.value === value) ? s : null;
  };
  const chuChon = (s) => (s && s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : '');

  // Hai dòng giấy tờ CÓ SẴN trên trang xoá (không phải bấm link chọn trường hợp như đăng ký).
  // Tìm theo NHÃN chữ chứ không theo chỉ số: cổng đổi thứ tự dòng là ảnh vẫn vào đúng chỗ.
  const DONG_XOA = [
    ['CT01_XOA', 'Tờ khai CT01 huỷ tạm trú', 'to khai thay doi thong tin cu tru'],
    ['THANH_LY', 'Biên bản thanh lý', 'khong con cho o hop phap'],
  ];

  const STEPS_XOA = [
    ['Chọn tỉnh và phường nhận hồ sơ', async (p, report) => {
      dongSelect2();
      const city = await waitFor(() => {
        const s = document.getElementById('cboRECEIVE_ADDR_CITY_CODE');
        return s && s.options.length > 1 ? s : null;
      }, 'danh sách tỉnh');
      const opt = findOption(city, p.receive.provinceName);
      if (!opt) throw new Error('Không thấy tỉnh "' + p.receive.provinceName + '" trên cổng');
      await chonO(city, opt.value, 'Ô tỉnh nhận hồ sơ');
      const ward = await waitFor(() => {
        const s = document.getElementById('cboRECEIVE_ADDR_VILLAGE_CODE');
        return s && s.options.length > 1 ? s : null;
      }, 'danh sách phường');
      const w = findOption(ward, p.receive.wardName);
      if (!w) throw new Error('Không thấy phường "' + p.receive.wardName + '" trong danh sách của cổng');
      await chonO(ward, w.value, 'Ô phường nhận hồ sơ');
      const org = await waitFor(() => {
        const el = document.getElementById('txtRECEIVE_ORG_ADDRESS');
        return el && el.value ? el.value : null;
      }, 'cơ quan Công an phường');
      report('Cơ quan thực hiện: ' + org);
    }],
    ['Chọn thủ tục xoá đăng ký tạm trú, cả hộ, khai hộ', async (p, report) => {
      const truongHop = p.caseCode || TRUONG_HOP_XOA;
      if (truongHop !== TRUONG_HOP_XOA) throw new Error('Chưa hỗ trợ trường hợp ' + truongHop);
      const loai = await waitFor(() => coLuaChon('cboBPROC_TYPE_CODE', 'TAMTRU_06'), 'thủ tục Xóa đăng ký tạm trú');
      await chonO(loai, 'TAMTRU_06', 'Ô thủ tục');
      // Khai hộ TRƯỚC khi chọn trường hợp nếu radio đã hiện: khi "người khai là chính chủ tài
      // khoản" đang được chọn, đổi sang TAT-XOA-14 làm cổng tự nạp hộ tạm trú của CHỦ TÀI KHOẢN.
      const r = document.getElementById('chkIS_NOT_CHANGED_PERSON');
      if (r && !r.checked && dungDuoc(r)) { r.click(); await sleep(200); }
      const th = await waitFor(() => coLuaChon('cboBPROC_CASE_CODE', truongHop), 'trường hợp ' + truongHop);
      await chonO(th, truongHop, 'Ô trường hợp');
      const khaiHo = await waitFor(() => {
        const x = document.getElementById('chkIS_NOT_CHANGED_PERSON');
        return x && (x.checked || hien(x) || hien(document.querySelector('label[for="chkIS_NOT_CHANGED_PERSON"]'))) ? x : null;
      }, 'lựa chọn khai hộ');
      if (!khaiHo.checked) { bamO(khaiHo, 'Lựa chọn khai hộ'); await sleep(200); }
      if (!khaiHo.checked) throw new Error('Cổng không nhận lựa chọn khai hộ');
      await waitFor(() => hien(document.getElementById('txtFULLNAME')), 'khối người đề nghị');
      report(chuChon(loai) + ' · ' + chuChon(th) + ' · khai hộ');
    }],
    ['Điền thông tin người đề nghị xoá', async (p, report) => {
      const ng = p.person;
      // Ngày sinh làm SAU CÙNG: đổi "định dạng ngày" thì cổng xoá trắng ô ngày sinh (bẫy 1 ở
      // luồng đăng ký), và vài ô khác cũng có handler change đụng tới khối người đề nghị.
      const viec = [
        ['txtFULLNAME', ng.fullName, 'Họ tên', goNhuNguoi],
        ['cboDATE_FORMAT', 'DDMMYYYY', 'Định dạng ngày sinh', chonO],
        ['cboGENDER_CODE', ng.genderCode, 'Giới tính', chonO],
        ['txtIDENTIFIER_NUMBER', ng.idNumber, 'Số định danh', goNhuNguoi],
        ['txtPHONE_NUMBER', ng.phone || '', 'Số điện thoại', goNhuNguoi],
        ['txtEMAIL', ng.email || '', 'Email', goNhuNguoi],
        ['txtHH_PERSON_FULLNAME', ng.fullName, 'Họ tên chủ hộ', goNhuNguoi],
        ['cboHH_PERSON_RELATIONSHIP_CODE', p.household.relationshipCode, 'Quan hệ với chủ hộ', chonO],
        ['txtHH_PERSON_IDENTIFIER_NUMBER', ng.idNumber, 'Số định danh chủ hộ', goNhuNguoi],
        ['txtDOB', ng.dob, 'Ngày sinh', danNhuNguoi],
      ];
      const khongDien = [];
      for (const [id, v, nhan, lam] of viec) {
        const el = document.getElementById(id);
        if (!el) { if (v) khongDien.push(nhan + ' (không có trên trang)'); continue; }
        try { await lam(el, v, nhan); } catch (e) { khongDien.push(String((e && e.message) || e)); }
      }
      await sleep(400); // để handler change/blur của cổng chạy xong rồi mới đọc lại
      // Đọc lại từng ô: thà báo đỏ còn hơn để người dùng nộp thiếu.
      const thieu = [];
      const kiem = (id, mong) => {
        const el = document.getElementById(id);
        if (!el || String(el.value || '').trim() !== String(mong || '').trim()) thieu.push(id);
      };
      kiem('txtFULLNAME', ng.fullName);
      kiem('txtDOB', ng.dob);
      kiem('cboGENDER_CODE', ng.genderCode);
      kiem('txtIDENTIFIER_NUMBER', ng.idNumber);
      if (ng.phone) kiem('txtPHONE_NUMBER', ng.phone);
      kiem('txtHH_PERSON_FULLNAME', ng.fullName);
      kiem('cboHH_PERSON_RELATIONSHIP_CODE', p.household.relationshipCode);
      kiem('txtHH_PERSON_IDENTIFIER_NUMBER', ng.idNumber);
      if (khongDien.length) throw new Error('Không điền được: ' + khongDien.join('; '));
      if (thieu.length) throw new Error('Cổng không nhận các ô: ' + thieu.join(', '));
      report('Ngày sinh ' + document.getElementById('txtDOB').value + ' · chủ hộ '
        + chuChon(document.getElementById('cboHH_PERSON_RELATIONSHIP_CODE')));
    }],
    ['Gắn tờ khai CT01 huỷ và biên bản thanh lý', async (p, report, files) => {
      const can = DONG_XOA.map(([kind, nhan, mau]) => ({ kind, nhan, mau, picked: filesOf(files, kind) }));
      const thieuAnh = can.filter((c) => c.picked.length === 0).map((c) => c.nhan);
      if (thieuAnh.length) throw new Error('Thiếu ảnh ' + thieuAnh.join(', '));
      const dongCua = (mau) => Array.from(document.querySelectorAll('#tblGiayToDinhKem tbody tr'))
        .find((tr) => norm(tr.textContent).includes(mau)) || null;
      try {
        await waitFor(() => can.every((c) => dongCua(c.mau)), 'bảng giấy tờ đính kèm');
      } catch (e) {
        const vang = can.filter((c) => !dongCua(c.mau)).map((c) => '"' + c.nhan + '"');
        throw new Error('Không thấy dòng giấy tờ cho ' + vang.join(', ') + ' trong bảng đính kèm của cổng');
      }
      const daGan = [];
      const canhBao = [];
      for (const c of can) {
        const tr = dongCua(c.mau);
        if (!hien(tr)) throw new Error('Dòng giấy tờ cho ' + c.nhan + ' đang ẩn trên trang');
        // Chỉ ô chọn tệp NẰM TRONG dòng (fileUpload{i}); cổng còn một #FileUpload khác ngoài bảng.
        const input = tr.querySelector('input[type="file"][id^="fileUpload"]');
        if (!input || input.disabled) throw new Error('Không có ô chọn tệp dùng được ở dòng cho ' + c.nhan);
        const i = input.id.slice('fileUpload'.length);
        const chk = document.getElementById('chkIS_COMPULSORY' + i);
        if (chk && !chk.checked) {
          if (dungDuoc(chk)) chk.click(); else canhBao.push('ô đánh dấu dòng ' + c.nhan + ' bị khoá');
        }
        const kieu = document.getElementById('cboFILE_TYPE' + i);
        if (kieu && kieu.value !== '1') await chonO(kieu, '1', 'Loại bản (dòng ' + c.nhan + ')');
        // Người dùng bấm "Chọn tệp" là mở hộp thoại của chính ô này. Gán tệp vào ô + change là
        // việc duy nhất content script làm được thay hộp thoại đó — trang tự đọc tệp trong
        // handler changeFileNew như khi người dùng chọn (và tự từ chối tệp sai định dạng).
        attach(input.id, c.picked);
        daGan.push(c.nhan + ' ' + c.picked.map((f) => f.name).join(', '));
      }
      await sleep(300);
      for (const c of can) {
        const tr = dongCua(c.mau);
        const chuaHien = c.picked.filter((f) => !(tr && tr.textContent.includes(f.name)));
        if (chuaHien.length) canhBao.push('chưa thấy ' + chuaHien.map((f) => f.name).join(', ') + ' hiện ở dòng ' + c.nhan);
      }
      report(daGan.join(' · ') + (canhBao.length ? ' · CẦN KIỂM LẠI: ' + canhBao.join('; ') : ''));
    }],
  ];

  async function run(payload, files, onProgress) {
    const progress = onProgress || (() => {});
    const steps = payload && payload.procedure === 'TAMTRU_06' ? STEPS_XOA : STEPS;
    for (const [name, fn] of steps) {
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

  window.__ihomeTamTru = { run, norm, findOption, formObject, STEPS, STEPS_XOA, dataUrlToFile, hien };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.type !== 'IHOME_TAMTRU_RUN') return;
    run(ev.data.payload, ev.data.files || [], (progress) => {
      window.postMessage({ type: 'IHOME_TAMTRU_PROGRESS', ...progress }, location.origin);
    })
      .then(() => window.postMessage({ type: 'IHOME_TAMTRU_DONE', ok: true }, location.origin))
      .catch((e) => window.postMessage({ type: 'IHOME_TAMTRU_DONE', ok: false, message: String((e && e.message) || e) }, location.origin));
  });
})();
