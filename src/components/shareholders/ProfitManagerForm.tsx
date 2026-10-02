import { validateInputDrafts } from "@/lib/inputDraftValidation";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { focusFirstError } from "@/lib/formErrors";
import { FinancialWorkflowError, workflowErrorMessage } from "@/lib/financialWorkflow";
import { validateProfitPerson, validateSalaryRules } from "@/lib/profitFeedback";
import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { CurrencyInput } from "@/components/ui/currency-input";
import { BuildingMultiSelect } from "@/components/buildings/BuildingMultiSelect";
import { Plus, Trash2 } from "lucide-react";
import { useAdminUsers } from "@/hooks/useAdminUsers";
import { useBuildings } from "@/hooks/useBuildings";
import {
  useProfitManagers,
  useManagerSalaries,
  useSaveManagerWithSalaries,
  type ProfitManager,
} from "@/hooks/useProfitManagers";
import type { SalaryForm, SalaryBasis } from "@/lib/managementSalary";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  manager: ProfitManager | null;
}

interface RuleRow {
  label: string;
  form: SalaryForm;
  basis: SalaryBasis;
  amount: number;
  percent: number;
  building_ids: string[];
}

const emptyRule = (): RuleRow => ({
  label: "",
  form: "FIXED",
  basis: "PER_BUILDING",
  amount: 0,
  percent: 0,
  building_ids: [],
});

