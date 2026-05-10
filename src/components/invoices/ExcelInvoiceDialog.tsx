import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, addMonths, endOfMonth, startOfMonth, parse } from 'date-fns';
import { Table as TableIcon, Download, Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useBuildings } from '@/hooks/useBuildings';
import { useBuildingServices } from '@/hooks/useBuildingServices';
import { useCreateInvoice } from '@/hooks/useInvoices';
import { supabase } from '@/integrations/supabase/client';
import type { InvoiceFormData } from '@/types/invoice';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface RowData {
  contract_id: string;
  room_id: string;
  room_name: string;
  rent_price: number;
  occupants: number;
  meter_id: string | null;
  prev_reading: number;
  current_reading: number | '';
  electric_amount: number; // overrideable
  electric_overridden: boolean;
  water_amount: number; // overrideable
  water_overridden: boolean;
  pdv_amount: number; // overrideable
  discount: number;
  selected: boolean;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));

export default function ExcelInvoiceDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const { data: buildings } = useBuildings();
  const createInvoice = useCreateInvoice();

  const [buildingId, setBuildingId] = useState('');
  const [billingMonth, setBillingMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [issueDate, setIssueDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [dueDate, setDueDate] = useState(format(addMonths(new Date(), 1), 'yyyy-MM-dd'));
  const [rows, setRows] = useState<RowData[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { data: bldSvc } = useBuildingServices(buildingId);

  // Resolve default prices from building_services (fall back to service.unit_price).
  // Chỉ xét dịch vụ đang BẬT cho toà — nếu không có thì giữ fallback hard-code.
  // Tránh bug: nhiều dịch vụ điện cùng tên kiểu "Điện 3k5"/"Điện MB405" sẽ
  // ghi đè lẫn nhau và lấy phải cái đã tắt.
  const defaults = useMemo(() => {
    let elec = 3500;
    let water = 100000;
    let pdv = 150000;
    let elecServiceId: string | null = null;
    let waterServiceId: string | null = null;
    let pdvServiceId: string | null = null;
    for (const bs of (bldSvc ?? []).filter((b: any) => b.is_active)) {
      const name = bs.service?.name?.toLowerCase() ?? '';
      const price = bs.unit_price_override ?? bs.service?.unit_price ?? 0;
      if (name.includes('điện')) {
        elec = Number(price) || elec;
        elecServiceId = bs.service_id;
      } else if (name.includes('nước')) {
        water = Number(price) || water;
        waterServiceId = bs.service_id;
      } else if (name.includes('dịch vụ') || name.includes('phí')) {
        pdv = Number(price) || pdv;
        pdvServiceId = bs.service_id;
      }
    }
    return { elec, water, pdv, elecServiceId, waterServiceId, pdvServiceId };
  }, [bldSvc]);

  // Load rooms + active contracts + meters + last reading for the building.
  const handleLoad = async () => {
    if (!buildingId) return;
    setLoaded(false);
    try {
      // 1) Active contracts in this building (via room → building).
      const { data: contracts, error: e1 } = await (supabase as any)
        .from('contracts')
        .select(
          `id, rent_price, room_id, status,
           room:rooms!contracts_room_id_fkey (id, name, building_id),
           contract_customers!contract_customers_contract_id_fkey (id)`
        )
        .eq('status', 'ACTIVE')
        .is('deleted_at', null);
      if (e1) throw e1;
      const buildingContracts = (contracts || []).filter(
        (c: any) => c.room?.building_id === buildingId
      );

      // 2) Electricity meters in this building.
      const { data: meters } = await supabase
        .from('meters')
        .select('id, room_id, meter_type')
        .eq('building_id', buildingId)
        .eq('meter_type', 'ELECTRICITY')
        .is('deleted_at', null);
      const meterByRoom = new Map<string, string>();
      (meters || []).forEach((m: any) => {
        if (m.room_id) meterByRoom.set(m.room_id, m.id);
      });

      // 3) Latest APPROVED reading per meter.
      const meterIds = (meters || []).map((m: any) => m.id);
      const lastReading = new Map<string, number>();
      if (meterIds.length > 0) {
        const { data: readings } = await (supabase as any)
          .from('meter_readings')
          .select('meter_id, current_reading, reading_date')
          .in('meter_id', meterIds)
          .eq('status', 'APPROVED')
          .is('deleted_at', null)
          .order('reading_date', { ascending: false });
        for (const r of readings || []) {
          if (!lastReading.has(r.meter_id)) {
            lastReading.set(r.meter_id, Number(r.current_reading) || 0);
          }
        }
      }

      const next: RowData[] = buildingContracts
        .map((c: any) => {
          const occupants = c.contract_customers?.length ?? 1;
          const meterId = meterByRoom.get(c.room_id) ?? null;
          const prev = meterId ? lastReading.get(meterId) ?? 0 : 0;
          return {
            contract_id: c.id,
            room_id: c.room_id,
            room_name: c.room?.name ?? '?',
            rent_price: Number(c.rent_price) || 0,
            occupants,
            meter_id: meterId,
            prev_reading: prev,
            current_reading: '' as const,
            electric_amount: 0,
            electric_overridden: false,
            water_amount: occupants * defaults.water,
            water_overridden: false,
            pdv_amount: defaults.pdv,
            discount: 0,
            selected: true,
          };
        })
        .sort((a: RowData, b: RowData) =>
          a.room_name.localeCompare(b.room_name, 'vi', { numeric: true })
        );
      setRows(next);
      setLoaded(true);
    } catch (err: any) {
      console.error(err);
      toast({
        variant: 'destructive',
        title: 'Lỗi tải dữ liệu',
        description: err.message || 'Không tải được danh sách phòng',
      });
    }
  };

  // Recompute water amount when defaults change (after building_services loads).
  useEffect(() => {
    if (!loaded) return;
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        water_amount: r.water_overridden ? r.water_amount : r.occupants * defaults.water,
        pdv_amount: r.pdv_amount === 0 ? defaults.pdv : r.pdv_amount,
      }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults.water, defaults.pdv]);

  const updateRow = (idx: number, patch: Partial<RowData>) => {
    setRows((prev) => {
      const next = [...prev];
      const row = { ...next[idx], ...patch };
      // Auto-recompute electric_amount unless user manually overrode it.
      if (
        ('current_reading' in patch || 'prev_reading' in patch) &&
        !row.electric_overridden
      ) {
        const consumption = Math.max(
          0,
          (Number(row.current_reading) || 0) - (Number(row.prev_reading) || 0)
        );
        row.electric_amount = consumption * defaults.elec;
      }
      // Auto-recompute water unless user overrode it.
      if ('occupants' in patch && !row.water_overridden) {
        row.water_amount = (Number(row.occupants) || 0) * defaults.water;
      }
      next[idx] = row;
      return next;
    });
  };

  const totals = useMemo(() => {
    const sel = rows.filter((r) => r.selected);
    return {
      count: sel.length,
      total: sel.reduce(
        (s, r) =>
          s +
          (r.rent_price + r.electric_amount + r.water_amount + r.pdv_amount - r.discount),
        0
      ),
    };
  }, [rows]);

  const allSelected = rows.length > 0 && rows.every((r) => r.selected);
  const toggleAll = () =>
    setRows((prev) => prev.map((r) => ({ ...r, selected: !allSelected })));

  const handleClose = () => {
    setRows([]);
    setLoaded(false);
    onOpenChange(false);
  };

  const handleSubmit = async () => {
    const selected = rows.filter((r) => r.selected);
    if (selected.length === 0) {
      toast({ variant: 'destructive', title: 'Chưa chọn phòng nào' });
      return;
    }
    setSubmitting(true);
    let ok = 0;
    let fail = 0;
    const periodStart = startOfMonth(parse(billingMonth + '-01', 'yyyy-MM-dd', new Date()));
    const periodEnd = endOfMonth(periodStart);
    const fromDate = format(periodStart, 'yyyy-MM-dd');
    const toDate = format(periodEnd, 'yyyy-MM-dd');

    for (const row of selected) {
      try {
        // 1) If user entered a current reading, record an UNAPPROVED meter reading.
        const consumption =
          (Number(row.current_reading) || 0) - (Number(row.prev_reading) || 0);
        if (row.meter_id && row.current_reading !== '' && consumption >= 0) {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            await supabase.from('meter_readings').insert({
              user_id: user.id,
              meter_id: row.meter_id,
              reading_date: issueDate,
              settlement_month: billingMonth,
              previous_reading: row.prev_reading,
              current_reading: Number(row.current_reading),
              status: 'APPROVED',
              approved_by: user.id,
              approved_at: new Date().toISOString(),
              meter_type: 'ELECTRICITY',
              service_id: defaults.elecServiceId,
              recorded_by: user.id,
            } as any);
          }
        }

        // 2) Build invoice items.
        const items: InvoiceFormData['items'] = [];
        let order = 0;
        items.push({
          type: 'RENT',
          description: `Tiền thuê phòng ${row.room_name} (${format(periodStart, 'MM/yyyy')})`,
          unit_price: row.rent_price,
          quantity: 1,
          coefficient: 1,
          sort_order: order++,
        });
        if (row.electric_amount > 0) {
          const cons = Math.max(consumption, 0);
          items.push({
            service_id: defaults.elecServiceId,
            type: 'SERVICE',
            description: `Tiền điện (${row.prev_reading} → ${row.current_reading || row.prev_reading})`,
            unit_price: cons > 0 ? row.electric_amount / cons : row.electric_amount,
            quantity: cons > 0 ? cons : 1,
            coefficient: 1,
            previous_reading: row.prev_reading,
            current_reading: Number(row.current_reading) || row.prev_reading,
            from_date: fromDate,
            to_date: toDate,
            sort_order: order++,
          });
        }
        if (row.water_amount > 0) {
          items.push({
            service_id: defaults.waterServiceId,
            type: 'SERVICE',
            description: `Tiền nước (${row.occupants} người)`,
            unit_price: row.occupants > 0 ? row.water_amount / row.occupants : row.water_amount,
            quantity: row.occupants || 1,
            coefficient: 1,
            sort_order: order++,
          });
        }
        if (row.pdv_amount > 0) {
          items.push({
            service_id: defaults.pdvServiceId,
            type: 'SERVICE',
            description: 'Phí dịch vụ',
            unit_price: row.pdv_amount,
            quantity: 1,
            coefficient: 1,
            sort_order: order++,
          });
        }

        const formData: InvoiceFormData = {
          building_id: buildingId,
          room_id: row.room_id,
          bed_id: null,
          contract_id: row.contract_id,
          billing_month: billingMonth,
          issue_date: issueDate,
          due_date: dueDate,
          discount_amount: row.discount,
          tax_percent: 0,
          prepaid_amount: 0,
          previous_debt: 0,
          notes: null,
          items,
        };
        await createInvoice.mutateAsync(formData);
        ok++;
      } catch (err) {
        console.error('Create invoice failed for', row.room_name, err);
        fail++;
      }
    }
    setSubmitting(false);
    toast({
      title: 'Hoàn tất tạo hoá đơn',
      description: `Thành công: ${ok}${fail > 0 ? ` — Lỗi: ${fail}` : ''}`,
    });
    if (fail === 0) handleClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[1400px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TableIcon className="h-5 w-5 text-indigo-600" />
            Tạo nhanh hoá đơn — Mode Excel
          </DialogTitle>
          <DialogDescription>
            Chọn toà & kỳ → Tải dữ liệu → Nhập chỉ số cuối → Bấm "Tạo hoá đơn"
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-5 gap-3 py-2">
          <div className="space-y-1 col-span-2">
            <Label>Toà nhà *</Label>
            <Select value={buildingId} onValueChange={setBuildingId}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn toà..." />
              </SelectTrigger>
              <SelectContent>
                {(buildings ?? []).map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Kỳ thanh toán *</Label>
            <Input
              type="month"
              value={billingMonth}
              onChange={(e) => setBillingMonth(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Ngày phát hành</Label>
            <Input
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Hạn thanh toán</Label>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 pb-2">
          <Button onClick={handleLoad} disabled={!buildingId}>
            <Download className="h-4 w-4 mr-2" />
            Tải dữ liệu
          </Button>
          {loaded && (
            <span className="text-sm text-muted-foreground">
              Đã tải {rows.length} phòng — đơn giá: điện {fmt(defaults.elec)}đ/kWh, nước{' '}
              {fmt(defaults.water)}đ/người, PDV {fmt(defaults.pdv)}đ/phòng
            </span>
          )}
        </div>

        <div className="flex-1 overflow-auto border rounded-md">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-100 sticky top-0 z-10">
              <tr className="text-xs uppercase">
                <th className="p-2 border w-8">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                </th>
                <th className="p-2 border text-left">Phòng</th>
                <th className="p-2 border text-right">Giá Phòng</th>
                <th className="p-2 border text-right w-[70px]">Số người</th>
                <th className="p-2 border text-right w-[90px]">Chỉ số đầu</th>
                <th className="p-2 border text-right w-[100px]">Chỉ số cuối</th>
                <th className="p-2 border text-right">Tiền điện</th>
                <th className="p-2 border text-right">Nước</th>
                <th className="p-2 border text-right">Phí Dịch Vụ</th>
                <th className="p-2 border text-right">Giảm trừ</th>
                <th className="p-2 border text-right bg-amber-50">Tổng</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="text-center p-8 text-muted-foreground">
                    {loaded ? 'Toà này không có hợp đồng đang hiệu lực.' : 'Chưa tải dữ liệu.'}
                  </td>
                </tr>
              )}
              {rows.map((r, i) => {
                const total =
                  r.rent_price + r.electric_amount + r.water_amount + r.pdv_amount - r.discount;
                return (
                  <tr key={r.contract_id} className={r.selected ? '' : 'opacity-50'}>
                    <td className="p-1 border text-center">
                      <Checkbox
                        checked={r.selected}
                        onCheckedChange={(v) => updateRow(i, { selected: !!v })}
                      />
                    </td>
                    <td className="p-1 border font-medium">{r.room_name}</td>
                    <td className="p-1 border">
                      <Input
                        className="h-7 text-right"
                        type="number"
                        value={r.rent_price}
                        onChange={(e) =>
                          updateRow(i, { rent_price: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <Input
                        className="h-7 text-right"
                        type="number"
                        value={r.occupants}
                        onChange={(e) =>
                          updateRow(i, { occupants: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td className="p-1 border text-right text-slate-600">
                      {r.meter_id ? fmt(r.prev_reading) : '—'}
                    </td>
                    <td className="p-1 border">
                      <Input
                        className="h-7 text-right"
                        type="number"
                        disabled={!r.meter_id}
                        value={r.current_reading}
                        onChange={(e) =>
                          updateRow(i, {
                            current_reading: e.target.value === '' ? '' : Number(e.target.value),
                          })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <Input
                        className="h-7 text-right"
                        type="number"
                        value={Math.round(r.electric_amount)}
                        onChange={(e) =>
                          updateRow(i, {
                            electric_amount: Number(e.target.value) || 0,
                            electric_overridden: true,
                          })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <Input
                        className="h-7 text-right"
                        type="number"
                        value={Math.round(r.water_amount)}
                        onChange={(e) =>
                          updateRow(i, {
                            water_amount: Number(e.target.value) || 0,
                            water_overridden: true,
                          })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <Input
                        className="h-7 text-right"
                        type="number"
                        value={r.pdv_amount}
                        onChange={(e) =>
                          updateRow(i, { pdv_amount: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <Input
                        className="h-7 text-right"
                        type="number"
                        value={r.discount}
                        onChange={(e) =>
                          updateRow(i, { discount: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td className="p-1 border text-right font-semibold bg-amber-50">
                      {fmt(total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="sticky bottom-0 bg-slate-100">
                <tr className="font-semibold">
                  <td colSpan={10} className="p-2 border text-right">
                    Tổng {totals.count} phòng đã chọn:
                  </td>
                  <td className="p-2 border text-right text-indigo-700 text-base">
                    {fmt(totals.total)}đ
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={handleClose}>
            Huỷ
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || totals.count === 0}
            className="bg-indigo-600 hover:bg-indigo-700"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang tạo...
              </>
            ) : (
              <>Tạo {totals.count} hoá đơn</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
