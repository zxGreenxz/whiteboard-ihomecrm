import { useCallback, useEffect, useState } from 'react';

import {
  layNguCanhXacNhan,
  layXacNhanDangCho,
  xoaXacNhanDangCho,
} from './confirmationStore';
import {
  KHOA_ROLLOUT_KE_HOACH,
  copilotAvailability,
  copilotAvailabilitySnapshotIsFresh,
  type CopilotAvailabilitySnapshot,
} from './featureFlags';
import {
  docKeHoach,
  duyetKeHoach,
  huyKeHoach,
  keHoachDaKetThuc,
  type BuocKeHoach,
  type KeHoach,
} from './plan/planClient';
import { tieuTokenStepUp } from './plan/stepUpClient';
import StepUpPinModal from './StepUpPinModal';

/** Câu báo khi quản trị đã tắt cơ chế kế hoạch giữa lúc đề xuất còn treo. */
export const LOI_KE_HOACH_DA_TAT = 'Cơ chế kế hoạch đã bị tắt bởi quản trị.';

/** Nhịp đọc lại trạng thái sau khi người dùng bấm duyệt — nhịp ĐẦU TIÊN. */
export const NHIP_POLL_MS = 1500;

/** Trần nhịp: chậm lại dần, nhưng không chậm tới mức thẻ trông như đã chết. */
export const NHIP_POLL_TOI_DA_MS = 5000;

/** Trần số vòng và trần thời gian theo dõi — kế hoạch nào cũng phải dừng lại. */
export const SO_VONG_TOI_DA = 120;
export const HAN_THEO_DOI_MS = 3 * 60_000;

/** Số lần đọc hỏng LIÊN TIẾP trước khi thôi hỏi. */
export const SO_LOI_LIEN_TIEP_TOI_DA = 3;

export const TEXT_HET_HAN_THEO_DOI = 'Hết thời gian theo dõi — xem tiếp ở tab Hành động.';

/**
 * G5-C2 (nhóm B) — badge riêng cho bước `UNKNOWN_EFFECT`: hành động ĐÃ được
 * gửi (Zalo/Network Center) nhưng kết quả thật chưa xác nhận, khác hẳn "chờ
 * chạy" (`PENDING`) hay "hỏng" (`FAILED`). Người bấm phải thấy NGAY đây là
 * một trạng thái TRUNG GIAN, không phải lỗi.
 */
export const TEXT_HIEU_UNG_NGOAI_DANG_DOI_SOAT = 'hiệu ứng ngoài — đang đối soát';

/** G5-A: token step-up hết hạn/đã dùng giữa lúc modal đóng và lúc bấm Duyệt. */
export const TEXT_PIN_HET_HAN =
  'Xác thực PIN đã hết hạn hoặc chưa hoàn tất. Hãy bấm "Duyệt bằng PIN" lại.';

/** Fix round 1 (F8): khong co to chuc thi khong the xac thuc/tieu token step-up. */
export const TEXT_PIN_THIEU_TO_CHUC =
  'Không xác định được tổ chức của kế hoạch này — chưa thể duyệt bằng PIN. Hãy tải lại cuộc trò chuyện.';

/**
 * Nhịp cho vòng kế tiếp: 1,5s tăng dần tới trần 5s.
 *
 * VÌ SAO KHÔNG GIỮ 1,5s MÃI. Các bước chạy ở một lượt chat khác và một bước ghi
 * có thể mất vài giây; hỏi hai lần một giây suốt ba phút là 120 lời gọi cho một
 * câu trả lời đổi vài lần. Nhịp giãn dần giữ được cảm giác "đang chạy" ở những
 * giây đầu (lúc người dùng thật sự đang nhìn) rồi rẻ dần về sau.
 */
export function nhipTiepTheo(vong: number): number {
  return Math.min(NHIP_POLL_TOI_DA_MS, Math.round(NHIP_POLL_MS * Math.pow(1.15, Math.max(0, vong))));
}

/**
 * Đã tới lúc thôi theo dõi chưa — theo CẢ hai trần.
 *
 * Trần số vòng một mình là không đủ vì nhịp giãn dần: 120 vòng với nhịp tối đa
 * 5 giây là gần 9 phút, chứ không phải 3 phút như ý định. Trần thời gian một
 * mình cũng không đủ: đồng hồ hệ thống nhảy (ngủ/thức, đổi múi giờ) là mất trần.
 */
