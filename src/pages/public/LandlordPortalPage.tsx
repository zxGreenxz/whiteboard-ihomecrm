// =============================================================================
// Link tên miền cho chủ nhà (chủ nhắn 24/10/2026): cgiang.chillhome.io.vn, agiang.chillhome.io.vn (hoặc
// /cn/<tên link> trên tên miền chính). Vào bằng PIN 6 số của từng người xem — "xem như tài khoản mật khẩu", máy nhớ
// đăng nhập; link có nhiều toà thì có ô chọn toà ở đầu trang. Số liệu y như link /qt/:token (chỉ đọc); thao tác
// duy nhất là "Xác nhận đã xem số liệu", server ghi theo người xem của phiên.
// =============================================================================
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { Handshake, LogOut, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SkeletonBar } from '@/components/loading/LoadingState';
import { SettlementScreen } from '@/components/landlord-settlement/SettlementScreen';
import {
  useConfirmLandlordPortalMonth,
  useLandlordPortal,
  useLandlordPortalLogin,
  useLandlordPortalLogout,
} from '@/hooks/useLandlordPortal';
import { PORTAL_PIN, readPortalSession, writePortalSession } from '@/lib/landlordPortal';
import { landlordErrorMessage, monthKey, monthToDate, monthsDescending } from '@/lib/landlordSettlement';

function PortalLogin({ slug, onLoggedIn }: { slug: string; onLoggedIn: (session: string) => void }) {
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const login = useLandlordPortalLogin();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending) return;
    if (!PORTAL_PIN.test(pin)) {
      setMsg('Nhập đủ 6 số của mã PIN.');
      return;
    }
    setMsg(null);
    try {
      const r = await login.mutateAsync({ slug, pin });
      if (r.status === 'OK') {
        onLoggedIn(r.session);
        return;
      }
      setPin('');
      if (r.status === 'INVALID') {
        setMsg(r.attempts_left > 0
          ? `Mã PIN không đúng — còn ${r.attempts_left} lần thử trước khi link tạm khoá.`
          : 'Mã PIN không đúng — link tạm khoá 15 phút.');
      } else if (r.status === 'LOCKED') {
        setMsg(`Nhập sai nhiều lần — thử lại sau khoảng ${Math.ceil(r.retry_after_seconds / 60)} phút.`);
      } else {
        setMsg('Link không tồn tại — kiểm tra lại địa chỉ hoặc liên hệ bên quản lý.');
      }
    } catch (err) {
      setMsg(landlordErrorMessage(err, 'Chưa đăng nhập được'));
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-sm" data-testid="portal-login">
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-900 text-emerald-200">
          <Handshake className="h-6 w-6" aria-hidden />
        </span>
        <h1 className="text-lg font-extrabold tracking-tight">Quyết toán vận hành</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Nhập mã PIN 6 số bên quản lý đã gửi cho bạn. Máy này sẽ nhớ đăng nhập, lần sau không cần nhập lại.
        </p>
        <div className="mt-5 space-y-1.5">
          <Label htmlFor="portal-pin">Mã PIN</Label>
          <Input id="portal-pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6}
            value={pin} autoFocus
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="h-12 text-center text-2xl tracking-[0.5em]" />
        </div>
        {msg && <p role="alert" className="mt-3 rounded-md border border-destructive/40 p-2 text-sm text-destructive">{msg}</p>}
        <Button type="submit" size="lg" className="mt-4 w-full" disabled={login.isPending}>
          {login.isPending ? 'Đang kiểm tra…' : 'Vào xem'}
        </Button>
      </form>
    </div>
  );
}

export default function LandlordPortalPage({ slug: slugProp }: { slug?: string }) {
  const params = useParams<{ slug: string }>();
  const slug = (slugProp ?? params.slug ?? '').toLowerCase();
  // đổi link (/cn/agiang → /cn/cgiang) ⇒ dựng lại từ đầu với phiên đã lưu của ĐÚNG link đó
  return <PortalView key={slug} slug={slug} />;
}

