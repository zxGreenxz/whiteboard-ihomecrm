// =============================================================================
// Màn "Sổ nhận tiền" — chủ công ty cài hình thức thu nào vào sổ nào
// (đợt 1 sửa phiếu thu chi, chủ chốt 25/09/2026).
//
//   Tiền mặt (TM)       = sổ tiền mặt RIÊNG của người thu: tối đa một sổ, và người
//                         đó phải đang GIỮ sổ (CUSTODIAN).
//   Chuyển khoản (TK) / = mỗi toà một danh sách: một sổ mặc định (vẫn là cột
//   Thanh toán (TT)       buildings.default_account_id_tk/_tt) + các sổ phụ.
//
// Luật nằm ở MÁY CHỦ (migration so_nhan_tien). Màn này chỉ đọc/ghi qua ba RPC
// list_receiving_cashbook_settings_v1 / set_personal_cash_book_v1 /
// set_building_receiving_cashbooks_v1 — cả ba tự kiểm "chủ công ty" theo đúng tổ
// chức, nên ẩn/hiện ở đây chỉ là cờ hiển thị.
//
// Đây là nơi DUY NHẤT sửa sổ mặc định TK/TT của toà: hai ô cũ trong form toà đã
// bỏ để không còn hai chỗ sửa cùng một cột.
// =============================================================================

import { useId, useMemo, useState } from "react";
import { ZodError } from "zod";
import { AlertTriangle, Banknote, ChevronDown, Landmark, Loader2, Lock, Save } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useCanManageReceivingCashbooks } from "@/hooks/useCanManageReceivingCashbooks";
import {
  useReceivingCashbookSettings,
  useSetBuildingReceivingCashbooks,
  useSetPersonalCashBook,
  type ReceivingSettings,
} from "@/hooks/useReceivingCashbooks";

type Member = ReceivingSettings["members"][number];
type BuildingConfig = ReceivingSettings["buildings"][number];
type Account = ReceivingSettings["accounts"][number];
type Method = "TK" | "TT";
interface MethodConfig {
  defaultAccountId: string | null;
  extraAccountIds: string[];
}

/** Giá trị "Chưa cài" trong Select — Radix không nhận value rỗng. */
const CHUA_CAI = "__chua_cai__";
/** Trần của set_building_receiving_cashbooks_v1 (quá thì máy chủ trả 22023). */
const TOI_DA_SO_PHU = 20;
const TEN_HINH_THUC: Record<Method, string> = { TK: "Chuyển khoản", TT: "Thanh toán" };
// Cùng nhãn với màn Thành viên (LOAI_TV). Không import từ đó để khỏi kéo cả hộp
// thoại phân quyền vào trang Sổ quỹ chỉ vì năm dòng chữ.
const TEN_VAI: Record<string, string> = {
  OWNER: "Chủ sở hữu",
  STAFF: "Nhân sự",
  SHAREHOLDER: "Cổ đông",
  PARTNER: "Đối tác",
  SERVICE: "Tài khoản dịch vụ",
};

function tenVai(memberType: string | null): string {
  if (!memberType) return "—";
  return TEN_VAI[memberType] ?? memberType;
}

function thongDiepLoi(error: unknown): string {
  if (error instanceof ZodError) return "Máy chủ trả dữ liệu không đúng dạng — tải lại trang, còn lỗi thì báo quản trị.";
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() ? message : "Lỗi không rõ — thử lại sau.";
}

function cungCauHinh(a: MethodConfig, b: MethodConfig): boolean {
  if (a.defaultAccountId !== b.defaultAccountId) return false;
  if (a.extraAccountIds.length !== b.extraAccountIds.length) return false;
  const conLai = new Set(b.extraAccountIds);
  return a.extraAccountIds.every((id) => conLai.has(id));
}

function tomTatSoPhu(ids: string[], theoId: Map<string, Account>): string {
  if (ids.length === 0) return "Chưa có sổ phụ";
  const ten = ids.map((id) => theoId.get(id)?.name ?? "Sổ không còn dùng được").join(", ");
  return ids.length > 2 ? `${ids.length} sổ: ${ten}` : ten;
}

function KhungDangTai() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Đang tải sổ nhận tiền">
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}

