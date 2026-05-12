// Contract template engine — render uploaded .docx templates with the
// 99 contract placeholders. Uses docxtemplater + pizzip for client-side
// .docx generation (no server). The placeholder syntax in templates is
// `{NAME}` (scalar) and `{#NAME}...{/NAME}` (loop), matching the spec
// shipped with iHomeCRM contract code reference.

import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { format, parseISO, isValid, addDays, addMonths } from "date-fns";

import type { ContractWithRelations } from "@/types/contract";
import {
  formatCurrencyVND,
  numberToVietnameseWords,
} from "@/lib/invoiceTemplateEngine";
import { supabase } from "@/integrations/supabase/client";

const TEMPLATE_BUCKET = "document-templates";

// Plain string placeholder names (no braces). Loops are arrays of objects.
type Scalar = string | number;
export interface ContractTemplateData {
  [key: string]: Scalar | Array<Record<string, Scalar>>;
}

// =============================================
// Helpers
// =============================================

function fmtDate(value?: string | null): string {
  if (!value) return "";
  const d = parseISO(value);
  return isValid(d) ? format(d, "dd/MM/yyyy") : "";
}

function dayOf(value?: string | null): string {
  if (!value) return "";
  const d = parseISO(value);
  return isValid(d) ? String(d.getDate()) : "";
}

function monthOf(value?: string | null): string {
  if (!value) return "";
  const d = parseISO(value);
  return isValid(d) ? String(d.getMonth() + 1) : "";
}

function yearOf(value?: string | null): string {
  if (!value) return "";
  const d = parseISO(value);
  return isValid(d) ? String(d.getFullYear()) : "";
}

function genderLabel(g?: string | null): string {
  if (!g) return "";
  if (g === "MALE") return "Nam";
  if (g === "FEMALE") return "Nữ";
  if (g === "OTHER") return "Khác";
  return g;
}

function paymentCycleMonths(cycle?: string | null): number {
  switch (cycle) {
    case "MONTHLY":
      return 1;
    case "QUARTERLY":
      return 3;
    case "SEMI_ANNUAL":
      return 6;
    case "ANNUAL":
      return 12;
    default:
      return 1;
  }
}

function joinAddress(parts: Array<string | null | undefined>): string {
  return parts.filter((p) => p && p.trim()).join(", ");
}

