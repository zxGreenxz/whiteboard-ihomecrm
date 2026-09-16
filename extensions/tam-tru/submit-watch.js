// Nghe đúng một việc trên trang cổng: lúc người dùng bấm "Nộp hồ sơ", trang gọi
// service `add_subm_info_v2`, và MÃ HỒ SƠ đã nằm sẵn trong chính gói gửi đi
// (khoá SUBM_CODE), kèm `is_send: '1'` để phân biệt với Lưu nháp ('0').
//
// VÌ SAO ĐỌC REQUEST CHỨ KHÔNG ĐỌC MÀN HÌNH: sau khi nộp, cổng chuyển sang trang
// thanh toán Vietcombank rồi mới quay lại danh sách hồ sơ, nên bám vào giao diện
// là bám vào thứ dễ vỡ nhất. Gói request thì luôn đi qua đây, một lần, đúng lúc.
//
// Chạy ở MAIN world để vá được XMLHttpRequest của chính trang. Chỉ đọc; không sửa
// request, không chặn, không gửi gì lên mạng — mã hồ sơ đi tiếp qua window.postMessage
// cho panel.js (cùng origin) rồi về CRM.
(() => {
  if (window.__ihomeTamTruTheoDoiNop) return;
  window.__ihomeTamTruTheoDoiNop = true;

  const MA_HOP_LE = /^[A-Z0-9][A-Z0-9.\-/]{4,60}$/i;

  /** Bóc SUBM_CODE + vài mốc cần theo dõi từ thân request, trả null nếu không phải lượt NỘP. */
  function bocMaHoSo(body) {
    if (typeof body !== 'string' || body.indexOf('add_subm_info_v2') < 0) return null;
    let params;
    try {
      const raw = body.startsWith('params=') ? body.slice('params='.length) : body;
      params = JSON.parse(decodeURIComponent(raw.replace(/\+/g, ' ')));
    } catch (e) {
      return null;
    }
    if (params.service !== 'add_subm_info_v2') return null;
    let data = params.SUBM_DATA;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { data = null; }
    }
    // Lưu nháp cũng đi service này; chỉ lượt NỘP mới vào sổ.
    if (!data || String(data.is_send) !== '1') return null;
    let info = data.SUBM_INFO;
    if (typeof info === 'string') {
      try { info = JSON.parse(info); } catch (e) { info = null; }
    }
    const ma = String((info && info.SUBM_CODE) || params.SUBM_CODE || '').trim();
    if (!MA_HOP_LE.test(ma)) return null;
    return {
      submCode: ma,
      receiveOrg: String(data.RECEIVE_ORG_ADDRESS || params.ORG_NAME || '').slice(0, 200),
      tempResidentFrom: String(data.TEMP_RESIDENT_FROM || ''),
      tempResidentTo: String(data.TEMP_RESIDENT_TO || ''),
      submittedAt: new Date().toISOString(),
    };
  }

  function bao(ket) {
    window.postMessage({ type: 'IHOME_TAMTRU_DA_NOP', ...ket }, location.origin);
  }

  const moGoc = XMLHttpRequest.prototype.open;
  const guiGoc = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ihomeUrl = String(url || '');
    return moGoc.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (/rest_exec/.test(this.__ihomeUrl || '')) {
        const ket = bocMaHoSo(body);
        // Chỉ ghi nhận khi cổng trả lời xong và không lỗi: bấm Nộp mà rớt mạng
        // thì chưa có hồ sơ nào để theo dõi.
        if (ket) {
          this.addEventListener('load', () => {
            if (this.status >= 200 && this.status < 300 && !/MSG_CODE"\s*:\s*"(ERROR|FAIL)/i.test(this.responseText || '')) bao(ket);
          });
        }
      }
    } catch (e) { /* không được phép làm hỏng lượt gửi của cổng */ }
    return guiGoc.apply(this, arguments);
  };

  window.__ihomeTamTruBocMa = bocMaHoSo;
})();
