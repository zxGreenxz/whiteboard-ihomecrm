// Tab "Hành động" của trang quản trị AI Copilot — hai thứ mà G2-A dựng ở DB
// nhưng chưa có mặt nào nhìn thấy: VAN chính sách và SỔ hành động.
//
// VÌ SAO CẦN MẶT NGƯỜI DÙNG CHO CHÚNG
//   `set_copilot_action_policy_v1` và `copilot_action_ledger_list_v1` đã sống
//   trên production. Không có trang này thì cách duy nhất để đổi trần rủi ro
//   hoặc đọc sổ là mở psql lên production — tức trong một sự cố, thao tác cứu
//   hoả lại là thao tác nguy hiểm nhất có thể làm.
//
// PHẦN THUẦN NẰM Ở `hanhDongCopilot.ts`
//   File này chỉ dựng giao diện. Chuẩn hoá dữ liệu, luật CAS và câu lỗi ở file
//   kia để đo được mà không cần DOM.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';

import { useAuth } from '@/hooks/useAuth';
import { useIsSuperAdmin } from '@/hooks/useIsAdmin';

import { dienGiaiLoiKeHoach } from '../chatErrors';
import { ACTION_CATALOG } from '../plan/actionCatalog';
import {
  baoCaoNgayGrant,
  dsGrant,
  taoGrant,
  thuHoiGrant,
  thuHoiTatCaGrant,
  type DongGrant,
  type KetQuaBaoCaoNgay,
} from '../plan/standingGrantClient';
import {
  datPin,
  moKhoaPinStepUp,
  resetPinStepUp,
  tieuTokenStepUp,
  trangThaiPin,
  type TrangThaiPin,
} from '../plan/stepUpClient';
import StepUpPinModal from '../StepUpPinModal';
import {
  SO_DONG_SO_MAC_DINH,
  dienGiaiLoiChinhSach,
  dinhDangThoiGian,
  docChinhSachHanhDong,
  docSoHanhDong,
  doiChinhSachHanhDong,
  locSuKienKeHoach,
  nhanSuKien,
  type ChinhSachHanhDong,
  type DongSoHanhDong,
  type MucRuiRoChinhSach,
} from './hanhDongCopilot';

const MUC_RUI_RO: readonly MucRuiRoChinhSach[] = ['L3', 'L4', 'L5'];
const VAI_HOP_LE = ['superadmin', 'owner', 'manager', 'staff'] as const;

