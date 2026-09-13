// Dịch vụ ĐANG THẬT SỰ ÁP DỤNG cho một hợp đồng.
//
// VÌ SAO CẦN FILE NÀY — án lệ 13/09/2026:
//   Màn chi tiết HĐ (và tab "Dịch vụ" cũ trước nó) chỉ đọc `contract_services`,
//   nên với HĐ không khai dịch vụ riêng thì nó in "Hợp đồng chưa đăng ký dịch vụ
//   nào". Câu đó khiến chủ nhà đọc xong tưởng HĐ không thu tiền dịch vụ — trong
//   khi hoá đơn VẪN thu, theo bảng giá của TOÀ.
//
//   Luật thật nằm ở `src/lib/contractServicePricing.ts` (nơi dialog tạo hoá đơn
//   dùng): HĐ có `contract_services` thì lấy giá HĐ; HĐ chưa khai gì thì FALLBACK
//   về đơn giá toà. Đo trên production 13/09: 238/291 HĐ đang hoạt động (82%)
//   rơi vào nhánh fallback — tức câu "chưa đăng ký dịch vụ nào" đang sai với hầu
//   hết hợp đồng.
//
//   Ca cụ thể HD-2026-00361 (950NK/PARIS 2): contract_services rỗng, nhưng hoá
//   đơn tháng đầu vẫn có "Nước 70.000" và "Phí Dịch Vụ TL 140.000" = giá toà
//   (100.000/người và 200.000/phòng) nhân 21/30 ngày.
//
// File này KHÔNG tự đặt luật mới — nó chỉ trình bày đúng luật đã có ở
// contractServicePricing. Sửa luật thì sửa ở đó trước.

import type { ContractServiceItem } from "@/components/contracts/detail/types";

/** Nguồn của mức giá đang áp dụng. */
export type NguonGia = "HD" | "TOA";

export interface DichVuToaLite {
  id: string;
  is_active: boolean | null;
  /** Giá riêng toà đặt đè lên giá gốc của dịch vụ. */
  unit_price_override: number | string | null;
  service?: {
    id?: string | null;
    name?: string | null;
    type?: string | null;
    unit?: string | null;
    unit_price?: number | string | null;
  } | null;
}

export interface DongDichVu {
  id: string;
  ten: string;
  loai: string;
  donVi: string | null;
  donGia: number;
  /** Chỉ số công tơ lúc vào ở — chỉ dịch vụ khai theo HĐ mới có. */
  chiSoDau: number | null;
}

const so = (gt: unknown): number => {
  const n = Number(gt);
  return Number.isFinite(n) ? n : 0;
};

export function dichVuHieuLuc(args: {
  contractServices: ContractServiceItem[];
  buildingServices: DichVuToaLite[];
}): { dong: DongDichVu[]; nguon: NguonGia | null } {
  const { contractServices, buildingServices } = args;

  if (contractServices.length > 0) {
    return {
      nguon: "HD",
      dong: contractServices.map((cs) => ({
        id: cs.id,
        ten: cs.service.name,
        loai: cs.service.type,
        donVi: cs.service.unit || null,
        donGia: so(cs.unit_price),
        chiSoDau: cs.initial_reading,
      })),
    };
  }

  const bat = buildingServices.filter((bs) => bs.is_active === true);
  if (bat.length === 0) return { dong: [], nguon: null };

  return {
    nguon: "TOA",
    dong: bat.map((bs) => ({
      id: bs.id,
      ten: bs.service?.name ?? "—",
      loai: bs.service?.type ?? "",
      donVi: bs.service?.unit || null,
      // `?? ` chứ không `|| `: toà đặt đè giá 0 (dịch vụ miễn phí) là một quyết
      // định hợp lệ, không phải "chưa đặt giá".
      donGia: so(bs.unit_price_override ?? bs.service?.unit_price),
      // Chỉ số đầu là chuyện của từng HĐ, bảng giá toà không có khái niệm này.
      chiSoDau: null,
    })),
  };
}
