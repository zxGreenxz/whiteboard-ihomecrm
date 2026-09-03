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

import { useIsSuperAdmin } from '@/hooks/useIsAdmin';

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

      {/* Standing grant là cơ chế Mức 3 (G4): chưa có đường THU HỒI nào đo được,
          nên chưa có nút bật. Hiện trạng thái để người vận hành biết nó đang ở
          đâu, và khoá lại kèm lý do thay vì giấu đi. */}
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

export default function HanhDongTab() {
  const qc = useQueryClient();
  // Sổ đã tự giới hạn ở server (người thường chỉ thấy dòng của mình), nên mục
  // này không phải một hàng rào — nó là một mục chỉ có nghĩa với người NHÌN
  // được cả công ty. Hiện nó cho người thường là hứa một bức tranh toàn cảnh
  // mà dữ liệu họ nhận được không dựng nổi.
  const { data: laSuperAdmin } = useIsSuperAdmin();
  const { organizations, selectedOrganizationId, selectOrganization } = useOrganization();
  const [ruiRo, setRuiRo] = useState<MucRuiRoChinhSach | ''>('');
  const [vai, setVai] = useState<string[] | null>(null);
  const [lyDo, setLyDo] = useState('');
  const [bangChung, setBangChung] = useState('');

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
