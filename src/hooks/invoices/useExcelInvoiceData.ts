// Data layer cho ExcelInvoiceDialog (Phase 9C) — fetch + submit orchestration.
// Transform thuần nằm ở src/lib/excelInvoiceRows.ts (có characterization test).
//
// CHỦ Ý không dùng useQuery cho nguồn dữ liệu lập hoá đơn: dialog load theo
// nút "Tải dữ liệu" và số liệu TIỀN phải tươi tại thời điểm bấm (cache stale
// của React Query có thể cho chỉ số điện/nợ cũ đã lỗi thời). Giữ ngữ nghĩa
// fetch-tươi-mỗi-lần-bấm y như bản inline cũ.
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { useCreateInvoice } from "@/hooks/useInvoices";
import { computePreviousDebt } from "@/lib/invoiceHelpers";
import {
  buildCreditByContract,
  buildInvoiceCountByContract,
  buildLastReadingByMeter,
  buildPreviousDebtByContract,
  buildInvoiceFormData,
  dedupeContractsByRoom,
  type ExcelRowData,
  type RawContract,
  type RawOldInvoice,
  type SubmitContext,
} from "@/lib/excelInvoiceRows";
import type { PreviousDebtSource } from "@/types/invoice";

export interface ExcelInvoiceSource {
  /** HĐ ACTIVE của toà, đã gom 1 phòng 1 HĐ (giữ HĐ mới nhất). */
  contracts: RawContract[];
  /** Tên các phòng có >1 HĐ ACTIVE (dữ liệu lỗi — cần thanh lý HĐ cũ). */
  dupRoomNames: string[];
  meterByRoom: Map<string, string>;
  lastReading: Map<string, number>;
  creditByContract: Map<string, number>;
  invoiceCountByContract: Map<string, number>;
  previousDebtByContract: Map<string, { total: number; sources: PreviousDebtSource[] }>;
}

