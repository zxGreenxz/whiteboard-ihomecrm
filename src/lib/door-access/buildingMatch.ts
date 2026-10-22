/**
 * Gợi ý tòa cho một máy SmartLife theo TÊN máy (chủ chốt 21/10: CRM gợi ý, người Quản lý xác
 * nhận). Hàm thuần — không đoán khi mơ hồ: hai tòa cùng điểm cao nhất ⇒ null.
 *
 * Điểm:
 *   100  tên máy = tên tòa, hoặc = một mã tòa (mã có thể nhiều giá trị cách nhau dấu phẩy);
 *    90  tên máy = số nhà đầu địa chỉ ("80/55" của "80/55 Đường số 3"), hoặc địa chỉ (phần trước
 *        dấu phẩy đầu) bắt đầu bằng tên máy (tính trọn từ);
 *    75  địa chỉ chứa tên máy (≥ 4 ký tự, tính trọn từ).
 * Chỉ trả gợi ý ≥ 70.
 */

export interface BuildingCandidate {
  id: string;
  name: string;
  code: string | null;
  street_address: string | null;
}

export interface BuildingSuggestion {
  buildingId: string;
  score: number;
}

export const SUGGEST_MIN_SCORE = 70;

/** Chữ thường, bỏ dấu (NFD), đ→d, chỉ giữ [a-z0-9/], gộp khoảng trắng. */
export function normalizeForMatch(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `needle` xuất hiện trong `haystack` như một cụm từ trọn vẹn (biên là khoảng trắng hoặc đầu/cuối). */
function containsWords(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

function startsWithWords(haystack: string, needle: string): boolean {
  return haystack === needle || haystack.startsWith(`${needle} `);
}

export function scoreBuilding(deviceName: string, building: BuildingCandidate): number {
  const device = normalizeForMatch(deviceName);
  if (!device) return 0;

  const exact = [building.name, ...(building.code ?? "").split(",")]
    .map(normalizeForMatch)
    .filter(Boolean);
  if (exact.includes(device)) return 100;

  const address = building.street_address ?? "";
  const head = normalizeForMatch(address.split(",")[0]);
  if (head) {
    const houseNumber = head.split(" ")[0] ?? "";
    if (/^\d/.test(houseNumber) && houseNumber === device) return 90;
    if (startsWithWords(head, device)) return 90;
  }

  const full = normalizeForMatch(address);
  if (device.length >= 4 && full && containsWords(full, device)) return 75;
  return 0;
}

export function suggestBuilding(
  deviceName: string | null | undefined,
  buildings: readonly BuildingCandidate[],
): BuildingSuggestion | null {
  if (!deviceName) return null;
  let best: BuildingSuggestion | null = null;
  let tied = false;
  for (const building of buildings) {
    const score = scoreBuilding(deviceName, building);
    if (score < SUGGEST_MIN_SCORE) continue;
    if (!best || score > best.score) {
      best = { buildingId: building.id, score };
      tied = false;
    } else if (score === best.score && building.id !== best.buildingId) {
      tied = true;
    }
  }
  return best && !tied ? best : null;
}
