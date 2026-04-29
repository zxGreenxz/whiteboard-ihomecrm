import { useEffect, useMemo, useState } from 'react';
import { ImageDown, Download, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoices: InvoiceWithRelations[];
}

interface Row {
  invoiceId: string;
  room: string;
  rent: number;
  occupants: number;
  prevReading: number | null;
  currentReading: number | null;
  electric: number;
  water: number;
  pdv: number;
  discount: number;
  total: number;
}

interface BuildingGroup {
  buildingId: string;
  buildingName: string;
  buildingAddress: string;
  rows: Row[];
}

const fmt = (n: number) =>
  n ? new Intl.NumberFormat('vi-VN').format(Math.round(n)) : '';

function extractRow(inv: InvoiceWithRelations, occupants: number): Row {
  const items = inv.invoice_items || [];
  let rent = 0;
  let electric = 0;
  let water = 0;
  let pdv = 0;
  let prevReading: number | null = null;
  let currentReading: number | null = null;

  for (const item of items) {
    const desc = (item.description || '').toLowerCase();
    if (item.type === 'RENT') {
      rent += item.amount || 0;
    } else if (item.type === 'DISCOUNT') {
      // skip
    } else if (desc.includes('điện')) {
      electric += item.amount || 0;
      if (item.previous_reading !== null && item.previous_reading !== undefined) {
        prevReading = Number(item.previous_reading);
      }
      if (item.current_reading !== null && item.current_reading !== undefined) {
        currentReading = Number(item.current_reading);
      }
    } else if (desc.includes('nước')) {
      water += item.amount || 0;
    } else {
      pdv += item.amount || 0;
    }
  }

  return {
    invoiceId: inv.id,
    room: inv.room?.name ?? '?',
    rent,
    occupants,
    prevReading,
    currentReading,
    electric,
    water,
    pdv,
    discount: inv.discount_amount || 0,
    total: inv.total_amount || 0,
  };
}

