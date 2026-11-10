// =============================================================================
// Trang khách xem lại camera được chia sẻ: /xem-camera/<ID>. Không cần tài khoản CRM — nhập ID + mật khẩu bên quản
// lý gửi, server cấp phiên `cs_…` (giữ trong tab, sessionStorage theo ID) dùng làm Bearer cho cổng video. Chỉ xem lại
// đúng một kênh trong khung giờ được chia sẻ; hết hạn / bị thu hồi ⇒ trang báo đã kết thúc và xoá phiên.
// =============================================================================
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Clock3, Eye, EyeOff, LogOut, RefreshCw, TimerOff } from "lucide-react";
import { SkeletonBar } from "@/components/loading/LoadingState";
import SharedCameraPlayer from "@/components/network-center/share/SharedCameraPlayer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cameraShareSessionQueryKey, useCameraShareLogin, useCameraShareLogout, useCameraShareSession,
} from "@/hooks/network-center/useCameraShares";
import { cameraTimeLabel } from "@/lib/network-center/cameraArchive";
import {
  CAMERA_SHARE_CODE, CAMERA_SHARE_PASSWORD, CAMERA_SHARE_PATH, CameraShareError, cameraShareChannelLabel, cameraShareWaitLabel,
  cameraShareWindowLabel, normalizeShareCode, normalizeSharePassword, readCameraShareSession, writeCameraShareSession,
  type CameraShare,
} from "@/lib/network-center/cameraShare";

function Shell({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-muted/30">{children}</div>;
}

function ShareLogin({ initialCode, notice, onLoggedIn, onEnded }: {
  initialCode: string; notice: string; onLoggedIn(code: string, session: string, share: CameraShare): void; onEnded(): void;
}) {
  const [code, setCode] = useState(initialCode);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const login = useCameraShareLogin();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (login.isPending) return;
    const normalizedCode = normalizeShareCode(code);
    const normalizedPassword = normalizeSharePassword(password);
    if (!CAMERA_SHARE_CODE.test(normalizedCode)) { setError("ID gồm 8 ký tự chữ và số, có trong tin nhắn bên quản lý gửi."); return; }
    if (!CAMERA_SHARE_PASSWORD.test(normalizedPassword)) { setError("Mật khẩu gồm 8 ký tự chữ thường và số."); return; }
    setError("");
    try {
      const result = await login.mutateAsync({ code: normalizedCode, password: normalizedPassword });
      if (result.status === "OK") { onLoggedIn(normalizedCode, result.session, result.share); return; }
      if (result.status === "ENDED") { onEnded(); return; }
      setPassword("");
      if (result.status === "INVALID") {
        setError(result.attempts_left > 0
          ? `ID hoặc mật khẩu không đúng — còn ${result.attempts_left} lần thử.`
          : "ID hoặc mật khẩu không đúng — đã tạm khoá, vui lòng thử lại sau.");
      } else {
        setError(`Nhập sai nhiều lần — thử lại sau ${cameraShareWaitLabel(result.retry_after_seconds)}.`);
      }
    } catch (cause) {
      setError(cause instanceof CameraShareError ? cause.message : "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.");
    }
  };

  return (
    <Shell>
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <form onSubmit={(event) => void submit(event)} className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-sm" data-testid="camera-share-login" noValidate>
          <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-slate-100">
            <Camera className="h-6 w-6" aria-hidden="true" />
          </span>
          <h1 className="text-lg font-extrabold tracking-tight">Xem lại camera</h1>
          <p className="mt-1 text-sm text-muted-foreground">Nhập ID và mật khẩu trong tin nhắn bên quản lý gửi để xem lại đoạn camera được chia sẻ.</p>
          {notice && <p role="status" className="mt-3 rounded-md bg-muted p-2 text-sm">{notice}</p>}
          <div className="mt-5 space-y-1.5">
            <Label htmlFor="camera-share-code">ID</Label>
            <Input id="camera-share-code" value={code} autoComplete="username" autoCapitalize="characters" spellCheck={false} inputMode="text" autoFocus={!initialCode}
              onChange={(event) => setCode(normalizeShareCode(event.target.value).slice(0, 8))}
              className="h-12 text-center font-mono text-2xl uppercase tracking-[0.3em]" />
          </div>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="camera-share-password">Mật khẩu</Label>
            <div className="relative">
              <Input id="camera-share-password" type={showPassword ? "text" : "password"} value={password} autoComplete="current-password" autoCapitalize="none" spellCheck={false}
                autoFocus={Boolean(initialCode)} maxLength={32} onChange={(event) => setPassword(event.target.value)}
                className="h-12 pr-12 text-center font-mono text-2xl tracking-[0.3em]" />
              <button type="button" className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-muted-foreground" aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
              </button>
            </div>
          </div>
          {error && <p role="alert" className="mt-3 rounded-md border border-destructive/40 p-2 text-sm text-destructive">{error}</p>}
          <Button type="submit" size="lg" className="mt-4 w-full" disabled={login.isPending}>
            {login.isPending ? "Đang kiểm tra…" : "Xem camera"}
          </Button>
        </form>
      </div>
    </Shell>
  );
}

