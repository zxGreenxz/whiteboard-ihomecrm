/* ===== Phòng trống — dữ liệu mẫu + bố cục sơ đồ theo tọa độ =====
 * Khi nối Supabase: thay `SAMPLE` bằng dữ liệu thật và ánh xạ sang các type dưới đây.
 * Tọa độ phòng (x,y,w,h) sau này lấy từ editor sơ đồ kéo-thả (layout_x/y/w/h).
 */

export type RoomStatus = "free" | "soon" | "rented";

export interface Box { x: number; y: number; w: number; h: number; }

export interface Room extends Box {
  id: string;
  no: number;
  code: string;
  buildingId: string;
  buildingName: string;
  buildingArea: string;
  buildingAddr: string;
  floor: number;
  type: string;
  price: number;        // triệu/tháng
  area: number;         // m²
  status: RoomStatus;
  amenities: string[];
  availDate: string | null;
  imgCount: number;
  phClass: string;
}

export interface Fixture extends Box {
  id: string;
  kind: "elevator" | "stairs";
}

export interface FloorPlan {
  floor: number;
  rooms: Room[];
  fixtures: Fixture[];
  corridor: Box;
  canvasW: number;
  canvasH: number;
}

export interface Building {
  id: string;
  code: string;
  name: string;
  area: string;
  address: string;
  floors: FloorPlan[];
  rooms: Room[];
  freeCount: number;
  total: number;
}

export const STATUS_META: Record<RoomStatus, { label: string; short: string }> = {
  free:   { label: "Trống sẵn", short: "Trống" },
  soon:   { label: "Sắp trống", short: "Sắp trống" },
  rented: { label: "Đã thuê",   short: "Đã thuê" },
};

export const fmtPrice = (p: number): string =>
  Number.isInteger(p) ? String(p) : p.toFixed(1).replace(".", ",");

/* ---- layout constants (đơn vị px trong canvas, sẽ scale-to-fit) ---- */
const RW = 150, RH = 118, GAP = 14, M = 18, CORRIDOR = 40;
const colX = (c: number) => M + c * (RW + GAP);

/* ---- generator ---- */
const STATUSES: RoomStatus[] = ["free", "free", "free", "free", "soon", "soon", "rented", "rented", "rented"];
const TYPES = [
  { name: "Studio", area: [26, 34], base: 7.5 },
  { name: "1PN",    area: [36, 46], base: 10.5 },
  { name: "1PN+",   area: [44, 52], base: 12.5 },
  { name: "2PN",    area: [55, 70], base: 16 },
  { name: "Duplex", area: [60, 78], base: 19 },
];
const AMENITIES = [
  "Máy lạnh", "Ban công", "Gác lửng", "Bếp riêng", "Máy giặt",
  "Cửa sổ lớn", "Tủ lạnh", "Full nội thất", "Wifi", "Nóng lạnh", "View thành phố",
];
const DEFS = [
  { id: "p1", code: "ORC", name: "The Orchard",      area: "Thảo Điền, Q.2", floors: 9,  perFloor: 7, address: "12 Nguyễn Văn Hưởng, Thảo Điền" },
  { id: "p2", code: "LAV", name: "Lavender House",   area: "Bình Thạnh",     floors: 7,  perFloor: 6, address: "88 Điện Biên Phủ, P.25, Bình Thạnh" },
  { id: "p3", code: "SUN", name: "Sunwah Court",     area: "Quận 1",         floors: 12, perFloor: 6, address: "37 Tôn Đức Thắng, Bến Nghé, Q.1" },
  { id: "p4", code: "MAI", name: "Maison Riverside", area: "Quận 4",         floors: 8,  perFloor: 8, address: "5 Bến Vân Đồn, P.12, Q.4" },
];

