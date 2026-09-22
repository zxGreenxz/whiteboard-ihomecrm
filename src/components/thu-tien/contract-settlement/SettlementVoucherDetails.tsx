// =============================================================================
// SettlementVoucherDetails — BẢNG QUYẾT TOÁN / CĂN CỨ của một
// phiếu, lấy ĐÚNG nguồn mà trang Thu chi đang dùng (plan §3.2).
//
// ── LỖI ĐANG SỬA ────────────────────────────────────────────────────────────
// Modal hồ sơ khoản chi in một câu giữ chỗ — "Căn cứ hoàn khách tra khi mở
// phiếu" — rồi dừng ở đó, vì lúc mở nó KHÔNG hề hỏi facts. Đúng là ở DANH SÁCH
// thì không nên gọi `get_termination_refund_facts_v1` (đắt), nhưng mở phiếu ra
// mà vẫn không hỏi thì người duyệt không có gì để đối chiếu.
//
// ── DÙNG LẠI, KHÔNG DỰNG LẠI ────────────────────────────────────────────────
// Bảng do `VoucherNote` của Thu chi vẽ (→ `TerminationRefundNote` /
// `CommissionVoucherNote` → `buildTerminationCard` / `buildCommissionNoteLines`).
// File này chỉ NỐI DÂY: đưa đúng phiếu vào, đọc trạng thái đọc ra, và bọc bằng
// bố cục của khu. Không chép lại một phép toán nào.
//
// Chỉ vẽ bảng tự sinh, không hiển thị ghi chú gốc theo yêu cầu của màn này.
// Không truyền fallbackNotes và không thay đổi notes đã lưu của phiếu.
//
// ── LỊCH SỬ BỔ SUNG KHÔNG THUỘC FILE NÀY ────────────────────────────────────
// `SettlementLifecycleModal` đã có mục "Lịch sử bổ sung" riêng. Vì thế phiếu
// truyền vào đây luôn mang `supplements: []` — dựng thêm ở đây là hiện hai lần.
//
// ── BỐN TRẠNG THÁI, KHÔNG PHẢI HAI ──────────────────────────────────────────
// Đang tải / lỗi / KHÔNG ĐỦ NGUỒN / đã có căn cứ phải nhìn khác nhau. RPC facts
// gate quyền theo toà và bỏ qua IM LẶNG phiếu không quyền, nên "0 dòng" là
// THIẾU NGUỒN chứ không phải "không có gì để cấn" — hiện nó thành 0 đ hay "đã
// khớp" là nói dối trên màn tiền. Dùng lại đúng bộ chữ của `SectionStatus`
// (contractLifecycle.ts) thay vì đẻ từ vựng thứ hai.
//
// KHÔNG GHI GÌ. Căn cứ và ghi chú không đụng tới số tiền hay trạng thái duyệt.
// =============================================================================

import { useEffect } from 'react';
import type { ModalReadState } from './modalReadState';
import {
  VoucherNote,
  type VoucherNoteRef,
} from '@/components/income-expenses/VoucherNote';
import { laPhieuHoaHong } from '@/components/income-expenses/CommissionVoucherNote';
import {
  laPhieuTraKhachThanhLy,
  TERMINATION_REFUND_SOURCE,
} from '@/components/income-expenses/TerminationRefundNote';
import { useTerminationRefundFacts } from '@/hooks/useTerminationRefundFacts';
import { useCommissionVoucherFacts } from '@/hooks/useCommissionVoucher';
import {
  CAN_CU_HOAN_TRA_KHI_MO_PHIEU,
  type SettlementRow, type SettlementRowKind,
} from '@/lib/contractSettlement';
import { moTaCanCu } from './nhan';

/**
 * Trạng thái đọc nguồn căn cứ. Ba giá trị cuối là ĐÚNG bộ chữ của
 * `SectionStatus` trong contractLifecycle.ts; 'loading' thêm vào vì ở đây có
 * lúc chờ mạng, còn dải vòng đời thì nhận số đã đọc xong.
 */
export type BasisReadState =
  | { kind: 'loading' }
  | { kind: 'error'; reason: string }
  | { kind: 'insufficient'; reason: string }
  | { kind: 'sufficient' };

