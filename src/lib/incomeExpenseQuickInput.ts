// Parser thuần cho dialog "Tạo phiếu nhanh" thu/chi.
// Cấu trúc 1 dòng: (phòng) (tòa nhà) (hạng mục) (ghi chú) (số tiền)
//
// Vì hạng mục là chuỗi NHIỀU TỪ lấy từ danh sách có sẵn, không thể đoán chắc
// ranh giới hạng mục↔ghi chú bằng vị trí token. Do đó parser KHÔNG tự đoán mà
// nhận "khoá" (lockedTypeId + categoryEndIndex) từ ngoài (do dialog set khi user
// chọn 1 hạng mục từ dropdown). Khi chưa khoá, parser trả `categorySearch` để
// dialog feed dropdown gợi ý.

import {
  BUILDING_WIDE_TOKENS,
  eqInsensitive,
  normalizeLoose,
  splitAliases,
  type BuildingRef,
  type RoomRef,
} from "./textMatch";

export type { BuildingRef, RoomRef };

export type IeTypeRef = {
  id: string;
  name: string;
  category: string | null;
  type: "income" | "expense";
};

export interface ParseIeOpts {
  raw: string;
  buildings: BuildingRef[];
  rooms: RoomRef[];
  /** Danh sách hạng mục đã lọc theo mode (income/expense) — để resolve lock. */
  types: IeTypeRef[];
  /** Index token (trong mảng tokens) NGAY SAU vùng hạng mục. null = chưa khoá. */
  categoryEndIndex: number | null;
  /** Id hạng mục user đã khoá. Có giá trị → ưu tiên (sau khi xác thực prefix). */
  lockedTypeId: string | null;
}

export interface ParsedIeInput {
  rawInput: string;
  roomToken: string;
  buildingToken: string;
  categoryTokens: string[];
  noteText: string;
  amount: number | null;
  amountToken: string | null;
  buildingId: string | null;
  roomId: string | null;
  isBuildingWide: boolean;
  typeId: string | null;
  typeName: string | null;
  /** Query feed dropdown gợi ý hạng mục. null = không ở "vùng hạng mục". */
  categorySearch: string | null;
  categoryLocked: boolean;
  hasAnyError: boolean;
  errors: {
    structure?: string;
    buildingNotFound?: string;
    roomNotFound?: string;
    categoryMissing?: string;
    amountMissing?: string;
  };
}

export const QUICK_STRUCTURE_HINT =
  "Cú pháp: (phòng) (tòa nhà) (hạng mục) (ghi chú) (số tiền). VD: 201 1392qt tiền điện tháng 5 200";

/**
 * Số tiền ghi nhanh: số trần hoặc có hậu tố "k" đều là NGHÌN.
 * "200" hay "200k" → 200000. Làm tròn 1000. Rỗng/âm/không hợp lệ → null.
 */
export function parseQuickAmount(token: string | null | undefined): number | null {
  if (!token) return null;
  const t = token.trim().toLowerCase();
  const m = /^(\d+)(k)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const vnd = n * 1000;
  return Math.round(vnd / 1000) * 1000;
}

