import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Smartphone } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { buildRoomListTable, GROUP_BG, samePhone, type LiftKind } from "@/pages/phong-trong/roomListTable";
import type { Building, Room } from "@/pages/phong-trong/sampleData";
import { SALE_POLICY_MAX } from "@/lib/publicRoomFeedback";
import { sheetKey } from "@/hooks/useSaveRoomListSheet";
import {
  applySheetDraft, ownPhone, ROOM_POLICY_MAX,
  type HotlineOption, type SheetEdits,
} from "./roomListSheetDraft";

const NONE = "__none__"; // Select không nhận value="" → sentinel cho "Mặc định"
const HEADERS = ["ĐỊA CHỈ", "MÃ PHÒNG", "GIÁ", "CHÍNH SÁCH SALE", "LOẠI PHÒNG", "NỘI THẤT", "TÌNH TRẠNG"];
// Cùng tỉ lệ cột với ảnh (exportRoomListImage COLS) để khung nhập trông như ảnh.
const COL_W = [320, 100, 130, 250, 190, 310, 220];
const LINE = "1px solid #548235";
const CELL = "px-2 py-1.5 text-center align-middle";
const INPUT =
  "w-full rounded-sm border border-dashed border-neutral-400 bg-white px-1.5 py-1 text-center text-[13px] text-neutral-900 " +
  "placeholder:font-normal placeholder:text-neutral-400 focus:border-solid focus:border-primary focus:outline-none aria-[invalid=true]:border-destructive";

/** Icon thang — cùng hình với icon vẽ trên ảnh. */
function LiftGlyph({ kind }: { kind: LiftKind }) {
  return kind === "elevator" ? (
    <svg viewBox="0 0 14 14" className="inline h-3.5 w-3.5 align-[-2px]" aria-hidden>
      <rect x="1.8" y="0.8" width="10.4" height="12.4" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 2.5 3.5 6h7zM7 11.5 3.5 8h7z" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 14 14" className="inline h-3.5 w-3.5 align-[-2px]" aria-hidden>
      <path d="M1 14V10h4V6h4V2h4v12z" fill="currentColor" />
    </svg>
  );
}

export interface RoomListSheetEditorProps {
  /** Dữ liệu đang lưu (get_my_available_rooms) — nguồn giá trị ban đầu của các ô. */
  buildings: Building[];
  hotlines: HotlineOption[];
  hotlineId: string | null;
  onHotlineChange: (id: string | null) => void;
  /** Số hotline đang gõ (chưa gõ = số của hotline đang dùng). */
  hotlinePhone: string;
  onHotlinePhoneChange: (value: string) => void;
  salePolicy: string;
  onSalePolicyChange: (value: string) => void;
  edits: SheetEdits;
  onPhoneChange: (buildingId: string, value: string) => void;
  onPolicyChange: (roomId: string, value: string) => void;
  /** Lỗi theo name ô: hotline_phone, hotline_id, sale_policy, phone:<id>, policy:<id>. */
  errors: Record<string, string>;
  disabled?: boolean;
}

/**
 * Khung nhập "DANH SÁCH PHÒNG TRỐNG" dạng ô Excel, bố cục y như ảnh tải về.
 * Ô nền trắng viền đứt là ô điền; còn lại tự lấy từ dữ liệu phòng/tòa.
 * Bảng dựng bằng chính buildRoomListTable của ảnh nên thấy gì ở đây thì ảnh ra đúng thế.
 */
