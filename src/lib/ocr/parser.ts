import type { CCCDQrData } from "../cccdQrParser";
export type OcrLine = {
  text: string;
  confidence: number;
  box: [number, number][];
  truncated?: boolean;
  anchorText?: string;
  reverse?: boolean;
};
export type OcrField =
  | "idNumber"
  | "fullName"
  | "dateOfBirth"
  | "gender"
  | "permanentAddress";
export type OcrReview = {
  status: "review" | "ambiguous";
  data: CCCDQrData;
  states: Record<OcrField, "readable" | "check" | "missing">;
};
type Size = { width: number; height: number };
type Kind = "id" | "name" | "dob" | "sex" | "address";
export const foldOcr = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "D").toUpperCase();
const anchors: Record<Exclude<Kind, "id">, RegExp> = {
  name: /HO VA TEN|FULL NAME/,
  dob: /NGAY SINH|DATE OF BIRTH/,
  sex: /GIOI TINH|\bSEX\b/,
  address: /NOI THUONG TRU|PLACE OF RESIDENCE/,
};
const unrelated =
  /QUE QUAN|PLACE OF ORIGIN|NGAY CAP|DATE OF ISSUE|CO GIA TRI|DATE OF EXPIRY|CAN CUOC|CITIZEN|DAC DIEM|IDENTIFICATION|CUC CANH|CHU KY|SIGNATURE/;
const bounds = (r: OcrLine) => ({
  left: Math.min(...r.box.map((p) => p[0])),
  right: Math.max(...r.box.map((p) => p[0])),
  top: Math.min(...r.box.map((p) => p[1])),
  bottom: Math.max(...r.box.map((p) => p[1])),
});
/** Expanded detector boxes clamped to a raster edge cannot establish that the
 * entire printed line survived. Treat this uncertainty as missing, even when
 * the recognizer emitted its normal end token. */
export const isOcrLineClipped = (box: OcrLine["box"], size: Size): boolean => {
  // The detector can omit the cut glyph at the boundary and finish just inside
  // it. Reserve half a text-line height of context; an absent margin cannot
  // establish that this is the full printed line.
  const height = Math.max(...box.map((p) => p[1])) - Math.min(...box.map((p) => p[1]));
  const margin = Math.max(2, height / 2);
  return box.some(([x, y]) => x <= margin || y <= margin || x >= size.width - 1 - margin || y >= size.height - 1 - margin);
};
const literalId = (s: string) =>
  /^(?:(?:SO\s*\/\s*)?NO\.?\s*:?\s*|SO\s*:?\s*)?(\d{12})$/.exec(
    foldOcr(s.trim()),
  )?.[1] ?? "";
const empty = (): CCCDQrData => ({
  source: "ocr",
  idNumber: "",
  fullName: "",
  dateOfBirth: "",
  gender: "",
  permanentAddress: "",
  idIssuePlace: "Cục Cảnh sát",
  idIssueDate: "",
});

/** Coordinates are in an upright image. Never choose between two fronts, even
 * duplicate identities: downstream field geometry must have one owner. */
export function selectOcrFields(
  lines: OcrLine[],
  size: Size,
): { status: "review" | "ambiguous"; selected: Record<Kind, number[]> } {
  const selected: Record<Kind, number[]> = {
    id: [],
    name: [],
    dob: [],
    sex: [],
    address: [],
  };
  if (
    lines.length > 128 ||
    !Number.isFinite(size.width * size.height) ||
    size.width * size.height > 24_000_000
  )
    return { status: "ambiguous", selected };
  const labels: Record<Exclude<Kind, "id">, number[]> = {
    name: [],
    dob: [],
    sex: [],
    address: [],
  };
  lines.forEach((r, i) => {
    if (
      r.box.length !== 4 ||
      r.box.some((p) => p.some((n) => !Number.isFinite(n)))
    )
      return;
    if (literalId(r.text)) selected.id.push(i);
    for (const key of Object.keys(anchors) as (keyof typeof anchors)[])
      if (anchors[key].test(foldOcr(r.anchorText ?? r.text)))
        labels[key].push(i);
  });
  if (selected.id.length > 1 || Object.values(labels).some((v) => v.length > 1))
    return {
      status: "ambiguous",
      selected: { id: [], name: [], dob: [], sex: [], address: [] },
    };
  // Every identity anchor must fit one upright card's field column. Normalize
  // by detected line height, not the whole image: a collage's empty space must
  // never expand the ownership envelope. Missing duplicate labels on another
  // front therefore cannot donate complementary fields to the first front.
  const owners = [
    selected.id[0],
    labels.name[0],
    labels.dob[0],
    labels.sex[0],
    labels.address[0],
  ]
    .filter((index): index is number => index !== undefined)
    .map((index) => bounds(lines[index]));
  if (owners.length > 1) {
    const heights = owners.map((b) => b.bottom - b.top).sort((a, b) => a - b);
    const scale = Math.max(8, heights[Math.floor(heights.length / 2)]);
    const lefts = owners.map((b) => b.left);
    const centers = owners.map((b) => (b.top + b.bottom) / 2);
    if (
      Math.max(...lefts) - Math.min(...lefts) > 6 * scale ||
      Math.max(...centers) - Math.min(...centers) > 18 * scale ||
      centers.some((y, i) => i > 0 && y < centers[i - 1] - 2 * scale)
    )
      return {
        status: "ambiguous",
        selected: { id: [], name: [], dob: [], sex: [], address: [] },
      };
  }
  for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
    const index = labels[key][0];
    if (index === undefined) continue;
    selected[key].push(index);
    if (key === "sex" || key === "dob") continue;
    const b = bounds(lines[index]),
      height = Math.max(8, b.bottom - b.top);
    const center = (b.top + b.bottom) / 2;
    // DB boxes expand around glyphs and adjacent lines can overlap. Compare
    // centers, not the empty space between boxes; retain the measured envelope.
    const below = lines
      .map((r, i) => ({ r, i, b: bounds(r) }))
      .filter(
        (s) =>
          s.i !== index &&
          (s.b.top + s.b.bottom) / 2 - center > height * 0.25 &&
          (s.b.top + s.b.bottom) / 2 - center < Math.max(3 * height, 90) &&
          Math.abs(s.b.left - b.left) < Math.min(size.width * 0.09, 6 * height),
      )
      .sort((a, b) => a.b.top - b.b.top);
    let lastBottom = b.bottom;
    for (const candidate of below) {
      const text = foldOcr(candidate.r.anchorText ?? candidate.r.text);
      if (
        candidate.b.top - lastBottom > height * 1.8 ||
        unrelated.test(text) ||
        Object.values(anchors).some((re) => re.test(text)) ||
        literalId(candidate.r.text)
      )
        break;
      selected[key].push(candidate.i);
      lastBottom = candidate.b.bottom;
      if (selected[key].length >= (key === "name" ? 2 : 4)) break;
    }
  }
  return { status: "review", selected };
}