function PortalView({ slug }: { slug: string }) {
  const [session, setSessionState] = useState<string | null>(() => readPortalSession(slug));
  const setSession = (s: string | null) => {
    writePortalSession(slug, s);
    setSessionState(s);
  };
  const [building, setBuilding] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const q = useLandlordPortal(slug, session, building, month ? monthToDate(month) : null);
  const logout = useLandlordPortalLogout();
  const confirm = useConfirmLandlordPortalMonth();
  const data = q.data ?? null;

  // phiên hết hạn / người xem bị thu hồi / đã thoát ⇒ server trả NULL: xoá phiên, hỏi lại PIN
  const phienChet = !!session && q.isSuccess && q.data === null && !q.isPlaceholderData;
  useEffect(() => {
    if (phienChet) {
      writePortalSession(slug, null);
      setSessionState(null);
    }
  }, [phienChet, slug]);

  useEffect(() => {
    document.title = data?.overview ? `Quyết toán ${data.overview.building_name}` : 'Quyết toán vận hành';
  }, [data]);

  if (!session) {
    return <PortalLogin slug={slug} onLoggedIn={(s) => { setBuilding(null); setMonth(null); setSession(s); }} />;
  }

  const overview = data?.overview ?? null;
  const months = overview ? monthsDescending(overview.effective_from, overview.current_month) : [];
  const selected = month ?? (data?.month ? monthKey(data.month.period_month) : null);
  const selectedBuilding = data?.selected ?? null;

  const onLogout = () => {
    const s = session;
    setSession(null);
    // thoát trên máy ngay; huỷ phiên ở server không chặn (lỗi mạng thì phiên tự hết hạn)
    logout.mutate({ slug, session: s });
  };

  const errorBlock = (
    <div role="alert" className="rounded-md border border-destructive/40 bg-background p-4 text-sm">
      <p className="font-medium text-destructive">Chưa tải được quyết toán.</p>
      <p className="mt-1 text-muted-foreground">{landlordErrorMessage(q.error, 'Chưa tải được quyết toán')}</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void q.refetch()}>
        <RefreshCw className="mr-1 h-3.5 w-3.5" />Tải lại
      </Button>
    </div>
  );
  let emptyBody: ReactNode;
  if (q.isLoading || phienChet) {
    emptyBody = (
      <div className="space-y-3" aria-busy="true">
        <SkeletonBar className="h-11 w-full" />
        <SkeletonBar className="h-40 w-full" />
        <SkeletonBar className="h-64 w-full" />
      </div>
    );
  } else if (q.isError && !data) {
    emptyBody = errorBlock;
  } else if (data && !selectedBuilding) {
    emptyBody = (
      <div className="rounded-md border bg-background p-6 text-center">
        <p className="font-medium">Link chưa có toà nào để xem</p>
        <p className="mt-1 text-sm text-muted-foreground">Bên quản lý chưa gộp toà vào link này. Liên hệ bên quản lý.</p>
      </div>
    );
  }

  const buildingPicker = data && data.buildings.length > 1 ? (
    <select aria-label="Chọn toà" value={selectedBuilding ?? ''} data-testid="portal-building-picker"
      onChange={(e) => { setBuilding(e.target.value); setMonth(null); }}
      className="h-8 max-w-[60vw] rounded-lg border border-white/20 bg-white/10 px-2 text-[13px] font-semibold text-white [&>option]:text-foreground">
      {data.buildings.map((b) => <option key={b.key} value={b.key}>{b.building_name}</option>)}
    </select>
  ) : undefined;
  const actions = data ? (
    <span className="inline-flex items-center gap-1.5">
      <span className="rounded-lg bg-white/10 px-2 py-1 text-[12px] text-white/80" data-testid="portal-viewer">{data.viewer}</span>
      <button type="button" onClick={onLogout}
        className="inline-flex h-8 items-center gap-1 rounded-lg border border-white/20 bg-white/10 px-2 text-[12px] font-semibold text-white hover:bg-white/20">
        <LogOut className="h-3.5 w-3.5" aria-hidden />Thoát
      </button>
    </span>
  ) : undefined;

  return (
    <div className="min-h-screen bg-muted/30">
      <SettlementScreen
        mode="public"
        buildingName={overview?.building_name ?? null}
        landlordName={overview?.landlord_name ?? null}
        month={data?.month ?? null}
        overview={overview}
        months={months}
        selectedMonth={selected}
        onSelectMonth={setMonth}
        buildingPicker={buildingPicker}
        actions={actions}
        notice={q.isError && data ? errorBlock : undefined}
        emptyBody={emptyBody}
        loading={q.isLoading}
        isFetching={q.isFetching && !q.isLoading}
        busy={q.isPlaceholderData}
        onConfirm={session && selectedBuilding
          ? (a) => confirm.mutateAsync({ slug, session, building: selectedBuilding, ...a })
          : undefined}
      />
    </div>
  );
}