export default function RoomListSheetEditor(props: RoomListSheetEditorProps) {
  const { buildings, hotlines, hotlineId, salePolicy, edits, errors, disabled } = props;
  const hotlinePhone = props.hotlinePhone.trim();

  const preview = useMemo(
    () => applySheetDraft(buildings, { hotline: hotlinePhone, salePolicy, edits }),
    [buildings, hotlinePhone, salePolicy, edits],
  );
  const table = useMemo(() => buildRoomListTable(preview), [preview]);
  const byBuilding = useMemo(() => new Map(buildings.map((b) => [b.id, b])), [buildings]);
  const byRoom = useMemo(() => new Map<string, Room>(buildings.flatMap((b) => b.rooms.map((r) => [r.id, r]))), [buildings]);
  const printedPhone = table.contactLines[1];

  const errorText = (name: string) =>
    errors[name] ? <p id={`${name}-error`} role="alert" className="mt-1 text-xs font-normal text-destructive">{errors[name]}</p> : null;

  return (
    <div className="overflow-x-auto rounded-md border" data-testid="room-list-sheet">
      <table className="w-full min-w-[1080px] table-fixed border-collapse bg-white text-[13px] leading-snug text-neutral-900">
        <colgroup>{COL_W.map((w, i) => <col key={i} style={{ width: `${(w / 1520) * 100}%` }} />)}</colgroup>
        <tbody>
          <tr>
            <td colSpan={7} className="py-2 text-center text-lg font-extrabold" style={{ border: LINE }}>
              {table.title}
            </td>
          </tr>
          <tr>
            {/* Ô liên hệ: CHỖ ĐIỀN hotline chung cho mọi tòa. */}
            <td className={`${CELL} space-y-1.5`} style={{ border: LINE }}>
              <div className="font-extrabold text-[#e00000]">LIÊN HỆ ADMIN ĐỂ MỞ CỬA</div>
              <label className="block text-left text-xs font-semibold text-neutral-700" htmlFor="sheet-hotline-phone">
                Hotline chung cho tất cả nhà
              </label>
              <input
                id="sheet-hotline-phone" name="hotline_phone" type="tel" inputMode="tel" disabled={disabled}
                value={props.hotlinePhone} onChange={(e) => props.onHotlinePhoneChange(e.target.value)}
                placeholder={printedPhone ? `Đang in ${printedPhone}` : "Gõ số hotline"}
                aria-invalid={!!errors.hotline_phone} aria-describedby={errors.hotline_phone ? "hotline_phone-error" : undefined}
                className={`${INPUT} text-lg font-extrabold text-[#e00000]`}
              />
              {errorText("hotline_phone")}
              {hotlines.length > 1 && (
                <Select
                  value={hotlineId ?? NONE}
                  onValueChange={(v) => props.onHotlineChange(v === NONE ? null : v)}
                  disabled={disabled}
                >
                  <SelectTrigger
                    aria-label="Chọn số trong danh sách hotline" data-field-name="hotline_id" className="h-8 bg-white text-xs"
                    aria-invalid={!!errors.hotline_id} aria-describedby={errors.hotline_id ? "hotline_id-error" : undefined}
                  >
                    <SelectValue placeholder="Mặc định (hotline đầu tiên)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Mặc định (hotline đầu tiên)</SelectItem>
                    {hotlines.map((h) => (
                      <SelectItem key={h.id} value={h.id}>
                        {h.name ? `${h.name} · ` : ""}{h.phone_number}{h.is_active === false ? " (đang tắt)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {errorText("hotline_id")}
              {!hotlinePhone && (
                <p className="text-left text-xs text-amber-700">
                  {printedPhone
                    ? `Chưa có hotline — ảnh đang in SĐT dùng nhiều nhất của các nhà (${printedPhone}). Gõ số vào ô trên rồi Lưu.`
                    : "Chưa có số liên hệ — gõ số hotline vào ô trên rồi Lưu."}
                </p>
              )}
              <Link to="/settings/categories/hotlines" className="block text-left text-xs font-medium text-primary underline">
                Quản lý danh sách hotline
              </Link>
            </td>
            {/* Khối thông tin chung: CHỖ ĐIỀN chính sách sale chung (chủ tự gõ cả giá điện). */}
            <td colSpan={6} className={`${CELL} space-y-1`} style={{ border: LINE }}>
              <label htmlFor="sheet-sale-policy" className="sr-only">Chính sách sale chung</label>
              <textarea
                id="sheet-sale-policy" name="sale_policy" rows={Math.max(3, salePolicy.split("\n").length + 1)}
                value={salePolicy} disabled={disabled} maxLength={SALE_POLICY_MAX}
                onChange={(e) => props.onSalePolicyChange(e.target.value)}
                placeholder={"Chính sách sale chung — mỗi dòng một ý, in ở khối trên đầu ảnh. Ví dụ:\nĐiện 3.800đ/số với nhà thang máy\nNước 100k/người, phí dịch vụ 150k/phòng\nXe free, Wifi free, có máy giặt chung"}
                aria-invalid={!!errors.sale_policy} aria-describedby={errors.sale_policy ? "sale_policy-error" : undefined}
                className={`${INPUT} resize-y`}
              />
              {errorText("sale_policy")}
            </td>
          </tr>
          <tr className="bg-[#70ad47] font-extrabold">
            {HEADERS.map((h) => <th key={h} scope="col" className={CELL} style={{ border: LINE }}>{h}</th>)}
          </tr>
          {table.groups.length === 0 && (
            <tr>
              <td colSpan={7} className="p-4 text-center text-neutral-500" style={{ border: LINE }}>
                Hiện không có phòng trống, sắp trống hay khách pass nào để đưa vào ảnh.
              </td>
            </tr>
          )}
          {table.groups.map((g, gi) => {
            const source = byBuilding.get(g.buildingId);
            const phoneName = sheetKey.phone(g.buildingId);
            return g.rows.map((row, ri) => {
              const room = byRoom.get(row.roomId);
              const policyName = sheetKey.policy(row.roomId);
              const passPolicy = room?.status === "pass" ? room.passSalePolicy?.trim() : "";
              return (
                <tr key={row.roomId} style={{ background: GROUP_BG[gi % GROUP_BG.length] }}>
                  {ri === 0 && (
                    <td rowSpan={g.rows.length} className={`${CELL} font-bold`} style={{ border: LINE }}>
                      <div>
                        {g.address}
                        {g.lift && (
                          <span className="ml-1.5 whitespace-nowrap font-semibold">
                            <LiftGlyph kind={g.lift.kind} /> {g.lift.label}
                          </span>
                        )}
                      </div>
                      <label className="mt-1.5 flex items-center gap-1" title="SĐT riêng của nhà này — để trống thì dùng hotline chung">
                        <Smartphone className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span className="sr-only">SĐT riêng của nhà {g.address}</span>
                        <input
                          name={phoneName} type="tel" inputMode="tel" disabled={disabled}
                          value={edits.phones[g.buildingId] ?? (source ? ownPhone(source) : "")}
                          onChange={(e) => props.onPhoneChange(g.buildingId, e.target.value)}
                          placeholder="SĐT riêng (trống = hotline)"
                          aria-invalid={!!errors[phoneName]} aria-describedby={errors[phoneName] ? `${phoneName}-error` : undefined}
                          className={`${INPUT} font-bold`}
                        />
                      </label>
                      {!g.phone && samePhone(edits.phones[g.buildingId] ?? (source ? ownPhone(source) : ""), hotlinePhone) && hotlinePhone && (
                        <p className="mt-0.5 text-[11px] font-normal text-neutral-600">Trùng hotline — ảnh không in lại</p>
                      )}
                      {errorText(phoneName)}
                    </td>
                  )}
                  <td className={`${CELL} font-bold`} style={{ border: LINE }}>{row.code}</td>
                  <td className={`${CELL} font-bold`} style={{ border: LINE }}>{row.price}</td>
                  <td className={CELL} style={{ border: LINE }}>
                    <label className="sr-only" htmlFor={`sheet-${policyName}`}>Chính sách sale phòng {row.code}</label>
                    <textarea
                      id={`sheet-${policyName}`} name={policyName} rows={2} disabled={disabled} maxLength={ROOM_POLICY_MAX}
                      value={edits.policies[row.roomId] ?? room?.saleNote ?? ""}
                      onChange={(e) => props.onPolicyChange(row.roomId, e.target.value)}
                      placeholder={passPolicy ? `Khách pass: ${passPolicy}` : "Chính sách riêng phòng"}
                      aria-invalid={!!errors[policyName]} aria-describedby={errors[policyName] ? `${policyName}-error` : undefined}
                      className={`${INPUT} resize-none font-bold text-[#c00000]`}
                    />
                    {errorText(policyName)}
                  </td>
                  <td className={CELL} style={{ border: LINE }}>{row.type}</td>
                  <td className={CELL} style={{ border: LINE }}>{row.amenities}</td>
                  <td className={`${CELL} font-bold`} style={{ border: LINE }}>
                    {row.status.map((s) => <div key={s}>{s}</div>)}
                  </td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}
