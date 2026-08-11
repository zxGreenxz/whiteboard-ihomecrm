/**
 * Khai báo kiểu cho những script `.mjs` mà TEST import trực tiếp.
 *
 * VÌ SAO CẦN
 *   Vài test đối chiếu kết quả của chính gate với dữ liệu thật —
 *   `navRoutesExist` gọi `collectAllRoutes()` của `check-route-guards.mjs` để
 *   khỏi chép tay danh sách route. Đó là cách làm ĐÚNG (test kiểm code thật, không
 *   kiểm bản chép), nhưng `.mjs` không có khai báo kiểu nên mỗi lời import là một
 *   lỗi `TS7016` dưới `noImplicitAny`. Sáu lỗi như vậy đang CHẶN việc mở đảo strict
 *   từ 246 lên 1144 file (xem `tooling/plan-remaining.json`, lô 93).
 *
 * RỦI RO TRÔI, VÀ CÁCH ĐÃ CHẶN
 *   Khai báo viết tay có thể lệch khỏi `.mjs` thật: đổi tên export ở script thì
 *   file này vẫn nói nó tồn tại, và trình biên dịch im lặng. Đó đúng lớp lỗi
 *   "bản chép trôi khỏi bản gốc" mà repo này đã trả giá nhiều lần.
 *
 *   `src/types/__tests__/scriptsMjsDeclarations.test.ts` nạp thật ba module rồi
 *   đối chiếu từng tên khai ở đây — trôi một cái là test đỏ ngay, kèm tên.
 *
 *   Chỉ khai những export mà test THẬT SỰ dùng. Khai thừa là mở thêm bề mặt phải
 *   canh mà không đổi lại được gì.
 */

declare module "*/scripts/check-route-guards.mjs" {
  /**
   * Một `<Route>` bóc được từ cây route. Ba trường này là thứ script thật sự
   * đẩy vào (xem `collectRoutes`); KHÔNG dùng index signature `[key: string]:
   * unknown` — bản đầu khai vậy và làm `guards`/`redirect` thành `unknown`,
   * khiến chính test đang dùng chúng báo lỗi.
   */
  export interface RouteEntry {
    path: string;
    guards: string[];
    redirect: boolean;
  }
  export function collectRoutes(sourceText: string): RouteEntry[];
  export function collectAllRoutes(): RouteEntry[];
}

declare module "*/scripts/check-risk-classifier.mjs" {
  export interface RiskTier {
    paths?: string[];
    [key: string]: unknown;
  }
  // Trả RegExp chứ KHÔNG phải string — bản khai đầu tiên ghi `string` và trình
  // biên dịch bắt ngay ở `riskMapCoverage.test.ts` vì test gọi `.test()`.
  export function globSangRegex(glob: string): RegExp;
  export function khopGlob(duong: string, glob: string): boolean;
  export function xepTier(duong: string, tiers: Record<string, RiskTier>): string | null;
}

declare module "*/scripts/audit-finance-v2-rollout.mjs" {
  /** Báo cáo `finance_v2_audit` do SQL harness trả về. */
  export interface FinanceV2AuditReport {
    schema_applied: boolean;
    [key: string]: unknown;
  }
  export interface FinanceV2AuditVerdict {
    cutoverReady: boolean;
    blockers: string[];
    phase: string;
  }
  export function parseAuditResponse(body: string): FinanceV2AuditReport;
  export function evaluateFinanceV2Audit(report: FinanceV2AuditReport): FinanceV2AuditVerdict;
}
