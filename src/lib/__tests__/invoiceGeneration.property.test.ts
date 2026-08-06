import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * ĐÂY LÀ TEST MÔ HÌNH, KHÔNG PHẢI TEST CỦA RPC.
 *
 * Logic sinh hoá đơn thật nằm trong hàm PostgreSQL `generate_invoices_for_building`,
 * không phải TypeScript — nên không có gì để import vào Vitest. File này viết một
 * bản MÔ PHỎNG bằng TS rồi kiểm tính chất trên bản mô phỏng đó.
 *
 * Cần nói thẳng để không ai đọc nhầm: các ca dưới đây XANH không chứng minh RPC
 * đúng. Chúng chứng minh bản mô phỏng tự nhất quán. RPC có thể đổi hành vi mà file
 * này vẫn xanh — chú thích cũ ("Mirrors the behavior of the RPC") là một lời khẳng
 * định mà không có gì kiểm.
 *
 * Vẫn giữ vì có giá trị thật: nó là ĐẶC TẢ CHẠY ĐƯỢC của luật sinh hoá đơn, bắt
 * được sai sót trong chính cách nghĩ. Nhưng để nó không trôi khỏi thực tế như các
 * bản chép khác trong repo (xem contractRoomFilter, meterReadingFormBugfix), khối
 * cuối file neo mô hình vào ĐỊNH NGHĨA SQL ĐANG CHẠY.
 */

// =============================================
// Types
// =============================================

type InvoiceType = 'rent_only' | 'service_only' | 'both';
type InvoiceItemType = 'RENT' | 'SERVICE' | 'PENALTY' | 'DISCOUNT' | 'OTHER';

interface ContractInfo {
  id: string;
  room_id: string;
  rent_amount: number;
  services: Array<{ name: string; price: number }>;
}

interface GeneratedInvoice {
  contract_id: string;
  billing_month: string;
  items: Array<{ type: InvoiceItemType; description: string; unit_price: number }>;
}

// =============================================
// Model Function (pure logic mirroring RPC behavior)
// =============================================

/**
 * Model the invoice generation logic as a pure function.
 * Mirrors the behavior of the `generate_invoices_for_building` RPC function.
 */
function generateInvoicesForBuilding(
  contracts: ContractInfo[],
  billingMonth: string,
  invoiceType: InvoiceType,
  existingInvoices: Array<{ contract_id: string; billing_month: string }>,
): GeneratedInvoice[] {
  const results: GeneratedInvoice[] = [];

  for (const contract of contracts) {
    // Skip if already exists (idempotence)
    const exists = existingInvoices.some(
      (inv) => inv.contract_id === contract.id && inv.billing_month === billingMonth,
    );
    if (exists) continue;

    const items: GeneratedInvoice['items'] = [];

    if (invoiceType === 'rent_only' || invoiceType === 'both') {
      items.push({ type: 'RENT', description: 'Tiền thuê', unit_price: contract.rent_amount });
    }

    if (invoiceType === 'service_only' || invoiceType === 'both') {
      for (const service of contract.services) {
        items.push({ type: 'SERVICE', description: service.name, unit_price: service.price });
      }
    }

    if (items.length > 0) {
      results.push({ contract_id: contract.id, billing_month: billingMonth, items });
    }
  }

  return results;
}

// =============================================
// Shared Arbitraries
// =============================================

const invoiceTypeArb = fc.constantFrom<InvoiceType>('rent_only', 'service_only', 'both');

const billingMonthArb = fc.integer({ min: 2020, max: 2030 }).chain((year) =>
  fc.integer({ min: 1, max: 12 }).map((month) => `${year}-${String(month).padStart(2, '0')}`),
);

const serviceArb = fc.record({
  name: fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/),
  price: fc.double({ min: 1, max: 10_000_000, noNaN: true, noDefaultInfinity: true }),
});

const contractArb = fc.record({
  id: fc.uuid(),
  room_id: fc.uuid(),
  rent_amount: fc.double({ min: 100, max: 50_000_000, noNaN: true, noDefaultInfinity: true }),
  services: fc.array(serviceArb, { minLength: 1, maxLength: 5 }),
});

const contractNoServicesArb = fc.record({
  id: fc.uuid(),
  room_id: fc.uuid(),
  rent_amount: fc.double({ min: 100, max: 50_000_000, noNaN: true, noDefaultInfinity: true }),
  services: fc.constant([] as Array<{ name: string; price: number }>),
});

