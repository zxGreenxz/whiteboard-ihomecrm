import { describe, expect, it } from "vitest";
import { parseOcrFields, selectOcrFields, type OcrLine } from "../parser";

const row = (text: string, y: number, x = 300, width = 650): OcrLine => ({
  text,
  confidence: 0.95,
  box: [
    [x, y],
    [x + width, y],
    [x + width, y + 25],
    [x, y + 25],
  ],
});
const lines = () => [
  row("Số / No.: 001099999991", 100),
  row("Họ và tên / Full name:", 150),
  row("NGUYỄN THỬ MỘT", 190),
  row("Ngày sinh / Date of birth: 29/02/2000", 240),
  row("Giới tính / Sex: Nữ  Quốc tịch / Nationality: Việt Nam", 280),
  row("Quê quán / Place of origin: Hà Nội", 320),
  row("Nơi thường trú / Place of residence: Số 12, Đường Hoa Sen,", 360),
  row("Phường An Bình, Thành phố Thử Nghiệm", 400),
  row("Có giá trị đến / Date of expiry: 29/02/2040", 450),
];
describe("OCR anchored five-field parsing", () => {
  it("preserves literal ID, Vietnamese spelling and full printed residence without hometown/expiry", () => {
    const result = parseOcrFields(lines(), { width: 1200, height: 550 });
    expect(result.status).toBe("review");
    expect(result.data).toEqual({
      source: "ocr",
      idNumber: "001099999991",
      fullName: "NGUYỄN THỬ MỘT",
      dateOfBirth: "2000-02-29",
      gender: "Nữ",
      permanentAddress:
        "Số 12, Đường Hoa Sen, Phường An Bình, Thành phố Thử Nghiệm",
      idIssuePlace: "Cục Cảnh sát",
      idIssueDate: "",
    });
  });
  it("rejects impossible dates and does not infer gender from Việt Nam", () => {
    const input = lines();
    input[3].text = "Ngày sinh / Date of birth: 31/02/2000";
    input[4].text = "Giới tính / Sex: ? Quốc tịch / Nationality: Việt Nam";
    const result = parseOcrFields(input, { width: 1200, height: 550 });
    expect(result.data.dateOfBirth).toBe("");
    expect(result.data.gender).toBe("");
  });
  it("does not repair a noisy ID or pick the issue date", () => {
    const input = lines();
    input[0].text = "Số / No.: 001O99999991";
    input[3].text = "Ngày cấp: 01/01/2024";
    const result = parseOcrFields(input, { width: 1200, height: 550 });
    expect(result.data.idNumber).toBe("");
    expect(result.data.dateOfBirth).toBe("");
  });
  it("rejects multiple fronts before any name/address selection", () => {
    const input = [
      ...lines(),
      ...lines().map((r) => ({
        ...r,
        box: r.box.map(([x, y]) => [x + 1300, y]) as OcrLine["box"],
      })),
    ];
    expect(selectOcrFields(input, { width: 2500, height: 550 }).status).toBe(
      "ambiguous",
    );
    expect(
      parseOcrFields(input, { width: 2500, height: 550 }).data.fullName,
    ).toBe("");
  });
  it("marks clipped address missing instead of treating a partial line as complete", () => {
    const input = lines();
    input[7].truncated = true;
    expect(
      parseOcrFields(input, { width: 1200, height: 550 }).data.permanentAddress,
    ).toBe("");
  });
  it("does not capture unrelated below-label dates or distant text", () => {
    const input = lines();
    input[6].text = "Nơi thường trú / Place of residence:";
    input[7].text = "Ngày cấp: 01/01/2024";
    expect(
      parseOcrFields(input, { width: 1200, height: 550 }).data.permanentAddress,
    ).toBe("");
  });
  it("joins a continuation with expanded overlapping boxes and modest indentation", () => {
    const input = lines();
    input[6] = row(
      "Nơi thường trú / Place of residence: Số 12,",
      360,
      300,
      650,
    );
    input[7] = row("Phường An Bình, Thành phố Thử Nghiệm", 377, 198, 700);
    expect(
      parseOcrFields(input, { width: 1200, height: 550 }).data.permanentAddress,
    ).toBe("Số 12, Phường An Bình, Thành phố Thử Nghiệm");
  });
});
