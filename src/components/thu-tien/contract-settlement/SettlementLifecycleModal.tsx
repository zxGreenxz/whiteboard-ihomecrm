// =============================================================================
// SettlementLifecycleModal — hồ sơ một khoản chi, theo bản thiết kế 03.
//
// Ba phần: đầu phiếu · DÒNG THỜI GIAN VÒNG ĐỜI HỢP ĐỒNG · hai cột nội dung.
//
// ⚠ MỌI NÚT TIỀN TÁC ĐỘNG ĐÚNG `voucherId` ĐANG MỞ. Không bao giờ chuyển sang
// phiếu khác chỉ vì cùng phòng hay cùng hợp đồng.
//
// Modal này ĐỌC và PHÁT LỆNH, không tự chọn writer — mọi lệnh đi qua
// `useSettlementActions`, và hộp thoại ghi sổ dùng nguyên
// `IncomeExpensePostingDialog` của Thu chi, KHÔNG sửa dialog đó.
//
// ── "Xác nhận & Chuyển Chờ Duyệt" làm gì ───────────────────────────────────
// KHÔNG lập phiếu — phiếu đã có sẵn từ Thu chi rồi. Nút này chỉ gỡ các vướng
// mắc mà màn này gỡ được (điền tên/ngân hàng/số tài khoản, đóng yêu cầu bổ
// sung). Gỡ hết blocker thì dòng TỰ chuyển sang làn Chờ duyệt, vì làn được suy
// ra chứ không lưu ở đâu. Lệch căn cứ thì phải sửa phiếu bên Thu chi.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  validatePostFinanceExecutionInput,
  type PostFinanceExecutionInput,
} from '@/lib/incomeExpensePostingValidation';
import {
  useCustodianCashbooksV2, useAttachPostingEvidence, adoptVoucherAttachmentsAsEvidence,
} from '@/hooks/income-expenses/financeV2Mutations';
import {
  describeEvidenceSkipReason, type PostingEvidenceSkip,
} from '@/lib/postingEvidenceItems';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';
import { useAuth } from '@/hooks/useAuth';
import { buildVietQRImageUrl, matchRecipientBankCode, RECIPIENT_BANKS } from '@/lib/vietqrDeeplink';
import BankSelect from '@/components/income-expenses/BankSelect';
import { ChungTuThanhToan } from './ChungTuThanhToan';
import { useAccounts } from '@/hooks/useAccounts';
import { useIncomeExpenseSupplements } from '@/hooks/income-expenses/supplements';
import { formatSupplementAuthor } from '@/lib/incomeExpenseSupplement';
import { ContractLifecycleBand } from './ContractLifecycleBand';
import { SettlementVoucherDetails } from './SettlementVoucherDetails';
import { mocNgayNghiepVu, type LaneSubject } from '@/lib/contractLifecycle';
import { vnTodayISO } from '@/lib/vnDate';
import {
  KIND_LABEL, STATUS_STYLE, fmtMoney, fmtNgay, isBlocker,
  type SettlementRow, type ViewStatus,
} from '@/lib/contractSettlement';
import type { useSettlementActions } from '@/hooks/useSettlementActions';
import { NHAN_VUONG_MAC, moTaCanCuTrongModal } from './nhan';
import type { ModalReadState } from './modalReadState';

type Actions = ReturnType<typeof useSettlementActions>;

interface Props {
  row: SettlementRow;
  view: ViewStatus;
  actions: Actions;
  onClose: () => void;
  onRetrySources?: () => void;
}

/** Khoá idempotency của một lệnh; giữ lại khi thử lại lệnh chưa rõ kết quả. */
const khoaMoi = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `cs-${Math.random().toString(36).slice(2)}`;

/**
 * Tên ngân hàng ĐÃ CHUẨN HOÁ theo danh mục dùng chung (`RECIPIENT_BANKS`), tức
 * `shortName` — y hệt giá trị form Thu chi lưu vào `receive_bank_name`.
 *
 * ⚠ Không nhận diện được thì TRẢ LẠI NGUYÊN CHUỖI CŨ, không trả rỗng. Dữ liệu
 * nhiều năm có đủ kiểu ("NH TMCP SO 1 CN Q7"); xoá trắng nó là lặng lẽ làm mất
 * thông tin duy nhất người dùng có để đối chiếu và chọn lại.
 */
function chuanHoaNganHang(tho: string | null | undefined): string {
  const s = (tho ?? '').trim();
  if (!s) return '';
  const code = matchRecipientBankCode(s);
  return RECIPIENT_BANKS.find((b) => b.code === code)?.shortName ?? s;
}

/** Câu lỗi đọc được cho người dùng; RPC trả PostgrestError, không phải Error. */
const moTaLoi = (e: unknown): string => {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m.trim() ? m.trim() : 'không rõ nguyên nhân';
};

export function SettlementLifecycleModal(props: Props) {
  // Draft, chứng từ và lệnh đang chạy chỉ thuộc một phiếu. Đổi phiếu tạo phiên
  // mới; completion của phiên đã unmount không được đóng/cập nhật phiên mới.
  return <SettlementLifecycleModalContent key={props.row.voucherId} {...props} />;
}

