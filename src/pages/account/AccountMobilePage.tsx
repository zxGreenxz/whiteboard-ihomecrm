import { hasUnconfirmedResponse } from '@/lib/operationOutcome';
import { focusFirstError } from '@/lib/formErrors';
import { passwordFieldErrors, AvatarProfilePartialError } from '@/lib/accountFeedback';
import { actionErrorMessage, notifyActionError } from '@/lib/actionFeedback';
import { QueryRegion } from '@/components/errors/QueryRegion';
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, User, Camera, Lock, Check, Bell, CreditCard, Download, LogOut, ChevronRight, ShieldCheck } from "lucide-react";
import "@/styles/mobileApp.css";
import "@/styles/financeMobile.css";
import "@/styles/estateMobile.css";
import { useProfile, useUpdateProfile, useUploadAvatar, useChangePassword } from "@/hooks/useProfile";
import { useAuth, useLogout } from "@/hooks/useAuth";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { isPushSupported, isSubscribed, enablePush, disablePush } from "@/lib/push";
import NotificationPreferencesCard from "@/components/notifications/NotificationPreferencesCard";
import AccountOrganizationCard from "@/components/account/AccountOrganizationCard";
import { toast } from "sonner";

const APP_VERSION = "5.2.0";

const initialsOf = (name?: string | null, email?: string | null) => {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  return (email?.slice(0, 2) || "U").toUpperCase();
};

/**
 * Tài khoản — màn hình app full-screen mobile (web-app). Dựng theo handoff
 * Claude Design (iHomeCRM Mobile.dc.html · 1k). Nối dữ liệu thật: useProfile +
 * đổi mật khẩu + tải ảnh đại diện + bật/tắt Web Push (@/lib/push) + đăng xuất.
 * Scope .cm-stage/.cm-app, ngoài MainLayout.
 */