/** Thuần, không I/O, không đồng hồ — kiểm được bằng unit test. */
export function basisReadState(
  q: { isLoading: boolean; isFetching?: boolean; isError: boolean; data: unknown },
  nguon: string,
): BasisReadState {
  if (q.isLoading || q.isFetching) return { kind: 'loading' };
  if (q.isError) return { kind: 'error', reason: `Không đọc được ${nguon}.` };
  // `data == null` gồm cả `undefined` (query chưa chạy) lẫn `null` (RPC trả 0
  // dòng vì gate quyền toà). Cả hai đều là CHƯA CHỨNG MINH ĐƯỢC.
  if (q.data == null) {
    return {
      kind: 'insufficient',
      reason: `Không thấy ${nguon} của phiếu này — có thể do quyền xem toà.`,
    };
  }
  return { kind: 'sufficient' };
}

/** Câu chốt bắt buộc cho mọi trạng thái thiếu. Không được rút gọn. */
const CHUA_KET_LUAN = 'Chưa kết luận được — KHÔNG coi là 0 đ hay đã khớp.';

/**
 * Vì sao phiếu này không có bảng tự sinh. Nói bằng ĐÚNG cái dấu còn thiếu, chứ
 * không đổ cho dữ liệu hỏng: phiếu tạo tay bên Thu chi vốn không mang dấu nào.
 */
const LY_DO_KHONG_CO_BANG: Record<SettlementRowKind, string> = {
  refund:
    'Phiếu này không mang dấu nguồn termination.refund nên không có hồ sơ quyết toán tự sinh để dựng bảng. '
    + 'Đây là phiếu tạo tay bên Thu chi hoặc phiếu hoàn giữ chỗ — không phải dữ liệu hỏng, '
    + 'và không được suy dấu nguồn ra từ tên phiếu.',
  commission:
    'Phiếu này không mang dấu commission_kind (broker/sale) nên nguồn ghi chú chi tiết tự sinh không phục vụ được nó. '
    + 'Đây là phiếu tạo tay bên Thu chi — không phải dữ liệu hỏng, và không được gắn dấu giả để ép nguồn đó chạy.',
  bonus:
    'Phiếu này không mang dấu commission_kind (broker/sale) nên nguồn ghi chú chi tiết tự sinh không phục vụ được nó. '
    + 'Đây là phiếu tạo tay bên Thu chi — không phải dữ liệu hỏng, và không được gắn dấu giả để ép nguồn đó chạy.',
  unknown:
    'Chưa xác định được loại phiếu nên chưa biết phải dựng bảng căn cứ nào. '
    + 'Xem lại hạng mục kế toán của phiếu bên Thu chi.',
};

/**
 * Hai vị ngữ `laPhieuHoaHong` / `laPhieuTraKhachThanhLy` đều đòi DẤU NGUỒN **và**
 * HỢP ĐỒNG. Nên nhánh "không có bảng tự sinh" có HAI nguyên nhân khác hẳn nhau,
 * và bảo một phiếu đã có dấu broker rằng nó "không mang dấu commission_kind" là
 * nói sai với người đang cầm tiền. Tách ra đúng nguyên nhân.
 */
const KHONG_CO_HOP_DONG =
  'Phiếu CÓ dấu nguồn nhưng CHƯA GẮN HỢP ĐỒNG, nên không tra được hồ sơ để dựng bảng. '
  + 'Gắn hợp đồng cho phiếu bên Thu chi rồi mở lại — không suy hợp đồng ra từ tên hay mã phiếu.';

const NHAN_CAN_CU: Record<SettlementRowKind, string> = {
  refund: 'Căn cứ hoàn khách',
  commission: 'Căn cứ số tiền theo kỳ ký',
  bonus: 'Căn cứ số tiền',
  unknown: 'Căn cứ',
};

/** Nguồn nào đang được hỏi — vào thẳng câu báo lỗi cho người đọc biết thiếu gì. */
const NGUON_HOAN = 'hồ sơ quyết toán thanh lý';
const NGUON_HOA_HONG = 'thông tin hợp đồng của phiếu';

function TrangThaiCanCu({ st }: { st: BasisReadState }) {
  if (st.kind === 'sufficient') return null;
  if (st.kind === 'loading') {
    return (
      <div className="cs-note-s" data-testid="settlement-basis-state" data-state="loading">
        Đang tải căn cứ…
      </div>
    );
  }
  return (
    <div
      className="cs-note-s"
      data-testid="settlement-basis-state"
      data-state={st.kind}
      style={st.kind === 'error' ? { color: 'var(--c-unpaid)' } : undefined}
    >
      {st.reason} {CHUA_KET_LUAN}
    </div>
  );
}