/** Tải 5 nguồn dữ liệu lập hoá đơn cho 1 toà (thứ tự query giữ như bản cũ). */
export async function fetchExcelInvoiceSource(buildingId: string): Promise<ExcelInvoiceSource> {
  // 1) Active contracts (lọc theo building qua room → building).
  const { data: contracts, error: e1 } = await supabase
    .from("contracts")
    .select(
      `id, rent_price, room_id, status, total_deposit, deposit_paid, deposit_remaining, discounts, start_date, created_at,
       room:rooms!contracts_room_id_fkey (id, name, building_id),
       contract_customers!contract_customers_contract_id_fkey (id),
       contract_services (
         service_id, unit_price,
         service:services!contract_services_service_id_fkey (name, pricing_type)
       )`,
    )
    .in("status", ["ACTIVE"])
    .is("deleted_at", null);
  if (e1) throw e1;
  const buildingContractsRaw = ((contracts ?? []) as unknown as RawContract[]).filter(
    (c) => c.room?.building_id === buildingId,
  );
  const { contracts: buildingContracts, dupRoomNames } =
    dedupeContractsByRoom(buildingContractsRaw);

  // 2) Đồng hồ điện của toà.
  const { data: meters, error: e2 } = await supabase
    .from("meters")
    .select("id, room_id, meter_type")
    .eq("building_id", buildingId)
    .eq("meter_type", "ELECTRICITY")
    .is("deleted_at", null);
  if (e2) throw e2;
  const meterByRoom = new Map<string, string>();
  (meters ?? []).forEach((m) => {
    if (m.room_id) meterByRoom.set(m.room_id, m.id);
  });

  // 3) Chỉ số APPROVED mới nhất per meter.
  const meterIds = (meters ?? []).map((m) => m.id);
  let lastReading = new Map<string, number>();
  if (meterIds.length > 0) {
    const { data: readings, error: e3 } = await supabase
      .from("meter_readings")
      .select("meter_id, current_reading, reading_date")
      .in("meter_id", meterIds)
      .eq("status", "APPROVED")
      .is("deleted_at", null)
      .order("reading_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (e3) throw e3;
    lastReading = buildLastReadingByMeter((readings ?? []) as never);
  }

  const contractIds = buildingContracts.map((c) => c.id);

  // 4) Credit (excess_amounts) per contract.
  let creditByContract = new Map<string, number>();
  if (contractIds.length > 0) {
    const { data: credits, error: e4 } = await supabase
      .from("excess_amounts")
      .select("contract_id, amount, source_invoice:invoices!source_invoice_id(deleted_at)")
      .in("contract_id", contractIds);
    if (e4) throw e4;
    creditByContract = buildCreditByContract((credits ?? []) as never);
  }

  // 5b) Đếm HĐ đã có per contract → slot khuyến mãi.
  let invoiceCountByContract = new Map<string, number>();
  if (contractIds.length > 0) {
    const { data: allInvoices, error: e5 } = await supabase
      .from("invoices")
      .select("id, contract_id")
      .in("contract_id", contractIds)
      .is("deleted_at", null)
      .neq("status", "CANCELLED");
    if (e5) throw e5;
    invoiceCountByContract = buildInvoiceCountByContract((allInvoices ?? []) as never);
  }

  // 5) Nợ cũ per contract (carry-over 2 pass — logic trong lib).
  let previousDebtByContract = new Map<string, { total: number; sources: PreviousDebtSource[] }>();
  if (contractIds.length > 0) {
    const { data: oldInvoices, error: e6 } = await supabase
      .from("invoices")
      .select(`
        id, invoice_number, billing_month, total_amount, paid_amount, contract_id, status, notes,
        previous_debt_sources,
        room:rooms!invoices_room_id_fkey (id, name),
        building:buildings!invoices_building_id_fkey (id, name),
        invoice_items (id, type, description)
      `)
      .in("contract_id", contractIds)
      .in("status", ["APPROVED", "PARTIAL_PAID", "OVERDUE"])
      .is("deleted_at", null);
    if (e6) throw e6;
    previousDebtByContract = buildPreviousDebtByContract(
      (oldInvoices ?? []) as unknown as RawOldInvoice[],
    );
  }

  return {
    contracts: buildingContracts,
    dupRoomNames,
    meterByRoom,
    lastReading,
    creditByContract,
    invoiceCountByContract,
    previousDebtByContract,
  };
}

/** Re-fetch nợ cũ cho 1 contract (nút ↻ trên dòng). */
export async function fetchPreviousDebtForContract(contractId: string) {
  return computePreviousDebt(contractId);
}

export interface SubmitExcelResult {
  ok: number;
  fail: number;
  /** Phòng đã tạo hoá đơn nhưng KHÔNG lưu được chỉ số điện. */
  readingFails: string[];
}

/**
 * Submit hàng loạt: per phòng (1) chốt chỉ số điện nếu có nhập, (2) tạo hoá
 * đơn qua useCreateInvoice (giữ nguyên invalidation). THỨ TỰ + hành vi lỗi giữ
 * y bản cũ: lỗi lưu chỉ số KHÔNG chặn tạo hoá đơn nhưng phải báo; lỗi tạo hoá
 * đơn 1 phòng không dừng các phòng sau (rủi ro atomicity đã ghi RISK-REGISTER,
 * đổi sang RPC transaction là phase riêng — KHÔNG làm ở Phase 9).
 */
export function useSubmitExcelInvoices() {
  const createInvoice = useCreateInvoice();

  const submit = async (rows: ExcelRowData[], ctx: SubmitContext): Promise<SubmitExcelResult> => {
    let ok = 0;
    let fail = 0;
    const readingFails: string[] = [];

    for (const row of rows) {
      try {
        // 1) Chốt chỉ số điện để CHỈ SỐ ĐẦU tháng sau nối tiếp đúng.
        const consumption =
          (Number(row.current_reading) || 0) - (Number(row.prev_reading) || 0);
        if (row.meter_id && row.current_reading !== "" && consumption >= 0) {
          const user = await getSessionUser();
          if (user) {
            const { error: readingErr } = await supabase.from("meter_readings").insert({
              user_id: user.id,
              meter_id: row.meter_id,
              reading_date: ctx.toDate,
              settlement_month: ctx.billingMonth,
              previous_reading: row.prev_reading,
              current_reading: Number(row.current_reading),
              status: "APPROVED",
              approved_by: user.id,
              approved_at: new Date().toISOString(),
              meter_type: "ELECTRICITY",
              service_id: row.elec_service_id,
              recorded_by: user.id,
            } as never);
            if (readingErr) {
              // KHÔNG chặn tạo hoá đơn, nhưng phải báo để không "mất" chỉ số âm thầm.
              console.error("Persist meter reading failed for", row.room_name, readingErr);
              readingFails.push(row.room_name);
            }
          }
        }

        // 2) Tạo hoá đơn (items + form data build ở lib — có test).
        await createInvoice.mutateAsync(buildInvoiceFormData(row, ctx));
        ok++;
      } catch (err) {
        console.error("Create invoice failed for", row.room_name, err);
        fail++;
      }
    }
    return { ok, fail, readingFails };
  };

  return { submit, isPending: createInvoice.isPending };
}
