import { focusFirstError } from '@/lib/formErrors';
import { passwordFieldErrors, AvatarProfilePartialError } from '@/lib/accountFeedback';
import { actionErrorMessage, notifyActionError } from '@/lib/actionFeedback';
import { QueryRegion } from '@/components/errors/QueryRegion';
import { LoadingState } from '@/components/loading/LoadingState';
import { useState, useRef, lazy, Suspense } from "react";
import { usePhoneViewport } from "@/hooks/use-mobile";
import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { User, Camera, Lock, Loader2 } from "lucide-react";
import { useProfile, useUpdateProfile, useUploadAvatar, useChangePassword } from "@/hooks/useProfile";
import { toast } from "sonner";
import { useClipboardImagePaste } from "@/hooks/useClipboardImagePaste";
import PushNotificationSettings from "@/components/notifications/PushNotificationSettings";
import NotificationPreferencesCard from "@/components/notifications/NotificationPreferencesCard";
import AccountOrganizationCard from "@/components/account/AccountOrganizationCard";
import { BankEmailConnectionManager } from "@/components/bank-email/BankEmailConnectionManager";

function ProfileDesktop() {
  const profileQuery = useProfile();
  const { data: profile, isLoading } = profileQuery;
  const updateProfile = useUpdateProfile();
  const uploadAvatar = useUploadAvatar();
  const changePassword = useChangePassword();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [profileInitialized, setProfileInitialized] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string,string>>({});
  const [passwordError, setPasswordError] = useState("");
  const [avatarError, setAvatarError] = useState("");

  // Initialize form when profile loads
  if (profile && !profileInitialized) {
    setFullName(profile.full_name || "");
    setPhone(profile.phone || "");
    setEmail(profile.email || "");
    setProfileInitialized(true);
  }

  const handleSaveProfile = () => {
    updateProfile.mutate({ full_name: fullName, phone, email });
  };

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const acceptAvatarFile = (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      setAvatarError("Chọn ảnh không quá 2MB.");
      void focusFirstError({ avatar: "Chọn ảnh không quá 2MB." });
      return;
    }
    setAvatarError("");
    uploadAvatar.mutate(file, { onError: error => setAvatarError(error instanceof AvatarProfilePartialError ? error.message : actionErrorMessage(error, "Chưa cập nhật được ảnh đại diện")) });
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) acceptAvatarFile(file);
  };

  const avatarPasteHandlers = useClipboardImagePaste({
    onFiles: (files) => acceptAvatarFile(files[0]),
    enabled: !uploadAvatar.isPending,
  });

  const handleChangePassword = () => {
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

  const initials = (profile?.full_name || "U")
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  if (isLoading) {
    return (
      <MainLayout title="Thông tin cá nhân" subtitle="Quản lý thông tin tài khoản của bạn" icon={User}>
        <LoadingState label="thông tin tài khoản" variant="detail" rows={6} className="max-w-2xl" onRetry={() => void profileQuery.refetch()} />
      </MainLayout>
    );
  }

  return (
    <MainLayout title="Thông tin cá nhân" subtitle="Quản lý thông tin tài khoản của bạn" icon={User}>
      <QueryRegion label="thông tin tài khoản" queries={[profileQuery]} skeleton="detail" rows={6}>
      {avatarError && <p role="alert" className="text-sm text-destructive">{avatarError}</p>}
      <div className="grid gap-6 max-w-2xl">
        {/* Avatar Section */}
        <Card>
          <CardHeader>
            <CardTitle>Ảnh đại diện</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-6">
            <div className="relative group cursor-pointer" role="button" tabIndex={0} data-field-name="avatar" aria-invalid={!!avatarError} onKeyDown={e => { if(e.key === "Enter" || e.key === " ") handleAvatarClick(); }} onClick={handleAvatarClick} {...avatarPasteHandlers}>
              <Avatar className="h-20 w-20">
                <AvatarImage src={profile?.avatar_url || undefined} alt={profile?.full_name || "Avatar"} />
                <AvatarFallback className="text-lg">{initials}</AvatarFallback>
              </Avatar>
              <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <Camera className="h-6 w-6 text-white" />
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                Nhấn vào ảnh hoặc hover + Ctrl+V để thay đổi. JPG, PNG. Tối đa 2MB.
              </p>
              {uploadAvatar.isPending && (
                <p className="text-sm text-primary flex items-center gap-1 mt-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Đang tải lên...
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <AccountOrganizationCard />

        {/* Profile Info Section */}
        <Card>
          <CardHeader>
            <CardTitle>Thông tin cá nhân</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fullName">Họ và tên</Label>
              <Input
                id="fullName"
                placeholder="Nhập họ và tên"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="Nhập email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Số điện thoại</Label>
              <Input
                id="phone"
                placeholder="Nhập số điện thoại"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <Button onClick={handleSaveProfile} disabled={updateProfile.isPending}>
              {updateProfile.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Lưu thay đổi
            </Button>
          </CardContent>
        </Card>

        {/* Change Password Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              Đổi mật khẩu
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">Mật khẩu hiện tại</Label>
              <Input
                id="currentPassword"
                type="password"
                placeholder="Nhập mật khẩu hiện tại"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <Separator />
            <div className="space-y-2">
              <Label htmlFor="newPassword">Mật khẩu mới</Label>
              <Input
                id="newPassword" name="newPassword" aria-invalid={!!fieldErrors.newPassword} aria-describedby={fieldErrors.newPassword ? "newPassword-error" : undefined}
                type="password"
                placeholder="Nhập mật khẩu mới (ít nhất 6 ký tự)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              {fieldErrors.newPassword && <p id="newPassword-error" role="alert" className="text-sm text-destructive">{fieldErrors.newPassword}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Xác nhận mật khẩu mới</Label>
              <Input
                id="confirmPassword" name="confirmPassword" aria-invalid={!!fieldErrors.confirmPassword} aria-describedby={fieldErrors.confirmPassword ? "confirmPassword-error" : undefined}
                type="password"
                placeholder="Nhập lại mật khẩu mới"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
              {fieldErrors.confirmPassword && <p id="confirmPassword-error" role="alert" className="text-sm text-destructive">{fieldErrors.confirmPassword}</p>}
            </div>
            {passwordError && <p role="alert" className="text-sm text-destructive">{passwordError}</p>}
            <Button onClick={handleChangePassword} disabled={changePassword.isPending} variant="outline">
              {changePassword.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Đổi mật khẩu
            </Button>
          </CardContent>
        </Card>

        {/* Push Notification Section */}
        <PushNotificationSettings />

        {/* Sở thích thông báo cá nhân — ĐẶT Ở ĐÂY chứ không ở /settings/general:
            8/10 người nhận thông báo không có `settings.view` nên không mở nổi trang
            cài đặt để tự tắt. /account/profile chỉ bọc ProtectedRoute. */}
        <NotificationPreferencesCard />
      </div>
      </QueryRegion>
      <div className="mt-6 max-w-2xl"><BankEmailConnectionManager /></div>
    </MainLayout>
  );
}

const AccountMobilePage = lazy(() => import("./AccountMobilePage"));

export default function ProfilePage() {
  const isPhone = usePhoneViewport();
  if (isPhone)
    return (
      <Suspense fallback={null}>
        <AccountMobilePage />
      </Suspense>
    );
  return <ProfileDesktop />;
}