function SettlementLifecycleModalContent({ row, view, actions, onClose, onRetrySources }: Props) {
  const kha = actions.availabilityOf(row);
  const [lifecycleReadState, setLifecycleReadState] = useState<ModalReadState>('loading');
  const [basisReadState, setBasisReadState] = useState<ModalReadState>('loading');
  const nguonDoiChieu = [
    row.validationState ?? 'ready',
    ...(row.organizationId && row.contractId ? [lifecycleReadState] : []),
    basisReadState,
  ];
  const coNguonLoi = nguonDoiChieu.includes('error');
  const daXacMinh = !coNguonLoi && !nguonDoiChieu.includes('loading');
  /**
   * Vai của lane đích lấy từ ĐÚNG loại phiếu. `row.kind` có thể là 'unknown'
   * (phiếu thủ công chưa nhận được loại) — khi đó lane mang nhãn trung tính,
   * KHÔNG được mặc định thành "Hợp đồng của phiếu hoàn".
   */
  const vaiLane: LaneSubject = { kind: 'voucher', voucherKind: row.kind };
  /**
   * Mốc ngày NGHIỆP VỤ của hồ sơ: ngày phiếu. Bản lùi dùng `vnTodayISO`, KHÔNG
   * dùng `new Date().toISOString()` — bản UTC trả HÔM QUA trong khoảng
   * 00:00–07:00 giờ Việt Nam.
   */
  const businessDate = mocNgayNghiepVu(row.eventDate, vnTodayISO());
  const [lyDo, setLyDo] = useState('');
  const [chuoiTuChoi, setChuoiTuChoi] = useState(false);
  const [daDoiChieu, setDaDoiChieu] = useState(false);
  const [nguoiNhan, setNguoiNhan] = useState(row.recipientName ?? '');
  /**
   * Ngân hàng lưu theo `shortName` như form Thu chi, prefill từ giá trị ĐANG CÓ
   * đã chuẩn hoá. Bản cũ khởi tạo RỖNG rồi suy ra "đã sửa" từ `!== ''`, nên
   * phiếu vốn đã có ngân hàng mở lên là lập tức bị coi như vừa sửa.
   */
  const [nganHang, setNganHang] = useState(() => chuanHoaNganHang(row.bankName));
  const [soTk, setSoTk] = useState(row.bankAccount ?? '');
  const [loiLuu, setLoiLuu] = useState<string | null>(null);
  const [dangLuuNhan, setDangLuuNhan] = useState(false);
  /** URL ảnh QR tải hỏng; so theo URL nên đổi tài khoản là tự hết lỗi cũ. */
  const [qrHong, setQrHong] = useState<string | null>(null);
  /** Đổi để React dựng lại <img> — thử lại mà KHÔNG bịa thêm tham số vào URL. */
  const [lanQR, setLanQR] = useState(0);
  /** null = chưa mở form chi. Khác null = đang chi, và nhớ sẽ gọi hàm nào. */
  const [dangChi, setDangChi] =
    useState<'APPROVE_AND_POST' | 'POST_APPROVED' | null>(null);
  const [soQuy, setSoQuy] = useState('');
  /**
   * NGÀY CHI MẶC ĐỊNH THEO GIỜ VIỆT NAM (plan §3.5).
   *
   * Bản cũ dùng `new Date().toISOString().slice(0, 10)` — đó là ngày UTC, nên
   * trong khoảng 00:00–06:59 giờ Việt Nam nó tự điền NGÀY HÔM QUA, và qua giao
   * tháng/giao năm thì lệch hẳn kỳ. `vnTodayISO()` ghim `Asia/Ho_Chi_Minh` nên
   * đúng cả trên máy/trình duyệt chạy UTC.
   *
   * KHÔNG thay bằng `todayISO()` của `collect.ts`: hàm đó còn đọc giờ MÁY.
   *
   * Khởi tạo MỘT LẦN: ngày người dùng tự chọn không bị refetch, tải ảnh hay
   * lưu thông tin người nhận ghi đè, và đi thẳng vào `postedOn` dạng chuỗi —
   * không vòng qua timestamp UTC.
   */
  const [ngayChi, setNgayChi] = useState(() => vnTodayISO());
  /** Chứng từ hợp lệ server nhận từ ẢNH TRÊN PHIẾU — luôn thay nguyên cụm. */
  const [idTuAnhPhieu, setIdTuAnhPhieu] = useState<string[]>([]);
  /** Chứng từ đi ĐƯỜNG LÙI: có trong kho chứng từ nhưng không đính được lên phiếu. */
  const [idDuongLui, setIdDuongLui] = useState<string[]>([]);
  /** Ảnh server KHÔNG nhận cho lần ghi sổ này, kèm lý do thô. */
  const [boQua, setBoQua] = useState<PostingEvidenceSkip[]>([]);
  /** URL vừa tải/dán trong phiên — `row.attachments` là ảnh chụp lúc đọc. */
  const [anhTrongPhien, setAnhTrongPhien] = useState<string[]>([]);
  const [dangNhanAnh, setDangNhanAnh] = useState(false);
  /** Adopt không trả về id nào VÀ cũng không nói ảnh nào bị loại ⇒ đọc hỏng. */
  const [nhanAnhHong, setNhanAnhHong] = useState(false);
  const [dangTaiAnh, setDangTaiAnh] = useState(false);
  const [dangGhiSo, setDangGhiSo] = useState(false);
  const lenhBoSung = useRef<{ command: string; idempotencyKey: string } | null>(null);
  const [dangPhatLenh, setDangPhatLenh] = useState(false);
  const dangPhatLenhRef = useRef(false);
  const luotPhatLenh = useRef(0);
  /** Sinh MỘT LẦN mỗi lần mở form chi — thử lại không ghi sổ hai lần. */
  const [khoaGhiSo, setKhoaGhiSo] = useState(khoaMoi);

  const { data: authUser } = useAuth();
  const dinhChungTu = useAttachPostingEvidence();
  const qc = useQueryClient();

  /** Mọi kết quả await phải còn thuộc phiên phiếu đang mở. */
  const phieuHienTai = useRef(row.voucherId);
  phieuHienTai.current = row.voucherId;
  const conSong = useRef(true);
  useEffect(() => {
    conSong.current = true;
    return () => { conSong.current = false; };
  }, []);
  /** Kết quả về sau khi đóng modal hoặc đã đổi phiếu thì BỎ, không gắn lung tung. */
  const conDungPhieu = useCallback(
    (id: string) => conSong.current && phieuHienTai.current === id,
    [],
  );
  const supplements = useIncomeExpenseSupplements(row.voucherId, true);
  const nguonCustodian = useCustodianCashbooksV2(!!dangChi);
  const nguonAccounts = useAccounts({ enabled: !!dangChi });
  const soCustodian = nguonCustodian.data;
  const moiSo = nguonAccounts.data;
  const soDangTai = nguonCustodian.isLoading || nguonAccounts.isLoading
    || nguonCustodian.isFetching || nguonAccounts.isFetching;
  const soBiLoi = nguonCustodian.isError || nguonAccounts.isError;
  const soSanSang = !soDangTai && !soBiLoi;

  /**
   * ⚠ `list_cashbooks_for_expense_v2()` KHÔNG nhận tham số tổ chức — nó trả mọi
   * sổ CUSTODIAN qua mọi membership đang hoạt động, và chỉ có id + name. Người
   * nhiều tổ chức sẽ thấy sổ của org khác, bấm vào thì writer từ chối. Giao với
   * `useAccounts` (có organization_id + is_virtual) để lọc theo org CỦA PHIẾU.
   */
  const soDungOrg = useMemo(() => {
    const hopLe = new Set(
      ((moiSo ?? []) as { id: string; organization_id?: string; is_virtual?: boolean }[])
        .filter((a) => a.organization_id === row.organizationId && !a.is_virtual)
        .map((a) => a.id),
    );
    return (soCustodian ?? []).filter((b) => hopLe.has(b.id));
  }, [moiSo, soCustodian, row.organizationId]);

  /**
   * THÔNG TIN NHẬN TIỀN ĐÃ LƯU — nguồn DUY NHẤT dựng QR và là mốc so "đã sửa".
   *
   * ĐỌC THẲNG TỪ `row`, tức từ bản vừa đọc lại của server. KHÔNG có ảnh chụp
   * client nào xen vào: `editRecipient` đã `await lamMoi()` trước khi resolve
   * (`useSettlementActions.ts`), nên tới nhịp lưu-xong thì `row` đã là bản mới.
   *
   * ⚠ Bản trước giữ một ảnh chụp giá trị VỪA GÕ và ưu tiên nó cho tới khi đổi
   * phiếu. Vì refetch đã xong từ trước, nó không còn tác dụng "hiện ngay" nào —
   * chỉ còn tác dụng CHE: RPC/trigger chuẩn hoá hay cắt bớt thứ gửi lên thì QR
   * và khối chỉ-đọc vẫn in con số của client, và màn hình không bao giờ tự sửa
   * lại chừng nào hộp thoại còn mở. Bỏ ảnh chụp ⇒ lệch nào cũng lộ ra ngay dưới
   * dạng "đang sửa, chưa lưu".
   *
   * ⚠ KHÔNG hứa chống ghi đè liên phiên (plan §7): `editRecipient` gọi RPC
   * không có khoá phiên bản. Máy khác sửa cùng lúc thì bản đọc lại có thể khác.
   */
  const nhanTien = useMemo(() => ({
    ten: (row.recipientName ?? '').trim(),
    nganHang: chuanHoaNganHang(row.bankName),
    soTk: (row.bankAccount ?? '').trim(),
  }), [row.recipientName, row.bankName, row.bankAccount]);

  /**
   * "Đã sửa" = LỆCH SO VỚI BẢN ĐÃ LƯU ĐÃ CHUẨN HOÁ, không phải "ô ngân hàng
   * khác rỗng". Nhờ vậy phiếu vốn có sẵn ngân hàng — kể cả viết là
   * "VIETTINBANK" — mở lên không tự nhận là vừa bị sửa.
   */
  const doiNguoiNhan =
    nguoiNhan.trim() !== nhanTien.ten
    || nganHang.trim() !== nhanTien.nganHang
    || soTk.trim() !== nhanTien.soTk;

  /** Chuỗi ngân hàng đang giữ nhưng danh mục chung không nhận ra. */
  const nganHangLa = nganHang.trim();
  const nganHangCu = nganHangLa !== '' && !matchRecipientBankCode(nganHangLa);

  /**
   * Ảnh VietQR THẬT, quét được — không phải ô mô phỏng như bản demo thiết kế.
   * Hiện QR giả trên app thật là mời người ta quét nhầm, nên thiếu dữ kiện thì
   * nói thẳng là chưa dựng được QR và thiếu ĐÚNG thứ gì.
   */
  const qr = useMemo(() => {
    const code = matchRecipientBankCode(nhanTien.nganHang);
    const bin = RECIPIENT_BANKS.find((b) => b.code === code)?.bin;
    if (!bin || !nhanTien.soTk) return null;
    return buildVietQRImageUrl({
      bin, accountNumber: nhanTien.soTk, amount: row.amount,
      note: row.voucherCode ?? undefined, accountName: nhanTien.ten || undefined,
    });
  }, [nhanTien, row.amount, row.voucherCode]);

  const thieuChoQR = useMemo(() => {
    const thieu: string[] = [];
    if (!nhanTien.nganHang) thieu.push('chưa có ngân hàng');
    else if (!matchRecipientBankCode(nhanTien.nganHang)) {
      thieu.push(`ngân hàng đang lưu là “${nhanTien.nganHang}” — không khớp danh mục, chọn lại ở ô Ngân hàng`);
    }
    if (!nhanTien.soTk) thieu.push('chưa có số tài khoản');
    return thieu.join(' · ');
  }, [nhanTien]);

  /**
   * Chỉ phiếu CÒN PHẢI CHI mới hiện QR. Phiếu đã chi / hoàn tác / huỷ / ghi sổ
   * ảo mà vẫn treo QR là mời chuyển khoản lần hai cho một khoản đã xong.
   */
  const conPhaiChi = view === 'review' || view === 'pending' || view === 'approved';

  /**
   * Dọn sạch mọi thứ thuộc về MỘT lần ghi chi — kể cả cờ "đang tải".
   *
   * ⚠ Cờ `dangTaiAnh` PHẢI nằm ở đây: lần tải của phiếu cũ về muộn sẽ bị chặn
   * ở `conDungPhieu` nên không tự tắt cờ được, và nếu không dọn thì form của
   * phiếu mới mở lên đã kẹt sẵn ở "Đang tải…" với nút xác nhận khoá cứng.
   */
  const xoaChungTu = useCallback(() => {
    setIdTuAnhPhieu([]);
    setIdDuongLui([]);
    setBoQua([]);
    setAnhTrongPhien([]);
    setNhanAnhHong(false);
    setDangTaiAnh(false);
  }, []);

  /** Form chi đang mở cho ĐÚNG phiếu nào — chốt tại lúc bấm, không suy lại. */
  const phieuCuaForm = useRef<string | null>(null);

  const moFormChi = (mode: 'APPROVE_AND_POST' | 'POST_APPROVED') => {
    if (!daXacMinh || dangPhatLenhRef.current || actions.isBusy) return;
    phieuCuaForm.current = row.voucherId;
    setDangChi(mode);
    setKhoaGhiSo(khoaMoi());
    xoaChungTu();
    setSoQuy('');
  };

  /**
   * Dropdown ngân hàng đi portal RIÊNG của Radix, là ANH EM của `.cs-scrim`
   * chứ không nằm trong nó. Radix chép z-index tính được của content lên bọc
   * ngoài — cũng là 50, bằng đúng `.cs-scrim`, nên hiện tại nó chỉ nổi lên trên
   * nhờ THỨ TỰ DOM. Lớp `cs-modal-mo` ghim việc đó thành luật (xem CSS), và chỉ
   * sống đúng lúc hộp thoại này mở.
   */
  useEffect(() => {
    document.body.classList.add('cs-modal-mo');
    return () => { document.body.classList.remove('cs-modal-mo'); };
  }, []);

  /**
   * MỞ BƯỚC GHI CHI LÀ TỰ NHẬN ẢNH CÓ SẴN LÀM CHỨNG TỪ (plan §3.1).
   *
   * Giống hệt `IncomeExpensePostingDialog` từ 27/08/2026: phiếu đã có ảnh
   * chuyển khoản thì mở lên là bấm chi được ngay, không bắt bấm thêm một nút
   * "Dùng ảnh có sẵn" nữa.
   *
   * ⚠ RANH GIỚI: việc này CHỈ chuẩn bị chứng từ. Nó không duyệt, không ghi
   * tiền, và KHÔNG thay điều kiện chọn sổ quỹ — tiền chỉ đi khi người dùng bấm
   * "Xác nhận đã chi đủ".
   */
  const luotNhanAnh = useRef(0);
  useEffect(() => {
    // `phieuCuaForm` chốt tại lúc BẤM mở form. Nhờ nó, lần render ngay sau khi
    // cha đổi `row` — form của phiếu cũ còn đang mở — không kéo theo một lượt
    // adopt cho phiếu mới mà người dùng chưa hề mở.
    if (!dangChi || phieuCuaForm.current !== row.voucherId) return;
    if (row.attachments.length === 0) return;
    const idPhieu = row.voucherId;
    const luot = luotNhanAnh.current + 1;
    luotNhanAnh.current = luot;
    const conHieuLuc = () => luotNhanAnh.current === luot && conDungPhieu(idPhieu);

    setDangNhanAnh(true);
    setNhanAnhHong(false);
    void adoptVoucherAttachmentsAsEvidence(idPhieu)
      .then((kq) => {
        if (!conHieuLuc()) return;
        setIdTuAnhPhieu(kq.evidenceIds);
        setBoQua(kq.skipped ?? []);
        // Không id nào VÀ không lý do nào = RPC đọc hỏng, không phải "ảnh bị loại".
        setNhanAnhHong(kq.evidenceIds.length === 0 && (kq.skipped ?? []).length === 0);
      })
      .finally(() => { if (conHieuLuc()) setDangNhanAnh(false); });

    return () => { luotNhanAnh.current += 1; setDangNhanAnh(false); };
    // `row.attachments` cố ý KHÔNG nằm trong deps: adopt một lần mỗi lần mở
    // form; ảnh thêm sau đi đường `themAnh` và đã trả về danh sách mới.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dangChi, row.voucherId]);

  /**
   * Khu này có query riêng (`contract-settlement`); `useAttachPostingEvidence`
   * chỉ làm mới các key của Thu chi. Làm mới tại ĐÂY — adapter của khu — thay
   * vì sửa hook dùng chung.
   */
  const lamMoiHoSo = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['contract-settlement'] });
  }, [qc]);

  /**
   * Tải ảnh lên rồi biến chính nó thành chứng từ — ĐÚNG đường của Thu chi.
   * Dán ảnh (Ctrl/Cmd+V) và chọn tệp đi CHUNG hàm này, không có đường thứ hai.
   */
  const themAnh = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const idPhieu = phieuHienTai.current;
    setDangTaiAnh(true);
    let coThem = false;
    try {
      for (const file of files) {
        const kq = await dinhChungTu(file, {
          voucherId: idPhieu,
          userId: authUser?.id ?? '',
          organizationId: row.organizationId,
        });
        if (!conDungPhieu(idPhieu)) return;
        // Hook đã toast lý do khi trả null — đừng toast đè lên nó.
        if (!kq) continue;
        coThem = true;
        const urlMoi = kq.url;
        if (kq.attachedToVoucher) {
          if (urlMoi) {
            setAnhTrongPhien((p) => (p.includes(urlMoi) ? p : [...p, urlMoi]));
          }
          setIdTuAnhPhieu(kq.evidenceIds);
          setBoQua(kq.skipped ?? []);
        } else {
          setIdDuongLui((p) => [...p, ...kq.evidenceIds]);
        }
        setNhanAnhHong(false);
      }
    } finally {
      if (conDungPhieu(idPhieu)) setDangTaiAnh(false);
    }
    if (coThem) lamMoiHoSo();
  }, [dinhChungTu, authUser?.id, row.organizationId, conDungPhieu, lamMoiHoSo]);

  const nhanTepDan = useCallback((files: File[]) => { void themAnh(files); }, [themAnh]);
  const tayDan = useClipboardImagePaste({
    onFiles: nhanTepDan,
    enabled: !!dangChi && !dangTaiAnh,
    multiple: true,
  });

  /** Chỉ id THẬT mới được gửi đi; trùng thì tính một lần. */
  const chungTuHopLe = useMemo(() => {
    const s = new Set<string>();
    for (const id of [...idTuAnhPhieu, ...idDuongLui]) {
      if (typeof id === 'string' && id.trim() !== '') s.add(id);
    }
    return [...s];
  }, [idTuAnhPhieu, idDuongLui]);

  /**
   * Dựng input y hệt hộp thoại Thu chi. Một chỗ duy nhất tạo ra nó, để form và
   * nút "Xác nhận" không thể lệch nhau về luật.
   */
  const duLieuGhiChi = (): PostFinanceExecutionInput => ({
    subjectKind: 'VOUCHER',
    subjectId: row.voucherId,
    cashbookId: soQuy,
    postedOn: ngayChi,
    evidenceIds: chungTuHopLe,
    /* Thu chi truyền 0 và KHÔNG có cột DB nào tương ứng — giữ y hệt, không
       bịa ra trường để đọc. */
    expectedExecutionRevision: 0,
    expectedApprovalVersion: row.approvalVersion,
    expectedPostingVersion: row.postingVersion,
    idempotencyKey: khoaGhiSo,
  });

  /**
   * Luật hợp lệ lấy NGUYÊN của Thu chi (`validatePostFinanceExecutionInput`),
   * không tự viết lại — viết lại là mời hai bề mặt lệch luật nhau.
   */
  const kiemTra = validatePostFinanceExecutionInput(duLieuGhiChi());
  const loiDauTien = Object.values(kiemTra.errors)[0] ?? null;

  /**
   * Đang xử lý ảnh hoặc đang ghi sổ thì khoá xác nhận — VÀ khoá luôn khi thông
   * tin người nhận còn sửa dở. Form chi nằm ngay dưới khối Người nhận tiền nên
   * hoàn toàn có thể sửa ngân hàng khi form đã mở; chi theo một QR dựng từ số
   * tài khoản CŨ trong lúc người dùng tin là đã đổi xong là cách mất tiền.
   */
  const khoaXacNhan =
    actions.isBusy || dangTaiAnh || dangNhanAnh || dangGhiSo || !kiemTra.ok
    || doiNguoiNhan || dangLuuNhan || !daXacMinh || dangPhatLenh
    || !soSanSang || !soDungOrg.some((s) => s.id === soQuy);

  /**
   * Chống bấm hai lần: `actions.isBusy` chỉ đổi sau một vòng render, còn hai cú
   * bấm liên tiếp nằm trong CÙNG một vòng. Ref chặn ngay lập tức.
   *
   * Thử lại sau lỗi vẫn dùng NGUYÊN `khoaGhiSo` của lần mở form này — writer
   * nhận cùng idempotency key nên không ghi sổ lần hai.
   */
  const dangGhiRef = useRef(false);
  const luotGhi = useRef(0);
  const ghiChi = () => {
    if (!dangChi || khoaXacNhan || dangGhiRef.current) return;
    dangGhiRef.current = true;
    setDangGhiSo(true);
    const input = duLieuGhiChi();
    const luot = ++luotGhi.current;
    const conDungLuot = () => conDungPhieu(input.subjectId) && luotGhi.current === luot;
    void chay(async () => {
      if (dangChi === 'APPROVE_AND_POST') await actions.approveAndPost(input);
      else await actions.post(input);
      if (!conDungLuot()) return;
      setDangChi(null);
      onClose();
    }).finally(() => {
      if (conDungLuot()) {
        dangGhiRef.current = false;
        setDangGhiSo(false);
      }
    });
  };

  const st = STATUS_STYLE[view];
  const chay = async (fn: () => Promise<void>) => {
    try { await fn(); } catch { /* hook đã toast */ }
  };
  const chayLenh = (fn: (conDungLuot: () => boolean) => Promise<void>) => {
    if (!daXacMinh || actions.isBusy || dangPhatLenhRef.current || dangGhiRef.current) return;
    const id = row.voucherId;
    const luot = ++luotPhatLenh.current;
    const conDungLuot = () => conDungPhieu(id) && luotPhatLenh.current === luot;
    dangPhatLenhRef.current = true;
    setDangPhatLenh(true);
    void chay(() => fn(conDungLuot)).finally(() => {
      if (!conDungLuot()) return;
      dangPhatLenhRef.current = false;
      setDangPhatLenh(false);
    });
  };

  // ── Vướng mắc còn chặn, sau khi trừ những thứ nút bên dưới gỡ được ────────
  const blocker = row.issues.filter(isBlocker);
  /** Blocker mà màn này KHÔNG gỡ được — phải sửa phiếu bên Thu chi. */
  const blockerNgoaiTam = blocker.filter(
    (i) => i !== 'MISSING_PAYMENT_INFO' && i !== 'SUPPLEMENT_PENDING',
  );

  /**
   * ĐƯỜNG LƯU DUY NHẤT của thông tin người nhận. Nút "Lưu thông tin nhận tiền"
   * và nút "Xác nhận & Chuyển Chờ Duyệt" cùng gọi đây, để hai bề mặt không thể
   * lệch nhau về patch hay về thứ được coi là "đã lưu".
   *
   * PATCH THƯA: chỉ gửi khoá ĐÃ ĐỔI, và không gửi `p_items` — server giữ nguyên
   * các dòng hạng mục. Ngân hàng chỉ viết khi người dùng chọn cái khác: chữ cũ
   * viết lệch chuẩn ("VIETTINBANK") vẫn ra đúng BIN nên không có lý do gì để
   * lặng lẽ viết đè lên dữ liệu thật của phiếu.
   *
   * Trả về `true` khi đã lưu xong (hoặc không có gì để lưu).
   */
  const dangLuuRef = useRef(false);
  const luuNhanTien = async (): Promise<boolean> => {
    // `dangLuuNhan` chỉ đổi sau một vòng render nên hai cú bấm trong CÙNG vòng
    // vẫn lọt — ref chặn ngay, y như `dangGhiRef` của nút ghi chi.
    if (!daXacMinh || dangLuuRef.current) return false;
    const id = row.voucherId;
    const ten = nguoiNhan.trim();
    const nh = nganHang.trim();
    const tk = soTk.trim();

    const patch: Parameters<Actions['editRecipient']>[0] = { voucherId: id };
    if (ten !== nhanTien.ten) patch.payerName = ten || null;
    if (nh !== nhanTien.nganHang) patch.bankName = nh || null;
    if (tk !== nhanTien.soTk) patch.bankAccount = tk || null;
    if (Object.keys(patch).length === 1) return true;

    dangLuuRef.current = true;
    setDangLuuNhan(true);
    setLoiLuu(null);
    try {
      // `editRecipient` chỉ resolve SAU `lamMoi()`, nên khi tới đây `row` đã
      // được đọc lại. Không chụp lại giá trị client ở đây — xem `nhanTien`.
      await actions.editRecipient(patch);
      // Phiếu đổi giữa chừng thì kết quả này KHÔNG được gắn sang phiếu mới.
      return conDungPhieu(id);
    } catch (e) {
      if (conDungPhieu(id)) setLoiLuu(moTaLoi(e));
      return false;
    } finally {
      dangLuuRef.current = false;
      if (conDungPhieu(id)) setDangLuuNhan(false);
    }
  };

  const boSung = async (xong: boolean, noiDung: string, conDungLuot: () => boolean) => {
    const command = JSON.stringify([row.voucherId, xong ? 'done' : 'request', noiDung]);
    if (lenhBoSung.current?.command !== command) {
      lenhBoSung.current = { command, idempotencyKey: khoaMoi() };
    }
    const lenh = lenhBoSung.current;
    const f = xong ? actions.markSupplementDone : actions.requestSupplement;
    await f({ voucherId: row.voucherId, noiDung, idempotencyKey: lenh.idempotencyKey });
    if (!conDungLuot()) return;
    // Thành công kết thúc logical command. Retry sau lỗi giữ nguyên khoá;
    // loại lệnh hoặc nội dung khác luôn lấy khoá mới.
    if (lenhBoSung.current === lenh) lenhBoSung.current = null;
    await supplements.refetch();
  };

  const xacNhanChuyenLan = () => chayLenh(async (conDungLuot) => {
    // Lưu hỏng thì DỪNG: không đóng yêu cầu bổ sung, không báo thành công.
    if (doiNguoiNhan && !(await luuNhanTien())) return;
    if (!conDungLuot()) return;
    if (row.supplementPending && kha.markSupplementDone) {
      await boSung(true, lyDo.trim() || 'Đã đối chiếu, đủ dữ kiện', conDungLuot);
    }
    if (!conDungLuot()) return;
    toast.success(
      blockerNgoaiTam.length
        ? 'Đã lưu. Phiếu vẫn ở Cần rà soát vì còn vướng ngoài tầm màn này.'
        : 'Đã xác nhận. Phiếu chuyển sang Chờ duyệt.',
    );
    setLyDo((hienTai) => hienTai === lyDo ? '' : hienTai);
  });

  const ghiChuBoSung = (xong: boolean) => chayLenh(async (conDungLuot) => {
    await boSung(xong, lyDo.trim(), conDungLuot);
    if (conDungLuot()) setLyDo((hienTai) => hienTai === lyDo ? '' : hienTai);
  });

  // ⚠ PHẢI dựng qua portal ra document.body.
  //
  // `.tt-stage` của trang Thanh toán là `position: fixed; z-index: 0` — tức một
  // STACKING CONTEXT. Modal nằm trong đó thì z-index bao nhiêu cũng chỉ có tác
  // dụng BÊN TRONG context ấy. Đã dính thật khi thử tay: nút trong modal bị
  // `.ptt-m-ovrow` của khung điện thoại chắn pointer event. Đừng chữa bằng cách
  // nâng z-index — nâng bao nhiêu cũng vô ích.
  return createPortal(
    <div className="cs-scrim" onClick={onClose}>
      <div className="cs-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>

        {/* ── Đầu phiếu ──────────────────────────────────────────────────── */}
        <div className="cs-m-head">
          <div style={{ minWidth: 0 }}>
            <div className="cs-m-code">
              {row.voucherCode ?? 'Chưa có mã'} · {row.contractNumber ?? 'Chưa gắn hợp đồng'}
            </div>
            <h2 className="cs-m-title">
              {KIND_LABEL[row.kind]} <span className="sl">/</span>{' '}
              <span className="mono">{row.buildingName} · {row.roomName ?? '—'}</span>
            </h2>
            <div className="cs-m-meta">
              <span className="cs-tag" style={{ background: st.bg, color: st.fg }}>{st.nhan}</span>
              <span>Khách: <b>{row.customerName}</b></span>
              {/* `nhanTien` chứ không phải `row`: lưu tên mới xong mà đầu phiếu
                  còn in tên cũ là hai chỗ trên CÙNG màn nói hai điều khác nhau. */}
              <span>Người nhận: <b>{nhanTien.ten || '—'}</b></span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexShrink: 0 }}>
            <div className="cs-m-amt">
              <div className="cap">Số tiền trên phiếu</div>
              <div className="val">{fmtMoney(row.amount)}</div>
            </div>
            <button type="button" className="cs-x" onClick={onClose} aria-label="Đóng">×</button>
          </div>
        </div>

        {/* ⚠ `ghiChuHoan` CHỈ dành cho phiếu hoàn. Bản cũ gắn nó cho mọi loại
            nên phiếu hoa hồng cũng hiện "Còn hoàn: <số hoa hồng>" — lấy số hoa
            hồng dán nhãn hoàn, đúng thứ plan §3.2 cấm. Dải tự bỏ qua nếu loại
            không phải hoàn, nhưng không truyền vẫn là rõ ràng hơn. */}
        <ContractLifecycleBand
          onReadStateChange={setLifecycleReadState}
          organizationId={row.organizationId}
          roomId={row.roomId}
          contractId={row.contractId}
          subject={vaiLane}
          businessDate={businessDate}
          sourceLabel="Phiếu đang xem"
          sourceText={`${row.voucherCode ?? 'Chưa có mã'} · ${KIND_LABEL[row.kind]}`}
          ghiChuHoan={row.kind === 'refund' ? {
            text: view === 'paid' ? `Đã hoàn: ${fmtMoney(row.amount)}` : `Còn hoàn: ${fmtMoney(row.amount)}`,
            mau: view === 'paid' ? 'var(--c-paid)' : 'var(--c-partial)',
          } : null}
        />

        {/* ── Hai cột ────────────────────────────────────────────────────── */}
        <div className="cs-body">
          <div className="cs-notes">
            <h3>Đối chiếu căn cứ</h3>
            <div className="cs-headlines">
              <div><span>Biến động</span> <b>{row.eventLabel}</b></div>
              <div><span>Ngày phiếu</span> <b>{fmtNgay(row.eventDate)}</b></div>
              <div><span>Nguồn</span> <b>{row.origin === 'reservation' ? 'Giữ chỗ' : 'Hợp đồng'}</b></div>
            </div>

            <div className="cs-sheet">
              <div className="cs-sheet-t">Số trên phiếu so với căn cứ</div>
              <div className="cs-kv"><span className="k">Số trên phiếu</span><span className="v">{fmtMoney(row.amount)}</span></div>
              {/* ⚠ `moTaCanCuTrongModal`, KHÔNG phải `moTaCanCu`. Ở hộp thoại
                  đã mở, câu "căn cứ hoàn khách tra khi mở phiếu" là lời hứa đã
                  thực hiện xong — số thật in ngay dưới ở "Bảng quyết toán ·
                  căn cứ". Xem chú thích của hàm đó trong `nhan.ts`. */}
              <div className="cs-kv"><span className="k">Số theo căn cứ</span><span className="v">{moTaCanCuTrongModal(row.basis)}</span></div>
              {row.basis.kind === 'mismatch' && (
                <div className="cs-kv strong top">
                  <span className="k">Chênh lệch</span>
                  <span className="v" style={{ color: 'var(--c-unpaid)' }}>
                    {fmtMoney(Math.abs(row.amount - row.basis.amount))}
                  </span>
                </div>
              )}
              <div className="cs-total">
                <span>
                  <b>{view === 'paid' ? 'Đã chi' : 'Còn phải chi'}</b>
                  <span className="sub">
                    {view === 'paid'
                      ? `${row.postedOn ? fmtNgay(row.postedOn) : 'ngày chi chưa xác minh'} · `
                        + `${row.bookName ?? 'sổ không rõ'}`
                      : view === 'reversed' ? 'Đã ghi sổ rồi hoàn tác'
                      : 'Chưa ghi sổ'}
                  </span>
                </span>
                <b className="val">{fmtMoney(row.amount)}</b>
              </div>
            </div>

            {row.basis.kind === 'mismatch' && (
              <div className="cs-warnbox" style={{ marginTop: 12 }}>
                Căn cứ hoa hồng đọc theo <b>bậc hiện hành</b>, không phải bậc tại ngày ký — đối
                chiếu lại với sale trước khi duyệt. Muốn sửa số tiền thì phải sửa phiếu bên Thu chi.
              </div>
            )}

            {row.issues.length > 0 && (
              <>
                <h3 style={{ marginTop: 16 }}>Vướng mắc</h3>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {row.issues.map((i) => {
                    const chan = isBlocker(i);
                    return (
                      <span key={i} className="cs-tag" style={{
                        background: chan ? 'var(--c-unpaid-bg)' : 'var(--line-2)',
                        color: chan ? 'var(--c-unpaid)' : 'var(--ink-2)',
                      }}>
                        {NHAN_VUONG_MAC.vuong[i].nhan}{chan ? '' : ' · cảnh báo'}
                      </span>
                    );
                  })}
                </div>
                <div className="cs-note-s" style={{ marginTop: 8 }}>
                  Chỉ thẻ đỏ mới giữ phiếu ở làn Cần rà soát. Thẻ xám là ghi chú, không chặn duyệt.
                </div>
              </>
            )}

            {/* Bảng quyết toán/căn cứ theo LOẠI phiếu + ghi chú gốc — lấy đúng
                nguồn Thu chi. Đặt TRƯỚC "Lịch sử bổ sung" theo plan §3.2, và
                mục bổ sung ở dưới vẫn là nơi DUY NHẤT dựng lịch sử bổ sung. */}
            <SettlementVoucherDetails row={row} onReadStateChange={setBasisReadState} />

            <h3 style={{ marginTop: 16 }}>Lịch sử bổ sung</h3>
            {supplements.isLoading ? (
              <div className="cs-note-s">Đang tải…</div>
            ) : supplements.isError ? (
              <div className="cs-note-s" style={{ color: 'var(--c-unpaid)' }}>
                Không đọc được ghi chú bổ sung. Chưa kết luận được là phiếu không có yêu cầu nào.
              </div>
            ) : (supplements.data ?? []).length === 0 ? (
              <div className="cs-note-s">Chưa có ghi chú bổ sung nào.</div>
            ) : (
              (supplements.data ?? []).map((s) => (
                <div key={s.id} className="cs-log">
                  <div style={{ whiteSpace: 'pre-line' }}>{s.note}</div>
                  <span>{formatSupplementAuthor(s)}</span>
                </div>
              ))
            )}
          </div>

          {/* ── Cột phải ─────────────────────────────────────────────────── */}
          <div className="cs-side">
            <div>
              <h4>Người nhận tiền</h4>
              {kha.editRecipient ? (
                <div style={{ display: 'grid', gap: 7 }}>
                  <input className="cs-in" value={nguoiNhan} placeholder="Tên người nhận"
                    onChange={(e) => setNguoiNhan(e.target.value)} />
                  {/* DÙNG NGUYÊN `BankSelect` của Thu chi: gõ-để-tìm theo tên,
                      tên không dấu và alias trên CÙNG một danh mục VietQR. Không
                      dựng danh mục thứ hai — hai danh mục là hai sự thật. */}
                  <BankSelect className="cs-in cs-bank" value={nganHang} onChange={setNganHang} />
                  {nganHangCu && (
                    <div className="cs-note-s" style={{ color: 'var(--c-partial)' }}>
                      Ngân hàng đang lưu: “{nganHangLa}” — không khớp danh mục, chọn lại trong ô
                      trên để dựng được QR. Chưa chọn thì chuỗi cũ vẫn được giữ nguyên.
                    </div>
                  )}
                  <input className="cs-in mono" value={soTk} placeholder="Số tài khoản"
                    onChange={(e) => setSoTk(e.target.value)} />
                  {/* Nút chỉ hiện khi CÓ THỨ ĐỂ LƯU — so với bản đã lưu đã chuẩn
                      hoá, không phải "ô ngân hàng khác rỗng". */}
                  {doiNguoiNhan && (
                    <button type="button" className="cs-btn primary sm"
                      disabled={!daXacMinh || actions.isBusy || dangPhatLenh || dangLuuNhan}
                      onClick={() => { void luuNhanTien(); }}>
                      {dangLuuNhan ? 'Đang lưu…' : 'Lưu thông tin nhận tiền'}
                    </button>
                  )}
                  {/* ⚠ Phải kèm `doiNguoiNhan`. `loiLuu` chỉ bị dọn khi lưu
                      lần nữa hoặc đổi phiếu, nên sau một lần lưu hỏng mà người
                      dùng gõ lại đúng giá trị cũ thì draft = bản đã lưu: QR về,
                      nút duyệt/chi mở khoá, mà dòng đỏ vẫn đứng đó bảo "chưa
                      lưu thì không duyệt/chi được". Câu đó khi ấy là sai. */}
                  {loiLuu && doiNguoiNhan && (
                    <div className="cs-note-s" style={{ color: 'var(--c-unpaid)' }}>
                      Chưa lưu được thông tin người nhận: {loiLuu}. Thông tin vừa gõ vẫn còn đây —
                      sửa rồi lưu lần nữa. Chưa lưu thì không duyệt/chi được.
                    </div>
                  )}
                  <div className="cs-note-s">
                    Hai người cùng sửa sẽ ghi đè nhau — đường ghi này chưa có khoá phiên bản.
                  </div>
                </div>
              ) : (
                <>
                  <div className="cs-side-kv"><span className="k">Tên</span><span>{nhanTien.ten || '—'}</span></div>
                  <div className="cs-side-kv"><span className="k">Ngân hàng</span><span>{nhanTien.nganHang || '—'}</span></div>
                  <div className="cs-side-kv">
                    <span className="k">Số tài khoản</span>
                    <span style={{ fontFamily: 'var(--mono)' }}>{nhanTien.soTk || '—'}</span>
                  </div>
                  <div className="cs-note-s" style={{ marginTop: 6 }}>
                    {row.status === 'pending'
                      ? 'Cần quyền sửa phiếu thu chi để đổi thông tin này.'
                      : 'Phiếu đã duyệt — không sửa được trục tiền.'}
                  </div>
                </>
              )}

              {/* ── QR chuyển khoản ──────────────────────────────────────────
                  Ở ĐÂY chứ không nằm trong form chi: làn Cần rà soát không có
                  form chi, mà vẫn phải quét được QR sau khi lưu tài khoản.
                  Nguồn dữ kiện là `nhanTien` — bản ĐÃ LƯU, không phải draft. */}
              {conPhaiChi && (
                <div style={{ marginTop: 10 }}>
                  {doiNguoiNhan ? (
                    <div className="cs-note-s" style={{ color: 'var(--c-partial)' }}>
                      Thông tin nhận tiền đang sửa và <b>chưa lưu</b>. QR cũ thuộc về tài khoản cũ
                      nên đã tạm gỡ — lưu xong mới dựng lại QR đúng tài khoản.
                    </div>
                  ) : qr ? (
                    qrHong === qr ? (
                      <div className="cs-qr">
                        <div className="cs-note-s" style={{ color: 'var(--c-unpaid)' }}>
                          Không tải được ảnh QR. Mạng hoặc dịch vụ VietQR đang lỗi — số tài khoản
                          bên trên vẫn dùng để chuyển tay được.
                        </div>
                        <button type="button" className="cs-btn sm" style={{ marginTop: 6 }}
                          onClick={() => { setQrHong(null); setLanQR((n) => n + 1); }}>
                          Thử lại ảnh QR
                        </button>
                      </div>
                    ) : (
                      <div className="cs-qr">
                        {/* `key` đổi là React dựng lại thẻ ảnh ⇒ tải lại, mà URL
                            giữ NGUYÊN — không nhét tham số lạ vào một URL tiền. */}
                        <img key={lanQR} src={qr} onError={() => setQrHong(qr)}
                          alt={`VietQR chuyển khoản cho ${nhanTien.ten || 'người nhận'}`} />
                        <div className="cs-note-s">
                          QR chuyển khoản · {nhanTien.ten || '—'} · {nhanTien.nganHang}
                          {' · '}<span style={{ fontFamily: 'var(--mono)' }}>{nhanTien.soTk}</span>
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="cs-note-s">Chưa dựng được QR: {thieuChoQR}.</div>
                  )}
                </div>
              )}
            </div>

            <div>
              <h4>Chứng từ thanh toán</h4>
              {!dangChi && view === 'paid' && (
                <div className="cs-proof" style={{ marginBottom: 8 }}>
                  <div>{row.bookName ?? 'Sổ không rõ'}</div>
                  <div className="val">{fmtMoney(row.amount)}</div>
                  {/* Không đọc được bút toán thì NÓI RA, đừng in "Chi ngày —"
                      để người xem tưởng phiếu thiếu ngày. */}
                  <div>
                    {row.postedOn
                      ? `Chi ngày ${fmtNgay(row.postedOn)}`
                      : 'Ngày chi chưa xác minh — cần quyền giữ sổ quỹ để đối chiếu'}
                  </div>
                </div>
              )}
              <ChungTuThanhToan
                attachments={row.attachments}
                anhTrongPhien={anhTrongPhien}
                boQua={boQua}
              />
              {row.hasAttachment && view !== 'paid' && (
                <div className="cs-note-s" style={{ marginTop: 6, color: 'var(--brand)' }}>
                  Đã có ảnh nên phiếu không còn vướng thông tin thanh toán.
                </div>
              )}
            </div>

            {/* ── Nút ──────────────────────────────────────────────────── */}
            <div className="cs-acts">
              {!daXacMinh && (
                <div className="cs-warnbox" role="status">
                  {!coNguonLoi
                    ? 'Đang xác minh dữ liệu phiếu. Chưa thể duyệt hoặc chi.'
                    : 'Chưa xác minh được dữ liệu phiếu. Hãy thử lại nguồn bị lỗi trước khi duyệt hoặc chi.'}
                  {row.validationState === 'error' && onRetrySources && (
                    <button type="button" className="cs-btn sm" onClick={onRetrySources}>Thử lại dữ liệu phiếu</button>
                  )}
                </div>
              )}
              {/* Một câu duy nhất giải thích vì sao mọi nút tiền đang khoá —
                  nút xám không kèm lý do là thứ người dùng bấm mãi rồi bỏ. */}
              {doiNguoiNhan && (
                <div className="cs-warnbox">
                  Thông tin nhận tiền đang sửa và chưa lưu. Bấm <b>Lưu thông tin nhận tiền</b> ở
                  khối trên trước; duyệt/chi theo bản chưa lưu là chi vào tài khoản cũ.
                </div>
              )}
              {/* ── Form ghi chi, DỰNG NGAY TẠI ĐÂY theo bản thiết kế 03 ────
                  Không mở hộp thoại của Thu chi nữa. Hàm gọi xuống và hình dạng
                  `PostFinanceExecutionInput` giữ NGUYÊN — chỉ đổi giao diện. */}
              {dangChi && (
                <>
                  <div className="cs-form-t">
                    {dangChi === 'APPROVE_AND_POST' ? 'Duyệt và ghi chi' : 'Ghi nhận chi'}
                  </div>

                  <label className="cs-lb">
                    Sổ chi
                    <select className="cs-in" value={soQuy} onChange={(e) => setSoQuy(e.target.value)}>
                      <option value="">— Chọn sổ quỹ —</option>
                      {soDungOrg.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </label>
                  {soBiLoi ? (
                    <div className="cs-note-s" role="status">
                      Không đọc được sổ quỹ. Chưa thể ghi chi.
                      <button type="button" className="cs-btn sm" onClick={() => {
                        void nguonCustodian.refetch();
                        void nguonAccounts.refetch();
                      }}>Thử lại sổ quỹ</button>
                    </div>
                  ) : soDangTai ? (
                    <div className="cs-note-s" role="status">Đang tải sổ quỹ…</div>
                  ) : soDungOrg.length === 0 && (
                    <div className="cs-note-s" style={{ color: 'var(--c-unpaid)' }}>
                      Bạn không giữ sổ quỹ nào của tổ chức này nên không ghi chi được.
                    </div>
                  )}

                  <label className="cs-lb">
                    Ngày chi
                    <input type="date" className="cs-in mono" value={ngayChi}
                      onChange={(e) => setNgayChi(e.target.value)} />
                  </label>

                  {/* QR đã chuyển lên khối "Người nhận tiền" — một chỗ duy nhất
                      dựng QR, và làn Cần rà soát (không có form chi) cũng thấy
                      được nó sau khi lưu tài khoản. */}

                  {/* ── Chứng từ ────────────────────────────────────────────
                      KHÔNG còn nút "Dùng ảnh có sẵn": ảnh trên phiếu đã được
                      nhận tự động lúc mở form. Ô này chỉ để BỔ SUNG. */}
                  <div>
                    <div className="cs-lb-t">Ảnh chuyển khoản</div>
                    {dangNhanAnh ? (
                      <div className="cs-note-s">Đang nhận ảnh của phiếu làm chứng từ…</div>
                    ) : chungTuHopLe.length > 0 ? (
                      <div className="cs-note-s" style={{ color: 'var(--brand)' }}>
                        {chungTuHopLe.length} ảnh dùng làm chứng từ cho lần chi này.
                      </div>
                    ) : (
                      <div className="cs-note-s" style={{ color: 'var(--c-unpaid)' }}>
                        {nhanAnhHong
                          ? 'Không nhận được ảnh trên phiếu làm chứng từ. Tải hoặc dán ảnh mới để chi.'
                          : 'Chưa có ảnh nào dùng được làm chứng từ cho lần chi này.'}
                      </div>
                    )}
                    {/* Mỗi ảnh bị loại có CÂU RIÊNG. Một ảnh hỏng không phủ nhận
                        ảnh còn lại — nói rõ để người dùng không tưởng mất hết. */}
                    {boQua.map((s) => (
                      <div key={s.url} className="cs-note-s" style={{ color: 'var(--c-partial)' }}>
                        Một ảnh không dùng được: {describeEvidenceSkipReason(s.reason)}.
                        {chungTuHopLe.length > 0
                          ? ' Ảnh còn lại vẫn tính là chứng từ.'
                          : ' Tải hoặc dán ảnh khác để chi.'}
                      </div>
                    ))}
                    <div className="cs-tai" {...tayDan}>
                      <div className="cs-note-s">
                        Tải thêm ảnh, hoặc đưa chuột vào đây rồi bấm Ctrl/Cmd+V để dán ảnh.
                      </div>
                      <label className={`cs-btn primary sm ${dangTaiAnh ? 'mo' : ''}`}
                        style={{ textAlign: 'center', cursor: dangTaiAnh ? 'wait' : 'pointer' }}>
                        {dangTaiAnh ? 'Đang tải…' : 'Tải hoặc Dán Ảnh'}
                        <input type="file" accept="image/*" multiple style={{ display: 'none' }}
                          disabled={dangTaiAnh}
                          onChange={(e) => {
                            const fs = [...(e.target.files ?? [])];
                            // Xoá giá trị để chọn lại CÙNG một file vẫn kích hoạt onChange.
                            e.target.value = '';
                            if (fs.length > 0) void themAnh(fs);
                          }} />
                      </label>
                    </div>
                  </div>

                  <button type="button" className="cs-btn primary"
                    disabled={khoaXacNhan}
                    onClick={ghiChi}>
                    Xác nhận đã chi đủ {fmtMoney(row.amount)}
                  </button>
                  {loiDauTien && <div className="cs-note-s">{loiDauTien}</div>}
                  {/* Bỏ dở lần chi thì dọn luôn chứng từ của lần đó: ảnh mờ và
                      câu "không tính cho lần chi này" là trạng thái CỦA MỘT LẦN
                      ghi sổ, để lại trên màn khi không còn lần nào đang mở là
                      nói về một việc không tồn tại. */}
                  <button type="button" className="cs-btn sm"
                    disabled={dangGhiSo}
                    onClick={() => { setDangChi(null); xoaChungTu(); }}>
                    Chưa chi, quay lại
                  </button>
                </>
              )}

              {!dangChi && view === 'review' && (
                <>
                  {blockerNgoaiTam.length > 0 && (
                    <div className="cs-warnbox">
                      Còn vướng ngoài tầm màn này:{' '}
                      {blockerNgoaiTam.map((i) => NHAN_VUONG_MAC.vuong[i].nhan).join(' · ')}.
                      Phải sửa phiếu bên Thu chi thì dòng mới sang được Chờ duyệt.
                    </div>
                  )}
                  {row.supplementPending && (
                    <textarea className="cs-ta" rows={2} value={lyDo}
                      onChange={(e) => setLyDo(e.target.value)} placeholder="Đã bổ sung gì…" />
                  )}
                  <label className="cs-note-s" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={daDoiChieu} style={{ marginTop: 3, accentColor: 'var(--brand)' }}
                      onChange={() => setDaDoiChieu((c) => !c)} />
                    Tôi đã đối chiếu thông tin người nhận và căn cứ của khoản chi này.
                  </label>
                  <button type="button" className="cs-btn primary"
                    disabled={!daXacMinh || actions.isBusy || dangPhatLenh || !daDoiChieu || (!doiNguoiNhan && !row.supplementPending)}
                    onClick={xacNhanChuyenLan}>
                    Xác nhận &amp; Chuyển Chờ Duyệt
                  </button>
                  <div className="cs-note-s">
                    Không lập phiếu mới — phiếu đã có sẵn bên Thu chi và vẫn là phiếu Chờ duyệt.
                    Nút này chỉ lưu thông tin còn thiếu; hết vướng thì dòng tự sang làn Chờ duyệt.
                  </div>
                </>
              )}

              {!dangChi && view === 'pending' && (
                <>
                  {/* ⚠ HAI NÚT DƯỚI ĐÂY LÀ CHỖ SAI CŨ: làn Chờ duyệt duyệt/chi
                      thẳng, BỎ QUA thông tin người nhận vừa gõ. Người dùng sửa
                      số tài khoản rồi bấm Duyệt & Chi là phiếu đi tiếp trên
                      dữ liệu CŨ. Chặn bằng `doiNguoiNhan` cho tới khi lưu. */}
                  {kha.approveAndPost && (
                    <button type="button" className="cs-btn primary"
                      disabled={!daXacMinh || actions.isBusy || dangPhatLenh || doiNguoiNhan || dangLuuNhan}
                      onClick={() => moFormChi('APPROVE_AND_POST')}>
                      Duyệt &amp; Chi {fmtMoney(row.amount)}
                    </button>
                  )}
                  <div className="pair">
                    <button type="button" className="cs-btn sm"
                      disabled={!daXacMinh || actions.isBusy || dangPhatLenh || !kha.requestSupplement || !lyDo.trim()}
                      onClick={() => ghiChuBoSung(false)}>
                      Cần bổ sung
                    </button>
                    {kha.approve && (
                      <button type="button" className="cs-btn ghost sm"
                        disabled={!daXacMinh || actions.isBusy || dangPhatLenh || doiNguoiNhan || dangLuuNhan}
                        onClick={() => chayLenh(async (conDungLuot) => {
                          await actions.approve(row);
                          if (conDungLuot()) onClose();
                        })}>
                        Duyệt Chờ Chi
                      </button>
                    )}
                  </div>
                  {kha.requestSupplement && (
                    <textarea className="cs-ta" rows={2} value={lyDo}
                      onChange={(e) => setLyDo(e.target.value)} placeholder="Cần bổ sung gì…" />
                  )}
                  <div className="cs-note-s">
                    <b>Duyệt &amp; Chi</b>: duyệt rồi ghi sổ ngay. <b>Duyệt Chờ Chi</b>: chuyển Chờ
                    chi, số dư chưa đổi. <b>Cần bổ sung</b>: ghi chú rồi đưa phiếu về Cần rà soát —
                    với Thu chi phiếu vẫn nguyên trạng thái Chờ duyệt.
                  </div>
                </>
              )}

              {!dangChi && view === 'approved' && (
                <>
                  {kha.post ? (
                    <button type="button" className="cs-btn primary"
                      disabled={!daXacMinh || actions.isBusy || dangPhatLenh || doiNguoiNhan || dangLuuNhan}
                      onClick={() => moFormChi('POST_APPROVED')}>
                      Ghi nhận chi {fmtMoney(row.amount)}
                    </button>
                  ) : (
                    <div className="cs-note-s">Không đủ quyền ghi sổ cho tổ chức của phiếu này.</div>
                  )}
                  <div className="cs-note-s">
                    Đã duyệt. Chi một lần đủ số tiền phiếu, sau đó đính chứng từ.
                  </div>
                </>
              )}

              {!dangChi && view === 'paid' && (
                <div className="cs-donebox">
                  {row.postedOn
                    ? `Đã chi đủ ngày ${fmtNgay(row.postedOn)}. Không có nút chi lại.`
                    : 'Đã chi đủ. Ngày chi chưa xác minh được (cần quyền giữ sổ quỹ). '
                      + 'Không có nút chi lại.'}
                </div>
              )}
              {/* PHIẾU HOÀN TÁC — chỗ bản trước sai nặng nhất.
                  REVERSED từng bị gộp vào 'approved', nên đúng cái nút "Ghi
                  nhận chi" hiện ra cho một phiếu ĐÃ TỪNG CHI rồi bị đảo: lời
                  mời chi lần hai. Ở đây không có nút nào; muốn chi lại thì làm
                  bên Thu chi, nơi có writer và cổng quyền thật. */}
              {!dangChi && view === 'reversed' && (
                <div className="cs-cancelbox">
                  <b>Bút toán đã bị hoàn tác.</b> Phiếu này từng được ghi sổ rồi bị đảo — không
                  phải phiếu chưa chi. Cần chi lại thì xử lý bên Thu chi, khu này không mời chi
                  lần hai.
                </div>
              )}
              {!dangChi && view === 'noncash' && (
                <div className="cs-cancelbox">
                  <b>Đã duyệt nhưng không ghi quỹ.</b> Phiếu ghi trên sổ ảo, tiền chưa rời két —
                  đừng đọc thành đã trả cho khách.
                </div>
              )}
              {!dangChi && view === 'cancelled' && (
                <div className="cs-cancelbox"><b>Đã từ chối.</b> Phiếu không còn trong danh sách cần xử lý.</div>
              )}

              {/* Từ chối VẪN mở cho phiếu hoàn tác: tiền đã quay về, huỷ phiếu
                  là bước tiếp theo hợp lý. Chỉ lời mời CHI LẠI mới bị gỡ. Cổng
                  quyền `kha.cancel` không đổi một dòng nào. */}
              {!dangChi && view !== 'paid' && view !== 'cancelled' && (
                !chuoiTuChoi ? (
                  <button type="button" className="cs-btn danger sm"
                    disabled={!daXacMinh || actions.isBusy || dangPhatLenh || !kha.cancel}
                    title={kha.cancelReason ?? undefined}
                    onClick={() => setChuoiTuChoi(true)}>
                    Từ chối phiếu
                  </button>
                ) : (
                  <>
                    <textarea className="cs-ta" rows={2} value={lyDo}
                      onChange={(e) => setLyDo(e.target.value)}
                      placeholder="Lý do từ chối (tối thiểu 8 ký tự)…" />
                    <div className="pair">
                      <button type="button" className="cs-btn sm"
                        onClick={() => { setChuoiTuChoi(false); setLyDo(''); }}>
                        Quay lại
                      </button>
                      <button type="button" className="cs-btn danger sm"
                        disabled={!daXacMinh || actions.isBusy || dangPhatLenh || lyDo.trim().length < 8}
                        onClick={() => chayLenh(async (conDungLuot) => {
                          await actions.cancel(row, lyDo.trim());
                          if (!conDungLuot()) return;
                          toast.success('Đã từ chối phiếu.');
                          onClose();
                        })}>
                        Xác nhận
                      </button>
                    </div>
                  </>
                )
              )}
              {kha.cancelReason && <div className="cs-note-s">Không huỷ được: {kha.cancelReason}</div>}
            </div>
          </div>
        </div>

        <div className="cs-m-foot">
          Chỉ duyệt và chi đúng phiếu đang mở. Hợp đồng trong dòng thời gian dùng để đối chiếu.
        </div>
      </div>

    </div>,
    document.body,
  );
}