function seeded(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
function fmtDate(d: Date) {
  return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0");
}

function layoutFloor(floor: number, rooms: Room[]): FloorPlan {
  const n = rooms.length;
  const perRow = Math.ceil(n / 2);
  const cols = perRow + 1;            // +1 cột lõi (thang máy/cầu thang) ở giữa
  const coreCol = Math.floor(cols / 2);
  const topY = M;
  const corridorY = M + RH;
  const botY = M + RH + CORRIDOR;
  const canvasW = M * 2 + cols * RW + (cols - 1) * GAP;
  const canvasH = botY + RH + M;

  const topRooms = rooms.slice(0, perRow);
  const botRooms = rooms.slice(perRow);
  let ti = 0, bi = 0;
  const placed: Room[] = [];
  for (let c = 0; c < cols; c++) {
    if (c === coreCol) continue;
    const x = colX(c);
    if (ti < topRooms.length) placed.push({ ...topRooms[ti++], x, y: topY, w: RW, h: RH });
    if (bi < botRooms.length) placed.push({ ...botRooms[bi++], x, y: botY, w: RW, h: RH });
  }
  const fixtures: Fixture[] = [
    { id: `fx-tm-${floor}`, kind: "elevator", x: colX(coreCol), y: topY, w: RW, h: RH },
    { id: `fx-ct-${floor}`, kind: "stairs",   x: colX(coreCol), y: botY, w: RW, h: RH },
  ];
  const corridor: Box = { x: M, y: corridorY, w: canvasW - M * 2, h: CORRIDOR };
  return { floor, rooms: placed, fixtures, corridor, canvasW, canvasH };
}

function build(): Building[] {
  let gid = 1;
  return DEFS.map((p, pi) => {
    const rnd = seeded((pi + 3) * 9173);
    const floors: FloorPlan[] = [];
    const all: Room[] = [];
    for (let f = p.floors; f >= 1; f--) {
      const rooms: Room[] = [];
      for (let r = 1; r <= p.perFloor; r++) {
        const t = TYPES[Math.floor(rnd() * TYPES.length)];
        const area = Math.round(t.area[0] + rnd() * (t.area[1] - t.area[0]));
        const priceM = t.base + f * 0.18 + (rnd() - 0.5) * 1.4;
        const price = Math.round(priceM * 2) / 2;
        const status = STATUSES[Math.floor(rnd() * STATUSES.length)];
        const no = f * 100 + r;
        const amenN = 4 + Math.floor(rnd() * 4);
        const amenities = [...AMENITIES].sort(() => rnd() - 0.5).slice(0, amenN);
        let availDate: string | null = null;
        if (status === "soon") availDate = fmtDate(new Date(2026, 5, 9 + Math.floor(rnd() * 30)));
        const room: Room = {
          id: "r" + gid++, no, code: p.code + "-" + no,
          buildingId: p.id, buildingName: p.name, buildingArea: p.area, buildingAddr: p.address,
          floor: f, type: t.name, area, price, status, amenities, availDate,
          imgCount: 4 + Math.floor(rnd() * 6),
          phClass: ["ph-a", "ph-b", "ph-c", "ph-d"][Math.floor(rnd() * 4)],
          x: 0, y: 0, w: RW, h: RH,
        };
        rooms.push(room);
        all.push(room);
      }
      floors.push(layoutFloor(f, rooms));
    }
    return {
      id: p.id, code: p.code, name: p.name, area: p.area, address: p.address,
      floors, rooms: all,
      freeCount: all.filter((r) => r.status === "free").length,
      total: all.length,
    };
  });
}

export const SAMPLE_BUILDINGS: Building[] = build();

/** SĐT/Zalo liên hệ mặc định cho nút Gọi/Zalo khi tài khoản chưa có hotline.
 *  RPC trả `contact` (từ bảng hotlines) sẽ override giá trị này nếu có. */
export const MANAGER = { name: "Liên hệ thuê phòng", phone: "0772 207 574", zalo: "0772207574" };

/* ===== Adapter: dữ liệu thật từ RPC get_public_available_rooms → Building[] =====
 * Giữ NGUYÊN type Building/Room + UI. "Loại phòng" để mặc định "Chờ cập nhật"
 * cho tới khi có data/logic thật (theo yêu cầu). */

export interface RpcRoom {
  id: string;
  building_id: string;
  floor: number;
  name: string;
  code: string | null;
  area: number | null;
  rent_price: number | null;
  deposit_amount: number | null;
  max_occupants: number | null;
  amenities: unknown;
  images: unknown;
  description: string | null;
  status_public: RoomStatus;
  avail_date: string | null; // YYYY-MM-DD
}

export interface RpcBuilding {
  id: string;
  name: string;
  code: string | null;
  area_id: string | null;
  area_name: string | null;
  district: string | null;
  ward: string | null;
  address: string | null;
  total_floors: number | null;
}

export interface RpcContact { name: string; phone: string }

export interface RpcPayload {
  areas: { id: string; name: string }[];
  buildings: RpcBuilding[];
  rooms: RpcRoom[];
  contact: RpcContact | null;
}

const PH_CLASSES = ["ph-a", "ph-b", "ph-c", "ph-d"];
const phFor = (id: string): string => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % PH_CLASSES.length;
  return PH_CLASSES[h];
};