export default function ProfitManagerForm({ open, onOpenChange, manager }: Props) {
  const isEdit = !!manager;
  const usersQuery = useAdminUsers();
  const { data: users = [] } = usersQuery;
  const buildingsQuery = useBuildings();
  const { data: buildings = [] } = buildingsQuery; // ẩn tòa ảo
  const managersQuery = useProfitManagers();
  const { data: managers = [] } = managersQuery;
  const allRulesQuery = useManagerSalaries();
  const { data: allRules = [] } = allRulesQuery;
  const saveMut = useSaveManagerWithSalaries();

  const dialogRef = useRef<HTMLDivElement>(null);
  const initialized = useRef<string | null>(null);
  const entityKey = manager?.id ?? 'new';
  const [blockedKey, setBlockedKey] = useState<string | null>(null);
  const saveBlocked = blockedKey === entityKey;
  const [errors, setErrors] = useState<Record<string,string>>({});
  const [serverError, setServerError] = useState('');
  const [savedSteps, setSavedSteps] = useState<readonly {id:string;label:string}[]>([]);
  const [authUserId, setAuthUserId] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [rules, setRules] = useState<RuleRow[]>([]);

  useEffect(() => {
    if (!open) { if (!saveBlocked) initialized.current = null; return; }
    if (saveBlocked || allRulesQuery.isLoading || allRulesQuery.isError || initialized.current === entityKey) return;
    initialized.current = entityKey;
    setErrors({}); setServerError(''); setSavedSteps([]);
    setAuthUserId(manager?.auth_user_id ?? "");
    setName(manager?.name ?? "");
    setNote(manager?.note ?? "");
    setIsActive(manager?.is_active ?? true);
    if (manager) {
      const mine = allRules
        .filter((r) => r.manager_id === manager.id)
        .map((r) => ({
          label: r.label ?? "",
          form: r.form,
          basis: r.basis,
          amount: r.amount,
          percent: r.percent,
          building_ids: r.building_ids,
        }));
      setRules(mine.length > 0 ? mine : [emptyRule()]);
    } else {
      setRules([emptyRule()]);
    }
  }, [open, manager, allRules, entityKey, saveBlocked, allRulesQuery.isLoading, allRulesQuery.isError]);

  // Loại user đã gán cho quản lý KHÁC (auth_user_id là UNIQUE).
  const linkedElsewhere = useMemo(() => {
    const set = new Set<string>();
    for (const m of managers) {
      if (m.auth_user_id && m.id !== manager?.id) set.add(m.auth_user_id);
    }
    return set;
  }, [managers, manager?.id]);

  const userOptions = useMemo(
    () =>
      users
        .filter((u) => !linkedElsewhere.has(u.id))
        .map((u) => ({
          value: u.id,
          label: u.full_name || u.email || u.id,
          keywords: [u.full_name ?? "", u.email ?? ""].filter(Boolean),
        })),
    [users, linkedElsewhere]
  );

  const buildingOptions = useMemo(
    () => (buildings as any[]).map((b) => ({ id: b.id, name: b.name, area_ids: b.area_ids ?? [] })),
    [buildings]
  );

  const handleUserChange = (uid: string) => {
    setAuthUserId(uid);
    if (!name.trim()) {
      const u = users.find((x) => x.id === uid);
      if (u) setName(u.full_name || u.email || "");
    }
  };

  const addRule = () => setRules((p) => [...p, emptyRule()]);
  const removeRule = (i: number) => setRules((p) => p.filter((_, idx) => idx !== i));
  const setRule = (i: number, patch: Partial<RuleRow>) =>
    setRules((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const handleSave = async () => {
    if (saveMut.isPending || saveBlocked) return;
    const nextErrors = {...validateProfitPerson(name,authUserId),...validateSalaryRules(rules)};
    setErrors(nextErrors); setServerError('');
    if (Object.keys(nextErrors).length) { await focusFirstError(nextErrors,{root:dialogRef.current}); return; }
    if (!validateInputDrafts(dialogRef.current)) return;
    try {
      await saveMut.mutateAsync({id:manager?.id,values:{name:name.trim(),note:note.trim()||null,is_active:isActive,auth_user_id:authUserId},rules:rules.map(r=>({...r,label:r.label.trim()||null}))});
      onOpenChange(false);
    } catch(error) {
      setServerError(workflowErrorMessage(error,'lưu quản lý và lương điều hành'));
      if(error instanceof FinancialWorkflowError) {setBlockedKey(entityKey);setSavedSteps(error.completed);}
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={dialogRef} className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa quản lý điều hành" : "Thêm quản lý điều hành"}</DialogTitle>
        </DialogHeader>

        <QueryRegion label="cấu hình lương điều hành" queries={[usersQuery, buildingsQuery, managersQuery, allRulesQuery]} skeleton="detail" rows={6}>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Tài khoản (user) <span className="text-red-500">*</span></Label>
            <SearchableSelect
              name="authUserId" aria-invalid={!!errors.authUserId} aria-describedby="profit-auth-error"
              value={authUserId}
              onValueChange={handleUserChange}
              placeholder="Chọn user để gắn quản lý"
              options={userOptions}
            />
            {errors.authUserId && <p id="profit-auth-error" className="text-sm text-destructive">{errors.authUserId}</p>}
            <p className="text-xs text-muted-foreground">
              Quản lý đăng nhập bằng tài khoản này để tự xem lương điều hành của mình. Có thể đồng thời là cổ đông.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Tên hiển thị <span className="text-red-500">*</span></Label>
            <Input name="name" aria-invalid={!!errors.name} aria-describedby="profit-name-error" value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: A.Phong..." />
            {errors.name && <p id="profit-name-error" className="text-sm text-destructive">{errors.name}</p>}
          </div>

          <div className="space-y-2">
            <Label>Ghi chú</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label className="text-sm">Đang hoạt động</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Quy tắc lương điều hành</Label>
              <Button type="button" variant="outline" size="sm" onClick={addRule}>
                <Plus className="h-4 w-4 mr-1" /> Thêm quy tắc
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Lương điều hành được trừ khỏi LN từng nhà <strong>trước</strong> khi chia cho cổ đông.
            </p>

            {rules.map((r, i) => (
              <div key={i} className="rounded-lg border p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <Input
                    value={r.label}
                    onChange={(e) => setRule(i, { label: e.target.value })}
                    placeholder={`Tên quy tắc (tuỳ chọn) — VD: Lương cụm A`}
                    className="h-8"
                  />
                  {rules.length > 0 && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeRule(i)}>
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Hình thức</Label>
                    <Select value={r.form} onValueChange={(v) => setRule(i, { form: v as SalaryForm })}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="FIXED">Tiền thực (VNĐ)</SelectItem>
                        <SelectItem value="PERCENT">Phần trăm (% LN)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Cơ sở tính</Label>
                    <Select value={r.basis} onValueChange={(v) => setRule(i, { basis: v as SalaryBasis })}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="PER_BUILDING">Theo từng nhà</SelectItem>
                        <SelectItem value="TOTAL_GROUP">Tổng cho nhóm nhà</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    {r.form === "FIXED"
                      ? r.basis === "PER_BUILDING"
                        ? "Số tiền mỗi nhà"
                        : "Tổng số tiền cho cả nhóm"
                      : "Phần trăm trên LN ròng"}
                  </Label>
                  {r.form === "FIXED" ? (
                    <CurrencyInput name={`rules.${i}.amount`} aria-invalid={!!errors[`rules.${i}.amount`]} value={r.amount} onChange={(v) => setRule(i, { amount: v })} suffix={false} />
                  ) : (
                    <div className="relative w-32">
                      <Input
                        name={`rules.${i}.percent`} aria-invalid={!!errors[`rules.${i}.percent`]}
                        type="number"
                        min={0}
                        max={100}
                        value={r.percent || ""}
                        onChange={(e) =>
                          setRule(i, { percent: Number(e.target.value) })
                        }
                        className="pr-6 text-right"
                        placeholder="0"
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Áp dụng cho nhà</Label>
                  <div data-field-name={`rules.${i}.building_ids`} className={errors[`rules.${i}.building_ids`] ? "rounded border border-destructive [&_button]:border-destructive" : ""}>
                  <BuildingMultiSelect
                    value={r.building_ids}
                    onChange={(ids) => setRule(i, { building_ids: ids })}
                    buildings={buildingOptions}
                    placeholder="Chọn nhà áp dụng"
                  />
                  </div>
                  {['building_ids','amount','percent'].map(field=>errors[`rules.${i}.${field}`]&&<p key={field} className="text-sm text-destructive">{errors[`rules.${i}.${field}`]}</p>)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {serverError && <div role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{serverError}{savedSteps.map((step,i)=><p key={`${step.id}-${i}`}>{step.label}: <code>{step.id}</code></p>)}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button onClick={handleSave} disabled={saveMut.isPending || saveBlocked}>
            {saveMut.isPending ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
        </QueryRegion>
      </DialogContent>
    </Dialog>
  );
}
