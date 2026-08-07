import type { SyncEntry } from "./types";

/** Descriptor realtime của miền HỢP ĐỒNG — gồm cả hai bảng VÒNG ĐỜI. */
export const CONTRACT_SYNC_ENTRIES: readonly SyncEntry[] = [
  {
    // Prefix ["contracts"] phủ luôn "paged"/"stats"/"dashboard-counts".
    table: "contracts",
    keys: [
      ["contracts"],
      ["contracts-legacy"],
      // deposit-dashboard đọc contracts + contract_terminations (KHÔNG phải
      // income_expenses) → phải gắn vào ĐÂY mới live theo thay đổi HĐ.
      ["deposit-dashboard"],
      ["unpaid-invoices"],
      ["dashboard-alerts"],
      ["recent-activities"],
      ["dashboard-summary"],
      ["business-performance"],
      ["occupancy-dashboard"],
    ],
    domain: "contracts",
  },
  // contract_terminations: hồ sơ thanh lý đổi status (DRAFT → PENDING_APPROVAL →
  // APPROVED/COMPLETED) và đổi số quyết toán. Từ Đợt −1 có trigger đông cứng đầu
  // vào quyết toán sau APPROVED/COMPLETED, nên trạng thái này có hệ quả CỨNG:
  // người thứ hai bấm duyệt trên hồ sơ đã bị bác sẽ ăn lỗi thay vì thấy trước.
  // Lưu ý: ["deposit-dashboard"] đang gắn ở entry `contracts` vì bảng cọc đọc cả
  // hai — nhưng thay đổi CHỈ ở contract_terminations thì trước đây không phát gì.
  {
    table: "contract_terminations",
    keys: [
      ["deposit-dashboard"],
      ["refund-forfeit-summary"],
      ["contract-terminations"],
      ["contracts"],
    ],
    domain: "contracts",
  },
  // contract_transfers: Đợt 2 biến bảng này thành SỔ AUDIT thật (audit ghi trước,
  // không nuốt lỗi) và dựng projection đoạn cư trú đọc từ nó. Chuỗi cư trú đổi mà
  // màn không đổi thì người rà tay đối chiếu số cũ.
  {
    table: "contract_transfers",
    keys: [
      ["room-residence-segments"],
      ["contract-transfers"],
      ["contracts"],
      ["rooms"],
    ],
    domain: "contracts",
  },
];