export default function InvoiceImageDialog({ open, onOpenChange, invoices }: Props) {
  const { toast } = useToast();
  const [occupantsByContract, setOccupantsByContract] = useState<Map<string, number>>(new Map());
  const [buildingAddrById, setBuildingAddrById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const contractIds = Array.from(new Set(invoices.map((inv) => inv.contract_id).filter(Boolean)));
    const buildingIds = Array.from(new Set(invoices.map((inv) => inv.building_id).filter(Boolean)));

    if (contractIds.length === 0 && buildingIds.length === 0) {
      setOccupantsByContract(new Map());
      setBuildingAddrById(new Map());
      return;
    }

    setLoading(true);
    Promise.all([
      contractIds.length > 0
        ? supabase
            .from('contract_customers')
            .select('contract_id')
            .in('contract_id', contractIds)
        : Promise.resolve({ data: [] as any[], error: null }),
      buildingIds.length > 0
        ? supabase.from('buildings').select('id, name, address').in('id', buildingIds)
        : Promise.resolve({ data: [] as any[], error: null }),
    ]).then(([ccRes, bRes]: any[]) => {
      if (cancelled) return;
      const occMap = new Map<string, number>();
      for (const cc of ccRes.data || []) {
        occMap.set(cc.contract_id, (occMap.get(cc.contract_id) || 0) + 1);
      }
      setOccupantsByContract(occMap);

      const bMap = new Map<string, string>();
      for (const b of bRes.data || []) {
        bMap.set(b.id, b.address || b.name || '');
      }
      setBuildingAddrById(bMap);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [open, invoices]);

  const groups: BuildingGroup[] = useMemo(() => {
    const grouped = new Map<string, BuildingGroup>();
    for (const inv of invoices) {
      const buildingId = inv.building_id;
      const buildingName = inv.building?.name ?? 'Toà nhà';
      const buildingAddress = buildingAddrById.get(buildingId) || buildingName;
      if (!grouped.has(buildingId)) {
        grouped.set(buildingId, {
          buildingId,
          buildingName,
          buildingAddress,
          rows: [],
        });
      }
      const occupants = occupantsByContract.get(inv.contract_id) || 1;
      grouped.get(buildingId)!.rows.push(extractRow(inv, occupants));
    }
    for (const g of grouped.values()) {
      g.rows.sort((a, b) => a.room.localeCompare(b.room, 'vi', { numeric: true }));
    }
    return Array.from(grouped.values()).sort((a, b) =>
      a.buildingName.localeCompare(b.buildingName, 'vi', { numeric: true }),
    );
  }, [invoices, occupantsByContract, buildingAddrById]);

  const handleDownloadAll = async () => {
    if (groups.length === 0) return;
    setDownloading(true);
    try {
      for (const g of groups) {
        const canvas = renderCanvas(g);
        await new Promise<void>((resolve) => {
          canvas.toBlob((blob) => {
            if (!blob) {
              resolve();
              return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `hoa-don-${sanitize(g.buildingName)}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            resolve();
          }, 'image/png');
        });
      }
      toast({
        title: 'Đã tải ảnh',
        description: `${groups.length} ảnh hoá đơn`,
      });
    } catch (err: any) {
      console.error(err);
      toast({
        variant: 'destructive',
        title: 'Lỗi tải ảnh',
        description: err?.message || 'Không tạo được ảnh',
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1400px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageDown className="h-5 w-5 text-purple-600" />
            Tải ảnh hoá đơn
          </DialogTitle>
          <DialogDescription>
            Tạo 1 ảnh PNG cho mỗi toà nhà từ các hoá đơn đang hiển thị ({invoices.length} hoá đơn,{' '}
            {groups.length} toà).
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto py-2 space-y-6">
          {loading ? (
            <div className="text-center text-muted-foreground py-8">Đang tải dữ liệu...</div>
          ) : groups.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              Không có hoá đơn nào để tải. Vui lòng điều chỉnh bộ lọc.
            </div>
          ) : (
            groups.map((g) => <BuildingPreview key={g.buildingId} group={g} />)
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Đóng
          </Button>
          <Button
            onClick={handleDownloadAll}
            disabled={downloading || groups.length === 0}
            className="bg-purple-600 hover:bg-purple-700"
          >
            {downloading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Đang tải...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Tải {groups.length > 1 ? `${groups.length} ảnh` : 'ảnh'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function sanitize(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'hoa-don'
  );
}

function BuildingPreview({ group }: { group: BuildingGroup }) {
  return (
    <div className="border rounded-md overflow-x-auto">
      <div className="bg-orange-100 text-red-800 text-center py-2 font-bold border-b border-gray-300">
        HÓA ĐƠN TIỀN PHÒNG {group.buildingAddress}
      </div>
      <div className="bg-orange-50 text-red-800 text-center text-xs italic py-1.5 px-2 border-b border-gray-300">
        Lưu ý: Thanh toán tiền phòng trước ngày 5 hàng tháng. Quá hạn trên sẽ phải chuyển ra ngoài
        và không nhận được tiền đặt cọc
      </div>
      <table className="w-full text-sm border-collapse">
        <thead className="bg-green-200">
          <tr>
            <Th>Phòng</Th>
            <Th>Giá Phòng</Th>
            <Th>Số người</Th>
            <Th>Chỉ số đầu</Th>
            <Th>Chỉ số cuối</Th>
            <Th>Tiền điện</Th>
            <Th>Nước</Th>
            <Th>Phí Dịch Vụ</Th>
            <Th>Giảm trừ</Th>
            <Th>Tổng phải thu KH</Th>
          </tr>
        </thead>
        <tbody>
          {group.rows.map((r) => (
            <tr key={r.invoiceId}>
              <Td className="text-center font-medium">{r.room}</Td>
              <Td className="text-right">{fmt(r.rent)}</Td>
              <Td className="text-center">{r.occupants}</Td>
              <Td className="text-center bg-blue-50">
                {r.prevReading !== null ? fmt(r.prevReading) : ''}
              </Td>
              <Td className="text-center bg-blue-50">
                {r.currentReading !== null ? fmt(r.currentReading) : ''}
              </Td>
              <Td className="text-right">{fmt(r.electric)}</Td>
              <Td className="text-right">{fmt(r.water)}</Td>
              <Td className="text-right">{fmt(r.pdv)}</Td>
              <Td className="text-center">{r.discount > 0 ? fmt(r.discount) : ''}</Td>
              <Td className="text-right font-semibold">{fmt(r.total)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border border-gray-400 px-2 py-1.5 text-center text-xs font-semibold">
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`border border-gray-400 px-2 py-1.5 ${className}`}>{children}</td>;
}

// =============================================
// Canvas rendering for PNG export
// =============================================

interface Col {
  label: string;
  w: number;
  align: 'left' | 'center' | 'right';
}

const COLS: Col[] = [
  { label: 'Phòng', w: 80, align: 'center' },
  { label: 'Giá Phòng', w: 110, align: 'right' },
  { label: 'Số người', w: 80, align: 'center' },
  { label: 'Chỉ số đầu', w: 100, align: 'center' },
  { label: 'Chỉ số cuối', w: 100, align: 'center' },
  { label: 'Tiền điện', w: 100, align: 'right' },
  { label: 'Nước', w: 90, align: 'right' },
  { label: 'Phí Dịch Vụ', w: 110, align: 'right' },
  { label: 'Giảm trừ', w: 90, align: 'right' },
  { label: 'Tổng phải thu KH', w: 140, align: 'right' },
];

const TOTAL_W = COLS.reduce((s, c) => s + c.w, 0);
const TITLE_H = 44;
const NOTE_H = 36;
const HEADER_H = 36;
const ROW_H = 34;

function renderCanvas(group: BuildingGroup): HTMLCanvasElement {
  const totalH = TITLE_H + NOTE_H + HEADER_H + group.rows.length * ROW_H;
  const dpr = 2;
  const canvas = document.createElement('canvas');
  canvas.width = TOTAL_W * dpr;
  canvas.height = totalH * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'middle';

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, TOTAL_W, totalH);

  // Title bar
  ctx.fillStyle = '#fde2c5';
  ctx.fillRect(0, 0, TOTAL_W, TITLE_H);
  ctx.fillStyle = '#9b1c1c';
  ctx.font = 'bold 18px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`HÓA ĐƠN TIỀN PHÒNG ${group.buildingAddress}`, TOTAL_W / 2, TITLE_H / 2);

  // Note bar
  ctx.fillStyle = '#fef0e0';
  ctx.fillRect(0, TITLE_H, TOTAL_W, NOTE_H);
  ctx.fillStyle = '#9b1c1c';
  ctx.font = 'italic 12px Arial, sans-serif';
  ctx.fillText(
    'Lưu ý: Thanh toán tiền phòng trước ngày 5 hàng tháng. Quá hạn trên sẽ phải chuyển ra ngoài và không nhận được tiền đặt cọc',
    TOTAL_W / 2,
    TITLE_H + NOTE_H / 2,
  );

  // Outer border around title+note
  ctx.strokeStyle = '#9b1c1c';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, TOTAL_W - 1, TITLE_H + NOTE_H - 1);

  // Header row
  let y = TITLE_H + NOTE_H;
  ctx.fillStyle = '#86efac';
  ctx.fillRect(0, y, TOTAL_W, HEADER_H);
  ctx.fillStyle = '#000';
  ctx.font = 'bold 12px Arial, sans-serif';
  let x = 0;
  for (const c of COLS) {
    ctx.textAlign = 'center';
    ctx.fillText(c.label, x + c.w / 2, y + HEADER_H / 2);
    x += c.w;
  }
  drawRowGrid(ctx, y, HEADER_H);

  // Data rows
  y += HEADER_H;
  for (let i = 0; i < group.rows.length; i++) {
    const r = group.rows[i];

    // Highlight chỉ số đầu/cuối columns (index 3, 4)
    const xReadStart = COLS.slice(0, 3).reduce((s, c) => s + c.w, 0);
    const wRead = COLS[3].w + COLS[4].w;
    ctx.fillStyle = '#dbeafe';
    ctx.fillRect(xReadStart, y, wRead, ROW_H);

    ctx.font = '13px Arial, sans-serif';
    ctx.fillStyle = '#000';
    let xx = 0;
    drawCell(ctx, COLS[0], xx, y, ROW_H, r.room, true);
    xx += COLS[0].w;
    drawCell(ctx, COLS[1], xx, y, ROW_H, fmt(r.rent));
    xx += COLS[1].w;
    drawCell(ctx, COLS[2], xx, y, ROW_H, String(r.occupants));
    xx += COLS[2].w;
    drawCell(ctx, COLS[3], xx, y, ROW_H, r.prevReading !== null ? fmt(r.prevReading) : '');
    xx += COLS[3].w;
    drawCell(ctx, COLS[4], xx, y, ROW_H, r.currentReading !== null ? fmt(r.currentReading) : '');
    xx += COLS[4].w;
    drawCell(ctx, COLS[5], xx, y, ROW_H, fmt(r.electric));
    xx += COLS[5].w;
    drawCell(ctx, COLS[6], xx, y, ROW_H, fmt(r.water));
    xx += COLS[6].w;
    drawCell(ctx, COLS[7], xx, y, ROW_H, fmt(r.pdv));
    xx += COLS[7].w;
    drawCell(ctx, COLS[8], xx, y, ROW_H, r.discount > 0 ? fmt(r.discount) : '');
    xx += COLS[8].w;

    ctx.font = 'bold 13px Arial, sans-serif';
    drawCell(ctx, COLS[9], xx, y, ROW_H, fmt(r.total));

    drawRowGrid(ctx, y, ROW_H);
    y += ROW_H;
  }

  return canvas;
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  col: Col,
  x: number,
  y: number,
  h: number,
  text: string,
  bold = false,
) {
  ctx.fillStyle = '#000';
  ctx.font = bold ? 'bold 13px Arial, sans-serif' : '13px Arial, sans-serif';
  ctx.textAlign = col.align;
  const padding = 8;
  const tx =
    col.align === 'right' ? x + col.w - padding : col.align === 'center' ? x + col.w / 2 : x + padding;
  ctx.fillText(text, tx, y + h / 2);
}

function drawRowGrid(ctx: CanvasRenderingContext2D, y: number, h: number) {
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(TOTAL_W, y + 0.5);
  ctx.moveTo(0, y + h - 0.5);
  ctx.lineTo(TOTAL_W, y + h - 0.5);
  let x = 0;
  for (const c of COLS) {
    ctx.moveTo(x + 0.5, y);
    ctx.lineTo(x + 0.5, y + h);
    x += c.w;
  }
  ctx.moveTo(x - 0.5, y);
  ctx.lineTo(x - 0.5, y + h);
  ctx.stroke();
}
