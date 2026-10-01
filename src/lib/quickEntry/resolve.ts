// Tìm TOÀ, PHÒNG và MÃ KHÁCH HÀNG điện nước ở bất kỳ đâu trong câu báo chi.
//
// Khác parser Tạo phiếu nhanh (đọc theo vị trí "phòng toà …"): câu ở đây tự do, nên:
//   - Toà khớp khi một từ trùng mã/bí danh toà (`buildings.code`, nhiều bí danh cách phẩy),
//     hoặc tên toà xuất hiện nguyên cụm. "405k" là tiền, không phải toà "405".
//   - Phòng CHỈ nhận khi có chữ báo "p", "ph", "phòng", "p." đứng trước — số 301 đứng trơ
//     trọi dễ là tiền. Nhắc phòng mà không nhắc toà ⇒ chỉ suy ra toà khi tên phòng duy nhất.
//   - Mã khách hàng in trên bill điện nước khớp `building_fee_accounts.provider_code` ⇒ ra cả
//     toà lẫn hạng mục phí (dien/nuoc…). So dạng gọn (bỏ khoảng trắng, dấu).
// AI cũng chỉ trả CHUỖI nhắc; ID thật luôn do các hàm ở đây tra — AI không bịa được toà.

import { normalizeLoose, splitAliases, type BuildingRef, type RoomRef } from "../textMatch";
import { normalizeForParse } from "./amount";

export type { BuildingRef, RoomRef };

export interface FeeAccountRef {
  building_id: string;
  fee_category: string;
  provider_code: string | null;
}

export interface ResolveRefs {
  buildings: BuildingRef[];
  rooms: RoomRef[];
  feeAccounts?: FeeAccountRef[];
}

export interface ResolvedBuilding {
  id: string;
  via: "code" | "name" | "provider_code" | "room";
}

export interface ResolveResult {
  building: ResolvedBuilding | null;
  /** Nhắc nhiều toà khác nhau ⇒ để người dùng chọn. */
  buildingCandidates: string[];
  room: { id: string } | null;
  /** Câu có chữ báo phòng ("p999") — kể cả khi không tìm ra phòng nào. */
  roomMentioned: boolean;
  /** "tn", "cả toà", "toàn toà": khoản cho cả toà, không phòng. */
  buildingWide: boolean;
  /** Hạng mục phí suy từ mã khách hàng (vd "dien", "nuoc"). */
  feeCategory: string | null;
}

/** Dạng gọn để so mã: bỏ dấu, chữ thường, chỉ giữ chữ + số. */
const compact = (s: string | null | undefined): string => normalizeLoose(s).replace(/[^a-z0-9]/g, "");

/** Khoá phòng: "P302", "Phòng 302", "p.302" ⇒ "302"; "A1" ⇒ "a1". */
const roomKey = (s: string | null | undefined): string => compact(s).replace(/^(phong|ph|p)(?=\d)/, "");

const WORD_RE = /[\p{L}\d]+/gu;
const BUILDING_WIDE_RE = /(?<![\p{L}\d])(?:tn|ca toa|toan toa)(?![\p{L}\d])/u;
const ROOM_CUE = new Set(["p", "ph", "phong"]);

interface Word {
  s: string;
  start: number;
  end: number;
}

