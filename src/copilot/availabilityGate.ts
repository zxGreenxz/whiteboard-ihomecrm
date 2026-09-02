// Cửa gửi theo độ tươi của snapshot quyền công cụ.
//
// `buildRegistry` trả về danh sách tool RỖNG khi snapshot null hoặc quá hạn, và
// `llmClient` không gửi trường `tools` khi danh sách rỗng. Nghĩa là một snapshot
// hết hạn KHÔNG làm hỏng lượt chat — nó lặng lẽ biến Copilot thành mô hình chay.
// Người dùng chỉ thấy câu trả lời chung chung và không hiểu vì sao vừa nãy còn
// tra được số phòng trống.
//
// Chỗ này quyết định: thà chặn lượt gửi kèm một câu tiếng Việt còn hơn trả lời
// bằng nửa năng lực mà không nói gì.
import { THONG_BAO_CHUA_CHON_TO_CHUC } from './chatErrors';
import {
  copilotAvailabilitySnapshotIsFresh,
  type CopilotAvailabilitySnapshot,
} from './featureFlags';

/**
 * Ngưỡng tươi để CHO PHÉP gửi, chặt hơn ngưỡng 60s mà server/registry dùng.
 *
 * Khoảng đệm 15s là để snapshot không hết hạn NGAY GIỮA lượt: từ lúc bấm gửi
 * tới lúc registry dựng danh sách tool còn vài trăm ms tới vài giây (tạo thread,
 * nén ảnh). Lấy đúng 60s ở cả hai đầu là tự chừa ra một khe đúng bằng độ trễ đó.
 */
export const TUOI_TOI_DA_DE_GUI_MS = 45_000;

export const THONG_BAO_QUYEN_CHUA_TUOI =
  'Đang làm mới quyền công cụ cho tổ chức này, thử lại sau vài giây.';

export interface QuyetDinhGui {
  /** Được phép chạy lượt này không. */
  guiDuoc: boolean;
  /** Nên `await refetch()` rồi hỏi lại hàm này trước khi kết luận. */
  canRefetch: boolean;
  /** Câu hiện cho người dùng khi bị chặn. */
  thongBao?: string;
}

/**
 * Hàm THUẦN: cùng một snapshot và một mốc `now` luôn cho cùng quyết định.
 *
 * Người gọi chạy hai lượt — lượt đầu với snapshot đang có, và nếu `canRefetch`
 * thì làm tươi rồi hỏi lại. Snapshot sau refetch vẫn null (mất mạng, RPC lỗi,
 * rollout tắt) thì `guiDuoc` vẫn false: đó là nhánh chặn thật.
 */
export function quyetDinhGuiTheoAvailability(
  snapshot: CopilotAvailabilitySnapshot | null | undefined,
  now: number = Date.now(),
): QuyetDinhGui {
  if (copilotAvailabilitySnapshotIsFresh(snapshot, TUOI_TOI_DA_DE_GUI_MS, now)) {
    return { guiDuoc: true, canRefetch: false };
  }
  return { guiDuoc: false, canRefetch: true, thongBao: THONG_BAO_QUYEN_CHUA_TUOI };
}

/**
 * Cửa gửi có xét cả TỔ CHỨC, không chỉ độ tươi.
 *
 * `useCopilotAvailability` bị `enabled: false` khi chưa chọn tổ chức, nên
 * `refetch()` chạy queryFn rồi trả `null` ngay — làm mới bao nhiêu lần cũng thế.
 * Đưa nhánh đó vào `quyetDinhGuiTheoAvailability` sẽ ra `canRefetch: true` kèm
 * câu "thử lại sau vài giây": hẹn một thứ không bao giờ đến, trong khi việc phải
 * làm hoàn toàn khác — chọn tổ chức.
 */
export function quyetDinhGuiTheoNguCanh(nguCanh: {
  organizationId: string | null;
  snapshot: CopilotAvailabilitySnapshot | null | undefined;
  now?: number;
}): QuyetDinhGui {
  if (!nguCanh.organizationId) {
    return { guiDuoc: false, canRefetch: false, thongBao: THONG_BAO_CHUA_CHON_TO_CHUC };
  }
  return quyetDinhGuiTheoAvailability(nguCanh.snapshot, nguCanh.now ?? Date.now());
}
