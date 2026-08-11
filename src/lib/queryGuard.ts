/**
 * Biến bất biến của `enabled` thành một phép kiểm THẬT.
 *
 * VẤN ĐỀ
 *   React Query có `enabled: !!start && !!end`, nên khi `queryFn` chạy thì các
 *   giá trị đó chắc chắn có. Nhưng TypeScript KHÔNG đọc được `enabled` — nó chỉ
 *   thấy tham số hook khai `string | undefined`, còn tham số RPC lại bắt buộc.
 *
 * VÌ SAO KHÔNG DÙNG DẤU `!`
 *   `x!` nói với trình biên dịch "tin tôi" rồi im lặng. Nếu sau này ai đó sửa
 *   `enabled` mà quên chỗ gọi, `undefined` sẽ trôi xuống PostgREST và lỗi hiện
 *   ra là một thông báo khó truy về hàm không tìm thấy — cách xa nguyên nhân.
 *   Hàm này giữ đúng bất biến ấy nhưng nói thẳng tên trường bị thiếu.
 *
 * @example
 *   p_start_date: batBuoc(start, 'start')
 */
export function batBuoc<T>(giaTri: T | null | undefined, ten: string): T {
  if (giaTri === null || giaTri === undefined || giaTri === '') {
    throw new Error(`Thiếu ${ten} — lẽ ra 'enabled' đã chặn query này.`);
  }
  return giaTri;
}