// =============================================
// Property 9: Loại hình thức sinh hoá đơn quyết định loại dòng dịch vụ
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 9: Loại hình thức sinh hoá đơn quyết định loại dòng dịch vụ
 *
 * Với bất kỳ lần sinh hoá đơn tự động:
 * - invoice_type = 'rent_only' → tất cả items type = 'RENT'
 * - invoice_type = 'service_only' → tất cả items type = 'SERVICE'
 * - invoice_type = 'both' → items chứa ít nhất một RENT và ít nhất một SERVICE
 *   (nếu hợp đồng có dịch vụ)
 *
 * **Validates: Requirements 6.4, 6.5, 6.6**
 */
describe('Feature: invoice-reimplementation, Property 9: Loại hình thức sinh hoá đơn quyết định loại dòng dịch vụ', () => {
  it('rent_only generates only RENT items', () => {
    fc.assert(
      fc.property(
        fc.array(contractArb, { minLength: 1, maxLength: 5 }),
        billingMonthArb,
        (contracts, billingMonth) => {
          const invoices = generateInvoicesForBuilding(contracts, billingMonth, 'rent_only', []);

          for (const invoice of invoices) {
            expect(invoice.items.length).toBeGreaterThan(0);
            for (const item of invoice.items) {
              expect(item.type).toBe('RENT');
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('service_only generates only SERVICE items', () => {
    fc.assert(
      fc.property(
        fc.array(contractArb, { minLength: 1, maxLength: 5 }),
        billingMonthArb,
        (contracts, billingMonth) => {
          const invoices = generateInvoicesForBuilding(contracts, billingMonth, 'service_only', []);

          for (const invoice of invoices) {
            expect(invoice.items.length).toBeGreaterThan(0);
            for (const item of invoice.items) {
              expect(item.type).toBe('SERVICE');
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('both generates at least one RENT and at least one SERVICE item (when contract has services)', () => {
    fc.assert(
      fc.property(
        fc.array(contractArb, { minLength: 1, maxLength: 5 }),
        billingMonthArb,
        (contracts, billingMonth) => {
          const invoices = generateInvoicesForBuilding(contracts, billingMonth, 'both', []);

          for (const invoice of invoices) {
            const contract = contracts.find((c) => c.id === invoice.contract_id)!;
            const hasRent = invoice.items.some((item) => item.type === 'RENT');
            const hasService = invoice.items.some((item) => item.type === 'SERVICE');

            expect(hasRent).toBe(true);
            if (contract.services.length > 0) {
              expect(hasService).toBe(true);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('both with no services generates only RENT items', () => {
    fc.assert(
      fc.property(
        fc.array(contractNoServicesArb, { minLength: 1, maxLength: 5 }),
        billingMonthArb,
        (contracts, billingMonth) => {
          const invoices = generateInvoicesForBuilding(contracts, billingMonth, 'both', []);

          for (const invoice of invoices) {
            // Should still have RENT items
            expect(invoice.items.length).toBeGreaterThan(0);
            expect(invoice.items.every((item) => item.type === 'RENT')).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('service_only with no services generates no invoices for those contracts', () => {
    fc.assert(
      fc.property(
        fc.array(contractNoServicesArb, { minLength: 1, maxLength: 5 }),
        billingMonthArb,
        (contracts, billingMonth) => {
          const invoices = generateInvoicesForBuilding(contracts, billingMonth, 'service_only', []);

          // Contracts with no services should produce no invoices (items would be empty)
          expect(invoices.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('invoice_type determines item types for any valid type', () => {
    fc.assert(
      fc.property(
        fc.array(contractArb, { minLength: 1, maxLength: 5 }),
        billingMonthArb,
        invoiceTypeArb,
        (contracts, billingMonth, invoiceType) => {
          const invoices = generateInvoicesForBuilding(contracts, billingMonth, invoiceType, []);

          for (const invoice of invoices) {
            const itemTypes = new Set(invoice.items.map((item) => item.type));

            if (invoiceType === 'rent_only') {
              expect(itemTypes.size).toBe(1);
              expect(itemTypes.has('RENT')).toBe(true);
            } else if (invoiceType === 'service_only') {
              for (const type of itemTypes) {
                expect(type).toBe('SERVICE');
              }
            } else {
              // 'both'
              expect(itemTypes.has('RENT')).toBe(true);
              const contract = contracts.find((c) => c.id === invoice.contract_id)!;
              if (contract.services.length > 0) {
                expect(itemTypes.has('SERVICE')).toBe(true);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================
// Property 10: Sinh hoá đơn không tạo trùng lặp (Idempotence)
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 10: Sinh hoá đơn không tạo trùng lặp (Idempotence)
 *
 * Với bất kỳ toà nhà và kỳ thanh toán, nếu đã tồn tại hoá đơn cho một hợp đồng
 * trong kỳ đó, việc sinh hoá đơn lần thứ hai phải bỏ qua hợp đồng đó.
 * Số hoá đơn sau 2 lần sinh phải bằng số hoá đơn sau 1 lần sinh.
 *
 * **Validates: Requirements 6.7**
 */
describe('Feature: invoice-reimplementation, Property 10: Sinh hoá đơn không tạo trùng lặp (Idempotence)', () => {
  it('generating twice produces the same invoice count as generating once', () => {
    fc.assert(
      fc.property(
        fc.array(contractArb, { minLength: 1, maxLength: 5 }),
        billingMonthArb,
        invoiceTypeArb,
        (contracts, billingMonth, invoiceType) => {
          // First generation: no existing invoices
          const firstGeneration = generateInvoicesForBuilding(contracts, billingMonth, invoiceType, []);

          // Build existing invoices from first generation
          const existingAfterFirst = firstGeneration.map((inv) => ({
            contract_id: inv.contract_id,
            billing_month: inv.billing_month,
          }));

          // Second generation: pass existing invoices
          const secondGeneration = generateInvoicesForBuilding(
            contracts,
            billingMonth,
            invoiceType,
            existingAfterFirst,
          );

          // Second generation should produce zero new invoices
          expect(secondGeneration.length).toBe(0);

          // Total after two generations equals first generation
          const totalInvoices = firstGeneration.length + secondGeneration.length;
          expect(totalInvoices).toBe(firstGeneration.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('existing invoices for a contract are skipped', () => {
    fc.assert(
      fc.property(
        fc.array(contractArb, { minLength: 2, maxLength: 5 }),
        billingMonthArb,
        invoiceTypeArb,
        (contracts, billingMonth, invoiceType) => {
          // Mark the first contract as already having an invoice
          const existingInvoices = [{ contract_id: contracts[0].id, billing_month: billingMonth }];

          const invoices = generateInvoicesForBuilding(contracts, billingMonth, invoiceType, existingInvoices);

          // The first contract should be skipped
          const generatedContractIds = invoices.map((inv) => inv.contract_id);
          expect(generatedContractIds).not.toContain(contracts[0].id);

          // Other contracts should still get invoices (if they produce items)
          const expectedCount = contracts.length - 1;
          // For service_only with no services, some contracts may not produce invoices
          expect(invoices.length).toBeLessThanOrEqual(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('existing invoices for a different billing month do not affect generation', () => {
    fc.assert(
      fc.property(
        fc.array(contractArb, { minLength: 1, maxLength: 5 }),
        billingMonthArb,
        billingMonthArb,
        invoiceTypeArb,
        (contracts, billingMonth, otherMonth, invoiceType) => {
          fc.pre(billingMonth !== otherMonth);

          // Existing invoices are for a different month
          const existingInvoices = contracts.map((c) => ({
            contract_id: c.id,
            billing_month: otherMonth,
          }));

          const invoices = generateInvoicesForBuilding(contracts, billingMonth, invoiceType, existingInvoices);

          // All contracts should still get invoices for the new month
          // (unless service_only with no services)
          if (invoiceType !== 'service_only') {
            expect(invoices.length).toBe(contracts.length);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('idempotence holds even with mixed existing invoices', () => {
    fc.assert(
      fc.property(
        fc.array(contractArb, { minLength: 3, maxLength: 6 }),
        billingMonthArb,
        invoiceTypeArb,
        fc.integer({ min: 1 }),
        (contracts, billingMonth, invoiceType, splitSeed) => {
          // Split contracts: some already have invoices, some don't
          const splitIndex = (splitSeed % (contracts.length - 1)) + 1;
          const existingInvoices = contracts.slice(0, splitIndex).map((c) => ({
            contract_id: c.id,
            billing_month: billingMonth,
          }));

          // First generation with partial existing
          const firstGen = generateInvoicesForBuilding(contracts, billingMonth, invoiceType, existingInvoices);

          // Combine existing + newly generated
          const allExisting = [
            ...existingInvoices,
            ...firstGen.map((inv) => ({ contract_id: inv.contract_id, billing_month: inv.billing_month })),
          ];

          // Second generation should produce nothing new
          const secondGen = generateInvoicesForBuilding(contracts, billingMonth, invoiceType, allExisting);
          expect(secondGen.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================
// NEO MÔ HÌNH VÀO SQL ĐANG CHẠY
// =============================================

/**
 * Mô hình ở trên giả định hai bất biến của RPC. Khối này kiểm chúng còn trong
 * ĐỊNH NGHĨA SỐNG — quét toàn bộ thư mục migration lấy `CREATE OR REPLACE` cuối
 * cùng, không đọc một file migration cố định (file cũ bị đóng băng bởi
 * migration-policy + băm sha256, nên khẳng định trên nó là hằng số, không phải
 * phép đo — xem scripts/check-migration-test-liveness.mjs).
 *
 * Đây KHÔNG phải parity đầy đủ giữa SQL và mô hình; nó chỉ bảo đảm hai trụ mà mô
 * hình dựa vào không biến mất im lặng. Parity đầy đủ cần chạy RPC thật trên
 * database, thuộc suite khác.
 */
function liveRpcBody(name: string): { file: string; body: string } {
  const dir = 'supabase/migrations';
  // Không dùng regex ở đây: chuỗi mẫu cần nhiều dấu gạch chéo ngược, mà trong
  // template literal thì `\s` bị JS nuốt thành `s` — regex thành vô nghĩa và ném
  // "Unterminated group". Tìm bằng chuỗi thường vừa đủ và không có bẫy escape.
  // Phải neo vào CREATE, không chỉ "FUNCTION public.<tên>": chuỗi sau còn xuất hiện
  // trong GRANT/REVOKE, và bắt trúng một dòng GRANT thì đoạn cắt ra chỉ dài vài
  // chục ký tự — khẳng định bên dưới đỏ vì lý do sai. (Nó ĐÃ đỏ như vậy một lần;
  // may là đỏ chứ không phải xanh giả.)
  const mocs = [
    `CREATE OR REPLACE FUNCTION public.${name}`,
    `CREATE FUNCTION public.${name}`,
  ];
  let hit: { file: string; body: string } | null = null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const text = readFileSync(`${dir}/${f}`, 'utf8');
    const at = mocs.map((m) => text.indexOf(m)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
    if (at < 0) continue;
    const next = text.indexOf('CREATE OR REPLACE FUNCTION', at + 1);
    hit = { file: f, body: text.slice(at, next === -1 ? undefined : next) };
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của public.${name}`);
  return hit;
}

describe('RPC sinh hoá đơn: hai trụ mà mô hình dựa vào', () => {
  const { file, body } = liveRpcBody('generate_invoices_for_building');

  it('vẫn khoá theo billing_month — mô hình giả định mỗi hợp đồng một hoá đơn/tháng', () => {
    expect(body, `định nghĩa sống ở ${file}`).toMatch(/billing_month/i);
  });

  it('vẫn chặn trùng theo (contract_id, billing_month) rồi BỎ QUA', () => {
    // Mất chốt này thì chạy hai lần sinh hoá đơn đôi cho cùng một tháng: nhân đôi
    // số phải thu của khách. Mô hình ở trên khẳng định tính idempotent, nên nếu SQL
    // bỏ chốt mà không ai biết thì cả file này thành lời trấn an sai.
    //
    // Khẳng định theo CƠ CHẾ THẬT, không theo cú pháp tôi đoán: bản đầu tôi tìm
    // `NOT EXISTS|ON CONFLICT` và test đỏ — hoá ra RPC dùng
    // `IF EXISTS (… ) THEN <bỏ qua>`. Test đỏ đúng lúc, và nhờ đó tôi đọc ra cơ chế
    // thật thay vì nới assertion cho nó xanh.
    expect(body, `định nghĩa sống ở ${file}`).toMatch(/EXISTS\s*\(/i);
    expect(body, `định nghĩa sống ở ${file}`).toMatch(/billing_month\s*=\s*p_billing_month/i);
    expect(body, `định nghĩa sống ở ${file}`).toMatch(/contract_id\s*=/i);
    // Nhánh trùng phải dẫn tới BỎ QUA, không phải vẫn ghi tiếp.
    expect(body, `định nghĩa sống ở ${file}`).toMatch(/skip/i);
  });
});