export default function AccountMobilePage() {
  const navigate = useNavigate();
  const profileQuery = useProfile();
  const { data: profile } = profileQuery;
  const { data: authUser } = useAuth();
  const { data: perms } = useMyPermissions();
  const updateProfile = useUpdateProfile();
  const uploadAvatar = useUploadAvatar();
  const changePassword = useChangePassword();
  const logout = useLogout();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [init, setInit] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string,string>>({});
  const [passwordError, setPasswordError] = useState("");
  const [avatarError, setAvatarError] = useState("");

  const [pushOn, setPushOn] = useState<boolean | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState("");
  const [pendingPush, setPendingPush] = useState<unknown>(null);

  useEffect(() => {
    if (profile && !init) {
      setFullName(profile.full_name || "");
      setPhone(profile.phone || "");
      setEmail(profile.email || "");
      setInit(true);
    }
  }, [profile, init]);

  useEffect(() => {
    let alive = true;
    if (isPushSupported()) {
      isSubscribed()
        .then((s) => alive && setPushOn(s))
        .catch(error => { if (alive) {
          setPushOn(null);
          setPushError(actionErrorMessage(error, "Chưa kiểm tra được trạng thái thông báo đẩy"));
        } });
    }
    return () => {
      alive = false;
    };
  }, []);

  const isAdmin = canUse(perms, "users", "view");
  const roleLabel = isAdmin ? "Quản trị viên" : "Nhân viên";
  const displayEmail = profile?.email || authUser?.email || "";
  const initials = initialsOf(profile?.full_name, displayEmail);

  const planDaysLeft = (() => {
    if (!profile?.subscription_expires_at) return null;
    const d = Math.ceil((new Date(profile.subscription_expires_at).getTime() - Date.now()) / 86400000);
    return d > 0 ? d : 0;
  })();

  const onAvatarPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setAvatarError("Chọn ảnh không quá 2MB.");
      void focusFirstError({ avatar: "Chọn ảnh không quá 2MB." });
      return;
    }
    setAvatarError("");
    uploadAvatar.mutate(file, { onError: error => setAvatarError(error instanceof AvatarProfilePartialError ? error.message : actionErrorMessage(error, "Chưa cập nhật được ảnh đại diện")) });
  };

  const onSaveProfile = () => updateProfile.mutate({ full_name: fullName, phone, email });

  const onChangePassword = () => {
    const errors = passwordFieldErrors(newPassword, confirmPassword);
    setFieldErrors(errors);
    setPasswordError('');
    if (Object.keys(errors).length) { void focusFirstError(errors, { order: ['newPassword', 'confirmPassword'] }); return; }
    changePassword.mutate(newPassword, {
      onError: error => setPasswordError(actionErrorMessage(error, "Chưa xác nhận được kết quả đổi mật khẩu")),
      onSuccess: () => {
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      },
    });
  };

  const onTogglePush = async (next: boolean) => {
    if (!isPushSupported()) {
      toast.error("Trình duyệt/thiết bị không hỗ trợ thông báo đẩy");
      return;
    }
    setPushBusy(true);
    setPushError("");
    try {
      if (next) {
        const res = await enablePush();
        if (res === "granted") {
          setPushOn(true);
          toast.success("Đã bật thông báo đẩy trên thiết bị này");
        } else if (res === "denied") {
          toast.error("Bạn đã chặn quyền thông báo. Hãy mở lại trong cài đặt trình duyệt.");
        } else {
          toast.info("Chưa cấp quyền thông báo");
        }
      } else {
        const result = await disablePush();
        if (result === "unsupported") {
          toast.info("Trình duyệt/thiết bị không hỗ trợ thông báo đẩy");
          return;
        }
        setPushOn(false);
        if (result === "already-disabled") toast.info("Thiết bị này đã tắt thông báo đẩy.");
        else toast.success("Đã tắt thông báo trên thiết bị này");
      }
    } catch (e) {
      setPushError(actionErrorMessage(e, "Chưa xác nhận được thay đổi thông báo đẩy"));
      if (hasUnconfirmedResponse(e)) { setPushOn(null); setPendingPush(e); }
      notifyActionError(e, "Chưa xác nhận được thay đổi thông báo đẩy");
    } finally {
      setPushBusy(false);
    }
  };

  const readPushState = async () => {
    setPushBusy(true);
    try {
      setPushOn(await isSubscribed(pendingPush));
      setPendingPush(null);
      setPushError("");
    } catch (error) {
      setPushOn(null);
      setPushError(actionErrorMessage(error, "Chưa kiểm tra được trạng thái thông báo đẩy"));
    } finally { setPushBusy(false); }
  };

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate("/")} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Tài khoản</h1>
              <p>Quản lý thông tin của bạn</p>
            </div>
          </div>

          <div className="mbody">
          <QueryRegion label="thông tin tài khoản" queries={[profileQuery]}>
          {avatarError && <p role="alert" className="text-sm text-destructive">{avatarError}</p>}
            <div className="acc-hero">
              <div className="acc-av" role="button" tabIndex={0} data-field-name="avatar" aria-invalid={!!avatarError} onKeyDown={e => { if(e.key === "Enter" || e.key === " ") fileRef.current?.click(); }} onClick={() => fileRef.current?.click()} style={{ cursor: "pointer", overflow: "hidden" }}>
                {profile?.avatar_url ? (
                  <img src={profile.avatar_url} alt={profile.full_name || "Avatar"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  initials
                )}
              </div>
              <div className="acc-hero-b">
                <div className="acc-name">{profile?.full_name || "Người dùng"}</div>
                <div className="acc-mail">{displayEmail || "—"}</div>
                <span className="acc-role"><ShieldCheck />{roleLabel}</span>
              </div>
              <button className="acc-cam" type="button" aria-label="Đổi ảnh" onClick={() => fileRef.current?.click()}>
                <Camera />
              </button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" style={{ display: "none" }} onChange={onAvatarPick} />
            </div>

            <AccountOrganizationCard variant="mobile" />

            {/* Thông tin cá nhân */}
            <div className="cd-card">
              <div className="cd-card-h">
                <div className="cd-card-t"><User size={17} />Thông tin cá nhân</div>
              </div>
              <div className="ff">
                <label className="ff-lbl">Họ và tên</label>
                <input className="ff-input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Nhập họ và tên" />
              </div>
              <div className="ff">
                <label className="ff-lbl">Email</label>
                <input className="ff-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Nhập email" />
              </div>
              <div className="ff">
                <label className="ff-lbl">Số điện thoại</label>
                <input className="ff-input mono" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Nhập số điện thoại" />
              </div>
              <button className="ff-save" type="button" onClick={onSaveProfile} disabled={updateProfile.isPending}>
                <Check />
                {updateProfile.isPending ? "Đang lưu…" : "Lưu thay đổi"}
              </button>
            </div>

            {/* Đổi mật khẩu */}
            <div className="cd-card">
              <div className="cd-card-h">
                <div className="cd-card-t"><Lock size={17} />Đổi mật khẩu</div>
              </div>
              <div className="ff">
                <label className="ff-lbl">Mật khẩu hiện tại</label>
                <input className="ff-input" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Nhập mật khẩu hiện tại" />
              </div>
              <div className="ff">
                <label className="ff-lbl">Mật khẩu mới</label>
                <input className="ff-input" id="newPassword" name="newPassword" aria-invalid={!!fieldErrors.newPassword} aria-describedby={fieldErrors.newPassword ? "newPassword-error" : undefined} style={fieldErrors.newPassword ? {borderColor:"hsl(var(--destructive))"} : undefined} type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Ít nhất 6 ký tự" />
              {fieldErrors.newPassword && <p id="newPassword-error" role="alert" className="text-sm text-destructive">{fieldErrors.newPassword}</p>}
              </div>
              <div className="ff">
                <label className="ff-lbl">Xác nhận mật khẩu mới</label>
                <input className="ff-input" id="confirmPassword" name="confirmPassword" aria-invalid={!!fieldErrors.confirmPassword} aria-describedby={fieldErrors.confirmPassword ? "confirmPassword-error" : undefined} style={fieldErrors.confirmPassword ? {borderColor:"hsl(var(--destructive))"} : undefined} type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Nhập lại mật khẩu mới" />
              {fieldErrors.confirmPassword && <p id="confirmPassword-error" role="alert" className="text-sm text-destructive">{fieldErrors.confirmPassword}</p>}
              </div>
              {passwordError && <p role="alert" className="text-sm text-destructive">{passwordError}</p>}
              <button className="ff-save ghost" type="button" onClick={onChangePassword} disabled={changePassword.isPending}>
                <Lock />
                {changePassword.isPending ? "Đang đổi…" : "Đổi mật khẩu"}
              </button>
            </div>

            <div className="msub"><span className="msub-t">Tùy chọn</span></div>
            <div className="acc-rows">
              {pushError && <p role="alert" className="text-sm text-destructive">{pushError}</p>}
              <div className="sp-rowcard">
                <span className="ic brand"><Bell /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="gn">Thông báo đẩy</span>
                  {pushOn === null && <button type="button" className="text-sm underline" onClick={() => void readPushState()} disabled={pushBusy}>Tải lại trạng thái thiết bị</button>}
                  <span className="gv">{pushOn === null ? "Chưa xác định trạng thái đăng ký của thiết bị" : "Nhắc nợ · hoá đơn · công việc"}</span>
                </div>
                <button
                  className={"sp-switch" + (pushOn ? " on" : "")}
                  onClick={() => !pushBusy && onTogglePush(!pushOn)}
                  aria-label="Thông báo đẩy"
                  disabled={pushBusy || pushOn === null}
                >
                  <span className="knob" />
                </button>
              </div>
            </div>

            {/* Sở thích thông báo cá nhân — đặt NGAY dưới công tắc push, ở /account/profile.
                Đây là lối duy nhất 8/10 người nhận thông báo có thể tự tắt loại họ không
                muốn: họ không có `settings.view` nên /settings/general đóng với họ, và
                trang đó cũng không có nhánh mobile. */}
            <NotificationPreferencesCard variant="mobile" />

            <div className="acc-rows">
              <div className="sp-rowcard">
                <span className="ic" style={{ background: "#f1ebfd", color: "#7c3aed" }}><CreditCard /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="gn">Gói dịch vụ</span>
                  <span className="gv">
                    {profile?.subscription_plan ? `Gói ${profile.subscription_plan}` : "Gói cơ bản"}
                    {planDaysLeft != null ? ` · còn ${planDaysLeft} ngày` : ""}
                  </span>
                </div>
              </div>

              <button
                className="sp-rowcard"
                type="button"
                onClick={() => toast.info("Cài lên máy: chạm nút Chia sẻ của trình duyệt → “Thêm vào MH chính”.")}
              >
                <span className="ic" style={{ background: "#e8f3ec", color: "#1f7a52" }}><Download /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="gn">Cài CRM lên máy</span>
                  <span className="gv">Thêm vào màn hình chính</span>
                </div>
                <span className="chev"><ChevronRight size={18} /></span>
              </button>
            </div>

            <button className="acc-logout" type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
              <LogOut />
              {logout.isPending ? "Đang đăng xuất…" : "Đăng xuất"}
            </button>
            <div className="acc-ver">iHomeCRM · phiên bản {APP_VERSION}</div>
            </QueryRegion>
          </div>
        </div>
      </div>
    </div>
  );
}
