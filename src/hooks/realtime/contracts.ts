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
  //
  // ĐÍNH CHÍNH 11/08/2026: key `["contract-terminations"]` ở đây KHÔNG query nào
  // dùng — nó chỉ tồn tại trong chính file này. invalidateQueries với một prefix
  // như vậy khớp 0 query rồi trả về: không lỗi, không cảnh báo. Nghĩa là việc nối
  // bảng này vào hub mới xong một nửa — bảng đã vào publication, đã vào hub, mà
  // đầu ra trỏ vào hư không. Im lặng chồng im lặng: cái sai không làm gì đỏ, và
  // cái sửa nó cũng vậy. Gate `check-realtime-query-keys.mjs` sinh ra từ đây.
  {
    table: "contract_terminations",
    keys: [
      ["deposit-dashboard"],
      // Ba key THẬT mà màn thanh lý dùng, thay cho ["contract-terminations"] chết:
      ["contract-termination-info"], // useContractDetailData
      ["pending-terminations"], // useContracts — hàng chờ duyệt
      ["termination-refund-preview"], // useTerminationRefund
      ["contract-history"], // lịch sử HĐ gộp extensions + transfers + terminations
      ["contracts"],
    ],
    domain: "contracts",
  },
  // contract_transfers: Đợt 2 biến bảng này thành SỔ AUDIT thật (audit ghi trước,
  // không nuốt lỗi) và dựng projection đoạn cư trú đọc từ nó. Chuỗi cư trú đổi mà
  // màn không đổi thì người rà tay đối chiếu số cũ.
  //
  // ĐÍNH CHÍNH 11/08/2026, cùng lỗi như trên: `["contract-transfers"]` và
  // `["room-residence-segments"]` không query nào dùng.
  //
  // `room-residence-segments` bị BỎ HẲN chứ không thay thế: projection đó tồn tại
  // trong database (`get_room_residence_segments_v1`) nhưng KHÔNG có client nào
  // gọi. Không có query thì không có gì để invalidate — thêm một key khác vào đây
  // chỉ là đổi một chỗ trỏ hư không lấy một chỗ khác. Khi nào có màn đọc nó thì
  // thêm key thật của màn đó.
  {
    table: "contract_transfers",
    keys: [
      ["contract-history"], // useContractHistory đọc thẳng contract_transfers
      ["reports"], // báo cáo gia hạn/chuyển nhượng: ["reports","renewals-transfers",…]
      ["contracts"],
      ["rooms"],
    ],
    domain: "contracts",
  },
];