export function daHetHanTheoDoi(vong: number, batDauLuc: number, bayGio: number): boolean {
  return vong >= SO_VONG_TOI_DA || bayGio - batDauLuc >= HAN_THEO_DOI_MS;
}

/**
 * Nhãn rủi ro hiện trên từng bước.
 *
 * L5 KHÔNG được hiện trần một chữ "L5". Hai đường L5 khác nhau về thứ người
 * dùng đang đồng ý, và người bấm phải đọc ra sự khác biệt đó ngay trên thẻ:
 *   · `maker_submit_v1` — Copilot NỘP hồ sơ, một CON NGƯỜI KHÁC duyệt. Không có
 *     đồng tiền nào đi đâu vì cú bấm này.
 *   · `direct_l5_v1` — ghi thẳng, và cơ chế xác thực bước hai (PIN) là điều kiện
 *     để nó mở. Đường này CHƯA tồn tại ở Mức 2 (`copilot_plan_create_v1` từ chối
 *     với `executor_not_supported`); nhãn có sẵn ở đây để ngày nó mở thì thẻ
 *     không im lặng hiện một chữ "L5" giống hệt đường nộp hồ sơ.
 */
export function nhanRuiRo(buoc: Pick<BuocKeHoach, 'risk' | 'executorKind'>): string {
  if (buoc.executorKind === 'maker_submit_v1') return 'L5 — nộp duyệt, AI không duyệt';
  if (buoc.executorKind === 'direct_l5_v1') return 'L5 — cần PIN';
  return buoc.risk;
}

/** Màu badge theo mức rủi ro — L5 phải khác hẳn L3/L4 bằng mắt, không chỉ bằng chữ. */
export function mauBadge(buoc: Pick<BuocKeHoach, 'risk' | 'executorKind'>): string {
  if (buoc.risk === 'L5') return 'bg-red-100 text-red-800';
  if (buoc.risk === 'L4') return 'bg-amber-100 text-amber-900';
  return 'bg-slate-100 text-slate-700';
}

/** Nhãn tiếng Việt của trạng thái một bước. */
export function nhanTrangThaiBuoc(trangThai: string): string {
  const bang: Record<string, string> = {
    PENDING: 'chờ chạy',
    DONE: 'đã chạy',
    FAILED: 'hỏng',
    BLOCKED: 'bị chặn',
    SKIPPED: 'bỏ qua',
    UNKNOWN_EFFECT: 'chưa rõ kết quả',
  };
  return bang[trangThai] ?? trangThai;
}

export function nhanTrangThaiKeHoach(trangThai: string): string {
  const bang: Record<string, string> = {
    DRAFT: 'chờ bạn duyệt',
    APPROVED: 'đã duyệt — đang chạy',
    DONE: 'đã chạy xong',
    FAILED: 'dừng vì một bước hỏng',
    CANCELLED: 'đã huỷ',
    EXPIRED: 'quá hạn',
  };
  return bang[trangThai] ?? trangThai;
}

/**
 * Tiêu đề của thẻ — G5-B: kế hoạch tự duyệt theo uỷ quyền đứng phải nói RÕ đó
 * KHÔNG PHẢI một cú bấm của người dùng (khác hẳn `APPROVED` thường). Chỉ áp
 * dụng khi CÒN đang chạy hoặc vừa duyệt — một khi kế hoạch đã DONE/FAILED thì
 * nhãn trạng thái kết thúc quan trọng hơn nguồn gốc duyệt.
 */
export function nhanTieuDeKeHoach(ke: Pick<KeHoach, 'planStatus' | 'standingGrantIds'>): string {
  if (ke.planStatus === 'APPROVED' && ke.standingGrantIds && ke.standingGrantIds.length > 0) {
    const idNgan = ke.standingGrantIds[0]?.slice(0, 8) ?? '';
    return `Đã tự duyệt theo uỷ quyền #${idNgan} — đang chạy`;
  }
  return nhanTrangThaiKeHoach(ke.planStatus);
}