/** Lấy số phòng từ name ("402" → 402); không có chữ số thì dùng fallback. */
const numFromName = (name: string, fallback: number): number => {
  const d = (name || "").replace(/\D/g, "");
  return d ? parseInt(d, 10) : fallback;
};

/** amenities jsonb có thể là mảng string hoặc mảng object → chuẩn hoá về string[]. */
const toAmenities = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) =>
      typeof a === "string"
        ? a
        : a && typeof a === "object"
        ? String((a as Record<string, unknown>).name ?? (a as Record<string, unknown>).label ?? "")
        : String(a),
    )
    .filter((s) => !!s);
};

const imgCountOf = (raw: unknown): number => (Array.isArray(raw) ? raw.length : 0);

/** "2026-06-30" → "30/06" (đúng định dạng availDate của UI). */
const fmtAvail = (d: string | null): string | null => {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[3]}/${m[2]}` : d;
};

export function buildingsFromRpc(payload: RpcPayload | null | undefined): Building[] {
  if (!payload || !Array.isArray(payload.buildings)) return [];

  const roomsByBuilding = new Map<string, RpcRoom[]>();
  for (const r of payload.rooms ?? []) {
    const arr = roomsByBuilding.get(r.building_id) ?? [];
    arr.push(r);
    roomsByBuilding.set(r.building_id, arr);
  }

  return payload.buildings.map((b) => {
    const loc = b.district || b.area_name || b.ward || "";
    const addr = b.address || loc;
    const src = roomsByBuilding.get(b.id) ?? [];

    const rooms: Room[] = src.map((r, i) => ({
      id: r.id,
      no: numFromName(r.name, i + 1),
      code: r.code || r.name || "",
      buildingId: b.id,
      buildingName: b.name,
      buildingArea: loc,
      buildingAddr: addr,
      floor: r.floor ?? 0,
      type: "Chờ cập nhật",
      price: (r.rent_price ?? 0) / 1_000_000,
      area: Math.round(r.area ?? 0),
      status: r.status_public,
      amenities: toAmenities(r.amenities),
      availDate: r.status_public === "soon" ? fmtAvail(r.avail_date) : null,
      imgCount: imgCountOf(r.images),
      phClass: phFor(r.id),
      x: 0, y: 0, w: 0, h: 0,
    }));

    // Nhóm theo tầng (cao → thấp); trong tầng sắp theo số phòng tăng dần.
    const floorNums = Array.from(new Set(rooms.map((r) => r.floor))).sort((a, z) => z - a);
    const floors: FloorPlan[] = floorNums.map((f) =>
      layoutFloor(f, rooms.filter((r) => r.floor === f).sort((a, z) => a.no - z.no)),
    );

    return {
      id: b.id,
      code: b.code || "",
      name: b.name,
      area: loc,
      address: addr,
      floors,
      rooms,
      freeCount: rooms.filter((r) => r.status === "free").length,
      total: rooms.length,
    };
  });
}