// English number-to-words for amounts (short scale, capitalised).
// Used only for `{*_TEXT_EN}` placeholders.
const EN_ONES = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function readUnder1000(n: number): string {
  if (n === 0) return "";
  const out: string[] = [];
  if (n >= 100) {
    out.push(`${EN_ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
    if (n > 0) out.push("and");
  }
  if (n >= 20) {
    out.push(EN_TENS[Math.floor(n / 10)]);
    if (n % 10 > 0) out.push(EN_ONES[n % 10]);
  } else if (n > 0) {
    out.push(EN_ONES[n]);
  }
  return out.join(" ");
}
function numberToEnglishWords(amount: number): string {
  const n = Math.round(Math.abs(amount));
  if (n === 0) return "Zero VND";
  const billions = Math.floor(n / 1_000_000_000);
  const millions = Math.floor((n % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const remainder = n % 1_000;
  const parts: string[] = [];
  if (billions) parts.push(`${readUnder1000(billions)} billion`);
  if (millions) parts.push(`${readUnder1000(millions)} million`);
  if (thousands) parts.push(`${readUnder1000(thousands)} thousand`);
  if (remainder) parts.push(readUnder1000(remainder));
  const phrase = parts.join(" ").replace(/\s+/g, " ").trim();
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} VND`;
}

// =============================================
// Build template data from a contract row
// =============================================

export interface OwnerInfo {
  name?: string | null;
  phone?: string | null;
  birthday?: string | null;
  id_number?: string | null;
  id_issue_place?: string | null;
  id_issue_date?: string | null;
}

export interface BuildContractDataInput {
  contract: ContractWithRelations;
  /** Owner profile fed in by the page (typically derived from auth + profile). */
  owner?: OwnerInfo;
  /** Vehicles linked to the contract's tenants (optional, defaults to []). */
  vehicles?: Array<{
    name?: string;
    license_plate?: string;
    type?: string;
    color?: string;
    brand?: string;
    model?: string;
    owner_name?: string;
  }>;
  /** Assets in the room (optional, defaults to []). */
  assets?: Array<{ name?: string; quantity?: number; unit?: string; condition?: string }>;
}

export function buildContractTemplateData({
  contract,
  owner,
  vehicles = [],
  assets = [],
}: BuildContractDataInput): ContractTemplateData {
  const room = contract.room;
  const building = room?.building;

  // Pick representative customer (first one flagged, else first in list).
  const repLink =
    contract.contract_customers?.find((cc) => cc.is_representative) ??
    contract.contract_customers?.[0];
  const rep = repLink?.customer as
    | (typeof repLink extends { customer?: infer C } ? C : never)
    | undefined;

  // Useful derived monetary values.
  const rent = contract.rent_price ?? 0;
  const deposit = contract.total_deposit ?? 0;
  const cycleMonths = paymentCycleMonths(contract.payment_cycle);
  const depositMonths =
    rent > 0 ? Math.round((deposit / rent) * 100) / 100 : 0;
  const promoMonths = contract.discounts?.months ?? 0;
  const promoPerMonth = contract.discounts?.amount_per_month ?? 0;

  // Cast rep to a richer shape — the joined select returns more than the
  // narrow `{full_name, phone, id_number}` declared on ContractCustomer.
  const r = (rep ?? {}) as Record<string, unknown>;
  const repStr = (k: string): string => {
    const v = r[k];
    return typeof v === "string" ? v : v == null ? "" : String(v);
  };

  // Compute tenants list (not just rep) for the {#TENANTS_TABLE} loop.
  const tenants: Array<Record<string, Scalar>> =
    (contract.contract_customers ?? []).map((cc, idx) => {
      const c = (cc.customer ?? {}) as Record<string, unknown>;
      const get = (k: string) => {
        const v = c[k];
        return typeof v === "string" ? v : v == null ? "" : String(v);
      };
      const birthday = fmtDate(get("date_of_birth") || null);
      const idNumber = get("id_number");
      const issueDate = fmtDate(get("id_issue_date") || null);
      const issuePlace = get("id_issue_place");
      const currentAddress = joinAddress([
        get("detailed_address"),
        get("ward"),
        get("district"),
        get("province"),
      ]);
      const permanentAddress =
        get("permanent_address") ||
        currentAddress;
      return {
        index: idx + 1,
        name: get("full_name"),
        tenantName: get("full_name"),
        phone: get("phone"),
        email: get("email"),
        id_number: idNumber,
        idNumber,
        birthday,
        BIRTHDAY: birthday,
        date_of_birth: birthday,
        gender: genderLabel(get("gender") || null),
        issueDate,
        id_issue_date: issueDate,
        issuePlace,
        id_issue_place: issuePlace,
        address: currentAddress,
        currentAddress,
        current_address: currentAddress,
        permanent_address: permanentAddress,
        permanentAddress,
        fullAddress: permanentAddress,
        is_representative: cc.is_representative ? "x" : "",
      };
    });

  // Service rows for the {#FEES_TABLE} / {#fees} loops.
  const fees: Array<Record<string, Scalar>> =
    (contract.contract_services ?? []).map((cs, idx) => ({
      index: idx + 1,
      name: cs.service?.name ?? "",
      unit: cs.service?.unit ?? "",
      pricing_type: cs.service?.pricing_type ?? "",
      unit_price: formatCurrencyVND(cs.unit_price ?? 0),
      initial_reading: cs.initial_reading ?? 0,
    }));

  // Compute initial electricity / water reading from contract_services if
  // the metered services are present, otherwise fall back to the column.
  const elecReading = contract.contract_services?.find(
    (cs) =>
      cs.service?.type === "ELECTRIC" ||
      /điện|electric/i.test(cs.service?.name ?? ""),
  )?.initial_reading;
  const waterReading = contract.contract_services?.find(
    (cs) =>
      cs.service?.type === "WATER" || /nước|water/i.test(cs.service?.name ?? ""),
  )?.initial_reading;

  // First period end date — derived from start_billing_date + cycle.
  const billingDate = contract.start_billing_date
    ? parseISO(contract.start_billing_date)
    : null;
  const firstPeriodEnd =
    billingDate && isValid(billingDate)
      ? addDays(addMonths(billingDate, cycleMonths), -1)
      : null;

  // 30 days before contract end.
  const endDate = contract.end_date ? parseISO(contract.end_date) : null;
  const before30 = endDate && isValid(endDate) ? addDays(endDate, -30) : null;

  return {
    // ===== Thông tin hợp đồng =====
    CONTRACT_NUMBER: contract.contract_number ?? "",
    SIGN_DATE: fmtDate(contract.signed_date),
    SIGN_DAY: dayOf(contract.signed_date),
    SIGN_MONTH: monthOf(contract.signed_date),
    SIGN_YEAR: yearOf(contract.signed_date),
    BILLING_DATE: fmtDate(contract.start_billing_date),
    START_DATE: fmtDate(contract.start_date),
    END_DATE: fmtDate(contract.end_date),
    CONTRACT_MONTH: (() => {
      const s = contract.start_date ? parseISO(contract.start_date) : null;
      const e = contract.end_date ? parseISO(contract.end_date) : null;
      if (!s || !e || !isValid(s) || !isValid(e)) return "";
      const months =
        (e.getFullYear() - s.getFullYear()) * 12 +
        (e.getMonth() - s.getMonth());
      return String(Math.max(0, months));
    })(),
    CODE: contract.contract_number ?? "",
    NOTE: contract.notes ?? "",
    END_DATE_BEFORE_30_DAYS: before30 ? format(before30, "dd/MM/yyyy") : "",
    END_DAY: dayOf(contract.end_date),
    END_MONTH: monthOf(contract.end_date),
    END_YEAR: yearOf(contract.end_date),

    // ===== Tòa nhà & Phòng =====
    APARTMENT_NAME: building?.name ?? "",
    APARTMENT_ADDRESS: (() => {
      const b = (building ?? {}) as Record<string, unknown>;
      const direct =
        (b.address as string | undefined) ||
        (b.full_address as string | undefined);
      if (direct && String(direct).trim()) return String(direct);
      return joinAddress([
        b.street_address as string | undefined,
        b.ward as string | undefined,
        b.district as string | undefined,
        b.province as string | undefined,
      ]);
    })(),
    LOCATION_NAME:
      ((building as Record<string, unknown> | undefined)?.location_name as string) ??
      "",
    ROOM_NAME: room?.name ?? "",
    ROOM_SIZE: ((room as Record<string, unknown> | undefined)?.area_sqm as number) ?? "",
    ROOM_NUMBER_BEDS: ((room as Record<string, unknown> | undefined)?.number_of_beds as number) ?? "",
    MAX_TENANTS: ((room as Record<string, unknown> | undefined)?.max_tenants as number) ?? "",
    BED_NAME: contract.bed?.name ?? "",
    FLOOR_NAME: ((room as Record<string, unknown> | undefined)?.floor_name as string) ?? "",

    // ===== Giá thuê & Thanh toán =====
    RENT_PRICE: formatCurrencyVND(rent),
    RENT_PRICE_TEXT: numberToVietnameseWords(rent),
    RENT_PRICE_TEXT_EN: numberToEnglishWords(rent),
    RENT_PRICE_PER_SQUARE: (() => {
      const sqm = (room as Record<string, unknown> | undefined)?.area_sqm as
        | number
        | undefined;
      if (!sqm || sqm <= 0) return "";
      return formatCurrencyVND(rent / sqm);
    })(),
    RENT_PRICE_TWO_MONTHS: formatCurrencyVND(rent * 2),
    RENT_PRICE_THREE_MONTHS: formatCurrencyVND(rent * 3),
    RENT_PRICE_PER_YEAR: formatCurrencyVND(rent * 12),
    RENT_PRICE_TWO_MONTH_TEXT: numberToVietnameseWords(rent * 2),
    RENT_PRICE_THREE_MONTH_TEXT: numberToVietnameseWords(rent * 3),
    RENT_PRICE_PER_YEAR_TEXT: numberToVietnameseWords(rent * 12),
    RENT_PRICE_PER_MONTH_INCREASE_10_PERCENT: formatCurrencyVND(rent * 1.1),
    RENT_PRICE_PER_MONTH_INCREASE_15_PERCENT: formatCurrencyVND(rent * 1.15),
    RENT_PRICE_PER_YEAR_INCREASE_10_PERCENT: formatCurrencyVND(rent * 12 * 1.1),
    RENT_PRICE_PER_YEAR_INCREASE_15_PERCENT: formatCurrencyVND(
      rent * 12 * 1.15,
    ),
    RENT_PRICE_2_YEAR: formatCurrencyVND(rent * 24),
    RENT_PRICE_2_YEAR_INCREASE_10_PERCENT: formatCurrencyVND(rent * 24 * 1.1),
    CONTRACT_PAYMENT_DAY: dayOf(contract.start_billing_date),
    PAYMENT_PERIOD: cycleMonths,
    PAYMENT_PERIOD_AND_DEPOSIT: `${cycleMonths} tháng / cọc ${depositMonths} tháng`,
    FIRST_PERIOD_END_DATE: firstPeriodEnd
      ? format(firstPeriodEnd, "dd/MM/yyyy")
      : "",

    // ===== Tiền cọc & Khuyến mãi =====
    DEPOSIT: formatCurrencyVND(deposit),
    DEPOSIT_TEXT: numberToVietnameseWords(deposit),
    DEPOSIT_TEXT_EN: numberToEnglishWords(deposit),
    DEPOSIT_MONTH: depositMonths || "",
    DEPOSIT_MONTH_TEXT:
      depositMonths > 0 ? numberToVietnameseWords(depositMonths) : "",
    DEPOSIT_DATE: fmtDate(contract.signed_date),
    DEPOSIT_NOTE: contract.notes ?? "",
    PROMOTION_MONTH: promoMonths,
    PROMOTION_PRICE_PER_MONTH: formatCurrencyVND(promoPerMonth),

    // ===== Khách thuê (representative) =====
    REPRESENT_CODE: repStr("id"),
    REPRESENT_NAME: repStr("full_name"),
    REPRESENT_GENDER: genderLabel(repStr("gender") || null),
    REPRESENT_BIRTHDAY: fmtDate(repStr("date_of_birth") || null),
    REPRESENT_PHONE_NUMBER: repStr("phone"),
    REPRESENT_EMAIL: repStr("email"),
    REPRESENT_ID_NUMBER: repStr("id_number"),
    REPRESENT_PLACE_OF_ISSUE: repStr("id_issue_place"),
    REPRESENT_ID_NUMBER_DATE: fmtDate(repStr("id_issue_date") || null),
    REPRESENT_ADDRESS:
      repStr("permanent_address") ||
      joinAddress([
        repStr("detailed_address"),
        repStr("ward"),
        repStr("district"),
        repStr("province"),
      ]),
    REPRESENT_CURRENT_ADDRESS:
      repStr("current_residence") ||
      joinAddress([
        repStr("detailed_address"),
        repStr("ward"),
        repStr("district"),
        repStr("province"),
      ]),
    REPRESENT_WORKPLACE: repStr("workplace"),
    REPRESENT_CONTACT_NAME: repStr("contact_person"),
    REPRESENT_CONTACT_PHONE: repStr("contact_person_phone"),
    REPRESENT_COUNTRY: r["is_foreign"] ? "Nước ngoài" : "Việt Nam",
    REPRESENT_PASSPORT_NUMBER: repStr("passport_number"),
    REPRESENT_PASSPORT_DUE_DATE: fmtDate(repStr("passport_due_date") || null),
    REPRESENT_BUSINESS_DOMAIN: repStr("occupation"),
    REPRESENT_ACCOUNT_NUMBER: repStr("bank_account_number"),
    REPRESENT_BANK_NAME: repStr("bank_name"),
    REPRESENT_CONSULTANT_NAME: repStr("advisor"),
    REPRESENT_CONSULTANT_PHONE: repStr("advisor_phone"),
    REPRESENT_BUSINESS_CODE: repStr("tax_code"),

    // ===== Chủ nhà =====
    CHU_HOP_DONG: owner?.name ?? "",
    OWNER_NAME: owner?.name ?? "",
    OWNER_PHONE: owner?.phone ?? "",
    OWNER_BIRTHDAY: fmtDate(owner?.birthday ?? null),
    OWNER_ID_NUMBER: owner?.id_number ?? "",
    OWNER_PLACE_OF_ISSUE: owner?.id_issue_place ?? "",
    OWNER_ID_NUMBER_DATE: fmtDate(owner?.id_issue_date ?? null),

    // ===== Thống kê & Dịch vụ =====
    NUMBER_TENANTS: tenants.length,
    TOTAL_TENANTS: tenants.length,
    NUMBER_VEHICLES: vehicles.length,
    TOTAL_VEHICLES: vehicles.length,
    FINGER_PRINT_CODE: repStr("fingerprint_code"),
    ELECTRIC_NUMBER:
      elecReading != null
        ? elecReading
        : contract.initial_electricity_reading ?? "",
    WATER_NUMBER:
      waterReading != null
        ? waterReading
        : contract.initial_water_reading ?? "",

    // ===== Thanh lý =====
    LIQUID_DATE: fmtDate(contract.actual_end_date),
    LIQUID_DAY: dayOf(contract.actual_end_date),
    LIQUID_MONTH: monthOf(contract.actual_end_date),
    LIQUID_YEAR: yearOf(contract.actual_end_date),

    // ===== Bảng dữ liệu (loops) =====
    TENANTS_TABLE: tenants,
    ASSETS_TABLE: assets.map((a, idx) => ({
      index: idx + 1,
      name: a.name ?? "",
      quantity: a.quantity ?? "",
      unit: a.unit ?? "",
      condition: a.condition ?? "",
    })),
    FEES_TABLE: fees,
    VEHICLES_TABLE: vehicles.map((v, idx) => ({
      index: idx + 1,
      name: v.name ?? "",
      license_plate: v.license_plate ?? "",
      licensePlate: v.license_plate ?? "",
      type: v.type ?? "",
      vehicleType: v.type ?? "",
      color: v.color ?? "",
      brand: v.brand ?? "",
      model: v.model ?? "",
      owner_name: v.owner_name ?? "",
      ownerName: v.owner_name ?? "",
      tenantName: v.owner_name ?? "",
    })),
    fees,
  };
}

// =============================================
// Render docx with docxtemplater
// =============================================

/**
 * Extract storage object path from a Supabase Storage URL.
 *  ".../object/public/document-templates/<user>/<file>" → "<user>/<file>"
 *  ".../object/sign/document-templates/<user>/<file>"  → "<user>/<file>"
 *  Returns null if the URL doesn't match.
 */
function extractStoragePath(url: string): string | null {
  const m = url.match(
    new RegExp(`/object/(?:public|sign|authenticated)/${TEMPLATE_BUCKET}/(.+?)(?:\\?|$)`),
  );
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Fetch a .docx template from Supabase Storage (the bucket is private, so
 * we go through the SDK with the user session instead of a raw fetch on
 * the public URL).
 */
async function fetchTemplateBuffer(templateUrl: string): Promise<ArrayBuffer> {
  const path = extractStoragePath(templateUrl);
  if (path) {
    const { data, error } = await supabase.storage
      .from(TEMPLATE_BUCKET)
      .download(path);
    if (error || !data) {
      throw new Error(`Không thể tải mẫu: ${error?.message ?? "unknown"}`);
    }
    return await data.arrayBuffer();
  }
  // Fall back to direct fetch (e.g. signed URL handed in directly).
  const res = await fetch(templateUrl);
  if (!res.ok) throw new Error(`Không thể tải mẫu (${res.status})`);
  return await res.arrayBuffer();
}

/**
 * Fetch a .docx template, replace placeholders, return a Blob.
 */
export async function renderContractDocx(
  templateUrl: string,
  data: ContractTemplateData,
): Promise<Blob> {
  const buffer = await fetchTemplateBuffer(templateUrl);

  const zip = new PizZip(buffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    // Empty / unknown placeholders → empty string instead of throwing.
    nullGetter: () => "",
  });

  doc.render(data);

  return doc.getZip().generate({
    type: "blob",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });
}

/**
 * Trigger a download of a .docx Blob in the browser.
 */
export function downloadDocxBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.endsWith(".docx") ? fileName : `${fileName}.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
