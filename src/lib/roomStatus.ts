import { differenceInDays } from "date-fns";

// Trạng thái hiển thị của phòng — dùng chung cho Sơ đồ toà nhà và Danh mục căn hộ.
export type RoomDisplayStatus =
  | "AVAILABLE"
  | "OCCUPIED"
  | "RESERVED"
  | "EXPIRING_SOON"
  | "MAINTENANCE";

// Số ngày còn lại của hợp đồng được coi là "sắp hết hạn / sắp trống".
export const EXPIRING_SOON_DAYS = 30;

/**
 * Suy ra trạng thái hiển thị của phòng dựa trên hợp đồng đang hiệu lực
 * (ACTIVE/EXTENDED) cộng với room.status.
 *
 * - Có hợp đồng còn hiệu lực:
 *   - còn 1..30 ngày  → EXPIRING_SOON (sắp hết hạn / sắp trống)
 *   - còn lại         → OCCUPIED (đang thuê)
 * - Không có hợp đồng: theo room.status → MAINTENANCE / RESERVED, mặc định AVAILABLE.
 */
export function getRoomDisplayStatus(
  roomStatus: string | null | undefined,
  activeContractEndDate?: string | null,
): RoomDisplayStatus {
  if (activeContractEndDate) {
    const daysUntilExpiry = differenceInDays(
      new Date(activeContractEndDate),
      new Date(),
    );
    if (daysUntilExpiry > 0 && daysUntilExpiry <= EXPIRING_SOON_DAYS) {
      return "EXPIRING_SOON";
    }
    return "OCCUPIED";
  }

  if (roomStatus === "MAINTENANCE") return "MAINTENANCE";
  if (roomStatus === "RESERVED") return "RESERVED";
  return "AVAILABLE";
}
