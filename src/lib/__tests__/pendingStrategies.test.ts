import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { PENDING_STRATEGIES, pendingStrategyOf } from "@/lib/pendingStrategies";

// Gate chống tái phát: mọi nơi dựng bộ chống ghi trùng bền phải dùng một namespace đã khai trong sổ chiến
// lược. Namespace mới chưa khai là đỏ: người thêm phải quyết nơi đó đối chiếu với máy chủ bằng cách nào
// (A/B/C/D) hay tạm dùng hộp cảnh báo (`van`), thay vì để một lần rớt mạng khoá người dùng mà không ai biết.

/**
 * Nơi dựng dấu mà namespace không viết thẳng thành chuỗi ở chỗ gọi. Mỗi tệp khai số lời gọi như vậy và các
 * namespace thật của nó; thêm một lời gọi nữa mà không khai là đỏ.
 */
const DYNAMIC_SITES: Record<string, { calls: number; namespaces: string[] }> = {
  // `const namespace='contract-excel-import'` dùng chung cho cả kho ảnh chụp lượt nhập.
  "src/lib/contractImportWorkflow.ts": { calls: 1, namespaces: ["contract-excel-import"] },
  // `ghiAnhHoSo(namespace, …)` nhận namespace từ ba nơi gọi trong cùng tệp.
  "src/lib/residenceDossierFiles.ts": {
    calls: 1,
    namespaces: ["residence-dossier-upload", "residence-dossier-term", "residence-dossier-remove"],
  },
};
/** Nơi dựng thẳng `FinancialWorkflowGuard` với phạm vi tự viết, ngoài nhà máy `persistentFinancialWorkflow`. */
const DIRECT_GUARD_SITES: Record<string, string[]> = {
  "src/lib/luckyDrawApi.ts": ["lucky-public-draw"],
};
/** Nhà máy `persistentFinancialWorkflow`: nơi định nghĩa, không phải nơi dùng. */
const DEFINITION_FILES = new Set(["src/lib/persistentFinancialWorkflow.ts"]);

interface FileUsage { literals: string[]; dynamicCalls: number; directGuards: number }

/**
 * Đọc cây cú pháp của một tệp nguồn: namespace viết thẳng, số lời gọi không viết thẳng, số guard dựng trực
 * tiếp. Dùng cây cú pháp thay vì dò chuỗi để chú thích và chuỗi ký tự kể lại về mã không bị tính là nơi dùng.
 */
function scanPendingUsage(source: string, fileName = "sample.ts"): FileUsage {
  const usage: FileUsage = { literals: [], dynamicCalls: 0, directGuards: 0 };
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const literalOf = (node: ts.Node | undefined) => (node && ts.isStringLiteralLike(node) ? node.text : null);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      let namespace: string | null | undefined;
      if (node.expression.text === "persistentFinancialWorkflow") namespace = literalOf(node.arguments[0]);
      if (node.expression.text === "runFinancialPending") {
        const scope = node.arguments[0];
        const property = scope && ts.isObjectLiteralExpression(scope)
          ? scope.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && item.name.getText(file) === "namespace")
          : undefined;
        namespace = literalOf(property?.initializer);
      }
      if (namespace) usage.literals.push(namespace);
      else if (namespace === null) usage.dynamicCalls += 1;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "FinancialWorkflowGuard") usage.directGuards += 1;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return usage;
}

/** Mọi chuỗi ký tự viết trong mã của tệp (không gồm chú thích). */
function stringLiterals(source: string, fileName: string): Set<string> {
  const found = new Set<string>();
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) found.push(full);
    }
  };
  walk(join(root, "src"));
  return found;
}