interface Props {
  row: SettlementRow;
  /** Chỉ hỏi RPC khi modal thật sự mở — giống `enabled` của Thu chi. */
  enabled?: boolean;
  onReadStateChange?: (state: ModalReadState) => void;
}

export function SettlementVoucherDetails({ row, enabled = true, onReadStateChange }: Props) {
  /**
   * Phiếu đưa cho renderer chung. Ba trường đầu CHÉP THÔ từ read model.
   *
   * ⚠ `commission_kind` chỉ nhận đúng 'broker'/'sale' vì kiểu của component
   * chung là vậy. Đây là THU HẸP giá trị thật, không phải bịa: giá trị lạ
   * (hoặc rỗng) rơi về `null` và phiếu đi nhánh "không có bảng tự sinh".
   */
  const phieu: VoucherNoteRef = {
    id: row.voucherId,
    contract_id: row.contractId,
    system_source: row.systemSource,
    commission_kind:
      row.commissionKind === 'broker' || row.commissionKind === 'sale'
        ? row.commissionKind
        : null,
    // Lịch sử bổ sung là mục RIÊNG của modal — xem đầu file.
    supplements: [],
  };

  const laHoan = laPhieuTraKhachThanhLy(phieu);
  const laHoaHong = laPhieuHoaHong(phieu);
  const coBangTuSinh = laHoan || laHoaHong;

  /**
   * Renderer nào sẽ THẮNG bên trong `VoucherNote`.
   *
   * ⚠ PHẢI cùng thứ tự với VoucherNote.tsx: hoa hồng xét TRƯỚC hoàn thanh lý.
   * Phiếu mang cả hai dấu là chuyện dữ liệu cho phép, và hai chỗ cùng quyết
   * định một việc mà quyết khác nhau thì banner trạng thái sẽ nói về một truy
   * vấn KHÁC với bảng đang vẽ. Tệ nhất: RPC thanh lý lỗi làm ẩn mất bảng hoa
   * hồng vốn tải được bình thường.
   *
   * Cũng là lý do chỉ MỘT hook được truyền voucherId — cái thua không vẽ gì
   * nên không được tốn một lượt gọi RPC.
   */
  const nguonBang: 'commission' | 'termination' | null =
    laHoaHong ? 'commission' : laHoan ? 'termination' : null;

  /** Có dấu nguồn thật nhưng thiếu hợp đồng — xem `KHONG_CO_HOP_DONG`. */
  const coDauNguon =
    phieu.commission_kind !== null || row.systemSource === TERMINATION_REFUND_SOURCE;
  const lyDoKhongCoBang =
    !coBangTuSinh && coDauNguon && !row.contractId
      ? KHONG_CO_HOP_DONG
      : LY_DO_KHONG_CO_BANG[row.kind];

  /**
   * Hỏi facts theo UUID phiếu ĐANG MỞ. Không bao giờ theo mã: production có
   * nhiều phiếu trùng mã hiển thị. Phiếu không đủ dấu ⇒ truyền `null`, tức
   * KHÔNG gọi RPC — `get_commission_voucher_facts_v1` đòi broker/sale, gọi cho
   * phiếu thủ công cũng chỉ trả rỗng.
   *
   * Hai hook này cũng được chính `VoucherNote` gọi bên dưới; React Query gộp
   * theo queryKey nên vẫn là MỘT request.
   */
  const hoan = useTerminationRefundFacts(nguonBang === 'termination' ? row.voucherId : null, enabled);
  const hoaHong = useCommissionVoucherFacts(nguonBang === 'commission' ? row.voucherId : null, enabled);

  const trangThai: BasisReadState =
    nguonBang === 'commission'
      ? basisReadState(hoaHong, NGUON_HOA_HONG)
      : nguonBang === 'termination'
        ? basisReadState(hoan, NGUON_HOAN)
        : { kind: 'sufficient' };

  /**
   * ĐỌC ĐƯỢC NHƯNG THIẾU — đúng nghĩa `ok: 'partial'` của `ReadState` (T2).
   *
   * RPC dựng `termination` và `contract` từ HAI nguồn RỜI: bảng
   * `contract_terminations` và `app_private.commission_contract_facts_v1(contract_id)`
   * (migration 20260902104355). Mỗi cái NULL được độc lập, và mỗi cái thiếu làm
   * hỏng một phần KHÁC NHAU của bảng:
   *   • thiếu `termination` ⇒ `buildTerminationCard` trả null ⇒ không có khung tổng hợp
   *   • thiếu `contract`    ⇒ dòng đầu in "—/— · bắt đầu — · kết thúc —" và
   *                           "Cọc đã thu: … (chưa có phiếu thu cọc)"
   * Trang Thu chi im lặng ở cả hai; ở màn duyệt chi thì im lặng là mời người ta
   * đọc mấy gạch ngang như một bản quyết toán đầy đủ.
   */
  const thieuNguonThanhLy: string[] =
    nguonBang === 'termination' && trangThai.kind === 'sufficient'
      ? [
          hoan.data?.termination ? null : 'hồ sơ quyết toán thanh lý (nên không dựng được khung tổng hợp)',
          hoan.data?.contract ? null : 'thông tin hợp đồng (nên phòng/toà, ngày và phiếu thu cọc hiện thành gạch ngang)',
        ].filter((x): x is string => x !== null)
      : [];
  const readState: ModalReadState = trangThai.kind === 'sufficient'
    ? thieuNguonThanhLy.length > 0 ? 'insufficient' : 'ready'
    : trangThai.kind;
  useEffect(() => { onReadStateChange?.(readState); }, [onReadStateChange, readState]);

  /**
   * Câu căn cứ cho nhánh KHÔNG có bảng tự sinh.
   *
   * ⚠ `basisOf` trả `CAN_CU_HOAN_TRA_KHI_MO_PHIEU` cho MỌI phiếu hoàn. Đó là
   * câu đúng ở DANH SÁCH. Ở ĐÂY thì không: hộp thoại đang mở rồi, và chỗ "tra"
   * duy nhất là hồ sơ quyết toán tự sinh — thứ mà nhánh này tồn tại chính vì
   * phiếu KHÔNG có. In lại nó là hứa một việc không bao giờ xảy ra, lại còn lặp
   * với khối "Số trên phiếu so với căn cứ" phía trên.
   *
   * So bằng HẰNG SỐ, không dò chuỗi: lý do `not-found` nào khác vẫn hiện nguyên
   * văn qua `moTaCanCu`.
   */
  const cauCanCu =
    row.basis.kind === 'not-found' && row.basis.reason === CAN_CU_HOAN_TRA_KHI_MO_PHIEU
      ? 'Đã tra lúc mở phiếu: phiếu này không có hồ sơ quyết toán tự sinh để đối chiếu.'
      : moTaCanCu(row.basis);

  return (
    <div data-testid="settlement-voucher-details">
      <h3 style={{ marginTop: 16 }}>Bảng quyết toán · căn cứ</h3>

      {coBangTuSinh ? (
        <>
          <TrangThaiCanCu st={trangThai} />
          {trangThai.kind === 'error' && (
            <button type="button" className="cs-btn sm" onClick={() => {
              void (nguonBang === 'commission' ? hoaHong.refetch() : hoan.refetch());
            }}>Thử lại căn cứ</button>
          )}
          {thieuNguonThanhLy.length > 0 ? (
            <TrangThaiCanCu
              st={{
                kind: 'insufficient',
                reason: `Đọc được phiếu nhưng KHÔNG thấy ${thieuNguonThanhLy.join(' và ')}.`,
              }}
            />
          ) : null}
          {trangThai.kind === 'sufficient' ? (
            <div className="cs-sheet" data-testid="settlement-basis">
              {/* Chỉ hiển thị bảng căn cứ, không kèm ghi chú gốc. */}
              <VoucherNote voucher={phieu} enabled={enabled} hideRefundInstruction />
            </div>
          ) : null}
        </>
      ) : (
        <div className="cs-sheet" data-testid="settlement-basis">
          <div className="cs-note-s" data-testid="settlement-basis-manual">
            {lyDoKhongCoBang}
          </div>
          {/* Căn cứ SỐ TIỀN vẫn có — nó đến từ read model (kỳ ký hợp đồng),
              khác hẳn ghi chú chi tiết tự sinh. `cauCanCu` tự nói "chưa tra"
              hay "tra mà hỏng", nên không có đường nào ra số 0 giả. */}
          <div className="cs-kv" style={{ marginTop: 4 }}>
            <span className="k">{NHAN_CAN_CU[row.kind]}</span>
            <span className="v">{cauCanCu}</span>
          </div>
        </div>
      )}

    </div>
  );
}

export default SettlementVoucherDetails;