function wordsOf(loose: string): Word[] {
  return [...loose.matchAll(WORD_RE)].map((m) => ({ s: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

function looseOf(text: string): string {
  const norm = normalizeForParse(text ?? "");
  const loose = normalizeLoose(norm);
  return loose.length === norm.length ? loose : norm;
}

function buildingsByCode(words: Word[], loose: string, buildings: BuildingRef[]): Map<string, ResolvedBuilding["via"]> {
  const found = new Map<string, ResolvedBuilding["via"]>();
  const tokens = new Set(words.map((w) => w.s));
  const spaced = ` ${loose.replace(/[^\p{L}\d]+/gu, " ").trim()} `;
  for (const b of buildings) {
    const aliases = splitAliases(b.code).map(compact).filter(Boolean);
    if (aliases.some((a) => tokens.has(a))) {
      found.set(b.id, "code");
      continue;
    }
    const name = normalizeLoose(b.name).replace(/[^\p{L}\d]+/gu, " ").trim();
    // Tên một từ trùng mã đã xét ở trên; tên nhiều từ phải xuất hiện nguyên cụm.
    if (name && (name.includes(" ") ? spaced.includes(` ${name} `) : tokens.has(compact(name)))) {
      found.set(b.id, "name");
    }
  }
  return found;
}

function roomMentions(words: Word[], loose: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    const glued = /^(?:phong|ph|p)(\d[\p{L}\d]*)$/u.exec(w.s);
    if (glued) {
      keys.push(glued[1]);
      continue;
    }
    const next = words[i + 1];
    // "p 301", "p.301", "phòng A1": chữ báo rồi một từ (chỉ cách nhau khoảng trắng hoặc dấu chấm).
    if (ROOM_CUE.has(w.s) && next && /^[\s.]*$/u.test(loose.slice(w.end, next.start))) {
      keys.push(roomKey(next.s));
      i += 1;
    }
  }
  return keys;
}

/** Toà/phòng/mã khách hàng nhắc trong câu. Không bao giờ ném lỗi. */
export function resolveBuildingRoom(text: string, refs: ResolveRefs): ResolveResult {
  const loose = looseOf(text);
  const words = wordsOf(loose);
  const byCode = buildingsByCode(words, loose, refs.buildings);

  let feeCategory: string | null = null;
  const textCompact = compact(loose);
  for (const fa of refs.feeAccounts ?? []) {
    const code = compact(fa.provider_code);
    if (code.length >= 6 && textCompact.includes(code)) {
      feeCategory = fa.fee_category;
      // Câu nhắc toà khác với toà của mã khách hàng ⇒ hai ứng viên, người dùng chọn.
      if (!byCode.has(fa.building_id)) byCode.set(fa.building_id, "provider_code");
      break;
    }
  }

  let building: ResolvedBuilding | null = null;
  let buildingCandidates: string[] = [];
  if (byCode.size === 1) {
    const [[id, via]] = [...byCode.entries()];
    building = { id, via };
  } else if (byCode.size > 1) {
    buildingCandidates = [...byCode.keys()];
  }

  let room: { id: string } | null = null;
  const roomKeys = roomMentions(words, loose);
  for (const key of roomKeys) {
    if (!key) continue;
    if (building) {
      const hit = refs.rooms.find((r) => r.building_id === building?.id && (roomKey(r.name) === key || roomKey(r.code) === key));
      if (hit) room = { id: hit.id };
    } else if (buildingCandidates.length === 0) {
      const hits = refs.rooms.filter((r) => roomKey(r.name) === key || roomKey(r.code) === key);
      if (hits.length === 1 && hits[0].building_id) {
        room = { id: hits[0].id };
        building = { id: hits[0].building_id, via: "room" };
      }
    }
    if (room) break;
  }

  return {
    building,
    buildingCandidates,
    room,
    roomMentioned: roomKeys.some(Boolean),
    buildingWide: BUILDING_WIDE_RE.test(loose),
    feeCategory,
  };
}

/**
 * Chuỗi nhắc toà (thường do AI trả) ⇒ id toà, chỉ khi khớp ĐÚNG mã/bí danh hoặc tên (dạng gọn)
 * và khớp duy nhất. Không khớp ⇒ null — AI bịa tên thì người dùng tự chọn.
 */
export function resolveBuildingMention(mention: string | null | undefined, buildings: BuildingRef[]): string | null {
  const m = compact(mention);
  if (!m) return null;
  const hits = buildings.filter(
    (b) => compact(b.name) === m || splitAliases(b.code).some((a) => compact(a) === m),
  );
  return hits.length === 1 ? hits[0].id : null;
}
