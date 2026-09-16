// Content script trên trang CRM: chỉ đặt dấu hiệu "extension có mặt" lên <html>
// để CRM bật nút hoặc hiện hướng dẫn cài.
//
// Gói dữ liệu KHÔNG đi qua đây. Trang gửi thẳng cho extension bằng
// chrome.runtime.sendMessage(<id>, …) nhờ externally_connectable, nên không có
// tin nào phát quảng bá trên window cho script khác nghe được.
(() => {
  const version = chrome.runtime.getManifest().version;
  const mark = () => {
    document.documentElement.setAttribute('data-ihome-tamtru-ext', version);
    document.documentElement.setAttribute('data-ihome-tamtru-id', chrome.runtime.id);
  };
  mark();
  document.addEventListener('DOMContentLoaded', mark);

  // Tiếng gõ cửa từ background khi cổng vừa nhận hồ sơ. KHÔNG mang dữ liệu:
  // trang tự hỏi extension để lấy mã, nên tin giả trên window chỉ gây một lượt
  // hỏi thừa chứ không chèn được mã rác vào sổ.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'TAM_TRU_CO_KET_QUA') {
      window.postMessage({ type: 'IHOME_TAMTRU_CO_KET_QUA' }, location.origin);
    }
  });
})();
