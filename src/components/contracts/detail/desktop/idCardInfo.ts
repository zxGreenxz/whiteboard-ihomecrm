// Khối thông tin giấy tờ in NGAY TRÊN ảnh CCCD trong màn chi tiết hợp đồng.
//
// Vì sao cần: ảnh CCCD chụp bằng điện thoại thường nghiêng, loá hoặc mờ ở chữ
// nhỏ. Đặt sẵn phần đã nhập vào hệ thống ngay cạnh ảnh thì người xem đối chiếu
// được bằng mắt trong một nhịp, không phải căng mắt đọc ảnh rồi mở sang trang
// khách hàng để so.
//
// ĐỊA CHỈ — CHỖ DUY NHẤT DỄ SAI Ở ĐÂY:
// `customers.ward` / `district` / `province` lưu MÃ SỐ ('15133', '390', '38'),
// không phải tên. Ghép chúng lại rồi in ra là hiện một dãy số vô nghĩa cạnh ảnh
// giấy tờ. Đổi mã sang tên phải qua 3 query phụ thuộc nhau (useProvinces →
// useDistricts → useWards) — quá nặng cho một dòng chữ. Nên ở đây chỉ dùng
// chuỗi địa chỉ do người nhập gõ sẵn, theo thứ tự ưu tiên:
//   permanent_address (đúng nghĩa "nơi thường trú" trên CCCD)
//   → detailed_address (hầu như khách nào cũng có)
//   → current_residence

export interface KhachChoGiayTo {
  full_name?: string | null;
  id_number?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  id_issue_date?: string | null;
  id_issue_place?: string | null;
  permanent_address?: string | null;
  detailed_address?: string | null;
  current_residence?: string | null;
  ward?: string | null;
  district?: string | null;
  province?: string | null;
}

export interface MucGiayTo {
  nhan: string;
  gia: string;
}

const chu = (gt: unknown): string | null =>
  typeof gt === "string" && gt.trim() !== "" ? gt.trim() : null;

/** "1998-08-06" → "06/08/1998". Không đọc được thì trả nguyên văn. */
function ngayVn(gt: string | null | undefined): string | null {
  const s = chu(gt);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

export function thongTinGiayTo(khach: KhachChoGiayTo): MucGiayTo[] {
  const diaChi =
    chu(khach.permanent_address) ??
    chu(khach.detailed_address) ??
    chu(khach.current_residence);

  const muc: Array<[string, string | null]> = [
    ["Họ và tên", chu(khach.full_name)],
    ["Ngày sinh", ngayVn(khach.date_of_birth)],
    ["Giới tính", chu(khach.gender)],
    ["Số CCCD", chu(khach.id_number)],
    ["Ngày cấp", ngayVn(khach.id_issue_date)],
    ["Nơi cấp", chu(khach.id_issue_place)],
    ["Nơi thường trú", diaChi],
  ];

  // Mục trống thì bỏ HẲN. Hàng loạt ô "—" cạnh ảnh giấy tờ chỉ làm rối, trong
  // khi thiếu mục nào người xem nhìn ảnh là biết ngay.
  return muc
    .filter((m): m is [string, string] => m[1] !== null)
    .map(([nhan, gia]) => ({ nhan, gia }));
}
