// Sở thích thông báo CỦA CHÍNH TÔI — 5 họ sự kiện × 2 công tắc (trong app / đẩy về máy).
//
// 🔴 Vì sao card này nằm ở /account/profile chứ KHÔNG phải /settings/general:
// đo thật bằng `get_my_permissions()` dưới JWT thật, `settings.view` chỉ TRUE với đúng
// một tài khoản (demo.chunha); nathan, joey, bosshuy, demo.sale, demo.ketoan, demo.quanly,
// demo.kythuat, demo.codong đều FALSE. 8/10 người NHẬN thông báo không mở nổi trang cài
// đặt để tắt thông báo của chính mình — mà nathan đang ôm 658/1130 dòng. Ba lớp cùng chặn
// họ: RequirePermission ở route, mục menu bị lọc khỏi Sidebar/HomeLauncher, và
// GeneralSettingsPage không có nhánh mobile trong khi push chỉ có nghĩa trên điện thoại.
// /account/profile chỉ bọc ProtectedRoute ⇒ 10/10 tài khoản vào được, cả desktop lẫn mobile.
//
// Một component, hai lớp áo: desktop dùng shadcn Card/Switch, mobile dùng bộ class
// .cd-card/.sp-rowcard/.sp-switch của web-app (.cm-app) để không lạc tông với màn Tài khoản.

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Bell } from "lucide-react";
import {
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENT_LABELS,
  useMyNotificationPreferences,
  useMyOrgOptions,
  useSetMyNotificationPreferences,
  type NotificationEventKey,
  type NotificationPreferenceRow,
} from "@/hooks/useNotificationSettings";

type PrefMap = Record<NotificationEventKey, NotificationPreferenceRow>;

interface Props {
  /** "desktop" = thẻ shadcn trong ProfilePage; "mobile" = thẻ .cd-card trong AccountMobilePage. */
  variant?: "desktop" | "mobile";
}

