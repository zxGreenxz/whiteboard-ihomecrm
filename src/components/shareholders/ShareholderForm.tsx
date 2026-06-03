import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { KeyRound, CheckCircle2 } from "lucide-react";
import {
  useCreateShareholder,
  useUpdateShareholder,
  useCreateShareholderLogin,
  type Shareholder,
} from "@/hooks/useShareholders";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  shareholder: Shareholder | null;
}

export default function ShareholderForm({ open, onOpenChange, shareholder }: Props) {
  const isEdit = !!shareholder;
  const createMut = useCreateShareholder();
  const updateMut = useUpdateShareholder();
  const loginMut = useCreateShareholderLogin();

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (open) {
      setName(shareholder?.name ?? "");
      setNote(shareholder?.note ?? "");
      setIsActive(shareholder?.is_active ?? true);
      setEmail("");
      setPassword("");
    }
  }, [open, shareholder]);

  const canSave = name.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    const values = { name: name.trim(), note: note.trim() || null, is_active: isActive };
    if (isEdit && shareholder) {
      await updateMut.mutateAsync({ id: shareholder.id, values });
    } else {
      await createMut.mutateAsync(values);
    }
    onOpenChange(false);
  };

  const handleCreateLogin = async () => {
    if (!shareholder) return;
    if (!email.trim() || password.length < 6) return;
    await loginMut.mutateAsync({
      shareholder_id: shareholder.id,
      email: email.trim(),
      password,
      full_name: name.trim(),
    });
    setEmail("");
    setPassword("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa cổ đông" : "Thêm cổ đông"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Tên cổ đông <span className="text-red-500">*</span></Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Hiệp, Hiển..." />
          </div>
          <div className="space-y-2">
            <Label>Ghi chú</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label className="text-sm">Đang hoạt động</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          {isEdit && (
            <div className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <KeyRound className="h-4 w-4" /> Tài khoản đăng nhập
              </div>
              {shareholder?.auth_user_id ? (
                <p className="text-sm text-emerald-600 flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4" /> Đã có tài khoản đăng nhập
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Tạo tài khoản để cổ đông tự đăng nhập xem phần lợi nhuận của mình.
                  </p>
                  <Input
                    type="email"
                    placeholder="Email đăng nhập"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <Input
                    type="password"
                    placeholder="Mật khẩu (≥ 6 ký tự)"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!email.trim() || password.length < 6 || loginMut.isPending}
                    onClick={handleCreateLogin}
                  >
                    {loginMut.isPending ? "Đang tạo..." : "Tạo tài khoản đăng nhập"}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button onClick={handleSave} disabled={!canSave || createMut.isPending || updateMut.isPending}>
            {createMut.isPending || updateMut.isPending ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
