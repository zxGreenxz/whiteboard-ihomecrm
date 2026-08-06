/**
 * Lọc phòng có thể chuyển tới trong hộp thoại Chuyển phòng.
 *
 * VÌ SAO TÁCH RA ĐÂY
 *   Logic này trước nằm inline trong TransferRoomDialog.tsx, còn test property
 *   (`contractRoomFilter.property.test.ts`) CHÉP TAY một bản riêng vào chính file
 *   test với chú thích "Replicates the exact logic from TransferRoomDialog.tsx".
 *   Hai bản đã lệch nhau:
 *     - Bản chép loại phòng hiện tại và coi lọc toà là TUỲ CHỌN.
 *     - Bản thật KHÔNG loại phòng hiện tại, và trả [] khi chưa chọn toà.
 *   Nên test xanh cho một bảo đảm mà code chạy thật không hề có. Một test chép
 *   lại implementation chỉ chứng minh bản chép tự nhất quán — nó không nói gì về
 *   thứ người dùng bấm vào.
 *
 *   Nay chỉ còn MỘT bản: component gọi hàm này, test import chính nó.
 */
export type PhongCoTheChuyen = {
  id: string;
  status: string;
  building_id: string;
};

/**
 * Trả danh sách phòng được phép chọn làm phòng đích.
 *
 * Hành vi giữ NGUYÊN như bản inline cũ, kể cả hai điểm dễ tưởng là thiếu sót:
 *
 * 1. Chưa chọn toà ⇒ trả mảng rỗng, KHÔNG phải "tất cả phòng". Hộp thoại bắt chọn
 *    toà trước; hiện toàn bộ phòng của mọi toà khi chưa chọn là mời người dùng
 *    chuyển nhầm sang toà khác.
 * 2. KHÔNG loại riêng phòng hiện tại. Phòng đang có hợp đồng hiệu lực mang trạng
 *    thái OCCUPIED nên đã bị lọc bởi điều kiện AVAILABLE. Thêm một lần loại theo
 *    id sẽ che mất trường hợp bất thường đáng thấy: nếu phòng hiện tại lại đang
 *    AVAILABLE thì dữ liệu đã sai ở chỗ khác, và giấu nó đi không sửa được gì.
 */
export function locPhongChuyenDuoc(
  tatCaPhong: PhongCoTheChuyen[],
  toaDangChon: string | null | undefined,
): PhongCoTheChuyen[] {
  if (!toaDangChon) return [];
  return tatCaPhong.filter(
    (p) => p.building_id === toaDangChon && p.status === "AVAILABLE",
  );
}