/**
 * Cơ chế kế hoạch có đang bị tắt không.
 *
 * Điều kiện là `!== 'enabled'`, không phải `=== 'disabled'` — cùng lý do với
 * `hanhDongDaTat` ở thẻ phiếu: `shadow` nghĩa là đang QUAN SÁT chứ chưa cho
 * chạy thật, và một cú bấm ghi thật dưới cờ `shadow` sẽ là chỗ duy nhất trong
 * hệ hiểu `shadow` là "được ghi". Snapshot thiếu/hết hạn cũng trả `true`.
 */
export function keHoachDaTat(availability: CopilotAvailabilitySnapshot | null | undefined): boolean {
  return copilotAvailability(availability, KHOA_ROLLOUT_KE_HOACH) !== 'enabled';
}

/** Kế hoạch nằm trong khe nhớ — `null` nếu khe rỗng hoặc hình dạng lạ. */
export function keHoachTuKhe(preview: Record<string, unknown> | undefined): KeHoach | null {
  const ke = preview?.ke_hoach;
  if (!ke || typeof ke !== 'object') return null;
  const r = ke as Partial<KeHoach>;
  return typeof r.planId === 'string' && typeof r.planVersion === 'number' ? (ke as KeHoach) : null;
}

/**
 * Tin nhắn hệ thống báo cho mô hình biết NGƯỜI DÙNG vừa bấm.
 *
 * ĐÂY LÀ MỘT LỜI THÔNG BÁO, KHÔNG PHẢI MỘT CÁI CỔNG. Không nơi nào trong ứng
 * dụng đọc chuỗi này rồi làm gì cả: mô hình (hoặc người dùng) gõ lại y hệt câu
 * này thì cũng chỉ là một dòng chữ trong khung chat. Cửa duy nhất mở được đường
 * chạy là `copilot_plan_approve_v1`, và nó đòi một nonce mà chỉ
 * `confirmationStore` cầm — thứ chỉ tới đó qua cú bấm thật trên thẻ này.
 */
export function tinNhanDaDuyet(planId: string, planVersion: number): string {
  return `[Hệ thống] Kế hoạch ${planId} đã được người dùng duyệt (phiên bản ${planVersion}). Hãy gọi thuc_thi_buoc.`;
}

/** Bảng bước — component THUẦN để đo được mà không cần DOM. */
export function BangBuocKeHoach({ steps }: { steps: readonly BuocKeHoach[] }) {
  return (
    <ol className="mb-3 space-y-1.5">
      {steps.map((b) => (
        <li
          key={b.stepNo}
          data-testid={`copilot-plan-step-${b.stepNo}`}
          className="rounded border border-slate-200 bg-white/70 p-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <span className="font-medium">Bước {b.stepNo}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${mauBadge(b)}`}>
              {nhanRuiRo(b)}
            </span>
            {b.status === 'UNKNOWN_EFFECT' && (
              <span
                data-testid={`copilot-plan-step-${b.stepNo}-hieu-ung-ngoai`}
                className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800"
              >
                {TEXT_HIEU_UNG_NGOAI_DANG_DOI_SOAT}
              </span>
            )}
            <span className="text-slate-500">{nhanTrangThaiBuoc(b.status)}</span>
          </div>
          <div className="mt-0.5">{b.labelVi}</div>
          {b.errorCode && <div className="mt-0.5 text-red-700">Mã lỗi: {b.errorCode}</div>}
        </li>
      ))}
    </ol>
  );
}

interface Props {
  /** Người dùng vừa bấm duyệt — ChatPanel dùng để báo cho mô hình chạy tiếp. */
  onDuyet: (planId: string, planVersion: number) => void;
  /** Câu cần đẩy vào khung chat (lỗi, huỷ, kết thúc). */
  onXong: (thongBao: string) => void;
  organizationId: string | null;
  threadId: string | null;
  generation: number;
  availability: CopilotAvailabilitySnapshot | null | undefined;
  /**
   * Mô hình có đang viết dở một lượt không.
   *
   * Nút Duyệt phải KHOÁ khi đang chạy: đường gửi tin hệ thống từ chối lượt thứ
   * hai, nên một cú bấm lúc đó tiêu nonce ở server mà không có lượt nào chạy
   * các bước. Xem chú thích đầu `useHangDoiSauDuyet.ts` cho cả sự cố.
   */
  running?: boolean;
}

