import { Pause, Save } from "lucide-react";
import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { NetworkBuilding, NetworkSettings } from "@/lib/network-center/contracts";
import { validateNetworkSettings } from "@/lib/network-center/model";
import { ExecuteButton } from "../ExecuteGuard";

export function SettingsTab({ site, controller }: { site: NetworkBuilding; controller: NetworkCenterController }) {
  const [draft, setDraft] = useState<NetworkSettings>(site.settings);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(site.settings);
    setError("");
  }, [
    site.buildingId,
    site.settings.alertSensitivity,
    site.settings.backupHour,
    site.settings.changesPaused,
    site.settings.dependencyGrouping,
    site.settings.pollingSeconds,
  ]);
  const save = () => {
    setError("");
    try {
      const validated = validateNetworkSettings(draft);
      controller.updateSettings(site.buildingId, validated);
      setDraft(validated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cài đặt không hợp lệ");
    }
  };
  return (
    <section className="nc-panel">
      <div className="nc-panel-heading"><div><p className="nc-eyebrow">Chính sách theo toà nhà</p><h3>Cài đặt</h3></div><ExecuteButton canExecute={controller.canExecute} disabledReason={controller.executeDisabledMessage} onClick={save}><Save data-icon="inline-start" /> Lưu cài đặt</ExecuteButton></div>
      <div className="nc-settings-grid">
        <div className="nc-field"><Label htmlFor="polling-seconds">Chu kỳ kiểm tra (giây)</Label><Input id="polling-seconds" type="number" min={30} max={300} value={draft.pollingSeconds} onChange={(event) => setDraft((current) => ({ ...current, pollingSeconds: Number(event.target.value) }))} disabled={!controller.canExecute} /></div>
        <div className="nc-field"><Label htmlFor="backup-hour">Giờ backup</Label><Input id="backup-hour" type="time" value={draft.backupHour} onChange={(event) => setDraft((current) => ({ ...current, backupHour: event.target.value }))} disabled={!controller.canExecute} /></div>
        <div className="nc-field"><Label htmlFor="alert-sensitivity">Ngưỡng cảnh báo</Label><select id="alert-sensitivity" value={draft.alertSensitivity} onChange={(event) => setDraft((current) => ({ ...current, alertSensitivity: event.target.value as NetworkSettings["alertSensitivity"] }))} disabled={!controller.canExecute}><option value="standard">Tiêu chuẩn</option><option value="strict">Nghiêm ngặt</option></select></div>
        <SettingSwitch label="Gom cảnh báo Aruba liên quan" checked={draft.dependencyGrouping} disabled={!controller.canExecute} onChange={(checked) => setDraft((current) => ({ ...current, dependencyGrouping: checked }))} />
        <SettingSwitch label="Tạm dừng thay đổi" icon={<Pause />} checked={draft.changesPaused} disabled={!controller.canExecute} onChange={(checked) => setDraft((current) => ({ ...current, changesPaused: checked }))} />
      </div>
      {error ? <p className="nc-form-error" role="alert">{error}</p> : null}
      {controller.canExecute ? <p className="nc-footnote">Nút lưu chỉ cập nhật bộ nhớ mô phỏng cục bộ, không ghi cấu hình lên thiết bị thật.</p> : null}
      {!controller.canExecute ? <p className="nc-footnote">{controller.executeDisabledMessage}</p> : null}
    </section>
  );
}

function SettingSwitch({ label, icon, checked, disabled, onChange }: { label: string; icon?: React.ReactNode; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <div className="nc-setting-switch"><span>{icon}{label}</span><Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} /></div>;
}
