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
})();