function scanRepository() {
  const root = process.cwd();
  const used = new Map<string, Set<string>>();
  const undeclaredDynamic: string[] = [];
  const undeclaredDirect: string[] = [];
  const staleDeclarations: string[] = [];
  const note = (namespace: string, file: string) => used.set(namespace, (used.get(namespace) ?? new Set()).add(file));

  const declared = new Set([...Object.keys(DYNAMIC_SITES), ...Object.keys(DIRECT_GUARD_SITES)]);
  for (const full of sourceFiles(root)) {
    const file = relative(root, full).split(sep).join("/");
    if (DEFINITION_FILES.has(file)) continue;
    const source = readFileSync(full, "utf8");
    // Phân tích cú pháp chỉ những tệp có nhắc tới bộ chống ghi trùng; phần còn lại không thể là nơi dùng.
    if (!/persistentFinancialWorkflow|runFinancialPending|FinancialWorkflowGuard/.test(source)) continue;
    declared.delete(file);
    const usage = scanPendingUsage(source, file);
    const strings = stringLiterals(source, file);
    usage.literals.forEach((namespace) => note(namespace, file));

    const dynamic = DYNAMIC_SITES[file];
    if (usage.dynamicCalls !== (dynamic?.calls ?? 0)) undeclaredDynamic.push(`${file}: ${usage.dynamicCalls} lời gọi không viết thẳng namespace`);
    const direct = DIRECT_GUARD_SITES[file];
    if ((usage.directGuards > 0) !== Boolean(direct)) undeclaredDirect.push(`${file}: ${usage.directGuards} guard dựng trực tiếp`);

    for (const namespace of [...(dynamic?.namespaces ?? []), ...(direct ?? [])]) {
      // Lời khai phải còn đúng với tệp: namespace khai ở trên phải thật sự nằm trong mã của tệp đó.
      if (strings.has(namespace)) note(namespace, file);
      else staleDeclarations.push(`${file}: ${namespace}`);
    }
  }
  // Tệp đã khai ở trên mà không còn dùng bộ chống ghi trùng: lời khai đã cũ.
  declared.forEach((file) => staleDeclarations.push(`${file}: không còn là nơi dùng`));
  return { used, undeclaredDynamic, undeclaredDirect, staleDeclarations };
}

describe("sổ chiến lược đối chiếu", () => {
  const scan = scanRepository();

  it("mọi namespace đang dùng trong mã nguồn đều đã khai trong sổ", () => {
    const missing = [...scan.used.entries()]
      .filter(([namespace]) => !pendingStrategyOf(namespace))
      .map(([namespace, files]) => `${namespace} (${[...files].join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("sổ không giữ dòng nào mà mã nguồn không còn dùng", () => {
    expect(Object.keys(PENDING_STRATEGIES).filter((namespace) => !scan.used.has(namespace))).toEqual([]);
  });

  it("nơi không viết thẳng namespace, hoặc dựng guard trực tiếp, phải được khai tên ở đầu tệp này", () => {
    expect(scan.undeclaredDynamic).toEqual([]);
    expect(scan.undeclaredDirect).toEqual([]);
    expect(scan.staleDeclarations).toEqual([]);
  });

  it("mỗi dòng có nhãn đọc được và một cách đối chiếu hợp lệ", () => {
    for (const [namespace, strategy] of Object.entries(PENDING_STRATEGIES)) {
      expect(strategy.label.trim(), namespace).toBe(strategy.label);
      expect(strategy.label.length, namespace).toBeGreaterThan(3);
      expect(["A", "B", "C", "D", "van"], namespace).toContain(strategy.reconcile);
      expect(typeof strategy.money, namespace).toBe("boolean");
    }
    expect(pendingStrategyOf("constructor")).toBeUndefined();
  });
});

describe("bộ quét nơi dùng", () => {
  it("bắt namespace viết thẳng ở cả hai họ, kể cả khi lời gọi xuống dòng", () => {
    expect(scanPendingUsage(`
      const guard = persistentFinancialWorkflow('room-create');
      const other = useRef(persistentFinancialWorkflow("salary-lock", { scope: 'actor' }));
      await runFinancialPending({
        namespace:'invoice-cancel',userId:user.id,
      }, work);
    `)).toEqual({ literals: ["room-create", "salary-lock", "invoice-cancel"], dynamicCalls: 0, directGuards: 0 });
  });

  it("đếm lời gọi không viết thẳng namespace và guard dựng trực tiếp", () => {
    expect(scanPendingUsage(`
      return persistentFinancialWorkflow(namespace, { scope: 'actor' }).run(key, operation, task);
      await runFinancialPending(scope, work);
      const guard = new FinancialWorkflowGuard({ scope: async key => ({ namespace: 'x', userId, organizationId, businessKey: key }) });
    `)).toEqual({ literals: [], dynamicCalls: 2, directGuards: 1 });
  });

  // Chú thích kể lại về mã không được tính là nơi dùng: nếu tính, một dòng sổ đã chết vẫn "còn dùng" nhờ một
  // câu chú thích, và một namespace chỉ có trong chú thích lại bị đòi khai.
  it("không tính lời gọi nằm trong chú thích", () => {
    expect(scanPendingUsage(`
      // persistentFinancialWorkflow('ghost-line') từng ở đây
      /**
       * persistentFinancialWorkflow('ghost-doc') và runFinancialPending({namespace:'ghost-action'})
       */
      const x = 1;
      {/* persistentFinancialWorkflow('ghost-jsx') */}
    `)).toEqual({ literals: [], dynamicCalls: 0, directGuards: 0 });
  });
});
