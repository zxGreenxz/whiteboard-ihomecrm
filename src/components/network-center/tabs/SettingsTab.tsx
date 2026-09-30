import { Pause, Save, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { NetworkBuilding, NetworkSettings } from "@/lib/network-center/contracts";
import { validateNetworkSettings } from "@/lib/network-center/model";
import { allowsNetworkExecution, networkRolloutDisabledMessage } from "@/lib/network-center/model";
import { settingsFieldErrors, networkFeedback } from '@/lib/network-center/feedback';
import { focusFirstError } from '@/lib/formErrors';
import { ExecuteButton } from "../ExecuteGuard";

export function SettingsTab({ site, controller }: { site: NetworkBuilding; controller: NetworkCenterController }) {
  const executionAllowed = allowsNetworkExecution(controller.canExecute, site.rolloutState);
  const executionDisabledMessage = networkRolloutDisabledMessage(
    controller.canExecute,
    site.rolloutState,
    controller.executeDisabledMessage,
  );
  const storedSettings = site.settings;
  const [draft, setDraft] = useState<NetworkSettings | null>(storedSettings);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const panelRef = useRef<HTMLElement>(null);
  const pending = useRef(false);
  const fieldError = (name: string) => fieldErrors[name] ? <p id={`settings-error-${name}`} className="nc-form-error" role="alert">{fieldErrors[name]}</p> : null;
  const fieldProps = (name: string) => ({ name, "aria-invalid": Boolean(fieldErrors[name]), "aria-describedby": fieldErrors[name] ? `settings-error-${name}` : undefined });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(storedSettings);
    setError("");
    setSaving(false);
  }, [site.buildingId, storedSettings]);
  const save = async () => {
    if (!draft || site.settingsVersion === null || pending.current) return;
    const errors = settingsFieldErrors(draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length) { void focusFirstError(errors, { root: panelRef.current }); return; }
    pending.current = true;
    setError("");
    setSaving(true);
    try {
      const validated = validateNetworkSettings(draft);
      await controller.updateSettings(site.buildingId, validated, site.settingsVersion);
      setDraft(validated);
    } catch (caught) {
      setError(networkFeedback(caught, `lưu cài đặt mạng của ${site.buildingName}`).description);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  // Toà chưa có dòng cài đặt trong hệ thống: đây là trạng thái RỖNG bình
  // thường, không phải lỗi. KHÔNG dựng giá trị mặc định giả để lấp ô nhập.
  if (!draft || site.settingsVersion === null) {
    return (
      <section ref={panelRef} className="nc-panel">
        <div className="nc-panel-heading">
          <div>
            <p className="nc-eyebrow">Chính sách theo toà nhà</p>
            <h3>Cài đặt</h3>
          </div>
        </div>
        <div className="nc-state-card">
          <SlidersHorizontal aria-hidden="true" />
          <h2>Chưa cấu hình Network Center</h2>
          <p>
            Toà nhà này chưa có bản ghi cài đặt nào trong hệ thống, nên chưa có
            chu kỳ kiểm tra, giờ sao lưu hay ngưỡng cảnh báo để hiển thị. Network Center
            không tự tạo dữ liệu thay thế.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section ref={panelRef} className="nc-panel">
      <div className="nc-panel-heading"><div><p className="nc-eyebrow">Chính sách theo toà nhà</p><h3>Cài đặt</h3></div><ExecuteButton canExecute={controller.canExecute} rolloutState={site.rolloutState} disabledReason={controller.executeDisabledMessage} disabled={saving} onClick={() => void save()}><Save data-icon="inline-start" /> {saving ? "Đang lưu…" : "Lưu cài đặt"}</ExecuteButton></div>
      <div className="nc-settings-grid">
        <div className="nc-field"><Label htmlFor="polling-seconds">Chu kỳ kiểm tra (giây)</Label><Input id="polling-seconds" {...fieldProps("pollingSeconds")} type="number" min={30} max={3600} value={draft.pollingSeconds} onChange={(event) => setDraft((current) => (current ? { ...current, pollingSeconds: Number(event.target.value) } : current))} disabled={!executionAllowed || saving} />{fieldError("pollingSeconds")}</div>
        <div className="nc-field"><Label htmlFor="backup-hour">Giờ sao lưu</Label><Input id="backup-hour" {...fieldProps("backupHour")} type="time" value={draft.backupHour} onChange={(event) => setDraft((current) => (current ? { ...current, backupHour: event.target.value } : current))} disabled={!executionAllowed || saving} />{fieldError("backupHour")}</div>
        <div className="nc-field"><Label htmlFor="alert-sensitivity">Ngưỡng cảnh báo</Label><select id="alert-sensitivity" {...fieldProps("alertSensitivity")} value={draft.alertSensitivity} onChange={(event) => setDraft((current) => (current ? { ...current, alertSensitivity: event.target.value as NetworkSettings["alertSensitivity"] } : current))} disabled={!executionAllowed}><option value="standard">Tiêu chuẩn</option><option value="strict">Nghiêm ngặt</option></select>{fieldError("alertSensitivity")}</div>
        <SettingSwitch label="Gom cảnh báo Aruba liên quan" checked={draft.dependencyGrouping} disabled={!executionAllowed} onChange={(checked) => setDraft((current) => (current ? { ...current, dependencyGrouping: checked } : current))} />
        <SettingSwitch label="Tạm dừng thay đổi" icon={<Pause />} checked={draft.changesPaused} disabled={!executionAllowed} onChange={(checked) => setDraft((current) => (current ? { ...current, changesPaused: checked } : current))} />
      </div>
      {error ? <p className="nc-form-error" role="alert">{error}</p> : null}
      {executionAllowed ? <p className="nc-footnote">{controller.isDemo
        ? "Nút lưu chỉ cập nhật bộ nhớ mô phỏng cục bộ, không ghi cấu hình lên thiết bị thật."
        : "Cài đặt được lưu cho tòa nhà; hệ thống áp dụng chu kỳ theo dõi và lựa chọn tạm dừng thay đổi vừa lưu."}</p> : null}
      {!executionAllowed ? <p className="nc-footnote">{executionDisabledMessage}</p> : null}
    </section>
  );
}

function SettingSwitch({ label, icon, checked, disabled, onChange }: { label: string; icon?: React.ReactNode; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <div className="nc-setting-switch"><span>{icon}{label}</span><Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} /></div>;
}
