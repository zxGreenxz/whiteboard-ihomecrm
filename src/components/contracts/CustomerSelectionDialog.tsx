import { useState, useMemo, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Loader2, Plus } from "lucide-react";
import { useCustomers } from "@/hooks/useCustomers";
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";

export interface CustomerBasic {
  id: string;
  full_name: string;
  phone: string;
  id_number: string | null;
}

interface CustomerSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCustomerIds: string[];
  onSelect: (customers: CustomerBasic[]) => void;
}

export function CustomerSelectionDialog({
  open,
  onOpenChange,
  selectedCustomerIds,
  onSelect,
}: CustomerSelectionDialogProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const knownIdsRef = useRef<Set<string>>(new Set());

  const { data: customerData, isLoading } = useCustomers(undefined, undefined);
  const customers = customerData?.data ?? [];

  // Seed checked state + known ids each time the dialog opens. The parent
  // controls `open` directly (no DialogTrigger), and Radix does NOT fire
  // onOpenChange for externally-controlled opens — so seeding inside the
  // onOpenChange handler never runs. Without this, the contract's already
  // selected customers show up UNCHECKED, and confirming (especially right
  // after "Tạo mới") drops them. Depend only on `open` so the user's in-dialog
  // toggles aren't reset on every parent re-render.
  useEffect(() => {
    if (!open) return;
    setCheckedIds(new Set(selectedCustomerIds));
    setSearchTerm("");
    knownIdsRef.current = new Set(customers.map((c) => c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-check newly created customers (any id we've never seen before).
  useEffect(() => {
    if (!open) return;
    const known = knownIdsRef.current;
    const newcomers = customers.filter((c) => !known.has(c.id));
    if (newcomers.length === 0) return;
    if (known.size > 0) {
      // Not the initial population — these are genuinely new rows.
      setCheckedIds((prev) => {
        const next = new Set(prev);
        for (const c of newcomers) next.add(c.id);
        return next;
      });
    }
    for (const c of customers) known.add(c.id);
  }, [customers, open]);

  // Filter customers by search term (name, phone, id_number)
  const filtered = useMemo(() => {
    if (!searchTerm.trim()) return customers;
    const term = searchTerm.trim().toLowerCase();
    return customers.filter(
      (c) =>
        c.full_name?.toLowerCase().includes(term) ||
        c.phone?.toLowerCase().includes(term) ||
        c.id_number?.toLowerCase().includes(term)
    );
  }, [customers, searchTerm]);

  const toggleCustomer = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const selected: CustomerBasic[] = customers
      .filter((c) => checkedIds.has(c.id))
      .map((c) => ({
        id: c.id,
        full_name: c.full_name,
        phone: c.phone,
        id_number: c.id_number ?? null,
      }));
    onSelect(selected);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Chọn khách hàng</DialogTitle>
        </DialogHeader>

        {/* Search + create */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Tìm theo tên, SĐT, CCCD..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreateOpen(true)}
            className="shrink-0"
          >
            <Plus className="h-4 w-4 mr-1" />
            Tạo mới
          </Button>
        </div>

        {/* Customer list */}
        <ScrollArea className="h-[360px] border rounded-md">
          {isLoading ? (
            <div className="flex items-center justify-center h-full py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-full py-10 text-sm text-muted-foreground">
              Không tìm thấy khách hàng
            </div>
          ) : (
            <div className="divide-y">
              {filtered.map((customer) => {
                const isChecked = checkedIds.has(customer.id);
                return (
                  <label
                    key={customer.id}
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => toggleCustomer(customer.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {customer.full_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {customer.phone}
                        {customer.id_number && ` · ${customer.id_number}`}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button onClick={handleConfirm}>
            Xác nhận{checkedIds.size > 0 && ` (${checkedIds.size})`}
          </Button>
        </DialogFooter>

        <CreateCustomerDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      </DialogContent>
    </Dialog>
  );
}
