export type BuildingRef = {
  id: string;
  name: string | null;
  code: string | null;
};

export type RoomRef = {
  id: string;
  name: string | null;
  code: string | null;
  building_id: string | null;
};

export type JobTypeRef = {
  id: string;
  name: string | null;
};

export type ParsedJobInput = {
  rawInput: string;
  buildingId: string | null;
  roomId: string | null;
  jobTypeId: string | null;
  roomToken: string;
  buildingToken: string;
  jobTypeToken: string;
  descriptionText: string;
  deadline: Date;
  deadlineSource: "default-tomorrow" | "offset" | "date";
  isBuildingWide: boolean;
  hasAnyError: boolean;
  errors: {
    structure?: string;
    buildingNotFound?: string;
    roomNotFound?: string;
    jobTypeNotFound?: string;
  };
};

const BUILDING_WIDE_TOKENS = ["tn", "tòa", "toa", "toanha", "toànhà"];

const STRUCTURE_HINT =
  'Cần ít nhất 4 phần: (phòng) (tòa nhà) (loại công việc) (mô tả). Ví dụ: 201 1392qt sửa vòi nước';

export function parseJobQuickInput(
  raw: string,
  today: Date,
  buildings: BuildingRef[],
  rooms: RoomRef[],
  jobTypes: JobTypeRef[],
): ParsedJobInput {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);

  const empty: ParsedJobInput = {
    rawInput: raw,
    buildingId: null,
    roomId: null,
    jobTypeId: null,
    roomToken: "",
    buildingToken: "",
    jobTypeToken: "",
    descriptionText: "",
    deadline: endOfDay(addDays(today, 1)),
    deadlineSource: "default-tomorrow",
    isBuildingWide: false,
    hasAnyError: true,
    errors: { structure: STRUCTURE_HINT },
  };

  if (tokens.length < 4) return empty;

  let dateTokens = 1;
  let deadline = endOfDay(addDays(today, 1));
  let deadlineSource: ParsedJobInput["deadlineSource"] = "default-tomorrow";

  const last = tokens[tokens.length - 1];
  const offsetMatch = /^(\d+)$/.exec(last);
  const dateMatch = /^(\d{1,2})\/(\d{1,2})$/.exec(last);

  if (offsetMatch) {
    const offset = parseInt(offsetMatch[1], 10);
    deadline = endOfDay(addDays(today, offset));
    deadlineSource = "offset";
  } else if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    const year = today.getFullYear();
    deadline = new Date(year, month - 1, day, 23, 59, 59, 999);
    deadlineSource = "date";
  } else {
    dateTokens = 0;
  }

  const headTokens = tokens.slice(0, tokens.length - dateTokens);
  if (headTokens.length < 4) {
    return { ...empty, deadline, deadlineSource };
  }

  const [roomToken, buildingToken, jobTypeToken, ...descTokens] = headTokens;
  const descriptionText = descTokens.join(" ");
  const isBuildingWide = BUILDING_WIDE_TOKENS.includes(normalizeLoose(roomToken));

  const buildingMatch = buildings.find(
    (b) =>
      eqInsensitive(b.name, buildingToken) ||
      splitAliases(b.code).some((a) => eqInsensitive(a, buildingToken)),
  );

  let roomMatch: RoomRef | undefined;
  let roomNotFoundMsg: string | undefined;
  if (buildingMatch && !isBuildingWide) {
    roomMatch = rooms.find(
      (r) =>
        r.building_id === buildingMatch.id &&
        (eqInsensitive(r.name, roomToken) ||
          splitAliases(r.code).some((a) => eqInsensitive(a, roomToken))),
    );
    if (!roomMatch) {
      roomNotFoundMsg = `Không tìm thấy phòng "${roomToken}" trong tòa "${buildingToken}". Dùng "tn" nếu là việc cho cả tòa nhà.`;
    }
  }

  const jobTypeMatch = jobTypes.find((t) =>
    eqLoose(t.name, jobTypeToken),
  );

  const errors: ParsedJobInput["errors"] = {};
  if (!buildingMatch) {
    errors.buildingNotFound = `Không tìm thấy tòa nhà "${buildingToken}". Kiểm tra lại mã hoặc tên tòa nhà.`;
  }
  if (roomNotFoundMsg) {
    errors.roomNotFound = roomNotFoundMsg;
  }
  if (!jobTypeMatch) {
    errors.jobTypeNotFound = `Loại công việc "${jobTypeToken}" chưa tồn tại. Bấm "Tạo nhanh" để thêm hoặc sửa lại.`;
  }

  return {
    rawInput: raw,
    buildingId: buildingMatch?.id ?? null,
    roomId: roomMatch?.id ?? null,
    jobTypeId: jobTypeMatch?.id ?? null,
    roomToken,
    buildingToken,
    jobTypeToken,
    descriptionText,
    deadline,
    deadlineSource,
    isBuildingWide,
    hasAnyError: Object.keys(errors).length > 0,
    errors,
  };
}

function eqInsensitive(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function normalizeLoose(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
}

function eqLoose(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return normalizeLoose(a) === normalizeLoose(b);
}

export function splitAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function endOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

export function formatDeadlineLabel(d: Date): string {
  const day = d.getDate().toString().padStart(2, "0");
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}
