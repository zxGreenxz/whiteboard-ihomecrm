// Test hồi quy cho gate chặn tự-apply-migration.
//
// Gate này là cửa chặn hệ quả nặng nhất repo — nó đứng giữa CI và việc replay
// migration lên production. Nó KHÔNG có test nào cho tới 07/08/2026, và khi đem
// đột biến ra thử thì 7/10 cách viết vi phạm đi thẳng qua.
//
// Mỗi ca dưới đây là một cách viết ĐÃ TỪNG LỌT (hoặc một đối chứng phải KHÔNG
// bị báo). Đừng xoá ca nào: mỗi ca là một lần gate đã sai thật.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findAutoApply } from "../check-no-auto-apply.mjs";

const wf = (steps) => `name: t
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
${steps}
`;

const co = (src) => findAutoApply(src, "t.yml").length > 0;

describe("check-no-auto-apply — biến thể xuống dòng giữa các token", () => {
  it("folded scalar `run: >` gãy giữa token (YAML nối lại bằng dấu cách)", () => {
    // Runner chạy thật `supabase db push --linked`.
    assert.equal(co(wf("      - run: >\n          supabase db\n          push --linked")), true);
  });

  it("nối dòng bằng backslash bash", () => {
    assert.equal(
      co(wf('      - run: |\n          SUPABASE_ACCESS_TOKEN="$T" \\\n          supabase \\\n            db push --linked')),
      true,
    );
  });

  it("plain multiline scalar (không có | hay >)", () => {
    assert.equal(co(wf("      - run: supabase db\n          push --linked")), true);
  });
});

describe("check-no-auto-apply — biến thể lệnh", () => {
  it("ghim version CLI: npx supabase@2.20.5 db push", () => {
    assert.equal(co(wf("      - run: |\n          npx supabase@2.20.5 db push --linked")), true);
  });

  it("db reset --db-url (anh em của --linked, cùng trỏ ra DB từ xa)", () => {
    assert.equal(co(wf('      - run: |\n          supabase db reset --db-url "$PROD"')), true);
  });

  it("db push --db-url", () => {
    assert.equal(co(wf('      - run: |\n          supabase db push --db-url "$PROD"')), true);
  });

  it("command substitution bên trong echo vẫn CHẠY THẬT", () => {
    assert.equal(co(wf('      - run: |\n          echo "r: $(supabase db push --linked)"')), true);
  });

  it("một dòng thẳng (đối chứng cơ bản)", () => {
    assert.equal(co(wf("      - run: supabase db push --linked")), true);
  });
});

describe("check-no-auto-apply — KHÔNG được báo nhầm", () => {
  it("echo thuần chỉ NÓI VỀ lệnh cấm", () => {
    // Guard grep cũ của network-center-validation.yml cấm luôn việc viết ra
    // rằng điều đó bị cấm — đúng lỗi này.
    assert.equal(co(wf('      - run: |\n          echo "supabase db push bi cam"')), false);
  });

  it("supabase db pull (chỉ đọc)", () => {
    assert.equal(co(wf("      - run: |\n          supabase db pull --linked")), false);
  });

  it("db reset không cờ từ xa (reset DB local khi test)", () => {
    assert.equal(co(wf("      - run: |\n          supabase db reset")), false);
  });

  it("comment shell trong block run", () => {
    assert.equal(co(wf("      - run: |\n          # supabase db push --linked\n          echo ok")), false);
  });
});

describe("check-no-auto-apply — YAML hỏng phải NÉM, không nuốt", () => {
  it("file không parse được thì báo lỗi chứ không trả rỗng", () => {
    // Trả rỗng = gate xanh = file nguy hiểm đi qua mà không ai kiểm.
    assert.throws(() => findAutoApply("a:\n  - b\n c: [unclosed\n", "hong.yml"));
  });
});
