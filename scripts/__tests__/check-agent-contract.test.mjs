// Test hồi quy cho gate chỉ-dẫn-agent.
//
// Gate này canh việc các chỉ dẫn ĐÃ GÂY HỎNG THẬT không quay lại file rule.
// Đem đột biến ra thử 07/08/2026 thì 9/11 cách viết đi thẳng qua — gốc là
// stripQuotedWarnings() vứt bỏ NGUYÊN DÒNG bất kỳ dòng nào chứa chữ "không"
// (regex có cờ /i). Tiếng Việt dùng chữ đó liên tục, nên gần như mọi chỉ dẫn
// nguy hiểm chỉ cần kèm một chữ "không" ở đâu đó trên dòng là tàng hình.
//
// Mỗi ca dưới đây là một cách viết ĐÃ TỪNG LỌT, hoặc một đối chứng phải KHÔNG
// bị báo. Đừng xoá ca nào.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findForbidden } from "../check-agent-contract.mjs";

const co = (text, id) => findForbidden(text, "AGENTS.md").some((p) => p.id === id);

describe("check-agent-contract — chữ 'không' ở CUỐI câu không được che lệnh", () => {
  it("lệnh phá file trần (đối chứng cơ bản)", () => {
    assert.equal(co("Chạy `npm run gen:types > src/x/types.ts`.", "gen-types-redirect"), true);
  });

  it("cùng lệnh đó + đuôi câu vô hại có chữ 'không'", () => {
    assert.equal(
      co("Chạy `npm run gen:types > src/x/types.ts` (không cần cờ gì thêm).", "gen-types-redirect"),
      true,
    );
  });

  it("cùng lệnh đó + chữ 'đừng' ở vế sau", () => {
    assert.equal(
      co("Chạy `npm run gen:types > src/x/types.ts`, đừng quên chạy lint.", "gen-types-redirect"),
      true,
    );
  });
});

describe("check-agent-contract — biến thể cách viết lệnh", () => {
  it("cờ nằm GIỮA lệnh và dấu redirect", () => {
    assert.equal(co("Chạy `npm run gen:types --silent > types.ts`.", "gen-types-redirect"), true);
  });

  it("redirect ghi số fd: 1>", () => {
    assert.equal(co("Chạy `npm run gen:types 1> types.ts`.", "gen-types-redirect"), true);
  });

  it("dạng CLI thô thay cho alias npm", () => {
    assert.equal(
      co("Chạy `npx supabase gen types typescript --linked > types.ts`.", "gen-types-redirect"),
      true,
    );
  });

  it("git add -A có chữ đứng sau (regex cũ neo `$` nên trượt)", () => {
    assert.equal(co("Stage nhanh bằng `git add -A` rồi commit.", "git-add-all"), true);
  });

  it("git add --all", () => {
    assert.equal(co("Stage nhanh bằng `git add --all` rồi commit.", "git-add-all"), true);
  });

  it("chữ chen giữa 'chưa push' và dấu '='", () => {
    assert.equal(co("Chưa push lên main = việc chưa xong.", "push-equals-done"), true);
  });
});

describe("check-agent-contract — KHÔNG được báo nhầm", () => {
  it("câu cấm thật: phủ định đứng TRƯỚC lệnh", () => {
    assert.equal(co("ĐỪNG chạy `npm run gen:types > types.ts` — nó cắt trắng file.", "gen-types-redirect"), false);
  });

  it("dòng nằm trong mục có tiêu đề phủ định", () => {
    const doc = ["## Những gì agent KHÔNG được tự làm", "", "3. `git add -A` / `git add .`."].join("\n");
    assert.equal(co(doc, "git-add-all"), false);
  });

  it("tiêu đề phủ định chỉ có hiệu lực tới tiêu đề KẾ TIẾP", () => {
    // Nếu không cắt theo tiêu đề gần nhất, một mục cấm ở đầu file sẽ tha cho cả
    // phần còn lại của tài liệu.
    const doc = [
      "## Những gì agent KHÔNG được tự làm",
      "",
      "1. Promote khi gate đỏ.",
      "",
      "## Quy trình thường ngày",
      "",
      "Stage nhanh bằng `git add -A` rồi commit.",
    ].join("\n");
    assert.equal(co(doc, "git-add-all"), true);
  });

  it("git add với đường dẫn cụ thể bắt đầu bằng ./", () => {
    assert.equal(co("Chạy `git add ./src/lib/push.ts`.", "git-add-all"), false);
  });

  it("append `>>` không cắt file nên không bị cấm", () => {
    assert.equal(co("Chạy `npm run gen:types >> nhat-ky.txt`.", "gen-types-redirect"), false);
  });
});
