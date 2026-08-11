// Bỏ chú thích trước khi một gate quét văn bản.
//
// VÌ SAO CÓ FILE NÀY — bốn lần cùng một lỗi, trong bốn gate khác nhau
//
//   Một gate quét văn bản thô không phân biệt được MÃ với VĂN KỂ LẠI VỀ MÃ. Bốn
//   ca đã đo được trong repo này, và hướng gây hại của chúng khác nhau:
//
//   1. check-copilot-docs-manifest — `registry.includes('manifest.json')` xanh dù
//      xoá sạch code lọc, vì ba dòng comment có sẵn chữ đó. Gate KHÔNG KIỂM GÌ mà
//      vẫn báo xanh: hướng nguy hiểm nhất.
//   2. check-realtime-query-keys — bắt phải key nằm trong chú thích giải thích
//      rằng key đó đã chết. Gate đòi sửa đúng dòng vừa sửa xong.
//   3. check-known-gaps — bắt phải `::warning::` trong chú thích giải thích rằng
//      ở đây KHÔNG dùng `::warning::`. Đòi đăng ký khoảng trống cho một quyết
//      định ngược hẳn thứ nó vừa đọc.
//   4. check-workflow-paths — đếm script nằm trong shell comment `# node ...`,
//      rồi đòi khai nó vào `paths:`. Ép người ta thêm nhiễu vào bộ lọc.
//
//   Ba trong bốn ca là BÁO THỪA (phiền, nhưng nhìn thấy được). Ca đầu là BÁO
//   THIẾU — gate xanh trong khi không kiểm gì. Đó là lý do file này tồn tại thay
//   vì vá tại chỗ lần thứ năm.
//
// GIỚI HẠN, nói rõ để không ai dùng sai
//
//   Đây là phép cắt theo DÒNG và theo cặp dấu, không phải trình phân tích cú
//   pháp. Nó KHÔNG hiểu chuỗi ký tự: `const s = "// không phải comment"` sẽ bị
//   cắt sai. Chấp nhận được vì mục đích là SO SÁNH/DÒ trong gate, nơi mất một
//   dòng chuỗi hiếm gặp rẻ hơn nhiều so với một gate xanh giả. Đừng dùng nó để
//   biến đổi mã rồi ghi lại.

/** Bỏ dòng bắt đầu bằng `#` — đúng cho cả YAML lẫn shell (kể cả trong `run:`). */
export function boChuThichShell(vanBan) {
  return vanBan
    .split(/\r?\n/)
    .filter((d) => !/^\s*#/.test(d))
    .join('\n');
}

/** Bỏ `//` đầu dòng và mọi khối `/* … *​/`. */
export function boChuThichJs(vanBan) {
  return vanBan
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((d) => !/^\s*(\/\/|\*)/.test(d))
    .join('\n');
}

/** Bỏ `--` đầu dòng và mọi khối `/* … *​/` — dạng chú thích của SQL. */
export function boChuThichSql(vanBan) {
  return vanBan
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((d) => !/^\s*--/.test(d))
    .join('\n');
}
