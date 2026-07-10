// Registry dataset export Excel (Phase 9D) — mỗi entity khai báo TƯỜNG MINH:
// cột select (không còn select('*') — không kéo cột nhạy cảm/thừa), thứ tự ổn
// định (orderBy + tiebreaker id do fetcher gắn), transform, và hàm ghi file
// (excelHelpers giữ nguyên format cột như cũ).
//
// SỬA 3 lỗi "cột ma" của bản select('*') cũ (dữ liệu xuất ra rỗng/Invalid Date
// mà không ai báo):
//  - invoices: billing_period_from/to KHÔNG tồn tại trong schema → suy từ
//    billing_month (đầu/cuối tháng); Khách hàng/Căn hộ trước đây luôn rỗng vì
//    select cũ không lấy room + tenant nằm sâu trong contract → nay lấy đủ +
//    hoist tenant lên đúng chỗ helper đọc.
//  - payments: cột thật là receipt_number → alias reference_number qua PostgREST.
//  - contracts: select cũ thiếu tenants.phone → cột SĐT luôn rỗng; nay lấy đủ.
import { endOfMonth, format, parse, startOfMonth } from "date-fns";
import {
  exportBuildings,
  exportRooms,
  exportTenants,
  exportContracts,
  exportInvoices,
  exportLeads,
  exportPayments,
} from "@/lib/excelHelpers";

export type ExportEntity =
  | "buildings" | "rooms" | "tenants" | "contracts" | "invoices" | "leads" | "payments";

export interface ExportDatasetSpec {
  title: string;
  description: string;
  table: string;
  /** Cột tường minh khi KHÔNG kèm quan hệ. */
  baseSelect: string;
  /** Cột tường minh khi kèm quan hệ (checkbox "Bao gồm thông tin liên quan"). */
  relationsSelect?: string;
  /** Cột sort ổn định (fetcher tự thêm tiebreaker .order("id")). */
  orderBy: string;
  /** Có lọc deleted_at IS NULL không (payments không có soft delete). */
  softDelete: boolean;
  /** Biến đổi rows trước khi ghi file (hoist quan hệ, suy cột dẫn xuất...). */
  transform?: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
  /** Ghi file xlsx (excelHelpers — format cột giữ nguyên bản cũ). */
  run: (rows: never[]) => Promise<void>;
}

// billing_month "2026-07" → {from: 2026-07-01, to: 2026-07-31} cho cột Kỳ từ/đến.
function billingMonthRange(billingMonth: unknown): { from: string | null; to: string | null } {
  if (typeof billingMonth !== "string" || !/^\d{4}-\d{2}$/.test(billingMonth)) {
    return { from: null, to: null };
  }
  const start = startOfMonth(parse(billingMonth + "-01", "yyyy-MM-dd", new Date()));
  return {
    from: format(start, "yyyy-MM-dd"),
    to: format(endOfMonth(start), "yyyy-MM-dd"),
  };
}

export const EXPORT_DATASETS: Record<ExportEntity, ExportDatasetSpec> = {
  buildings: {
    title: "Xuất danh sách Tòa nhà",
    description: "Xuất toàn bộ hoặc một phần danh sách tòa nhà ra file Excel",
    table: "buildings",
    baseSelect:
      "id, code, name, type, province, district, ward, street_address, total_floors, total_rooms, status, created_at",
    orderBy: "name",
    softDelete: true,
    run: exportBuildings as (rows: never[]) => Promise<void>,
  },
  rooms: {
    title: "Xuất danh sách Căn hộ",
    description: "Xuất toàn bộ hoặc một phần danh sách căn hộ ra file Excel",
    table: "rooms",
    baseSelect:
      "id, code, name, floor, area, rent_price, deposit_amount, max_occupants, status, building_id, created_at",
    relationsSelect:
      "id, code, name, floor, area, rent_price, deposit_amount, max_occupants, status, building_id, created_at, building:buildings(name)",
    orderBy: "name",
    softDelete: true,
    run: exportRooms as (rows: never[]) => Promise<void>,
  },
  tenants: {
    title: "Xuất danh sách Khách hàng",
    description: "Xuất toàn bộ hoặc một phần danh sách khách hàng ra file Excel",
    table: "tenants",
    baseSelect:
      "id, full_name, phone, email, id_number, date_of_birth, gender, permanent_address, status, created_at",
    orderBy: "full_name",
    softDelete: true,
    run: exportTenants as (rows: never[]) => Promise<void>,
  },
  contracts: {
    title: "Xuất danh sách Hợp đồng",
    description: "Xuất toàn bộ hoặc một phần danh sách hợp đồng ra file Excel",
    table: "contracts",
    baseSelect:
      "id, contract_number, start_date, end_date, rent_price, total_deposit, status, room_id, created_at",
    relationsSelect:
      "id, contract_number, start_date, end_date, rent_price, total_deposit, status, room_id, created_at, tenant:tenants(full_name, phone), room:rooms(name, building:buildings(name))",
    orderBy: "start_date",
    softDelete: true,
    run: exportContracts as (rows: never[]) => Promise<void>,
  },
  invoices: {
    title: "Xuất danh sách Hóa đơn",
    description: "Xuất toàn bộ hoặc một phần danh sách hóa đơn ra file Excel",
    table: "invoices",
    baseSelect:
      "id, invoice_number, billing_month, subtotal, total_amount, paid_amount, status, due_date, building_id, created_at",
    relationsSelect:
      "id, invoice_number, billing_month, subtotal, total_amount, paid_amount, status, due_date, building_id, created_at, room:rooms(name), contract:contracts(contract_number, tenant:tenants(full_name))",
    orderBy: "billing_month",
    softDelete: true,
    transform: (rows) =>
      rows.map((r) => {
        const range = billingMonthRange(r.billing_month);
        const contract = r.contract as { tenant?: unknown } | null | undefined;
        return {
          ...r,
          billing_period_from: range.from,
          billing_period_to: range.to,
          // helper đọc item.tenant trực tiếp — hoist từ contract.tenant lên.
          tenant: contract?.tenant ?? null,
        };
      }),
    run: exportInvoices as (rows: never[]) => Promise<void>,
  },
  leads: {
    title: "Xuất danh sách Khách hẹn",
    description: "Xuất toàn bộ hoặc một phần danh sách khách hẹn ra file Excel",
    table: "leads",
    baseSelect:
      "id, customer_name, phone, email, source, status, appointment_date, notes, building_id, room_id, created_at",
    relationsSelect:
      "id, customer_name, phone, email, source, status, appointment_date, notes, building_id, room_id, created_at, room:rooms(name, building:buildings(name))",
    orderBy: "created_at",
    softDelete: true,
    run: exportLeads as (rows: never[]) => Promise<void>,
  },
  payments: {
    title: "Xuất danh sách Thanh toán",
    description: "Xuất toàn bộ hoặc một phần danh sách thanh toán ra file Excel",
    table: "payments",
    // cột thật là receipt_number — alias về reference_number cho helper.
    baseSelect:
      "id, amount, payment_date, payment_method, reference_number:receipt_number, notes, invoice_id, created_at",
    relationsSelect:
      "id, amount, payment_date, payment_method, reference_number:receipt_number, notes, invoice_id, created_at, invoice:invoices(invoice_number, contract:contracts(contract_number, tenant:tenants(full_name, phone)))",
    orderBy: "payment_date",
    softDelete: false,
    run: exportPayments as (rows: never[]) => Promise<void>,
  },
};
