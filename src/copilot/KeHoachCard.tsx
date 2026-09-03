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

/** Câu báo khi quản trị đã tắt cơ chế kế hoạch giữa lúc đề xuất còn treo. */
export const LOI_KE_HOACH_DA_TAT = 'Cơ chế kế hoạch đã bị tắt bởi quản trị.';

/** Nhịp đọc lại trạng thái sau khi người dùng bấm duyệt. */
export const NHIP_POLL_MS = 1500;

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
}: Props) {
  const scope = { organizationId, threadId, generation };
  const [dangCho, setDangCho] = useState(() =>
    layXacNhanDangCho(Date.now(), undefined, scope, 'ke_hoach'),
  );
  const [keHoach, setKeHoach] = useState<KeHoach | null>(() =>
    keHoachTuKhe(layXacNhanDangCho(Date.now(), undefined, scope, 'ke_hoach')?.preview),
  );
  const [dangGui, setDangGui] = useState(false);
  const [daDuyet, setDaDuyet] = useState(false);
  const [loi, setLoi] = useState('');

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

  // Sau khi duyệt: đọc trạng thái thật cho tới khi kế hoạch kết thúc.
  useEffect(() => {
    if (!daDuyet || !planId) return;
    let song = true;
    const t = setInterval(() => {
      void docKeHoach(planId).then((kq) => {
        if (!song || !kq.keHoach) return;
        setKeHoach(kq.keHoach);
        if (keHoachDaKetThuc(kq.keHoach.planStatus)) clearInterval(t);
      });
    }, NHIP_POLL_MS);
    return () => {
      song = false;
      clearInterval(t);
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
    const kq = await duyetKeHoach(keHoach.planId, keHoach.planVersion, keHoach.planDigest);
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
      <div className="mb-2 font-medium text-slate-900">
        Kế hoạch {keHoach.stepCount} bước — {nhanTrangThaiKeHoach(keHoach.planStatus)}
      </div>
      <BangBuocKeHoach steps={keHoach.steps} />
      <p className="mb-2 text-xs text-slate-700">
        Bấm một lần là đồng ý cho CẢ dãy bước trên, chạy tuần tự. Một bước hỏng thì các bước sau
        không chạy.
      </p>
      {keHoach.failureReason && (
        <p className="mb-2 text-xs text-red-700">Lý do dừng: {keHoach.failureReason}</p>
      )}
      {loi && <p className="mb-2 text-xs text-red-700">{loi}</p>}
      {conNutBam && (
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="copilot-plan-approve"
            onClick={() => void bam()}
            disabled={dangGui}
            className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          >
            {dangGui ? 'Đang gửi…' : 'Duyệt kế hoạch'}
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
    </div>
  );
}