/**
 * Thẻ KẾ HOẠCH — cú bấm thật cho MỘT DÃY thao tác ghi.
 *
 * VÌ SAO NÓ KHÔNG PHẢI MỘT ĐOẠN VĂN BẢN CỦA MÔ HÌNH
 *   Cùng lý do với `XacNhanPhieuCard`, chỉ là tiền cược cao hơn: một cú bấm ở
 *   đây mở đường cho tới 8 thao tác ghi. Mô hình sinh ra được văn bản trông y
 *   hệt cái nút này; nó KHÔNG sinh ra được một sự kiện click, và nonce cấp kế
 *   hoạch không bao giờ đi qua ngữ cảnh của nó.
 *
 * VÌ SAO POLL SAU KHI DUYỆT
 *   Các bước chạy ở phía server qua một lượt chat khác (mô hình gọi
 *   `thuc_thi_buoc`). Thẻ không biết lượt đó tới đâu, và ĐOÁN thì sẽ nói dối —
 *   nên nó hỏi `copilot_plan_get_v1` mỗi 1,5 giây cho tới khi kế hoạch vào
 *   trạng thái kết thúc, rồi dừng hẳn.
 */
export default function KeHoachCard({
  onDuyet,
  onXong,
  organizationId,
  threadId,
  generation,
  availability,
  running = false,
}: Props) {
  const scope = { organizationId, threadId, generation };
  const [dangCho, setDangCho] = useState(() =>
    layXacNhanDangCho(Date.now(), undefined, scope, 'ke_hoach'),
  );
  const [keHoach, setKeHoach] = useState<KeHoach | null>(() =>
    keHoachTuKhe(layXacNhanDangCho(Date.now(), undefined, scope, 'ke_hoach')?.preview),
  );
  const [dangGui, setDangGui] = useState(false);
  // G5-B: kế hoạch tới thẳng ở trạng thái APPROVED (uỷ quyền đứng đã phủ hết
  // các bước lúc lập) không có cú bấm nào để chờ — vòng đọc-lại-trạng-thái
  // bên dưới phải bắt đầu NGAY từ lúc mount, không đợi `bam()` chạy xong.
  const [daDuyet, setDaDuyet] = useState(() => keHoach?.planStatus === 'APPROVED');
  const [ketThucTheoDoi, setKetThucTheoDoi] = useState<'' | 'het_gio' | 'loi'>('');
  const [loi, setLoi] = useState('');
  const [hienModalPin, setHienModalPin] = useState(false);

  // Nhịp một giây cho khe nhớ: nonce sống 5 phút và thẻ phải biến mất gần như
  // ngay khi nó chết, thay vì mời người dùng bấm vào một lỗi.
  useEffect(() => {
    const t = setInterval(() => {
      const x = layXacNhanDangCho(Date.now(), undefined, scope, 'ke_hoach');
      setDangCho(x);
      if (x && !daDuyet) setKeHoach(keHoachTuKhe(x.preview));
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, threadId, generation, daDuyet]);

  const planId = keHoach?.planId ?? null;

  // Sau khi duyệt: đọc trạng thái thật cho tới khi kế hoạch kết thúc — hoặc tới
  // khi HẾT HẠN THEO DÕI. Ba trần, mỗi cái chặn một kiểu treo khác nhau:
  //   · kết thúc  ⇒ không còn gì để hỏi;
  //   · vòng/thời gian ⇒ mô hình không bao giờ gọi `thuc_thi_buoc` (kế hoạch nằm
  //     APPROVED tới khi `execute_deadline` 30 phút đưa nó về EXPIRED, mà trạng
  //     thái đó được đánh giá LƯỜI nên tự nó không đổi) — thẻ phải nói ra và chỉ
  //     chỗ xem tiếp, thay vì quay mãi;
  //   · lỗi liên tiếp ⇒ mạng/quyền hỏng; hỏi lần thứ tư cũng cùng một câu trả lời.
  useEffect(() => {
    if (!daDuyet || !planId) return;
    let song = true;
    let vong = 0;
    let loiLienTiep = 0;
    const batDau = Date.now();
    let hen: ReturnType<typeof setTimeout> | undefined;

    const hoi = () => {
      void docKeHoach(planId).then((kq) => {
        if (!song) return;
        if (!kq.keHoach) {
          loiLienTiep += 1;
          if (loiLienTiep >= SO_LOI_LIEN_TIEP_TOI_DA) {
            setLoi(kq.thongBao ?? 'Không đọc được trạng thái kế hoạch.');
            setKetThucTheoDoi('loi');
            return;
          }
        } else {
          loiLienTiep = 0;
          // G5-B: từ 05/09 `copilot_plan_get_v1` cũng mang uỷ quyền đứng
          // (`standing_grant_ids` trong bản tóm tắt), nên vòng poll thường tự
          // giữ được nhãn. Phép hợp nhất dưới đây là DÂY AN TOÀN cho hai
          // trường hợp vẫn có thật: máy chủ chưa kịp nhận migration đó, và kế
          // hoạch tự duyệt mà bản tóm tắt trả mảng rỗng. Giữ NGUYÊN
          // `standingGrantIds` đã biết thay vì để mỗi vòng poll xoá nó, kẻo
          // tiêu đề thẻ nhảy từ "Đã tự duyệt theo uỷ quyền #…" về nhãn
          // APPROVED chung chung chỉ sau 1,5 giây.
          const moi = kq.keHoach;
          setKeHoach((truoc) =>
            moi.standingGrantIds
              ? moi
              : { ...moi, standingGrantIds: truoc?.standingGrantIds ?? null },
          );
          if (keHoachDaKetThuc(moi.planStatus)) return;
        }
        vong += 1;
        if (daHetHanTheoDoi(vong, batDau, Date.now())) {
          setKetThucTheoDoi('het_gio');
          return;
        }
        hen = setTimeout(hoi, nhipTiepTheo(vong));
      });
    };

    hen = setTimeout(hoi, NHIP_POLL_MS);
    return () => {
      song = false;
      if (hen !== undefined) clearTimeout(hen);
    };
  }, [daDuyet, planId]);

  const ngoaiPhamVi = useCallback((): boolean => {
    const hienTai = layNguCanhXacNhan();
    return (
      !hienTai ||
      hienTai.organizationId !== organizationId ||
      hienTai.threadId !== threadId ||
      hienTai.generation !== generation ||
      !copilotAvailabilitySnapshotIsFresh(availability) ||
      availability.organizationId !== organizationId
    );
  }, [organizationId, threadId, generation, availability]);

  if (!keHoach) return null;

  // ĐIỂM NỐI #3 (G5-A). Kế hoạch có bước L5 dưới trần L5 đòi thêm một token
  // step-up trước khi `duyetKeHoach` được gọi — xem `stepUpClient.ts`. Tổ chức
  // dùng để tra/tiêu token PHẢI là tổ chức của CHÍNH kế hoạch: nó là tổ chức mà
  // `copilot_step_up_verify_v1` đã ràng token vào lúc phát ra.
  const canPin = keHoach.maxRisk === 'L5';
  const orgIdChoPin = keHoach.organizationId ?? organizationId;

  const bam = async () => {
    if (dangGui || !dangCho) return;
    setDangGui(true);
    setLoi('');
    // Phạm vi lệch ⇒ im lặng bỏ thẻ (người dùng đã đổi công ty/cuộc trò chuyện).
    if (ngoaiPhamVi()) {
      setDangCho(null);
      setDangGui(false);
      return;
    }
    // Kill switch là quyết định của người vận hành nên phải NÓI RA: người dùng
    // vừa bấm một cái nút và có quyền biết vì sao không có gì xảy ra.
    if (keHoachDaTat(availability)) {
      xoaXacNhanDangCho('ke_hoach');
      setDangCho(null);
      setDangGui(false);
      onXong(`⚠️ ${LOI_KE_HOACH_DA_TAT} Hãy bật lại ở trang quản trị AI Copilot rồi lập lại.`);
      return;
    }
    let token: string | undefined;
    if (canPin) {
      token = (orgIdChoPin && tieuTokenStepUp(orgIdChoPin)) || undefined;
      if (!token) {
        setDangGui(false);
        setLoi(TEXT_PIN_HET_HAN);
        return;
      }
    }
    const kq = await duyetKeHoach(keHoach.planId, keHoach.planVersion, keHoach.planDigest, token);
    setDangGui(false);
    if (!kq.ok) {
      setLoi(kq.thongBao ?? 'Không duyệt được kế hoạch.');
      setDangCho(null);
      return;
    }
    setDangCho(null);
    setDaDuyet(true);
    const phienBan = kq.planVersion ?? keHoach.planVersion;
    setKeHoach({ ...keHoach, planStatus: 'APPROVED', planVersion: phienBan });
    onDuyet(keHoach.planId, phienBan);
  };

  const bamNutDuyet = () => {
    if (dangGui || !dangCho) return;
    // Fix round 1 (F8): L5 nhung khong biet to chuc thi khong mo modal duoc
    // (StepUpPinModal doi organizationId khong rong) — nut da bi disabled
    // cho truong hop nay, day la lop phong thu thu hai.
    if (canPin && !orgIdChoPin) return;
    // L5 dưới trần L5: mở modal PIN thay vì duyệt thẳng. `bam()` chỉ chạy SAU
    // khi modal báo xác thực xong (`onXacThucXong`), lúc đó token đã nằm trong
    // `confirmationStore` chờ `tieuTokenStepUp` lấy-và-xoá.
    if (canPin) {
      setHienModalPin(true);
      return;
    }
    void bam();
  };

  const huy = async () => {
    if (dangGui) return;
    setDangGui(true);
    const kq = await huyKeHoach(keHoach.planId, keHoach.planVersion, 'Người dùng huỷ trên thẻ kế hoạch');
    setDangGui(false);
    setDangCho(null);
    if (!kq.ok) {
      setLoi(kq.thongBao ?? 'Không huỷ được kế hoạch.');
      return;
    }
    setKeHoach({ ...keHoach, planStatus: 'CANCELLED' });
    onXong('Đã huỷ kế hoạch. Không bước nào chạy.');
  };

  const conNutBam = Boolean(dangCho) && !daDuyet && keHoach.planStatus === 'DRAFT';

  return (
    <div
      data-testid="copilot-plan-card"
      className="rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm"
    >
      <div className="mb-2 font-medium text-slate-900" data-testid="copilot-plan-title">
        Kế hoạch {keHoach.stepCount} bước — {nhanTieuDeKeHoach(keHoach)}
      </div>
      <BangBuocKeHoach steps={keHoach.steps} />
      <p className="mb-2 text-xs text-slate-700">
        Bấm một lần là đồng ý cho CẢ dãy bước trên, chạy tuần tự. Một bước hỏng thì các bước sau
        không chạy.
      </p>
      {keHoach.failureReason && (
        <p className="mb-2 text-xs text-red-700">Lý do dừng: {keHoach.failureReason}</p>
      )}
      {ketThucTheoDoi === 'het_gio' && (
        <p className="mb-2 text-xs text-slate-700" data-testid="copilot-plan-het-theo-doi">
          {TEXT_HET_HAN_THEO_DOI}
        </p>
      )}
      {loi && <p className="mb-2 text-xs text-red-700">{loi}</p>}
      {conNutBam && running && (
        <p className="mb-2 text-xs text-slate-700" data-testid="copilot-plan-cho-tro-ly">
          Chờ trợ lý viết xong rồi bấm — bấm lúc này sẽ tiêu mất phiếu đồng ý mà không chạy được
          bước nào.
        </p>
      )}
      {conNutBam && canPin && !orgIdChoPin && (
        <p className="mb-2 text-xs text-red-700" data-testid="copilot-plan-pin-thieu-to-chuc">
          {TEXT_PIN_THIEU_TO_CHUC}
        </p>
      )}
      {conNutBam && (
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="copilot-plan-approve"
            onClick={bamNutDuyet}
            disabled={dangGui || running || (canPin && !orgIdChoPin)}
            className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          >
            {dangGui ? 'Đang gửi…' : canPin ? 'Duyệt bằng PIN' : 'Duyệt kế hoạch'}
          </button>
          <button
            type="button"
            data-testid="copilot-plan-cancel"
            onClick={() => void huy()}
            disabled={dangGui}
            className="rounded-md border border-slate-400 px-3 py-1.5 text-xs font-medium text-slate-800 disabled:opacity-60"
          >
            Huỷ
          </button>
        </div>
      )}
      {hienModalPin && orgIdChoPin && (
        <StepUpPinModal
          organizationId={orgIdChoPin}
          onXacThucXong={() => {
            setHienModalPin(false);
            void bam();
          }}
          onHuy={() => setHienModalPin(false)}
        />
      )}
    </div>
  );
}
