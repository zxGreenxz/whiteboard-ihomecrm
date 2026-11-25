import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { LoadingState } from "@/components/loading/LoadingState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCameraAlertZaloGroups, type CameraAlertScope } from "@/hooks/network-center/useCameraAlerts";
import { cameraAlertFailure, formatVnDateTime } from "@/lib/network-center/cameraAlertForm";
import type { CameraAlertRepository, CameraAlertZaloGroups } from "@/lib/network-center/cameraContracts";

export type CameraAlertZaloGroup = CameraAlertZaloGroups["items"][number];

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

/** Chọn nick Zalo cá nhân đang kết nối, rồi chọn một nhóm của nick đó (tìm theo tên). */
export function CameraAlertZaloPicker({ open, onOpenChange, scope, repository, currentAccountId, currentConversationId, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: CameraAlertScope;
  repository?: CameraAlertRepository;
  currentAccountId: string | null;
  currentConversationId: string | null;
  onPick: (group: CameraAlertZaloGroup) => void;
}) {
  const [search, setSearch] = useState("");
  const term = useDebounced(search, 300);
  // Danh sách không lọc cho ô chọn nick; danh sách theo từ khoá cho ô chọn nhóm.
  const allGroups = useCameraAlertZaloGroups(scope, "", open, repository);
  const matches = useCameraAlertZaloGroups(scope, term, open, repository);
  const accounts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const group of allGroups.data?.items ?? []) if (!seen.has(group.accountId)) seen.set(group.accountId, group.accountName);
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [allGroups.data]);
  const [accountId, setAccountId] = useState<string | null>(currentAccountId);
  const [picked, setPicked] = useState<string | null>(currentConversationId);
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setAccountId(currentAccountId);
    setPicked(currentConversationId);
  }, [open, currentAccountId, currentConversationId]);
  useEffect(() => {
    // Nick đang lưu đã mất kết nối (không còn trong danh sách) ⇒ gợi ý nick đầu tiên đang kết nối.
    if (accounts.length > 0 && !accounts.some((account) => account.id === accountId)) setAccountId(accounts[0]?.id ?? null);
  }, [accounts, accountId]);

  const groups = (matches.data?.items ?? []).filter((group) => group.accountId === accountId);
  const pickedGroup = groups.find((group) => group.id === picked)
    ?? (allGroups.data?.items ?? []).find((group) => group.id === picked && group.accountId === accountId);
  const failure = allGroups.isError ? cameraAlertFailure(allGroups.error, "tải danh sách nhóm Zalo")
    : matches.isError ? cameraAlertFailure(matches.error, "tìm nhóm Zalo") : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="network-center network-center-dialog nc-dialog nc-dialog-wide nc-dialog-fit">
        <DialogHeader>
          <DialogTitle>Chọn nhóm Zalo nhận cảnh báo</DialogTitle>
          <DialogDescription>Chỉ hiện nhóm của nick Zalo cá nhân đang kết nối trong công ty. Không đọc nội dung tin của nhóm.</DialogDescription>
        </DialogHeader>
        {allGroups.isPending ? <LoadingState label="danh sách nhóm Zalo" variant="list" rows={3} /> : null}
        {failure ? (
          <div className="nc-form-error" role="alert">
            <p>{failure.text}</p>
            <Button type="button" variant="outline" className="mt-2" onClick={() => { void allGroups.refetch(); void matches.refetch(); }}>Thử lại</Button>
          </div>
        ) : null}
        {allGroups.isSuccess && accounts.length === 0 ? (
          <p className="nc-empty-copy">Chưa có nick Zalo cá nhân nào đang kết nối. Vào Chat Zalo để kết nối nick trước, rồi quay lại đây.</p>
        ) : null}
        {accounts.length > 0 ? (
          <div className="nc-form">
            <div className="nc-field">
              <Label htmlFor="camera-alert-zalo-account">Nick Zalo gửi tin</Label>
              <Select value={accountId ?? undefined} onValueChange={(value) => { setAccountId(value); setPicked(null); }}>
                <SelectTrigger id="camera-alert-zalo-account" aria-label="Nick Zalo gửi tin"><SelectValue placeholder="Chọn nick" /></SelectTrigger>
                <SelectContent className="network-center nc-select-content">
                  {accounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="nc-field">
              <Label htmlFor="camera-alert-zalo-search">Tìm nhóm theo tên</Label>
              <div className="nc-search-field">
                <Search aria-hidden="true" />
                <Input id="camera-alert-zalo-search" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} placeholder="Ví dụ: Web nội bộ" />
              </div>
            </div>
            {matches.isFetching && !matches.isPending ? <p className="sr-only" role="status">Đang tìm nhóm</p> : null}
            {matches.isSuccess && groups.length === 0 ? (
              <p className="nc-empty-copy">{term ? `Không có nhóm nào tên chứa “${term}” của nick này.` : "Nick này chưa có nhóm Zalo nào."}</p>
            ) : null}
            {groups.length > 0 ? (
              <RadioGroupPrimitive.Root value={picked ?? ""} onValueChange={setPicked} aria-label="Nhóm Zalo" className="nc-group-list">
                {groups.map((group) => (
                  <RadioGroupPrimitive.Item key={group.id} value={group.id} className="nc-group-option">
                    <span className="flex items-center gap-2"><Users className="h-4 w-4" aria-hidden="true" /><strong className="break-words">{group.name}</strong></span>
                    <small>{group.lastMessageAt ? `Tin cuối ${formatVnDateTime(group.lastMessageAt)}` : "Chưa có tin"}</small>
                  </RadioGroupPrimitive.Item>
                ))}
              </RadioGroupPrimitive.Root>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button type="button" disabled={!pickedGroup} onClick={() => { if (pickedGroup) { onPick(pickedGroup); onOpenChange(false); } }}>Dùng nhóm này</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
