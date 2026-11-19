// Màn 8 — Cài đặt điểm danh tự động của chủ: tần suất, các khung giờ, ai áp dụng.
import { useEffect } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { Card, CardTitle, PersonAvatar, StaffHeader, StaffShell, StatusPill } from "@/components/staff-day/StaffShell";
import { useGpsSettings, useSaveGpsSettings, useSetGpsMember } from "@/hooks/gps-checkin/useGpsCheckin";
import { actionErrorMessage } from "@/lib/actionFeedback";
import { cn } from "@/lib/utils";
import {
  gpsSettingsFormSchema, relativeMinutes, slotsPerDay, type GpsSettingsDoc, type GpsSettingsForm,
} from "@/lib/gpsCheckin";

const INTERVALS = [15, 30, 60] as const;
const TOLERANCES = [5, 10, 15] as const;

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex-1 text-[13px]">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function memberStatus(member: GpsSettingsDoc["members"][number]): { text: string; ok: boolean } {
  if (!member.device) return { text: "chưa cài app — chưa có dấu nào", ok: false };
  const parts = ["đã cài app"];
  if (member.last_ping_at) parts.push(`dấu gần nhất ${relativeMinutes(member.last_ping_at)}`);
  if (member.device.state.batteryPct != null) parts.push(`pin ${member.device.state.batteryPct}%`);
  return { text: parts.join(" · "), ok: true };
}

function MemberRow({ member }: { member: GpsSettingsDoc["members"][number] }) {
  const setMember = useSetGpsMember();
  const status = memberStatus(member);
  const toggle = async (applies: boolean) => {
    try {
      await setMember.mutateAsync({ userId: member.user.id, applies });
    } catch (error) {
      toast.error(actionErrorMessage(error, `Chưa đổi được cài đặt của ${member.user.name}`));
    }
  };
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] border px-2.5 py-2">
      <PersonAvatar name={member.user.name} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold">{member.user.name}{member.device?.state.model ? ` · ${member.device.state.model}` : ""}</div>
        <div className={cn("text-[11px]", status.ok ? "text-emerald-800" : "text-amber-800")}>{status.text}</div>
      </div>
      <Switch checked={member.applies} disabled={setMember.isPending} onCheckedChange={(value) => { void toggle(value); }} aria-label={`Áp dụng cho ${member.user.name}`} />
    </div>
  );
}