export default function ReceivingCashbookSettings() {
  const quyen = useCanManageReceivingCashbooks();
  const { selectedOrganizationId, isLoading: dangNapToChuc, isOrphan } = useOrganization();
  // Không phải chủ thì KHÔNG gọi RPC: máy chủ sẽ trả 42501, hỏi chỉ tốn một lượt.
  const settings = useReceivingCashbookSettings(selectedOrganizationId, quyen.allowed);

  if (quyen.isLoading) return <KhungDangTai />;

  if (!quyen.allowed) {
    return (
      <Alert>
        <Lock className="h-4 w-4" />
        <AlertTitle>Không có quyền cài sổ nhận tiền</AlertTitle>
        <AlertDescription>Chỉ chủ công ty hoặc quản trị hệ thống mới cài được sổ nhận tiền.</AlertDescription>
      </Alert>
    );
  }

  if (!selectedOrganizationId) {
    if (dangNapToChuc) return <KhungDangTai />;
    return (
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Chưa chọn công ty</AlertTitle>
        <AlertDescription>
          {isOrphan
            ? "Tài khoản chưa thuộc công ty nào nên chưa có sổ nhận tiền để cài."
            : "Chọn công ty đang làm việc (ô tên công ty ở đầu trang, hoặc ở trang Tài khoản) rồi quay lại đây."}
        </AlertDescription>
      </Alert>
    );
  }

  if (settings.isError) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Không tải được sổ nhận tiền</AlertTitle>
        <AlertDescription>
          <p>{thongDiepLoi(settings.error)}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void settings.refetch()}>
            Thử lại
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!settings.data) return <KhungDangTai />;

  return (
    <div className="space-y-4">
      <SoTienMatRieng members={settings.data.members} accounts={settings.data.accounts} />
      <SoNhanTheoToa buildings={settings.data.buildings} accounts={settings.data.accounts} />
    </div>
  );
}

/* ─────────────────────────── Sổ tiền mặt riêng ─────────────────────────── */