/** Bảng sổ — component THUẦN, nhận dữ liệu đã chuẩn hoá nên render được trong test. */
export function BangNhatKyHanhDong({ dong }: { dong: readonly DongSoHanhDong[] }) {
  return (
    <div className="overflow-x-auto rounded border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left">
          <tr>
            <th className="p-2">Thời gian</th>
            <th className="p-2">Sự kiện</th>
            <th className="p-2">Hành động</th>
            <th className="p-2">Người dùng</th>
            <th className="p-2">Mã lỗi</th>
            <th className="p-2">Đối tượng</th>
          </tr>
        </thead>
        <tbody>
          {dong.length === 0 ? (
            <tr>
              <td className="p-3 text-muted-foreground" colSpan={6}>
                Chưa có dòng nào trong sổ cho công ty này.
              </td>
            </tr>
          ) : (
            dong.map((d) => (
              <tr key={d.id} className="border-t align-top">
                <td className="whitespace-nowrap p-2 font-mono text-xs">
                  {dinhDangThoiGian(d.createdAt)}
                </td>
                <td className="p-2">{nhanSuKien(d.event)}</td>
                <td className="p-2 font-mono text-xs">{d.actionId ?? '—'}</td>
                <td className="p-2 font-mono text-xs">{d.userId ?? '—'}</td>
                <td className="p-2 font-mono text-xs">
                  {d.errorCode ? (
                    <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">{d.errorCode}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="p-2 font-mono text-xs">
                  {d.entityTable ? `${d.entityTable}${d.entityId ? `:${d.entityId.slice(0, 8)}` : ''}` : '—'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * "Kế hoạch gần đây" — CÙNG một cái sổ, lọc lấy bảy sự kiện của đường kế hoạch.
 *
 * VÌ SAO TÁCH RA MỘT BẢNG RIÊNG THAY VÌ ĐỂ NGƯỜI ĐỌC TỰ LỌC MẮT
 *   Một kế hoạch là một CÂU CHUYỆN nhiều dòng (lập → duyệt → từng bước), và
 *   trong bảng chung nó nằm xen giữa các dòng của những hành động lẻ. Người
 *   đang trực một sự cố cần đọc "kế hoạch nào vừa chạy, tới bước nào thì dừng"
 *   — câu hỏi đó không trả lời được bằng cách nhìn một bảng trộn.
 *
 * Cột `Kế hoạch` in 8 ký tự đầu của `plan_id` cộng số bước: đủ để nối các dòng
 * của cùng một kế hoạch bằng mắt, và không dài tới mức đẩy các cột khác ra khỏi
 * màn hình.
 */
export function BangKeHoachGanDay({ dong }: { dong: readonly DongSoHanhDong[] }) {
  const cua = locSuKienKeHoach(dong);
  return (
    <div className="overflow-x-auto rounded border" data-testid="copilot-admin-plan-table">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left">
          <tr>
            <th className="p-2">Thời gian</th>
            <th className="p-2">Sự kiện</th>
            <th className="p-2">Kế hoạch</th>
            <th className="p-2">Hành động</th>
            <th className="p-2">Mã lỗi</th>
          </tr>
        </thead>
        <tbody>
          {cua.length === 0 ? (
            <tr>
              <td className="p-3 text-muted-foreground" colSpan={5}>
                Chưa có kế hoạch nào trong sổ của công ty này.
              </td>
            </tr>
          ) : (
            cua.map((d) => (
              <tr key={d.id} className="border-t align-top">
                <td className="whitespace-nowrap p-2 font-mono text-xs">
                  {dinhDangThoiGian(d.createdAt)}
                </td>
                <td className="p-2">{nhanSuKien(d.event)}</td>
                <td className="p-2 font-mono text-xs">
                  {d.planId ? d.planId.slice(0, 8) : '—'}
                  {d.stepNo === null ? '' : ` · bước ${d.stepNo}`}
                </td>
                <td className="p-2 font-mono text-xs">{d.actionId ?? '—'}</td>
                <td className="p-2 font-mono text-xs">
                  {d.errorCode ? (
                    <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">{d.errorCode}</span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Thẻ chính sách — cũng THUẦN: mọi thứ động đi qua props. */
export function TheChinhSachHanhDong(props: {
  chinhSach: ChinhSachHanhDong | null;
  dangTai: boolean;
  ruiRo: MucRuiRoChinhSach | '';
  vai: readonly string[];
  lyDo: string;
  bangChung: string;
  dangLuu: boolean;
  onDoiRuiRo: (gt: MucRuiRoChinhSach) => void;
  onDoiVai: (vai: string, bat: boolean) => void;
  onDoiLyDo: (gt: string) => void;
  onDoiBangChung: (gt: string) => void;
  onLuu: () => void;
}) {
  const { chinhSach } = props;
  const duLieuDu = Boolean(props.lyDo.trim() && props.bangChung.trim() && chinhSach);
  return (
    <div className="space-y-3 rounded border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Chính sách hành động</div>
          <div className="text-xs text-muted-foreground">
            Van trần rủi ro của Copilot. Mọi thay đổi dùng CAS theo revision và bắt buộc có lý do
            kèm bằng chứng.
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          Revision: <span className="font-mono">{chinhSach?.revision ?? '—'}</span>
        </div>
      </div>

      {props.dangTai && !chinhSach ? (
        <div className="text-sm text-muted-foreground">Đang tải chính sách…</div>
      ) : null}
      {!props.dangTai && !chinhSach ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          BLOCKED — không đọc được chính sách từ server; không hiển thị giá trị đoán.
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          Trần rủi ro cho phép chạy thẳng
          <select
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={props.ruiRo}
            disabled={!chinhSach || props.dangLuu}
            onChange={(e) => props.onDoiRuiRo(e.target.value as MucRuiRoChinhSach)}
          >
            {MUC_RUI_RO.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <fieldset className="text-sm">
          <legend>Vai được phép chạy hành động</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {VAI_HOP_LE.map((v) => (
              <label key={v} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={props.vai.includes(v)}
                  disabled={!chinhSach || props.dangLuu}
                  onChange={(e) => props.onDoiVai(v, e.target.checked)}
                />
                {v}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {/* G5-B đã dựng đủ đường tạo/thu hồi/thu hồi tất cả (thẻ "Uỷ quyền đứng" bên
          dưới) — cái CÒN THIẾU không phải "đường thu hồi", mà là NÚT BẬT van
          này: đó là việc của G5-D, để một thứ mở ra cho AI tự duyệt không bị
          bật bởi một cú bấm không kèm rà soát riêng của nó. Ô này vẫn chỉ-đọc,
          hiện trạng thái thật để người vận hành biết van đang ở đâu. */}
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={chinhSach?.standingGrantsEnabled ?? false}
          disabled
          title="Mức 3 — chưa mở ở giai đoạn này"
        />
        Uỷ quyền thường trực (standing grant)
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">Mức 3</span>
      </label>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          Lý do bắt buộc
          <Input
            value={props.lyDo}
            disabled={!chinhSach || props.dangLuu}
            onChange={(e) => props.onDoiLyDo(e.target.value)}
            placeholder="Ví dụ: mở L4 cho pilot thu chi"
          />
        </label>
        <label className="text-sm">
          Liên kết bằng chứng
          <Input
            value={props.bangChung}
            disabled={!chinhSach || props.dangLuu}
            onChange={(e) => props.onDoiBangChung(e.target.value)}
            placeholder="URL / mã run / ticket"
          />
        </label>
      </div>

      <Button size="sm" disabled={!duLieuDu || props.dangLuu} onClick={props.onLuu}>
        {props.dangLuu ? 'Đang lưu…' : 'Đổi chính sách'}
      </Button>
    </div>
  );
}

/**
 * Mã lỗi của cụm PIN step-up → câu tiếng Việt.
 *
 * `reauth_failed` là mã CỤC BỘ của file này (thẻ tự phát ra khi
 * `signInWithPassword` báo lỗi trước lúc gọi `datPin` — xem chú thích ở
 * `datPin` trong `stepUpClient.ts` về vì sao re-auth là ranh giới CLIENT).
 * Mọi mã khác (pin_format/pin_weak/pin_invalid/pin_locked/
 * step_up_superadmin_only…) nhường cho `dienGiaiLoiKeHoach` — bảng đó đã có
 * đủ sáu mã của G5-A, không dựng bảng riêng để hai bảng lệch nhau.
 */
export function dienGiaiLoiPin(loi: unknown): string {
  const cau = loi instanceof Error ? loi.message : String(loi ?? '');
  if (cau === 'reauth_failed') return 'Mật khẩu không đúng — không đổi được PIN.';
  return dienGiaiLoiKeHoach(cau);
}

/** Thẻ PIN step-up — cũng THUẦN: mọi thứ động đi qua props. */
export function TheStepUpPin(props: {
  trangThai: TrangThaiPin | null;
  dangTaiTrangThai: boolean;
  pinHienTai: string;
  pinMoi: string;
  matKhau: string;
  dangDatPin: boolean;
  onDoiPinHienTai: (gt: string) => void;
  onDoiPinMoi: (gt: string) => void;
  onDoiMatKhau: (gt: string) => void;
  onDatPin: () => void;
  laSuperAdmin: boolean;
  moKhoaUserId: string;
  moKhoaLyDo: string;
  dangMoKhoa: boolean;
  onDoiMoKhoaUserId: (gt: string) => void;
  onDoiMoKhoaLyDo: (gt: string) => void;
  onMoKhoa: () => void;
  dangReset: boolean;
  onReset: () => void;
}) {
  const { trangThai } = props;
  const duLieuDuDatPin = Boolean(
    /^[0-9]{4}$/.test(props.pinMoi) && props.matKhau.trim() && (!trangThai?.daDat || props.pinHienTai.trim()),
  );
  // Cùng hai ô (user_id/lý do) phục vụ CẢ "Mở khoá" lẫn "Reset PIN" — hai
  // thao tác cùng nhắm một người dùng, chỉ khác hậu quả (mở khoá đếm/lock,
  // hay xoá hẳn PIN để họ tự đặt lại). Không dựng cặp ô thứ hai cho gọn.
  const duLieuDuMoKhoa = Boolean(props.moKhoaUserId.trim() && props.moKhoaLyDo.trim().length >= 3);
  const dangKhoa = Boolean(trangThai?.lockedUntil && new Date(trangThai.lockedUntil).getTime() > Date.now());
  return (
    <div className="space-y-3 rounded border p-3" data-testid="copilot-admin-pin-card">
      <div>
        <div className="text-sm font-medium">PIN step-up</div>
        <div className="text-xs text-muted-foreground">
          Lớp xác thực thứ hai cho kế hoạch L5 dưới trần L5. Chỉ super admin đặt/đổi được PIN (v1).
        </div>
      </div>

      <div className="text-sm" data-testid="copilot-admin-pin-status">
        {props.dangTaiTrangThai && !trangThai ? (
          <span className="text-muted-foreground">Đang tải trạng thái PIN…</span>
        ) : trangThai ? (
          <>
            <span className={trangThai.daDat ? 'text-emerald-700' : 'text-amber-700'}>
              {trangThai.daDat ? 'Đã đặt PIN.' : 'Chưa đặt PIN.'}
            </span>
            {dangKhoa && (
              <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">
                Đang khoá tới {dinhDangThoiGian(trangThai.lockedUntil)}
              </span>
            )}
            {!dangKhoa && trangThai.failedAttempts > 0 && (
              <span className="ml-2 text-xs text-amber-700">
                {trangThai.failedAttempts} lần sai gần nhất chưa reset
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">Không đọc được trạng thái PIN.</span>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {trangThai?.daDat && (
          <label className="text-sm">
            PIN hiện tại
            <Input
              type="password"
              inputMode="numeric"
              maxLength={4}
              data-testid="copilot-admin-pin-current"
              value={props.pinHienTai}
              disabled={props.dangDatPin}
              onChange={(e) => props.onDoiPinHienTai(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              placeholder="4 số"
            />
          </label>
        )}
        <label className="text-sm">
          PIN mới
          <Input
            type="password"
            inputMode="numeric"
            maxLength={4}
            data-testid="copilot-admin-pin-new"
            value={props.pinMoi}
            disabled={props.dangDatPin}
            onChange={(e) => props.onDoiPinMoi(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
            placeholder="4 số"
          />
        </label>
        <label className="text-sm">
          Mật khẩu (re-auth)
          <Input
            type="password"
            data-testid="copilot-admin-pin-password"
            value={props.matKhau}
            disabled={props.dangDatPin}
            onChange={(e) => props.onDoiMatKhau(e.target.value)}
            placeholder="Mật khẩu đăng nhập"
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Server không kiểm được việc re-auth vừa xảy ra — nhập đúng mật khẩu đăng nhập là điều kiện
        do CHÍNH thẻ này gác, trước khi gọi RPC đặt PIN.
      </p>
      <Button
        size="sm"
        data-testid="copilot-admin-pin-submit"
        disabled={!duLieuDuDatPin || props.dangDatPin}
        onClick={props.onDatPin}
      >
        {props.dangDatPin ? 'Đang lưu…' : trangThai?.daDat ? 'Đổi PIN' : 'Đặt PIN'}
      </Button>

      {props.laSuperAdmin && (
        <div className="space-y-2 border-t pt-3">
          <div className="text-sm font-medium">Mở khoá PIN của người dùng khác</div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              Mã người dùng (user_id)
              <Input
                data-testid="copilot-admin-pin-unlock-userid"
                value={props.moKhoaUserId}
                disabled={props.dangMoKhoa}
                onChange={(e) => props.onDoiMoKhoaUserId(e.target.value)}
                placeholder="uuid"
              />
            </label>
            <label className="text-sm">
              Lý do (bắt buộc)
              <Input
                data-testid="copilot-admin-pin-unlock-reason"
                value={props.moKhoaLyDo}
                disabled={props.dangMoKhoa}
                onChange={(e) => props.onDoiMoKhoaLyDo(e.target.value)}
                placeholder="Ví dụ: người dùng báo bị khoá nhầm"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="copilot-admin-pin-unlock-submit"
              disabled={!duLieuDuMoKhoa || props.dangMoKhoa || props.dangReset}
              onClick={props.onMoKhoa}
            >
              {props.dangMoKhoa ? 'Đang mở khoá…' : 'Mở khoá'}
            </Button>
            {/* PIN đã MẤT (không phải bị khoá) — "Mở khoá" không giúp gì vì
                nó giữ nguyên PIN cũ. Reset xoá hẳn PIN để người đó tự đặt
                PIN mới, không cần PIN cũ. */}
            <Button
              size="sm"
              variant="destructive"
              data-testid="copilot-admin-pin-reset-submit"
              disabled={!duLieuDuMoKhoa || props.dangMoKhoa || props.dangReset}
              onClick={props.onReset}
            >
              {props.dangReset ? 'Đang reset…' : 'Reset PIN (mất PIN)'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tiền tệ VND thô, không dấu phân cách — đủ cho một ô nhập số. */
function tienSangSo(gt: string): number | undefined {
  const n = Number(gt.trim());
  return gt.trim() !== '' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Danh sách building_id (uuid) phân tách bằng dấu phẩy, hoặc mảng rỗng. */
function toaSangMang(gt: string): string[] | undefined {
  const ds = gt
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ds.length > 0 ? ds : undefined;
}

/**
 * Thẻ UỶ QUYỀN ĐỨNG (G5-B, điểm nối #4) — THUẦN, mọi trạng thái động đi qua
 * props cùng khuôn `TheChinhSachHanhDong`/`TheStepUpPin`.
 *
 * BA HÀNH ĐỘNG GHI, BA MỨC XÁC THỰC KHÁC NHAU
 *   Tạo đòi step-up PIN (mở cửa tự duyệt cho AI thì phải xác thực hai lớp,
 *   cùng cửa với duyệt L5 dưới trần L5). Thu hồi MỘT hạn mức không đòi gì
 *   ngoài super admin — đóng một cửa dễ hơn mở. "Thu hồi TẤT CẢ" là kill
 *   switch riêng của cơ chế này: cùng không đòi PIN (một sự cố cần tắt NGAY,
 *   không phải lúc để bắt người trực nhớ mật khẩu và bấm thêm một bước), NHƯNG
 *   đòi một câu lý do đủ dài vì nó ảnh hưởng tới MỌI hạn mức của cả tổ chức.
 */
export function TheUyQuyenDung(props: {
  danhSach: readonly DongGrant[];
  dangTaiDs: boolean;
  danhSachHanhDong: readonly { actionId: string; labelVi: string }[];
  actionId: string;
  maxPerDay: string;
  gioHetHan: string;
  maxAmount: string;
  toaNha: string;
  lyDoTao: string;
  dangTao: boolean;
  onDoiActionId: (gt: string) => void;
  onDoiMaxPerDay: (gt: string) => void;
  onDoiGioHetHan: (gt: string) => void;
  onDoiMaxAmount: (gt: string) => void;
  onDoiToaNha: (gt: string) => void;
  onDoiLyDoTao: (gt: string) => void;
  onTao: () => void;
  lyDoThuHoi: string;
  onDoiLyDoThuHoi: (gt: string) => void;
  dangThuHoiId: string | null;
  onThuHoi: (grantId: string) => void;
  lyDoThuHoiTatCa: string;
  onDoiLyDoThuHoiTatCa: (gt: string) => void;
  dangThuHoiTatCa: boolean;
  onThuHoiTatCa: () => void;
  baoCao: KetQuaBaoCaoNgay | null;
  dangTaiBaoCao: boolean;
  coToChuc: boolean;
}) {
  const soNguyen = (gt: string) => {
    const n = Number(gt.trim());
    return Number.isInteger(n) && n > 0;
  };
  const duLieuDuTao = Boolean(
    props.actionId && soNguyen(props.maxPerDay) && soNguyen(props.gioHetHan) && props.lyDoTao.trim(),
  );
  const duLieuDuThuHoiTatCa = props.lyDoThuHoiTatCa.trim().length >= 10;
  const conSong = props.danhSach.filter((g) => !g.revokedAt);

  return (
    <div className="space-y-3 rounded border p-3" data-testid="copilot-admin-grant-card">
      <div>
        <div className="text-sm font-medium">Uỷ quyền đứng</div>
        <div className="text-xs text-muted-foreground">
          Cấp trước một hạn mức cho MỘT hành động, theo NGÀY, tối đa 30 ngày. Khi van "uỷ quyền
          đứng" (thẻ Chính sách hành động ở trên) đang mở và mọi bước của một kế hoạch đều được
          một hạn mức còn hiệu lực phủ, kế hoạch tự duyệt — không ai bấm.
        </div>
      </div>

      {!props.coToChuc ? (
        <div className="text-sm text-muted-foreground">Chọn công ty ở mục sổ hành động bên dưới trước.</div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm">
              Hành động
              <select
                className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                data-testid="copilot-admin-grant-action"
                value={props.actionId}
                disabled={props.dangTao}
                onChange={(e) => props.onDoiActionId(e.target.value)}
              >
                <option value="">Chọn hành động</option>
                {props.danhSachHanhDong.map((a) => (
                  <option key={a.actionId} value={a.actionId}>
                    {a.labelVi} ({a.actionId})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Hạn mức mỗi ngày
              <Input
                type="number"
                min={1}
                max={200}
                data-testid="copilot-admin-grant-max-per-day"
                value={props.maxPerDay}
                disabled={props.dangTao}
                onChange={(e) => props.onDoiMaxPerDay(e.target.value)}
              />
            </label>
            <label className="text-sm">
              Hết hạn sau (giờ)
              <Input
                type="number"
                min={1}
                max={720}
                data-testid="copilot-admin-grant-expires-hours"
                value={props.gioHetHan}
                disabled={props.dangTao}
                onChange={(e) => props.onDoiGioHetHan(e.target.value)}
                placeholder="tối đa 720 (30 ngày)"
              />
            </label>
            <label className="text-sm">
              Số tiền tối đa mỗi lần (tuỳ chọn)
              <Input
                type="number"
                min={1}
                data-testid="copilot-admin-grant-max-amount"
                value={props.maxAmount}
                disabled={props.dangTao}
                onChange={(e) => props.onDoiMaxAmount(e.target.value)}
                placeholder="Để trống = không giới hạn"
              />
            </label>
            <label className="text-sm md:col-span-2">
              Chỉ áp dụng cho toà (tuỳ chọn)
              <Input
                data-testid="copilot-admin-grant-buildings"
                value={props.toaNha}
                disabled={props.dangTao}
                onChange={(e) => props.onDoiToaNha(e.target.value)}
                placeholder="building_id (uuid), cách nhau bằng dấu phẩy — để trống = mọi toà"
              />
            </label>
          </div>
          <label className="block text-sm">
            Lý do cấp (bắt buộc)
            <Input
              data-testid="copilot-admin-grant-reason"
              value={props.lyDoTao}
              disabled={props.dangTao}
              onChange={(e) => props.onDoiLyDoTao(e.target.value)}
              placeholder="Vì sao cần tự duyệt hành động này"
            />
          </label>
          <Button
            size="sm"
            data-testid="copilot-admin-grant-submit"
            disabled={!duLieuDuTao || props.dangTao}
            onClick={props.onTao}
          >
            {props.dangTao ? 'Đang xác thực PIN…' : 'Cấp hạn mức (cần PIN)'}
          </Button>

          <div className="border-t pt-3">
            <div className="mb-2 text-sm font-medium">
              Hạn mức đang có ({conSong.length} còn hiệu lực / {props.danhSach.length} tổng)
            </div>
            <div className="overflow-x-auto rounded border" data-testid="copilot-admin-grant-table">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2">Hành động</th>
                    <th className="p-2">Hạn mức/ngày</th>
                    <th className="p-2">Đã dùng hôm nay</th>
                    <th className="p-2">Hết hạn</th>
                    <th className="p-2">Trạng thái</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {props.dangTaiDs && props.danhSach.length === 0 ? (
                    <tr>
                      <td className="p-3 text-muted-foreground" colSpan={6}>Đang tải…</td>
                    </tr>
                  ) : props.danhSach.length === 0 ? (
                    <tr>
                      <td className="p-3 text-muted-foreground" colSpan={6}>
                        Chưa có hạn mức nào cho công ty này.
                      </td>
                    </tr>
                  ) : (
                    props.danhSach.map((g) => (
                      <tr key={g.grantId} className="border-t align-top" data-testid="copilot-admin-grant-row">
                        <td className="p-2 font-mono text-xs">{g.actionId}</td>
                        <td className="p-2">{g.maxPerDay}</td>
                        <td className="p-2">{g.usedToday}</td>
                        <td className="p-2 text-xs">{dinhDangThoiGian(g.expiresAt)}</td>
                        <td className="p-2 text-xs">
                          {g.revokedAt ? (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5">Đã thu hồi</span>
                          ) : (
                            <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">
                              Còn hiệu lực
                            </span>
                          )}
                        </td>
                        <td className="p-2">
                          {!g.revokedAt && (
                            <Button
                              size="sm"
                              variant="outline"
                              data-testid="copilot-admin-grant-revoke"
                              disabled={props.dangThuHoiId === g.grantId || !props.lyDoThuHoi.trim()}
                              onClick={() => props.onThuHoi(g.grantId)}
                            >
                              {props.dangThuHoiId === g.grantId ? 'Đang thu hồi…' : 'Thu hồi'}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <label className="mt-2 block text-sm">
              Lý do thu hồi (dùng cho nút "Thu hồi" của từng dòng ở trên)
              <Input
                data-testid="copilot-admin-grant-revoke-reason"
                value={props.lyDoThuHoi}
                onChange={(e) => props.onDoiLyDoThuHoi(e.target.value)}
                placeholder="Vì sao thu hồi hạn mức này"
              />
            </label>
          </div>

          <div className="space-y-2 border-t pt-3">
            <div className="text-sm font-medium text-red-700">
              Thu hồi TẤT CẢ hạn mức của công ty này — kill switch
            </div>
            <label className="block text-sm">
              Lý do (bắt buộc, ít nhất 10 ký tự)
              <Input
                data-testid="copilot-admin-grant-revoke-all-reason"
                value={props.lyDoThuHoiTatCa}
                disabled={props.dangThuHoiTatCa}
                onChange={(e) => props.onDoiLyDoThuHoiTatCa(e.target.value)}
                placeholder="Ví dụ: nghi ngờ một hạn mức bị cấp sai phạm vi, tắt hết trong lúc soát"
              />
            </label>
            <Button
              size="sm"
              variant="destructive"
              data-testid="copilot-admin-grant-revoke-all"
              disabled={!duLieuDuThuHoiTatCa || props.dangThuHoiTatCa || conSong.length === 0}
              onClick={props.onThuHoiTatCa}
            >
              {props.dangThuHoiTatCa ? 'Đang thu hồi…' : `Thu hồi tất cả (${conSong.length})`}
            </Button>
          </div>

          <div className="border-t pt-3">
            <div className="mb-2 text-sm font-medium">Báo cáo ngày</div>
            {props.dangTaiBaoCao && !props.baoCao ? (
              <div className="text-sm text-muted-foreground">Đang tải báo cáo…</div>
            ) : props.baoCao ? (
              <div className="text-sm" data-testid="copilot-admin-grant-report">
                <div>
                  Ngày <span className="font-mono">{props.baoCao.ngay ?? '—'}</span>: {props.baoCao.ke.length} kế
                  hoạch tự duyệt, tổng tiền{' '}
                  <span className="font-mono">
                    {props.baoCao.tongTien !== null ? props.baoCao.tongTien.toLocaleString('vi-VN') : '—'}
                  </span>{' '}
                  đ.
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Không đọc được báo cáo.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function HanhDongTab() {
  const qc = useQueryClient();
  // Sổ đã tự giới hạn ở server (người thường chỉ thấy dòng của mình), nên mục
  // này không phải một hàng rào — nó là một mục chỉ có nghĩa với người NHÌN
  // được cả công ty. Hiện nó cho người thường là hứa một bức tranh toàn cảnh
  // mà dữ liệu họ nhận được không dựng nổi.
  const { data: laSuperAdmin } = useIsSuperAdmin();
  const { data: nguoiDung } = useAuth();
  const { organizations, selectedOrganizationId, selectOrganization } = useOrganization();
  const [ruiRo, setRuiRo] = useState<MucRuiRoChinhSach | ''>('');
  const [vai, setVai] = useState<string[] | null>(null);
  const [lyDo, setLyDo] = useState('');
  const [bangChung, setBangChung] = useState('');

  // ── PIN step-up (G5-A) ─────────────────────────────────────────────────
  const [pinHienTai, setPinHienTai] = useState('');
  const [pinMoi, setPinMoi] = useState('');
  const [matKhauReAuth, setMatKhauReAuth] = useState('');
  const [moKhoaUserId, setMoKhoaUserId] = useState('');
  const [moKhoaLyDo, setMoKhoaLyDo] = useState('');

  const trangThaiPinQuery = useQuery({
    queryKey: ['copilot-step-up-status'],
    retry: false,
    queryFn: async () => {
      const kq = await trangThaiPin();
      if (!kq.ok) throw new Error(kq.maLoi ?? 'loi_khong_ro');
      return kq.trangThai;
    },
  });

  const datPinMutation = useMutation({
    mutationFn: async () => {
      if (!nguoiDung?.email) throw new Error('unauthenticated');
      // Re-auth BẮT BUỘC trước khi gọi RPC đặt/đổi PIN — server không kiểm
      // được điều đó (xem chú thích ở `datPin` trong `stepUpClient.ts`).
      const { error: loiReAuth } = await supabase.auth.signInWithPassword({
        email: nguoiDung.email,
        password: matKhauReAuth,
      });
      if (loiReAuth) throw new Error('reauth_failed');
      const kq = await datPin(pinMoi, pinHienTai || undefined);
      if (!kq.ok) throw new Error(kq.maLoi ?? 'loi_khong_ro');
      return kq;
    },
    onSuccess: async () => {
      toast.success('Đã lưu PIN step-up.');
      setPinHienTai('');
      setPinMoi('');
      setMatKhauReAuth('');
      await qc.invalidateQueries({ queryKey: ['copilot-step-up-status'] });
    },
    onError: (loi) => toast.error(dienGiaiLoiPin(loi)),
  });

  const moKhoaMutation = useMutation({
    mutationFn: async () => {
      const kq = await moKhoaPinStepUp(moKhoaUserId.trim(), moKhoaLyDo.trim());
      if (!kq.ok) throw new Error(kq.maLoi ?? 'loi_khong_ro');
      return kq;
    },
    onSuccess: () => {
      toast.success('Đã mở khoá PIN của người dùng.');
      setMoKhoaUserId('');
      setMoKhoaLyDo('');
    },
    onError: (loi) => toast.error(dienGiaiLoiPin(loi)),
  });

  // Reset PIN (bổ sung G5-C2) — dùng chung ô user_id/lý do với "Mở khoá".
  const resetPinMutation = useMutation({
    mutationFn: async () => {
      const kq = await resetPinStepUp(moKhoaUserId.trim(), moKhoaLyDo.trim());
      if (!kq.ok) throw new Error(kq.maLoi ?? 'loi_khong_ro');
      return kq;
    },
    onSuccess: () => {
      toast.success('Đã xoá PIN của người dùng — họ có thể tự đặt PIN mới.');
      setMoKhoaUserId('');
      setMoKhoaLyDo('');
    },
    onError: (loi) => toast.error(dienGiaiLoiPin(loi)),
  });

  // ── Uỷ quyền đứng (G5-B, điểm nối #4) ──────────────────────────────────
  const [grantActionId, setGrantActionId] = useState('');
  const [grantMaxPerDay, setGrantMaxPerDay] = useState('1');
  const [grantGioHetHan, setGrantGioHetHan] = useState('24');
  const [grantMaxAmount, setGrantMaxAmount] = useState('');
  const [grantToaNha, setGrantToaNha] = useState('');
  const [grantLyDoTao, setGrantLyDoTao] = useState('');
  const [grantHienModalPin, setGrantHienModalPin] = useState(false);
  const [grantLyDoThuHoi, setGrantLyDoThuHoi] = useState('');
  const [grantDangThuHoiId, setGrantDangThuHoiId] = useState<string | null>(null);
  const [grantLyDoThuHoiTatCa, setGrantLyDoThuHoiTatCa] = useState('');

  const danhSachHanhDongGrant = useMemo(
    () =>
      Object.values(ACTION_CATALOG).map((a) => ({ actionId: a.actionId, labelVi: a.labelVi })),
    [],
  );

  const dsGrantQuery = useQuery({
    queryKey: ['copilot-standing-grants', selectedOrganizationId ?? null],
    enabled: Boolean(selectedOrganizationId),
    retry: false,
    queryFn: async () => {
      const kq = await dsGrant(selectedOrganizationId as string);
      if (!kq.ok) throw new Error(kq.maLoi ?? 'loi_khong_ro');
      return kq.danhSach;
    },
  });

  const baoCaoGrantQuery = useQuery({
    queryKey: ['copilot-standing-grants-report', selectedOrganizationId ?? null],
    enabled: Boolean(selectedOrganizationId),
    retry: false,
    queryFn: async () => {
      const kq = await baoCaoNgayGrant(selectedOrganizationId as string);
      if (!kq.ok) throw new Error(kq.maLoi ?? 'loi_khong_ro');
      return kq;
    },
  });

  /**
   * Cấp hạn mức: mở modal PIN, `onXacThucXong` mới thật sự gọi `taoGrant` — cùng
   * khuôn `KeHoachCard.bam()` (modal xong rồi mới `tieuTokenStepUp` + gọi RPC).
   * KHÔNG dùng `useMutation` ở nhánh mở modal: mutation chỉ chạy SAU khi có token.
   */
  const taoGrantMutation = useMutation({
    mutationFn: async () => {
      if (!selectedOrganizationId) throw new Error('organization_required');
      const token = tieuTokenStepUp(selectedOrganizationId);
      if (!token) throw new Error('step_up_required');
      const han = new Date(Date.now() + Number(grantGioHetHan) * 60 * 60_000).toISOString();
      const kq = await taoGrant({
        organizationId: selectedOrganizationId,
        actionId: grantActionId,
        constraints: {
          ...(tienSangSo(grantMaxAmount) === undefined ? {} : { maxAmount: tienSangSo(grantMaxAmount) }),
          ...(toaSangMang(grantToaNha) === undefined ? {} : { buildingIds: toaSangMang(grantToaNha) }),
        },
        maxPerDay: Number(grantMaxPerDay),
        expiresAt: han,
        reason: grantLyDoTao.trim(),
        stepUpToken: token,
      });
      if (!kq.ok) throw new Error(kq.maLoi ?? 'loi_khong_ro');
      return kq;
    },
    onSuccess: async () => {
      toast.success('Đã cấp hạn mức uỷ quyền đứng.');
      setGrantActionId('');
      setGrantMaxPerDay('1');
      setGrantGioHetHan('24');
      setGrantMaxAmount('');
      setGrantToaNha('');
      setGrantLyDoTao('');
      await qc.invalidateQueries({ queryKey: ['copilot-standing-grants'] });
    },
    onError: (loi) => toast.error(dienGiaiLoiKeHoach(loi instanceof Error ? loi.message : String(loi))),
  });

  const thuHoiGrantMutation = useMutation({
    mutationFn: async (grantId: string) => {
      setGrantDangThuHoiId(grantId);
      const kq = await thuHoiGrant(grantId, grantLyDoThuHoi.trim());
      if (!kq.ok) throw new Error(kq.maLoi ?? 'loi_khong_ro');
      return kq;
    },
    onSuccess: async () => {
      toast.success('Đã thu hồi hạn mức.');
      await qc.invalidateQueries({ queryKey: ['copilot-standing-grants'] });
    },
    onError: (loi) => toast.error(dienGiaiLoiKeHoach(loi instanceof Error ? loi.message : String(loi))),
    onSettled: () => setGrantDangThuHoiId(null),
  });

  const thuHoiTatCaGrantMutation = useMutation({
    mutationFn: async () => {
      if (!selectedOrganizationId) throw new Error('organization_required');
      const kq = await thuHoiTatCaGrant(selectedOrganizationId, grantLyDoThuHoiTatCa.trim());
      if (!kq.ok) throw new Error(kq.maLoi ?? 'loi_khong_ro');
      return kq;
    },
    onSuccess: async (kq) => {
      toast.success(`Đã thu hồi ${kq.soLuongThuHoi ?? 0} hạn mức.`);
      setGrantLyDoThuHoiTatCa('');
      await qc.invalidateQueries({ queryKey: ['copilot-standing-grants'] });
    },
    onError: (loi) => toast.error(dienGiaiLoiKeHoach(loi instanceof Error ? loi.message : String(loi))),
  });

  const chinhSachQuery = useQuery({
    queryKey: ['copilot-action-policy'],
    retry: false,
    queryFn: docChinhSachHanhDong,
  });
  const chinhSach = chinhSachQuery.data ?? null;

  const soQuery = useQuery({
    queryKey: ['copilot-action-ledger', selectedOrganizationId ?? null],
    enabled: Boolean(selectedOrganizationId),
    retry: false,
    queryFn: () => docSoHanhDong(selectedOrganizationId, SO_DONG_SO_MAC_DINH),
  });

  // Giá trị hiển thị = thứ người dùng vừa sửa, nếu chưa sửa thì lấy của server.
  // Không `useEffect` đồng bộ state: một lần refetch giữa chừng sẽ đá mất thao
  // tác đang dở của người vận hành.
  const ruiRoHienTai = ruiRo || chinhSach?.maxDirectRisk || '';
  const vaiHienTai = useMemo(() => vai ?? chinhSach?.allowedRoles ?? [], [vai, chinhSach]);

  const doiChinhSach = useMutation({
    mutationFn: async () => {
      if (!chinhSach) throw new Error('copilot_policy_missing');
      return doiChinhSachHanhDong({
        expectedRevision: chinhSach.revision,
        ...(ruiRoHienTai ? { maxDirectRisk: ruiRoHienTai as MucRuiRoChinhSach } : {}),
        allowedRoles: [...vaiHienTai],
        reason: lyDo.trim(),
        evidenceLink: bangChung.trim(),
      });
    },
    onSuccess: async () => {
      toast.success('Đã đổi chính sách hành động.');
      setLyDo('');
      setBangChung('');
      setVai(null);
      setRuiRo('');
      await qc.invalidateQueries({ queryKey: ['copilot-action-policy'] });
      await qc.invalidateQueries({ queryKey: ['copilot-action-ledger'] });
    },
    onError: async (loi) => {
      toast.error(dienGiaiLoiChinhSach(loi));
      // Revision cũ trong tay là thứ khiến lần bấm kế tiếp cũng hỏng — tải lại
      // ngay thay vì để người dùng tự đoán phải làm gì.
      if (String(loi instanceof Error ? loi.message : loi).includes('stale_revision')) {
        await chinhSachQuery.refetch();
      }
    },
  });

  return (
    <div className="space-y-4">
      <TheChinhSachHanhDong
        chinhSach={chinhSach}
        dangTai={chinhSachQuery.isLoading}
        ruiRo={ruiRoHienTai}
        vai={vaiHienTai}
        lyDo={lyDo}
        bangChung={bangChung}
        dangLuu={doiChinhSach.isPending}
        onDoiRuiRo={setRuiRo}
        onDoiVai={(v, bat) =>
          setVai((truoc) => {
            const nen = truoc ?? chinhSach?.allowedRoles ?? [];
            return bat ? [...new Set([...nen, v])] : nen.filter((x) => x !== v);
          })
        }
        onDoiLyDo={setLyDo}
        onDoiBangChung={setBangChung}
        onLuu={() => doiChinhSach.mutate()}
      />

      <TheStepUpPin
        trangThai={trangThaiPinQuery.data ?? null}
        dangTaiTrangThai={trangThaiPinQuery.isLoading}
        pinHienTai={pinHienTai}
        pinMoi={pinMoi}
        matKhau={matKhauReAuth}
        dangDatPin={datPinMutation.isPending}
        onDoiPinHienTai={setPinHienTai}
        onDoiPinMoi={setPinMoi}
        onDoiMatKhau={setMatKhauReAuth}
        onDatPin={() => datPinMutation.mutate()}
        laSuperAdmin={Boolean(laSuperAdmin)}
        moKhoaUserId={moKhoaUserId}
        moKhoaLyDo={moKhoaLyDo}
        dangMoKhoa={moKhoaMutation.isPending}
        onDoiMoKhoaUserId={setMoKhoaUserId}
        onDoiMoKhoaLyDo={setMoKhoaLyDo}
        onMoKhoa={() => moKhoaMutation.mutate()}
        dangReset={resetPinMutation.isPending}
        onReset={() => resetPinMutation.mutate()}
      />

      {laSuperAdmin ? (
        <>
          <TheUyQuyenDung
            danhSach={dsGrantQuery.data ?? []}
            dangTaiDs={dsGrantQuery.isLoading}
            danhSachHanhDong={danhSachHanhDongGrant}
            actionId={grantActionId}
            maxPerDay={grantMaxPerDay}
            gioHetHan={grantGioHetHan}
            maxAmount={grantMaxAmount}
            toaNha={grantToaNha}
            lyDoTao={grantLyDoTao}
            dangTao={taoGrantMutation.isPending || grantHienModalPin}
            onDoiActionId={setGrantActionId}
            onDoiMaxPerDay={setGrantMaxPerDay}
            onDoiGioHetHan={setGrantGioHetHan}
            onDoiMaxAmount={setGrantMaxAmount}
            onDoiToaNha={setGrantToaNha}
            onDoiLyDoTao={setGrantLyDoTao}
            onTao={() => setGrantHienModalPin(true)}
            lyDoThuHoi={grantLyDoThuHoi}
            onDoiLyDoThuHoi={setGrantLyDoThuHoi}
            dangThuHoiId={grantDangThuHoiId}
            onThuHoi={(grantId) => thuHoiGrantMutation.mutate(grantId)}
            lyDoThuHoiTatCa={grantLyDoThuHoiTatCa}
            onDoiLyDoThuHoiTatCa={setGrantLyDoThuHoiTatCa}
            dangThuHoiTatCa={thuHoiTatCaGrantMutation.isPending}
            onThuHoiTatCa={() => thuHoiTatCaGrantMutation.mutate()}
            baoCao={baoCaoGrantQuery.data ?? null}
            dangTaiBaoCao={baoCaoGrantQuery.isLoading}
            coToChuc={Boolean(selectedOrganizationId)}
          />
          {grantHienModalPin && selectedOrganizationId && (
            <StepUpPinModal
              organizationId={selectedOrganizationId}
              onXacThucXong={() => {
                setGrantHienModalPin(false);
                taoGrantMutation.mutate();
              }}
              onHuy={() => setGrantHienModalPin(false)}
            />
          )}
        </>
      ) : null}

      <div className="space-y-2 rounded border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">Nhật ký hành động AI</div>
            <div className="text-xs text-muted-foreground">
              {SO_DONG_SO_MAC_DINH} dòng gần nhất. Người thường chỉ thấy dòng của mình; super admin
              thấy cả công ty và các lần đổi chính sách.
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => void soQuery.refetch()}>
            Tải lại
          </Button>
        </div>
        <label className="block text-sm">
          Công ty
          <select
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={selectedOrganizationId ?? ''}
            onChange={(e) => selectOrganization(e.target.value)}
          >
            <option value="">Chọn công ty</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </label>
        {soQuery.error ? (
          <div className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
            Không đọc được sổ: {String(soQuery.error instanceof Error ? soQuery.error.message : soQuery.error)}
          </div>
        ) : null}
        <BangNhatKyHanhDong dong={soQuery.data ?? []} />
      </div>

      {laSuperAdmin ? (
        <div className="space-y-2 rounded border p-3">
          <div>
            <div className="text-sm font-medium">Kế hoạch gần đây</div>
            <div className="text-xs text-muted-foreground">
              Bảy sự kiện của đường kế hoạch (lập · duyệt · từng bước · huỷ · quá hạn), lọc từ
              chính {SO_DONG_SO_MAC_DINH} dòng sổ ở trên.
            </div>
          </div>
          <BangKeHoachGanDay dong={soQuery.data ?? []} />
        </div>
      ) : null}
    </div>
  );
}
