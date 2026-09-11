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
import * as gate from "../check-agent-contract.mjs";

const co = (text, id) => findForbidden(text, "AGENTS.md").some((p) => p.id === id);

describe('hướng dẫn dùng được và giữ ngắn', () => {
  const check = (text, file = 'AGENTS.md') => {
    assert.equal(typeof gate.checkGuide, 'function', 'gate phải kiểm lệnh, link và độ dài');
    return gate.checkGuide(text, file, { 'gate:agent-contract': 'node scripts/check-agent-contract.mjs' },
      (path) => path === 'docs/engineering/PROJECT_CONTRACT.md');
  };

  it('bắt npm script không tồn tại', () => {
    assert.ok(check('npm run gate:khong-co').some(p => p.id === 'unknown-npm-script'));
    assert.ok(!check('npm run gate:agent-contract').some(p => p.id === 'unknown-npm-script'));
  });

  it('bắt link nội bộ hỏng, giải đường dẫn theo file tài liệu', () => {
    assert.ok(check('[luật](docs/missing.md)').some(p => p.id === 'broken-guide-link'));
    assert.ok(!check('[luật](docs/engineering/PROJECT_CONTRACT.md)').some(p => p.id === 'broken-guide-link'));
    assert.ok(!check('[luật](PROJECT_CONTRACT.md)', 'docs/engineering/MIGRATION_STRATEGY.md')
      .some(p => p.id === 'broken-guide-link'));
  });

  it('chặn phình adapter cả bằng dòng dài và nhiều dòng', () => {
    assert.ok(check('x\n'.repeat(61)).some(p => p.id === 'guide-too-long'));
    assert.ok(check('x'.repeat(6001)).some(p => p.id === 'guide-too-long'));
  });

  it('con trỏ trong HTML comment không thay hướng dẫn người đọc', () => {
    assert.ok(check('<!-- PROJECT_CONTRACT.md -->').some(p => p.id === 'missing-contract-pointer'));
  });

  it('không giữ miễn trừ cho lệnh nguy hiểm trong văn kể đã bỏ', () => {
    const old = '- Nó dạy chạy `npm run gen:types` kèm dấu redirect `>` đổ vào `types.ts` — suốt nhiều tháng. Shell';
    assert.ok(co(old, 'gen-types-redirect'));
  });

  it('adapter công cụ trỏ đúng mục tra cứu mã nguồn trong Contract', () => {
    const dung = '[Project Contract §12](docs/engineering/PROJECT_CONTRACT.md#12-tra-cứu-mã-nguồn-và-gitnexus)';
    assert.ok(!check(dung, 'AGENTS.md').some(p => p.id === 'missing-source-lookup-pointer'));
    assert.ok(check('[Project Contract](docs/engineering/PROJECT_CONTRACT.md)', 'AGENTS.md')
      .some(p => p.id === 'missing-source-lookup-pointer'));
  });
});

describe('cấu hình GitNexus tùy chọn', () => {
  const scripts = {
    'graph:analyze': 'node scripts/run-pinned-gitnexus.mjs analyze',
    'graph:status': 'node scripts/run-pinned-gitnexus.mjs status',
    'graph:query': 'node scripts/run-pinned-gitnexus.mjs query',
    'graph:context': 'node scripts/run-pinned-gitnexus.mjs context',
    'graph:impact': 'node scripts/run-pinned-gitnexus.mjs impact',
    'graph:trace': 'node scripts/run-pinned-gitnexus.mjs trace',
  };
  const hopLe = (overrides = {}) => ({
    scripts,
    trackedFiles: ['scripts/run-pinned-gitnexus.mjs', 'tooling/agent-tools.json'],
    existingFiles: new Set(['scripts/run-pinned-gitnexus.mjs', 'tooling/agent-tools.json']),
    agentTools: { gitnexus: { version: '1.6.9', analyzeArgs: ['--index-only', '--skip-agents-md', '--worker-timeout', '60'] } },
    workflowRuns: ['node scripts/check-agent-contract.mjs'],
    ...overrides,
  });
  const coLoi = (input, id) => {
    assert.equal(typeof gate.checkRepositoryContract, 'function', 'gate phải kiểm cấu hình repo thật');
    return gate.checkRepositoryContract(input).some(p => p.id === id);
  };

  it('bắt wrapper hoặc pin bị mất', () => {
    assert.equal(coLoi(hopLe({ existingFiles: new Set(['tooling/agent-tools.json']) }), 'missing-gitnexus-wrapper'), true);
    assert.equal(coLoi(hopLe({ agentTools: { gitnexus: { version: 'latest', analyzeArgs: [] } } }), 'invalid-gitnexus-pin'), true);
  });

  it('bắt alias thiếu hoặc trỏ khỏi wrapper', () => {
    const thieu = { ...scripts };
    delete thieu['graph:status'];
    assert.equal(coLoi(hopLe({ scripts: thieu }), 'invalid-gitnexus-alias'), true);
    assert.equal(coLoi(hopLe({ scripts: { ...scripts, 'graph:impact': 'npx gitnexus impact' } }), 'invalid-gitnexus-alias'), true);
  });

  it('bắt graph artifact hoặc skill sinh mặc định được track', () => {
    for (const file of [
      '.ua/meta.json',
      '.gitnexus/manifest.json',
      '.agents/skills/generated/gitnexus/SKILL.md',
      '.agents/skills/gitnexus/SKILL.md',
      '.claude/skills/generated/gitnexus/SKILL.md',
      '.claude/skills/gitnexus/SKILL.md',
    ]) {
      assert.equal(coLoi(hopLe({ trackedFiles: [...hopLe().trackedFiles, file] }), 'tracked-generated-graph'), true, file);
    }
  });

  it('chỉ bắt GitNexus MCP dự án và graph bắt buộc trong workflow', () => {
    const trackedMcp = [...hopLe().trackedFiles, '.mcp.json'];
    assert.equal(coLoi(hopLe({
      trackedFiles: trackedMcp,
      projectMcp: { mcpServers: { gitnexus: { command: 'node', args: ['scripts/run-pinned-gitnexus.mjs', 'mcp'] } } },
    }), 'project-graph-integration'), true);
    assert.equal(coLoi(hopLe({
      trackedFiles: trackedMcp,
      projectMcp: { mcpServers: { unrelated: { command: 'example-mcp' } } },
    }), 'project-graph-integration'), false);
    assert.equal(coLoi(hopLe({ workflowRuns: ['node scripts/run-pinned-gitnexus.mjs analyze'] }), 'mandatory-graph-workflow'), true);
  });

  it('parser workflow bỏ comment lịch sử nhưng giữ lệnh graph đang hoạt động', () => {
    assert.equal(typeof gate.workflowRunsFromText, 'function', 'phải parse YAML thay vì quét comment');
    const chiComment = 'jobs:\n  test:\n    steps:\n      # đã từng chạy graph:analyze\n      - run: node scripts/check-agent-contract.mjs\n';
    const dangChay = 'jobs:\n  test:\n    steps:\n      - run: npm run graph:analyze\n';
    assert.equal(coLoi(hopLe({ workflowRuns: gate.workflowRunsFromText(chiComment) }), 'mandatory-graph-workflow'), false);
    assert.equal(coLoi(hopLe({ workflowRuns: gate.workflowRunsFromText(dangChay) }), 'mandatory-graph-workflow'), true);
  });
});

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