function ShareEnded({ onBack }: { onBack(): void }) {
  return (
    <Shell>
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <div role="alert" className="w-full max-w-sm rounded-2xl border bg-card p-6 text-center shadow-sm" data-testid="camera-share-ended">
          <TimerOff className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
          <h1 className="mt-3 text-lg font-extrabold tracking-tight">Lượt chia sẻ đã kết thúc</h1>
          <p className="mt-1 text-sm text-muted-foreground">Lượt chia sẻ đã hết hạn hoặc đã bị thu hồi. Liên hệ bên quản lý nếu cần xem thêm.</p>
          <Button type="button" variant="outline" className="mt-4 w-full" onClick={onBack}>Nhập ID khác</Button>
        </div>
      </div>
    </Shell>
  );
}

export default function CameraSharePage() {
  const params = useParams<{ code?: string }>();
  const code = normalizeShareCode(params.code ?? "");
  // Đổi ID trên đường dẫn ⇒ dựng lại từ đầu với phiên đã lưu của ĐÚNG ID đó.
  return <ShareView key={code} urlCode={code} />;
}

function ShareView({ urlCode }: { urlCode: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const code = CAMERA_SHARE_CODE.test(urlCode) ? urlCode : "";
  const [session, setSession] = useState<string | null>(() => (code ? readCameraShareSession(code) : null));
  const [ended, setEnded] = useState(false);
  const [notice, setNotice] = useState("");
  const sessionQuery = useCameraShareSession(session);
  const logout = useCameraShareLogout();
  const share = sessionQuery.data ?? null;
  /** Đồng hồ máy đã qua giờ hết hạn và đang hỏi lại server: NULL lúc này nghĩa là lượt chia sẻ đã kết thúc. */
  const expiring = useRef(false);

  useEffect(() => { document.title = "Xem lại camera"; }, []);

  const dropSession = useCallback(() => {
    if (code) writeCameraShareSession(code, null);
    queryClient.removeQueries({ queryKey: ["camera-share", "session"] });
    setSession(null);
  }, [code, queryClient]);
  const end = useCallback(() => { dropSession(); setEnded(true); }, [dropSession]);

  // Server trả NULL: phiên hết hạn, lượt chia sẻ đã kết thúc hoặc đã thoát ở nơi khác ⇒ xoá phiên, hỏi lại mật khẩu.
  const sessionDead = Boolean(session) && sessionQuery.isSuccess && sessionQuery.data === null;
  useEffect(() => {
    if (!sessionDead) return;
    dropSession();
    if (expiring.current) { expiring.current = false; setEnded(true); return; }
    setNotice("Phiên xem đã kết thúc. Nhập lại mật khẩu nếu lượt chia sẻ còn hiệu lực.");
  }, [sessionDead, dropSession]);
  const { refetch: refetchSession } = sessionQuery;
  const recheckExpiry = useCallback(() => {
    expiring.current = true;
    // Máy chủ nói còn hạn (đồng hồ máy khách nhanh, hoặc phiên chỉ bị máy khác thay chỗ) ⇒ bỏ cờ, lần NULL sau là mất phiên thường.
    void refetchSession().then((result) => { if (result.data) expiring.current = false; });
  }, [refetchSession]);

  const loggedIn = (nextCode: string, nextSession: string, nextShare: CameraShare) => {
    writeCameraShareSession(nextCode, nextSession);
    queryClient.setQueryData(cameraShareSessionQueryKey(nextSession), nextShare);
    setNotice("");
    if (nextCode !== urlCode) { navigate(`${CAMERA_SHARE_PATH}/${nextCode}`, { replace: true }); return; }
    setSession(nextSession);
  };
  const signOut = () => {
    const token = session;
    dropSession();
    // Thoát trên máy ngay; huỷ phiên ở server không chặn (lỗi mạng thì phiên tự hết hạn).
    if (token) logout.mutate(token);
  };

  // "Nhập ID khác": bỏ ID đã kết thúc khỏi đường dẫn để ô ID trống thật; không có ID trên đường dẫn thì chỉ quay lại ô nhập.
  if (ended) return <ShareEnded onBack={() => { setEnded(false); setNotice(""); if (urlCode) navigate(CAMERA_SHARE_PATH); }} />;
  if (!session) return <ShareLogin initialCode={urlCode.slice(0, 8)} notice={notice} onLoggedIn={loggedIn} onEnded={end} />;

  return (
    <Shell>
      <header className="sticky top-0 z-30 flex items-center gap-3 bg-slate-950 px-4 py-3 text-white">
        <Camera className="h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-white/70">{share?.building_name ?? "Xem lại camera"}</p>
          <h1 className="truncate text-base font-bold" data-testid="camera-share-title">{share ? cameraShareChannelLabel(share.channel, share.channel_name) : "Đang mở…"}</h1>
        </div>
        <button type="button" onClick={signOut} className="inline-flex h-11 items-center gap-1 rounded-lg border border-white/20 bg-white/10 px-3 text-sm font-semibold hover:bg-white/20">
          <LogOut className="h-4 w-4" aria-hidden="true" />Thoát
        </button>
      </header>
      <main className="mx-auto max-w-4xl space-y-4 px-4 py-4">
        {sessionQuery.isError && !share ? (
          <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-background p-4 text-sm">
            <p className="font-medium text-destructive">Chưa mở được phiên xem.</p>
            <p className="text-muted-foreground">{sessionQuery.error instanceof CameraShareError ? sessionQuery.error.message : "Vui lòng thử lại."}</p>
            <Button type="button" variant="outline" size="sm" disabled={sessionQuery.isFetching} onClick={() => void sessionQuery.refetch()}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />Thử lại
            </Button>
          </div>
        ) : !share ? (
          <div className="space-y-3" aria-busy="true" aria-label="Đang mở phiên xem">
            <SkeletonBar className="h-6 w-2/3" />
            <SkeletonBar className="aspect-video w-full" />
          </div>
        ) : (
          <>
            <section className="space-y-1 rounded-md border bg-background p-3 text-sm" aria-label="Phạm vi được xem">
              <p><span className="text-muted-foreground">Khung giờ được xem: </span><span className="font-medium">{cameraShareWindowLabel(share.window_start, share.window_end)}</span></p>
              <p className="flex items-center gap-1 text-muted-foreground"><Clock3 className="h-4 w-4 shrink-0" aria-hidden="true" />Link hết hạn lúc {cameraTimeLabel(share.expires_at)}</p>
            </section>
            <SharedCameraPlayer key={`${share.share_id}:${session}`} share={share} token={session} onEnded={end} onExpired={recheckExpiry} />
          </>
        )}
      </main>
    </Shell>
  );
}
