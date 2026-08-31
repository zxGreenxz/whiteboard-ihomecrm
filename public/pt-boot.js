/*
 * Bắt lỗi SỚM cho trang công khai "Phòng trống" (/phongtrong và /r/:token).
 *
 * VÌ SAO PHẢI CÓ FILE NÀY
 *   Bộ đo đếm của trang nằm trong bundle React và chỉ gắn được listener sau khi
 *   chunk lazy tải xong rồi component mount — trên 4G là muộn khoảng 0,5–3 giây
 *   kể từ lúc tài liệu bắt đầu tải. Toàn bộ lỗi trong quãng đó rơi vào khoảng
 *   mù. Đó đúng là quãng mà trình duyệt in-app (Zalo, Facebook…) tiêm script
 *   cầu nối của nó vào trang, nên nhật ký lỗi trước đây vừa mỏng vừa lệch:
 *   chỉ thấy phần đuôi của những lỗi tình cờ nổ muộn.
 *
 *   File này chạy ở thẻ <script> ĐẦU TIÊN của <head>, gắn listener ngay, và xếp
 *   hàng những gì bắt được. Khi tracker khởi động, nó rút hàng đợi rồi cắm hàm
 *   `hook` để nhận trực tiếp — từ đó chỉ còn MỘT đường dẫn, không ghi đúp.
 *
 * NGUYÊN TẮC
 *   - Không phụ thuộc gì, ES5, không bao giờ ném (mọi thân hàm bọc try/catch):
 *     một bộ ghi lỗi mà tự làm hỏng trang thì tệ hơn không có.
 *   - Không gọi mạng. Việc gửi là của tracker, nơi đã có token và phiên.
 *   - Giữ 50 bản ghi ĐẦU TIÊN, không phải 50 bản mới nhất: lỗi sớm là thứ đang
 *     thiếu, và một vòng lặp lỗi vô hạn không được phép đẩy chúng ra ngoài.
 *   - Chỉ chạy trên đường dẫn công khai. Phần còn lại của CRM không đụng tới.
 */
(function () {
  try {
    // React Router bỏ qua dấu "/" cuối và không phân biệt hoa thường, còn so
    // chuỗi thô thì có. Lệch nhau ở đây nghĩa là trang VẪN chạy mà file này đã
    // thoát — mất đúng khoảng mù 0,5–3 giây mà nó sinh ra để bịt, và không có
    // tín hiệu nào cho biết.
    var p = String(location.pathname || '').toLowerCase().replace(/\/+$/, '') || '/';
    if (p !== '/phongtrong' && p.indexOf('/r/') !== 0) return;
  } catch (e) {
    return;
  }

  var MAX = 50;
  var bag = window.__ptErr;
  if (!bag || typeof bag !== 'object') {
    bag = { q: [], hook: null };
    window.__ptErr = bag;
  }

  function push(rec) {
    try {
      if (typeof bag.hook === 'function') {
        bag.hook(rec);
        return;
      }
      if (bag.q.length < MAX) bag.q.push(rec);
    } catch (e) {
      /* hook của tracker hỏng thì cũng không được kéo theo trang */
    }
  }

  function stamp(rec) {
    try {
      rec.ts = Date.now();
    } catch (e) {
      /* đồng hồ hỏng: bỏ mốc thời gian, phần còn lại vẫn dùng được */
    }
    return rec;
  }

  // capture = true: tài nguyên hỏng (<img>, <script>, <link>) KHÔNG nổi bọt nên
  // listener thường không bao giờ thấy chúng.
  window.addEventListener(
    'error',
    function (ev) {
      try {
        var t = ev && ev.target;
        if (t && t !== window && t.tagName) {
          push(
            stamp({
              k: 'resource',
              msg: 'resource load failed: ' + String(t.tagName),
              src: String(t.src || t.href || '').slice(0, 300),
            }),
          );
          return;
        }
        push(
          stamp({
            k: 'js',
            msg: String((ev && ev.message) || 'unknown error').slice(0, 500),
            src: String((ev && ev.filename) || '').slice(0, 300),
            line: ev && typeof ev.lineno === 'number' ? ev.lineno : undefined,
            col: ev && typeof ev.colno === 'number' ? ev.colno : undefined,
            stack: ev && ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 2000) : undefined,
          }),
        );
      } catch (e) {
        /* không có gì để cứu vãn ở đây; im lặng là đúng */
      }
    },
    true,
  );

  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var r = ev ? ev.reason : null;
      push(
        stamp({
          k: 'unhandledrejection',
          msg: String(r).slice(0, 500),
          stack: r && r.stack ? String(r.stack).slice(0, 2000) : undefined,
        }),
      );
    } catch (e) {
      /* như trên */
    }
  });
})();
