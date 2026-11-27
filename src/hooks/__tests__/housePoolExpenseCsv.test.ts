// @vitest-environment node
import { expect, it, vi } from "vitest";
import { readPoolExpenseCsv } from "../profit-ledger/useHousePool";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

const id = "00000000-0000-4000-8000-000000000001";
const header = "ID phiếu,Ngày,Mã phiếu,Nội dung,Số tiền (đ)";
const row = `${id},2026-01-03,PC001,"Nội dung, có dấu phẩy",125`;
const csv = (rows: string[]) =>
  new File(["\uFEFF" + [header, ...rows].join("\r\n")], "danh-sach.csv");

it("đọc đúng mã gốc, ngày và số đồng trong tệp CSV tiếng Việt", async () => {
  await expect(readPoolExpenseCsv(csv([row]))).resolves.toEqual([
    { id, day: "2026-01-03", code: "PC001", amount: 125 },
  ]);
});

it("chặn ngay khi cùng một phiếu xuất hiện hai lần", async () => {
  await expect(readPoolExpenseCsv(csv([row, row]))).rejects.toThrow("ID phiếu khác nhau");
});