export default function NotificationPreferencesCard({ variant = "desktop" }: Props) {
  const { options, isLoading: loadingOrgs } = useMyOrgOptions();
  const [orgId, setOrgId] = useState<string | null>(null);

  // 9/10 tài khoản có đúng 1 tổ chức ⇒ tự chọn, không bắt bấm. Chỉ chủ (2 tổ chức)
  // mới thấy ô chọn bên dưới.
  const effectiveOrgId = orgId ?? options[0]?.id ?? null;

  const { data, isLoading } = useMyNotificationPreferences(effectiveOrgId);
  const save = useSetMyNotificationPreferences(effectiveOrgId);

  const [draft, setDraft] = useState<PrefMap | null>(null);

  useEffect(() => {
    if (data?.prefs) setDraft(data.prefs);
  }, [data]);

  const rows = useMemo(() => draft, [draft]);
  const locked = !data?.available || save.isPending || !effectiveOrgId;

  const toggle = (key: NotificationEventKey, field: "in_app" | "push", next: boolean) => {
    if (!rows) return;
    const updated: PrefMap = { ...rows, [key]: { ...rows[key], [field]: next } };
    // Cập nhật lạc quan rồi mới gọi RPC: công tắc phải nhảy ngay, không đợi mạng.
    setDraft(updated);
    save.mutate(updated, {
      onError: () => setDraft(rows), // hoàn nguyên đúng trạng thái trước cú bấm
    });
  };

  // Không thuộc tổ chức nào ⇒ query bị `enabled:false` và sẽ treo ở "Đang tải…" mãi mãi
  // nếu không tách riêng nhánh này.
  const noOrg = !loadingOrgs && !effectiveOrgId;
  const busy = !noOrg && (loadingOrgs || isLoading || !rows);

  const notice = noOrg
    ? "Bạn chưa thuộc tổ chức nào nên chưa có tuỳ chọn thông báo để đặt."
    : !busy && data && !data.available
      ? "Tuỳ chọn cá nhân chưa bật trên máy chủ — đang hiển thị mặc định (nhận tất cả) và tạm thời chưa lưu được."
      : null;

  /* ───────────────────────────── Mobile (.cm-app) ──────────────────────── */
  if (variant === "mobile") {
    return (
      <div className="cd-card">
        <div className="cd-card-h">
          <div className="cd-card-t">
            <Bell size={17} />
            Thông báo tôi muốn nhận
          </div>
        </div>

        {options.length > 1 && (
          <div className="ff">
            <label className="ff-lbl">Tổ chức</label>
            <select
              className="ff-input"
              value={effectiveOrgId ?? ""}
              onChange={(e) => setOrgId(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {notice && (
          <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--ink-2, #52525b)" }}>
            {notice}
          </div>
        )}

        {noOrg ? null : busy ? (
          <div style={{ padding: "12px 14px", fontSize: 13, color: "var(--ink-2, #52525b)" }}>
            Đang tải…
          </div>
        ) : (
          <div className="acc-rows" style={{ padding: "4px 0 10px" }}>
            {NOTIFICATION_EVENT_KEYS.map((k) => (
              <div className="sp-rowcard" key={k}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="gn">{NOTIFICATION_EVENT_LABELS[k].title}</span>
                  <span className="gv">{NOTIFICATION_EVENT_LABELS[k].desc}</span>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 10, color: "var(--ink-2, #52525b)", marginBottom: 2 }}>
                      Trong app
                    </div>
                    <button
                      type="button"
                      className={"sp-switch" + (rows![k].in_app ? " on" : "")}
                      aria-label={`Trong app · ${NOTIFICATION_EVENT_LABELS[k].title}`}
                      disabled={locked}
                      onClick={() => !locked && toggle(k, "in_app", !rows![k].in_app)}
                    >
                      <span className="knob" />
                    </button>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 10, color: "var(--ink-2, #52525b)", marginBottom: 2 }}>
                      Đẩy về máy
                    </div>
                    <button
                      type="button"
                      className={"sp-switch" + (rows![k].push ? " on" : "")}
                      aria-label={`Đẩy về máy · ${NOTIFICATION_EVENT_LABELS[k].title}`}
                      disabled={locked}
                      onClick={() => !locked && toggle(k, "push", !rows![k].push)}
                    >
                      <span className="knob" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ───────────────────────────── Desktop (shadcn) ──────────────────────── */
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Thông báo tôi muốn nhận
        </CardTitle>
        <CardDescription>
          Áp dụng cho riêng tài khoản của bạn. "Trong app" là chuông và trang Bản tin;
          "Đẩy về máy" là thông báo hiện trên điện thoại/máy tính kể cả khi chưa mở web.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {options.length > 1 && (
          <div className="flex items-center gap-3">
            <Label className="text-sm">Tổ chức</Label>
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={effectiveOrgId ?? ""}
              onChange={(e) => setOrgId(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

        {noOrg ? null : busy ? (
          <p className="text-sm text-muted-foreground">Đang tải…</p>
        ) : (
          <div className="divide-y">
            <div className="flex items-center justify-end gap-6 pb-2 text-xs text-muted-foreground">
              <span className="w-16 text-center">Trong app</span>
              <span className="w-16 text-center">Đẩy về máy</span>
            </div>
            {NOTIFICATION_EVENT_KEYS.map((k) => (
              <div key={k} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{NOTIFICATION_EVENT_LABELS[k].title}</p>
                  <p className="text-xs text-muted-foreground">
                    {NOTIFICATION_EVENT_LABELS[k].desc}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-6">
                  <div className="w-16 text-center">
                    <Switch
                      checked={rows![k].in_app}
                      disabled={locked}
                      onCheckedChange={(v) => toggle(k, "in_app", v)}
                      aria-label={`Trong app · ${NOTIFICATION_EVENT_LABELS[k].title}`}
                    />
                  </div>
                  <div className="w-16 text-center">
                    <Switch
                      checked={rows![k].push}
                      disabled={locked}
                      onCheckedChange={(v) => toggle(k, "push", v)}
                      aria-label={`Đẩy về máy · ${NOTIFICATION_EVENT_LABELS[k].title}`}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!noOrg && (
          <p className="text-xs text-muted-foreground">
            Tắt "Đẩy về máy" chỉ ngừng thông báo bật lên ngoài màn hình; dòng vẫn nằm trong
            Bản tin nếu "Trong app" còn bật. Công tắc push chung của thiết bị nằm ở thẻ
            "Thông báo đẩy" phía trên.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