export function validOcrDate(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return "";
  const [, y, m, d] = match,
    date = new Date(Date.UTC(+y, +m - 1, +d));
  return +y >= 1900 &&
    date.getUTCFullYear() === +y &&
    date.getUTCMonth() === +m - 1 &&
    date.getUTCDate() === +d &&
    date <= new Date()
    ? raw
    : "";
}
function afterLabel(text: string, kind: "name" | "address"): string {
  const re =
    kind === "name"
      ? /(?:full\s*name|họ\s*và\s*tên)\s*[:/]?\s*/giu
      : /(?:place\s*of\s*residence|nơi\s*thường\s*trú)\s*[:/]?\s*/giu;
  const matches = [...text.matchAll(re)];
  const last = matches[matches.length - 1];
  return last ? text.slice(last.index! + last[0].length).trim() : "";
}
export function parseOcrFields(lines: OcrLine[], size: Size): OcrReview {
  const { status, selected } = selectOcrFields(lines, size),
    data = empty();
  const states: OcrReview["states"] = {
    idNumber: "missing",
    fullName: "missing",
    dateOfBirth: "missing",
    gender: "missing",
    permanentAddress: "missing",
  };
  if (status === "ambiguous") return { status, data, states };
  const get = (kind: Kind) => selected[kind].map((i) => lines[i]);
  const usable = (rows: OcrLine[]) =>
    rows.length > 0 &&
    rows.every(
      (r) =>
        !r.truncated && !isOcrLineClipped(r.box, size) && r.text.length <= 500,
    );
  const ids = get("id");
  if (usable(ids)) data.idNumber = literalId(ids[0].text);
  const names = get("name");
  if (usable(names)) {
    const text = [
      afterLabel(names[0].text, "name"),
      ...names.slice(1).map((r) => r.text.trim()),
    ]
      .filter(Boolean)
      .join(" ");
    if (
      text &&
      /^[\p{L}\p{M} .'-]+$/u.test(text) &&
      !unrelated.test(foldOcr(text))
    )
      data.fullName = text;
  }
  const dob = get("dob")[0];
  if (dob && usable([dob])) {
    const tail =
      foldOcr(dob.text)
        .split(/NGAY SINH|DATE OF BIRTH/)
        .pop() ?? "";
    const m = /(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/.exec(tail);
    if (m)
      data.dateOfBirth = validOcrDate(
        `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`,
      );
  }
  const sex = get("sex")[0];
  if (sex && usable([sex])) {
    const tail =
      foldOcr(sex.text)
        .split(/QUOC TICH|NATIONALITY/)[0]
        .split(/GIOI TINH|SEX/)
        .pop() ?? "";
    const m = /^\s*[:/]*\s*(NAM|NU)\s*$/.exec(tail);
    data.gender = m?.[1] === "NAM" ? "Nam" : m?.[1] === "NU" ? "Nữ" : "";
  }
  const address = get("address");
  if (usable(address))
    data.permanentAddress = [
      afterLabel(address[0].text, "address"),
      ...address.slice(1).map((r) => r.text.trim()),
    ]
      .filter(Boolean)
      .join(" ");
  for (const [field, kind] of Object.entries({
    idNumber: "id",
    fullName: "name",
    dateOfBirth: "dob",
    gender: "sex",
    permanentAddress: "address",
  }) as [OcrField, Kind][])
    if (data[field])
      states[field] = get(kind).every((r) => r.confidence >= 0.85)
        ? "readable"
        : "check";
  return { status, data, states };
}
