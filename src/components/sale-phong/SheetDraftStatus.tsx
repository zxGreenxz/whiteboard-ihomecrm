import type { useRoomListSheetDraft } from './useRoomListSheetDraft';

export default function SheetDraftStatus({ sheet }: { sheet: ReturnType<typeof useRoomListSheetDraft> }) {
  return <div className="space-y-2 text-sm">
    {sheet.storageWarning && <p role="alert" className="text-amber-700">Trình duyệt chưa giữ được bản nháp. Giữ màn hình mở tới khi đã xác nhận lưu.</p>}
    {sheet.inventoryBlocked && <p role="alert" className="text-amber-700">Chưa xác nhận được dữ liệu phòng hiện tại. Tạm khóa lưu; bản nháp vẫn được giữ.</p>}
    {sheet.cellErrors.batch && <p role="alert" className="text-destructive">{sheet.cellErrors.batch}</p>}
    {sheet.errors.account && <p role="alert" className="text-destructive">{sheet.errors.account}</p>}
    {sheet.issues.map(issue => <div key={issue.id} role="alert" className="rounded border border-amber-400 p-3">
      <p><b>Phòng {issue.label}:</b> {issue.message}</p>
      {issue.unknown ? <p className="mt-1">Bấm Lưu để đối chiếu lại yêu cầu này; không tạo lần ghi mới.</p>
        : <button type="button" className="mt-2 underline" disabled={sheet.busy} onClick={() => sheet.discardRoom(issue.id)}>Bỏ nháp phòng {issue.label} và dùng bản mới</button>}
    </div>)}
    {sheet.accountDraft && <button type="button" className="underline" disabled={sheet.busy} onClick={sheet.discardAccount}>Bỏ bản nháp cài đặt chung</button>}
    {sheet.dirty && <p className="text-muted-foreground">Có bản nháp chưa lưu. Chuyển chế độ vẫn giữ nội dung trong phiên này. Mỗi lần lưu tối đa 50 phòng.</p>}
  </div>;
}
