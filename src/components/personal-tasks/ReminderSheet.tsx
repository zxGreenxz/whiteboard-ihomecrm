import { Sheet } from './TaskSheets';
import { Switch } from '@/components/ui/switch';
import type { usePersonalTaskReminders } from '@/hooks/usePersonalTaskReminders';
import type { ReminderSettings } from '@/lib/personal-tasks/reminders';

type Controller = ReturnType<typeof usePersonalTaskReminders>;
function Choices<T extends number | string | null>({ label, value, options, disabled, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; disabled: boolean; onChange: (value: T) => void;
}) {
  return <fieldset className="ptask-reminder-group" disabled={disabled}><legend>{label}</legend>
    <div className="ptask-reminder-chips">{options.map(option => <button key={String(option.value)} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>
  </fieldset>;
}
const beforeOptions = [null, 5, 10, 15, 30, 60].map(value => ({ value, label: value === null ? 'Tắt' : value === 60 ? '1 giờ' : `${value} phút` }));
const afterOptions = [null, 0, 15, 30, 60].map(value => ({ value, label: value === null ? 'Tắt' : value === 0 ? 'Đúng giờ' : value === 60 ? 'Sau 1 giờ' : `Sau ${value} phút` }));
const morningOptions: { value: ReminderSettings['morning']; label: string }[] = [
  { value: null, label: 'Tắt' }, ...(['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00'] as const).map(value => ({ value, label: value })),
];
const tones: { value: ReminderSettings['tone']; label: string }[] = [{ value: 'tintin', label: 'Tin tin' }, { value: 'dingdong', label: 'Ding dong' }, { value: 'bell', label: 'Chuông' }];
export function ReminderSheet({ controller, onClose }: { controller: Controller; onClose: () => void }) {
  const { settings, access, error, busy, enable, save, preview, retry } = controller;
  const active = settings.enabled && access === 'granted';
  return <Sheet title="Nhắc hẹn" description="Áp dụng cho các việc đang xử lý có hẹn giờ." onClose={onClose}>
    <div className="ptask-notification-status" role="status">
      <p>{access === 'unsupported' ? 'Trình duyệt này chưa hỗ trợ thông báo. Trên iPhone, hãy thêm webapp vào Màn hình chính rồi mở lại.'
        : access === 'denied' ? 'Thông báo đang bị chặn. Vào cài đặt trình duyệt để cho phép thông báo của trang này.'
        : active ? 'Đã bật nhắc hẹn khi trang Việc của tôi đang mở.' : 'Chưa bật nhắc hẹn trên máy này.'}</p>
      {access !== 'unsupported' && access !== 'denied' && <button className={active ? 'ptask-secondary' : 'ptask-primary'} disabled={busy}
        onClick={() => { if (active) void save({ enabled: false }); else void enable(); }}>{busy ? 'Đang lưu…' : active ? 'Tắt thông báo' : 'Bật thông báo'}</button>}
    </div>
    <Choices label="Nhắc trước giờ hẹn" value={settings.before} options={beforeOptions} disabled={busy} onChange={before => { void save({ before }); }} />
    <Choices label="Nhắc khi tới hạn" value={settings.after} options={afterOptions} disabled={busy} onChange={after => { void save({ after }); }} />
    <Choices label="Điểm việc buổi sáng" value={settings.morning} options={morningOptions} disabled={busy} onChange={morning => { void save({ morning }); }} />
    <div className="ptask-sound-toggle"><label htmlFor="ptask-reminder-sound">Âm thanh</label><Switch id="ptask-reminder-sound" checked={settings.sound} disabled={busy} onCheckedChange={sound => { void save({ sound }); }} /></div>
    <div className="ptask-reminder-sound"><Choices label="Tiếng chuông" value={settings.tone} options={tones} disabled={busy || !settings.sound} onChange={tone => { void save({ tone }); }} />
      <button className="ptask-preview-sound" disabled={busy || !settings.sound} onClick={() => { void preview(); }}>Nghe thử</button></div>
    {error && <div className="ptask-reminder-error" role="alert"><p>{error}</p><button onClick={retry} disabled={busy}>Thử lại</button></div>}
    <p className="ptask-reminder-note">Giờ Việt Nam · Cài đặt tự lưu trên thiết bị này.<br />Giữ trang Việc của tôi mở để nhận nhắc. Khi đóng app, chuyển trang hoặc khóa máy, lời nhắc có thể không chạy. Bản lưu cục bộ chưa có nhắc nền.</p>
    <p className="ptask-reminder-note">Tiếng chuông đã chọn phát khi trang đang hiện trên màn hình, sau khi bấm Bật thông báo hoặc Nghe thử. Âm thanh thông báo hệ thống do điện thoại và trình duyệt quyết định.</p>
    <div className="ptask-sheet-footer"><button className="ptask-primary" disabled={busy} onClick={onClose}>Xong</button></div>
  </Sheet>;
}