export function parseIncomeExpenseQuickInput(opts: ParseIeOpts): ParsedIeInput {
  const { raw, buildings, rooms, types, categoryEndIndex, lockedTypeId } = opts;
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const endsWithSpace = /\s$/.test(raw);

  const roomToken = tokens[0] ?? "";
  const buildingToken = tokens[1] ?? "";
  const isBuildingWide = BUILDING_WIDE_TOKENS.includes(normalizeLoose(roomToken));

  // 1. Resolve tòa nhà + phòng
  const buildingMatch = buildingToken
    ? buildings.find(
        (b) =>
          eqInsensitive(b.name, buildingToken) ||
          splitAliases(b.code).some((a) => eqInsensitive(a, buildingToken)),
      )
    : undefined;

  let roomMatch: RoomRef | undefined;
  let roomNotFoundMsg: string | undefined;
  if (buildingMatch && !isBuildingWide && roomToken) {
    roomMatch = rooms.find(
      (r) =>
        r.building_id === buildingMatch.id &&
        (eqInsensitive(r.name, roomToken) ||
          splitAliases(r.code).some((a) => eqInsensitive(a, roomToken))),
    );
    if (!roomMatch) {
      roomNotFoundMsg = `Không tìm thấy phòng "${roomToken}" trong tòa "${buildingToken}". Dùng "tn" nếu là phiếu cho cả tòa nhà.`;
    }
  }

  // 2. Xác thực khoá hạng mục (nếu có)
  const lockedType = lockedTypeId
    ? types.find((t) => t.id === lockedTypeId)
    : undefined;
  let lockValid = false;
  if (lockedType && categoryEndIndex != null && categoryEndIndex > 2) {
    const lockedRegion = tokens.slice(2, categoryEndIndex).join(" ");
    lockValid = normalizeLoose(lockedRegion) === normalizeLoose(lockedType.name);
  }

  // 3. Phát hiện số tiền ở token cuối.
  //    amountFloor = vùng được phép lấy số tiền: sau phòng+tòa (>=2), và khi đã
  //    khoá hạng mục thì phải sau vùng hạng mục (>=categoryEndIndex) → không bao
  //    giờ "ăn nhầm" token số nằm trong tên hạng mục.
  const amountFloor =
    lockValid && categoryEndIndex != null ? categoryEndIndex : 2;
  const lastIdx = tokens.length - 1;
  let amount: number | null = null;
  let amountToken: string | null = null;
  let amountTokenCount = 0;
  if (lastIdx >= amountFloor) {
    const parsedAmt = parseQuickAmount(tokens[lastIdx]);
    if (parsedAmt != null) {
      amount = parsedAmt;
      amountToken = tokens[lastIdx];
      amountTokenCount = 1;
    }
  }

  const head = tokens.slice(0, tokens.length - amountTokenCount);

  // 4. Tách hạng mục / ghi chú
  let categoryTokens: string[] = [];
  let noteText = "";
  let typeId: string | null = null;
  let typeName: string | null = null;
  let categorySearch: string | null = null;
  let categoryLocked = false;

  if (lockValid && lockedType && categoryEndIndex != null) {
    categoryTokens = head.slice(2, categoryEndIndex);
    typeId = lockedType.id;
    typeName = lockedType.name;
    categoryLocked = true;
    noteText = head.slice(categoryEndIndex).join(" ");
  } else {
    categoryTokens = head.slice(2);
    // "vùng hạng mục": đã qua phòng+tòa và đang gõ hạng mục
    const inCategoryZone =
      head.length >= 3 || (head.length === 2 && endsWithSpace && !!buildingToken);
    categorySearch = inCategoryZone ? head.slice(2).join(" ") : null;
  }

  // 5. Lỗi
  const errors: ParsedIeInput["errors"] = {};
  if (tokens.length < 2) {
    errors.structure = QUICK_STRUCTURE_HINT;
  } else if (buildingToken && !buildingMatch) {
    errors.buildingNotFound = `Không tìm thấy tòa nhà "${buildingToken}". Kiểm tra lại mã hoặc tên.`;
  }
  if (roomNotFoundMsg) {
    errors.roomNotFound = roomNotFoundMsg;
  }
  if (!typeId) {
    errors.categoryMissing = "Chọn hạng mục từ danh sách gợi ý.";
  }
  if (amount == null) {
    errors.amountMissing = "Thiếu số tiền ở cuối (vd: 200 hoặc 200k).";
  }

  return {
    rawInput: raw,
    roomToken,
    buildingToken,
    categoryTokens,
    noteText,
    amount,
    amountToken,
    buildingId: buildingMatch?.id ?? null,
    roomId: roomMatch?.id ?? null,
    isBuildingWide,
    typeId,
    typeName,
    categorySearch,
    categoryLocked,
    hasAnyError: Object.keys(errors).length > 0,
    errors,
  };
}

/** Số token (whitespace-separated) của 1 tên hạng mục — để tính categoryEndIndex. */
export function countTokens(name: string): number {
  return name.trim().split(/\s+/).filter(Boolean).length;
}