function SoTienMatRieng({ members, accounts }: { members: Member[]; accounts: Account[] }) {
  // Sổ mỗi thành viên đang GIỮ — máy chủ chỉ nhận những sổ này (42501 nếu khác).
  const soDangGiu = useMemo(() => {
    const theoThanhVien = new Map<string, Account[]>();
    for (const account of accounts) {
      for (const membershipId of account.custodianMembershipIds) {
        const ds = theoThanhVien.get(membershipId);
        if (ds) ds.push(account);
        else theoThanhVien.set(membershipId, [account]);
      }
    }
    return theoThanhVien;
  }, [accounts]);
  const soConDung = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);

  return (
    <Card>
      <CardHeader className="space-y-1 p-4 sm:p-6">
        <CardTitle className="flex items-center gap-2 text-base">
          <Banknote className="h-4 w-4 shrink-0" />
          Sổ tiền mặt riêng
        </CardTitle>
        <CardDescription className="text-xs">
          Thu tiền mặt chỉ vào được sổ này. Chưa cài thì người đó không thu tiền mặt được.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tổ chức chưa có thành viên đang hoạt động.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {members.map((member) => (
              <DongSoTienMat
                key={member.membershipId}
                member={member}
                soGiu={soDangGiu.get(member.membershipId) ?? []}
                soConDung={soConDung}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DongSoTienMat({
  member,
  soGiu,
  soConDung,
}: {
  member: Member;
  soGiu: Account[];
  soConDung: Set<string>;
}) {
  const luu = useSetPersonalCashBook();
  const ten = member.name?.trim() || "Không tên";
  const hienTai = member.personalCashBook;
  // Sổ đang cài mà người đó không còn giữ (hoặc sổ đã xoá / thành sổ ảo): vẫn phải
  // có một mục cho nó, vì Radix Select không vẽ được giá trị không có mục tương ứng
  // — và chủ cần THẤY để đổi.
  const lech = hienTai && !soGiu.some((a) => a.id === hienTai.id) ? hienTai : null;
  const dangChon = luu.isPending ? (luu.variables?.accountId ?? null) : (hienTai?.id ?? null);
  const khongGiuSoNao = soGiu.length === 0 && !hienTai;

  const doiSo = (value: string) => {
    const accountId = value === CHUA_CAI ? null : value;
    if (accountId === (hienTai?.id ?? null)) return;
    luu.mutate({ membershipId: member.membershipId, accountId });
  };

  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="truncate text-sm font-medium">{ten}</span>
        <Badge variant="secondary" className="font-normal">
          {tenVai(member.memberType)}
        </Badge>
      </div>
      <div className="w-full space-y-1 sm:w-72 sm:shrink-0">
        <div className="flex items-center gap-2">
          <Select value={dangChon ?? CHUA_CAI} onValueChange={doiSo} disabled={luu.isPending || khongGiuSoNao}>
            <SelectTrigger aria-label={`Sổ tiền mặt riêng của ${ten}`} className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CHUA_CAI}>Chưa cài</SelectItem>
              {soGiu.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
              {lech && (
                <SelectItem value={lech.id} disabled>
                  {lech.name} (không dùng được)
                </SelectItem>
              )}
            </SelectContent>
          </Select>
          {luu.isPending && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
        </div>
        {khongGiuSoNao && (
          <p className="text-xs text-muted-foreground">
            Chưa giữ sổ nào — người này cần thu tiền mặt thì giao quyền giữ sổ trước.
          </p>
        )}
        {lech && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {soConDung.has(lech.id)
              ? `Người này không còn giữ sổ "${lech.name}"`
              : `Sổ "${lech.name}" đã xoá hoặc không còn là sổ thật`}
            {" — chọn sổ khác hoặc Chưa cài."}
          </p>
        )}
      </div>
    </li>
  );
}

/* ─────────────────── Chuyển khoản / Thanh toán theo toà ─────────────────── */

function SoNhanTheoToa({ buildings, accounts }: { buildings: BuildingConfig[]; accounts: Account[] }) {
  const theoId = useMemo(() => new Map(accounts.map((a) => [a.id, a] as const)), [accounts]);

  return (
    <Card>
      <CardHeader className="space-y-1 p-4 sm:p-6">
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4 shrink-0" />
          Chuyển khoản / Thanh toán theo toà
        </CardTitle>
        <CardDescription className="text-xs">
          Mỗi toà một sổ mặc định (chọn sẵn khi thu) và các sổ phụ. Người thu chỉ thấy các sổ trong danh sách mà họ
          đang giữ hoặc biết.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
        {buildings.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tổ chức chưa có toà nào.</p>
        ) : (
          buildings.map((building) => (
            <section key={building.id} aria-label={`Toà ${building.name}`} className="rounded-md border p-3">
              <h4 className="mb-2 truncate text-sm font-semibold">{building.name}</h4>
              <div className="grid gap-3 md:grid-cols-2">
                <CaiSoTheoHinhThuc building={building} method="TK" accounts={accounts} theoId={theoId} />
                <CaiSoTheoHinhThuc building={building} method="TT" accounts={accounts} theoId={theoId} />
              </div>
            </section>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function CaiSoTheoHinhThuc({
  building,
  method,
  accounts,
  theoId,
}: {
  building: BuildingConfig;
  method: Method;
  accounts: Account[];
  theoId: Map<string, Account>;
}) {
  const luu = useSetBuildingReceivingCashbooks();
  const idMacDinh = useId();
  const idSoPhu = useId();
  const [nhap, setNhap] = useState<MethodConfig | null>(null);

  const daLuu = building[method];
  // Sổ phụ đã xoá / thành sổ ảo: máy chủ đã bỏ qua khi thu và sẽ TỪ CHỐI nếu gửi
  // lại (22023) ⇒ không đưa vào bản đang sửa; còn sót thì cho bấm Lưu để gỡ.
  const soPhuHopLe = daLuu.extraAccountIds.filter((id) => theoId.has(id));
  const soPhuHong = daLuu.extraAccountIds.length - soPhuHopLe.length;
  const goc: MethodConfig = { defaultAccountId: daLuu.defaultAccountId, extraAccountIds: soPhuHopLe };
  const dangSua = nhap ?? goc;
  const macDinhHong = dangSua.defaultAccountId !== null && !theoId.has(dangSua.defaultAccountId);
  const coThayDoi = soPhuHong > 0 || (nhap !== null && !cungCauHinh(nhap, goc));
  // Sổ phụ không được trùng sổ mặc định.
  const ungVienPhu = accounts.filter((a) => a.id !== dangSua.defaultAccountId);
  const daDuSoPhu = dangSua.extraAccountIds.length >= TOI_DA_SO_PHU;
  const tenHinhThuc = TEN_HINH_THUC[method];
  const nhan = `${tenHinhThuc} — toà ${building.name}`;

  const chonMacDinh = (value: string) => {
    const id = value === CHUA_CAI ? null : value;
    setNhap({ defaultAccountId: id, extraAccountIds: dangSua.extraAccountIds.filter((x) => x !== id) });
  };
  const doiSoPhu = (id: string, chon: boolean) => {
    const conLai = dangSua.extraAccountIds.filter((x) => x !== id);
    setNhap({ defaultAccountId: dangSua.defaultAccountId, extraAccountIds: chon ? [...conLai, id] : conLai });
  };
  const luuLai = () => {
    luu.mutate(
      {
        buildingId: building.id,
        method,
        defaultAccountId: dangSua.defaultAccountId,
        extraAccountIds: dangSua.extraAccountIds,
      },
      { onSuccess: () => setNhap(null) },
    );
  };

  return (
    <div className="min-w-0 space-y-2 rounded-md bg-muted/40 p-2.5 sm:p-3">
      <p className="text-sm font-medium">{tenHinhThuc}</p>

      <div className="space-y-1">
        <Label htmlFor={idMacDinh} className="text-xs font-normal text-muted-foreground">
          Sổ mặc định
        </Label>
        <Select value={dangSua.defaultAccountId ?? CHUA_CAI} onValueChange={chonMacDinh} disabled={luu.isPending}>
          <SelectTrigger id={idMacDinh} aria-label={`Sổ mặc định ${nhan}`} className="bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={CHUA_CAI}>Chưa cài</SelectItem>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
            {macDinhHong && dangSua.defaultAccountId && (
              <SelectItem value={dangSua.defaultAccountId} disabled>
                Sổ không còn dùng được
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        {macDinhHong && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Sổ mặc định đang cài đã xoá hoặc là sổ ảo — chọn sổ khác hoặc Chưa cài.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor={idSoPhu} className="text-xs font-normal text-muted-foreground">
          Sổ phụ
        </Label>
        {/* modal: màn này còn nằm trong hộp thoại ở trang Sổ quỹ điện thoại. Popover
            không modal thì khoá cuộn của hộp thoại nuốt thao tác cuộn danh sách sổ. */}
        <Popover modal>
          <PopoverTrigger asChild>
            <Button
              id={idSoPhu}
              type="button"
              variant="outline"
              disabled={luu.isPending}
              aria-label={`Sổ phụ ${nhan}`}
              className="w-full justify-between gap-2 bg-background px-3 font-normal"
            >
              <span className="min-w-0 truncate">{tomTatSoPhu(dangSua.extraAccountIds, theoId)}</span>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="min-w-[220px] max-w-[calc(100vw-2rem)] p-2"
            style={{ width: "var(--radix-popover-trigger-width)" }}
          >
            {ungVienPhu.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">Không còn sổ nào khác để thêm.</p>
            ) : (
              <div className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
                {ungVienPhu.map((a) => {
                  const chon = dangSua.extraAccountIds.includes(a.id);
                  const htmlId = `${idSoPhu}-${a.id}`;
                  return (
                    <Label
                      key={a.id}
                      htmlFor={htmlId}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm font-normal hover:bg-accent"
                    >
                      <Checkbox
                        id={htmlId}
                        checked={chon}
                        disabled={!chon && daDuSoPhu}
                        onCheckedChange={(value) => doiSoPhu(a.id, value === true)}
                      />
                      <span className="min-w-0 truncate">{a.name}</span>
                    </Label>
                  );
                })}
              </div>
            )}
            {daDuSoPhu && (
              <p className="px-2 pt-1 text-xs text-muted-foreground">Tối đa {TOI_DA_SO_PHU} sổ phụ cho một hình thức.</p>
            )}
          </PopoverContent>
        </Popover>
        {soPhuHong > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {soPhuHong} sổ phụ đã xoá hoặc là sổ ảo — bấm Lưu để gỡ khỏi danh sách.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        {nhap !== null && coThayDoi && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setNhap(null)} disabled={luu.isPending}>
            Bỏ thay đổi
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          onClick={luuLai}
          disabled={!coThayDoi || macDinhHong || luu.isPending}
          aria-label={`Lưu ${nhan}`}
        >
          {luu.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Save className="mr-1.5 h-4 w-4" aria-hidden />
          )}
          Lưu
        </Button>
      </div>
    </div>
  );
}
