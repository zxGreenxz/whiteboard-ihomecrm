// Dòng thông tin của một khách thuê trong thẻ "KHÁCH THUÊ".
//
// LUẬT ẨN/HIỆN — chủ chốt 13/09/2026:
//   · Điện thoại và CCCD LUÔN hiện, rỗng thì ghi "Chưa có". Thiếu giấy tờ của
//     khách đang ở là chuyện phải nhìn thấy, không được giấu.
//   · Email và phương tiện rỗng thì ẨN HẲN. Hai thứ này không bắt buộc; in
//     "Chưa có" chỉ tổ chiếm chỗ và làm loãng dòng.
//
// Tách khỏi JSX vì luật ẩn/hiện và cách ghép mô tả xe là thứ dễ sai lặng lẽ
// (dấu phân cách cụt, mục rỗng vẫn đẻ ra ô trống) mà nhìn UI không phát hiện ra.

import type { ContractVehicle } from "@/components/contracts/detail/types";

export type LoaiMuc = "phone" | "cccd" | "xe" | "email";

export interface MucMetaKhach {
  loai: LoaiMuc;
  /** Chuỗi đã sẵn sàng in. */
  chu: string;
  /** Bắt buộc mà đang trống — tô nhạt để thấy ngay là thiếu. */
  thieu: boolean;
  /** Khoá React cho mục xe (mỗi xe một dòng). */
  khoa?: string;
}

export interface KhachChoDongMeta {
  phone?: string | null;
  id_number?: string | null;
  email?: string | null;
}

const chu = (gt: unknown): string | null =>
  typeof gt === "string" && gt.trim() !== "" ? gt.trim() : null;

/**
 * "86AA-042.67 · Galaxy SYM · Đen" — số xe · tên · màu, đúng thứ tự chủ yêu cầu.
 * Phần nào trống thì bỏ hẳn để không còn dấu phân cách cụt.
 */
export function moTaXe(v: ContractVehicle): string {
  // `vehicle_name` là ô người dùng gõ; hồ sơ nhập từ nguồn khác chỉ có cặp
  // brand/model. Không lùi về cặp đó thì dòng xe trống trơn dù dữ liệu vẫn có.
  const hangDong = [chu(v.brand), chu(v.model)].filter(Boolean).join(" ");
  const tenXe = chu(v.vehicle_name) ?? chu(hangDong);

  const bien = chu(v.license_plate);
  const mau = chu(v.color);

  // Xe rỗng hoàn toàn ⇒ chuỗi rỗng để nơi gọi bỏ qua, KHÔNG in "Chưa có biển số"
  // cho một bản ghi chẳng có thông tin gì.
  if (!bien && !tenXe && !mau) return "";

  return [bien ?? "Chưa có biển số", tenXe, mau].filter(Boolean).join(" · ");
}

export interface AnhCccd {
  truoc?: string;
  sau?: string;
}

/**
 * Đọc `customers.id_images` (JSON tự do) thành cặp ảnh mặt trước / mặt sau.
 * Trả null khi không có ảnh nào dùng được — nơi gọi lấy đó làm điều kiện hiện nút.
 */
export function anhCccd(idImages: unknown): AnhCccd | null {
  if (!idImages || typeof idImages !== "object" || Array.isArray(idImages)) return null;
  const o = idImages as Record<string, unknown>;
  // Khách nước ngoài dùng hộ chiếu: chỉ có một ảnh, xếp vào "mặt trước".
  const truoc = chu(o.front) ?? chu(o.passport) ?? undefined;
  const sau = chu(o.back) ?? undefined;
  if (!truoc && !sau) return null;
  return { truoc, sau };
}

export function mucMetaKhach(
  khach: KhachChoDongMeta,
  xe: ContractVehicle[],
): MucMetaKhach[] {
  const muc: MucMetaKhach[] = [];

  const dienThoai = chu(khach.phone);
  muc.push({ loai: "phone", chu: dienThoai ?? "Chưa có", thieu: !dienThoai });

  const cccd = chu(khach.id_number);
  muc.push({ loai: "cccd", chu: cccd ?? "Chưa có", thieu: !cccd });

  for (const v of xe) {
    const moTa = moTaXe(v);
    if (moTa) muc.push({ loai: "xe", chu: moTa, thieu: false, khoa: v.id });
  }

  const email = chu(khach.email);
  if (email) muc.push({ loai: "email", chu: email, thieu: false });

  return muc;
}