function SettingsForm({ doc }: { doc: GpsSettingsDoc }) {
  const save = useSaveGpsSettings();
  const toForm = (d: GpsSettingsDoc): GpsSettingsForm => ({
    enabled: d.settings.enabled,
    interval_min: d.settings.interval_min as GpsSettingsForm["interval_min"],
    late_tolerance_min: d.settings.late_tolerance_min as GpsSettingsForm["late_tolerance_min"],
    windows: d.settings.windows.map((window) => ({ from: window.from, to: window.to })),
    skip_sunday: d.settings.skip_sunday,
    skip_holidays: d.settings.skip_holidays,
    skip_approved_leave: d.settings.skip_approved_leave,
  });
  const form = useForm<GpsSettingsForm>({ resolver: zodResolver(gpsSettingsFormSchema), defaultValues: toForm(doc), mode: "onChange" });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "windows" });

  useEffect(() => { form.reset(toForm(doc)); }, [doc.settings.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const values = form.watch();
  const count = slotsPerDay(values.windows ?? [], values.interval_min);
  const errors = form.formState.errors;
  const rootError = errors.windows?.root?.message ?? errors.windows?.message;

  const submit = form.handleSubmit(async (value) => {
    try {
      await save.mutateAsync(value);
      toast.success("Đã lưu cài đặt, áp dụng từ mốc kế tiếp");
    } catch (error) {
      toast.error(actionErrorMessage(error, "Chưa lưu được cài đặt"));
    }
  });

  return (
    <form onSubmit={(event) => { void submit(event); }} className="space-y-3" noValidate>
      <Card label="Bật tính năng" className="flex-row items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-bold">Bật điểm danh tự động bằng GPS</div>
          <div className="text-xs text-muted-foreground">Nhân viên chỉ cần cài app một lần; sau đó máy tự ghi</div>
        </div>
        <Controller control={form.control} name="enabled" render={({ field }) => (
          <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Bật điểm danh tự động bằng GPS" />
        )} />
      </Card>

      <Card label="Tần suất">
        <CardTitle>Tự ghi mỗi</CardTitle>
        <Controller control={form.control} name="interval_min" render={({ field }) => (
          <div className="flex rounded-lg bg-slate-100 p-[3px]" role="radiogroup" aria-label="Tần suất tự ghi">
            {INTERVALS.map((minutes) => (
              <button key={minutes} type="button" role="radio" aria-checked={field.value === minutes} onClick={() => field.onChange(minutes)}
                className={cn("h-9 flex-1 rounded-md text-sm font-medium", field.value === minutes ? "bg-white text-primary shadow-sm" : "text-muted-foreground")}>
                {minutes} phút
              </button>
            ))}
          </div>
        )} />
        <div className="flex items-center gap-2.5">
          <label htmlFor="han-tre" className="flex-1 text-[13px]">Tính là mất tín hiệu khi trễ quá</label>
          <Controller control={form.control} name="late_tolerance_min" render={({ field }) => (
            <select id="han-tre" className="h-9 w-[130px] rounded-md border bg-white px-2 text-sm" value={field.value} onChange={(e) => field.onChange(Number(e.target.value))}>
              {TOLERANCES.map((minutes) => <option key={minutes} value={minutes}>{minutes} phút</option>)}
            </select>
          )} />
        </div>
        <p className="text-xs text-muted-foreground">Với các khung giờ bên dưới, mỗi {values.interval_min} phút là {count} mốc/ngày. 15 phút dày gấp đôi và tốn pin hơn.</p>
      </Card>

      <Card label="Khung giờ điểm danh tự động">
        <CardTitle right={<StatusPill tone="neutral">{fields.length} khung</StatusPill>}>Khung giờ điểm danh tự động</CardTitle>
        {fields.map((field, index) => {
          const fromError = errors.windows?.[index]?.from?.message;
          const toError = errors.windows?.[index]?.to?.message;
          return (
            <div key={field.id} className="space-y-1">
              {/* Nhãn nằm riêng một dòng: ô giờ cần đủ rộng để không cắt mất SA/CH ở máy đặt định dạng 12 giờ. */}
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Khung {index + 1}</span>
                <button type="button" aria-label={`Xoá khung ${index + 1}`} disabled={fields.length === 1} onClick={() => remove(index)} className="flex h-9 w-9 items-center justify-center rounded-lg text-red-700 disabled:opacity-40">
                  <Trash2 className="h-[18px] w-[18px]" aria-hidden="true" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input type="time" step={300} aria-label={`Khung ${index + 1} bắt đầu`} aria-invalid={!!fromError} className="h-11 min-w-0 flex-1 rounded-md border bg-white px-2 text-base aria-[invalid=true]:border-destructive" {...form.register(`windows.${index}.from`)} />
                <span aria-hidden="true" className="text-muted-foreground">–</span>
                <input type="time" step={300} aria-label={`Khung ${index + 1} kết thúc`} aria-invalid={!!toError} className="h-11 min-w-0 flex-1 rounded-md border bg-white px-2 text-base aria-[invalid=true]:border-destructive" {...form.register(`windows.${index}.to`)} />
              </div>
              {fromError || toError ? <p role="alert" className="text-xs text-destructive">{fromError ?? toError}</p> : null}
            </div>
          );
        })}
        {rootError ? <p role="alert" className="text-xs text-destructive">{rootError}</p> : null}
        <button type="button" disabled={fields.length >= 6} onClick={() => append({ from: "18:00", to: "20:00" })} className="flex h-11 items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-primary bg-emerald-50 text-[13px] font-semibold text-emerald-800 disabled:opacity-50">
          <Plus className="h-4 w-4" aria-hidden="true" /> Thêm khung giờ
        </button>
        <p className="rounded-[10px] bg-slate-100 px-2.5 py-2 text-xs text-slate-700">
          <b>Ngoài các khung này</b> máy không tự ghi GPS. Lúc đó điểm danh tính theo việc đã xong hoặc lượt check nhà — hai thứ này đã có sẵn giờ và GPS.
        </p>
        <Controller control={form.control} name="skip_sunday" render={({ field }) => <SwitchRow label="Không ghi Chủ nhật" checked={field.value} onChange={field.onChange} />} />
        <Controller control={form.control} name="skip_approved_leave" render={({ field }) => <SwitchRow label="Không ghi ngày phép đã duyệt" checked={field.value} onChange={field.onChange} />} />
        <Controller control={form.control} name="skip_holidays" render={({ field }) => <SwitchRow label="Không ghi ngày lễ" checked={field.value} onChange={field.onChange} />} />
      </Card>

      <Card label="Áp dụng cho và tình trạng máy">
        <CardTitle>Áp dụng cho · tình trạng máy</CardTitle>
        {doc.members.map((member) => <MemberRow key={member.user.id} member={member} />)}
        <p className="text-xs text-muted-foreground">Quản lý mới vào chấm v5 sẽ tự được thêm; cài app xong là có dấu.</p>
      </Card>

      <section aria-label="Lưu ý" className="flex gap-2.5 rounded-2xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-amber-900">
        <Smartphone className="mt-0.5 h-[18px] w-[18px] shrink-0" aria-hidden="true" />
        <p className="text-xs leading-relaxed">Cần app cài trên máy nhân viên và quyền vị trí «Luôn luôn». Tắt máy, tắt định vị, hết pin hoặc gỡ app thì mốc đó ghi «mất tín hiệu» kèm lý do máy báo về. Máy nằm yên lâu có thể ghi trễ vài phút.</p>
      </section>

      <div className="flex gap-2">
        <Button type="button" variant="outline" className="h-11 flex-1" disabled={!form.formState.isDirty} onClick={() => form.reset(toForm(doc))}>Huỷ</Button>
        <Button type="submit" className="h-11 flex-[2]" disabled={save.isPending || !form.formState.isDirty}>Lưu cài đặt</Button>
      </div>
    </form>
  );
}

export default function GpsCheckinSettingsPage() {
  const query = useGpsSettings();
  return (
    <StaffShell>
      <StaffHeader backTo="/my-day/team" backLabel="Quay lại" title="Điểm danh tự động" sub="cài đặt của chủ" />
      <QueryRegion label="cài đặt điểm danh" skeleton="detail" rows={6} queries={[query]}>
        {query.data ? <SettingsForm doc={query.data} /> : null}
      </QueryRegion>
    </StaffShell>
  );
}
