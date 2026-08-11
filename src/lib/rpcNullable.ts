/**
 * Đặt TÊN cho một khoảng trống của bộ sinh kiểu Supabase, thay vì rắc cast lẻ.
 *
 * VẤN ĐỀ
 *   PostgreSQL phân biệt hai thứ mà TypeScript của Supabase gộp làm một:
 *     - tham số CÓ `DEFAULT`      → bộ sinh khai `p_x?: T`  (tức `T | undefined`)
 *     - tham số KHÔNG có `DEFAULT` → bộ sinh khai `p_x: T`   (bắt buộc, không null)
 *
 *   Nhưng một tham số BẮT BUỘC vẫn có thể NHẬN NULL — `p_room_id uuid` không có
 *   default nghĩa là "phải truyền", không phải "không được null". Với phiếu thu
 *   chi không gắn phòng thì `NULL` chính là giá trị đúng.
 *
 *   Bộ sinh không có cách nào diễn đạt "bắt buộc nhưng nhận null", nên mọi lời
 *   gọi hợp lệ kiểu đó đều đỏ dưới `strictNullChecks`. Đo 11/08/2026: 38 lỗi
 *   trên 13 file, tất cả cùng hình dạng này.
 *
 * VÌ SAO LÀ MỘT HÀM CHỨ KHÔNG PHẢI `as any` TẠI CHỖ
 *   Cả hai đều là ép kiểu. Khác nhau ở chỗ đọc lại:
 *     - `as any` rải rác thì không phân biệt được đâu là "giới hạn bộ sinh" và
 *       đâu là "ai đó lười"; và nó tắt luôn kiểm tra của mọi thứ khác trên dòng.
 *     - Hàm này chỉ nới ĐÚNG chiều null, giữ nguyên `T`, và grep một phát ra hết
 *       mọi chỗ đang dựa vào khoảng trống đó. Ngày nào bộ sinh diễn đạt được
 *       nullability, xoá hàm này là trình biên dịch chỉ ngay ra toàn bộ danh sách.
 *
 * KHÔNG dùng cho tham số CÓ `DEFAULT`: chỗ đó bỏ hẳn khoá (`undefined`) mới đúng,
 * và kiểu sinh ra đã cho phép sẵn.
 *
 * @example
 *   p_room_id: rpcNullable(input.room_id ?? null)
 */
export function rpcNullable<T>(giaTri: T | null | undefined): T {
  return giaTri as T;
}
