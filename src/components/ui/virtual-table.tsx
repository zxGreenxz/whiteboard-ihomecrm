// Bảng shadcn `<Table>` có ảo hoá dòng bằng @tanstack/react-virtual.
//
// VÌ SAO
//   Các màn danh sách (Tài sản, Căn hộ, Sổ cọc) render MỌI dòng vào DOM: 500
//   dòng × ~10 ô = 5.000 node chỉ để người dùng nhìn 12 dòng đầu, và mỗi phím
//   gõ vào ô tìm kiếm là dựng lại toàn bộ. Ảo hoá chỉ giữ trong DOM cửa sổ
//   đang thấy (+ overscan) và bù chiều cao bằng hai dòng đệm để thanh cuộn
//   vẫn đúng tỉ lệ.
//
// VÌ SAO GÓI CẢ <Table> VÀO MỘT COMPONENT thay vì chỉ đưa hook cho trang
//   1. Hook virtualizer phải sống CÙNG chỗ với phần tử cuộn. Bảng nằm trong
//      tab chưa mở (Radix TabsContent) mount SAU mà trang cha không re-render,
//      nên hook đặt ở cha sẽ không bao giờ thấy phần tử cuộn → chỉ dựng
//      overscan rồi đứng im khi cuộn.
//   2. Mỗi frame cuộn virtualizer gọi rerender: đặt ở đây thì chỉ bảng dựng
//      lại; đặt ở trang thì cả trang (KPI, bộ lọc, dialog) dựng lại theo.
//
// CÁCH DÙNG (giữ nguyên markup ô, chỉ đổi khung):
//   <Card>
//     <VirtualTable
//       rows={rows}
//       header={<TableRow><TableHead>…</TableHead></TableRow>}
//       emptyRow={<TableRow><TableCell colSpan={n}>Không có…</TableCell></TableRow>}
//       renderRow={(row, index, measureRef) =>
//         <Row key={row.id} row={row} index={index} measureRef={measureRef} … />}
//     />
//   </Card>
//   Trong Row: <TableRow ref={measureRef} data-index={index}> — hai thuộc tính này
//   để virtualizer đo chiều cao THẬT của từng dòng (dòng hai dòng chữ cao hơn).
//   Row nên là `React.memo` và callback truyền vào nên là `useCallback`.
//
// PHẦN TỬ CUỘN là DIV `overflow-auto` mà shadcn Table bọc quanh `<table>`
// (không phải `<table>`), nên `getScrollElement` lấy `parentElement` của table
// và chiều cao được giới hạn qua biến thể `[&>div]` trên div bọc ngoài. Sticky
// header chỉ dính đúng khi phần tử cuộn là DIV này — bọc thêm một DIV cuộn bên
// ngoài thì thead dính vào DIV trong (không cuộn) và trôi mất.
//
// DƯỚI NGƯỠNG (NGUONG_AO_HOA dòng) không ảo hoá: render thẳng như cũ, không
// khung cuộn riêng, không sticky — bảng ngắn không phải trả giá cho khung cuộn.
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useRef, type ReactNode, type RefObject } from "react";
import { Table, TableBody, TableHeader } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** Từ ngưỡng này trở lên danh sách mới được ảo hoá. */
const NGUONG_AO_HOA = 50;

/** Ô `p-4` (16+16) + một dòng chữ ~20px + viền 1px. */
const UOC_LUONG_DONG = 53;

/** Overscan mỗi chiều; cũng bù luôn phần thead nằm trên tbody trong cùng khung cuộn. */
const OVERSCAN = 8;

/** Gắn vào `ref` của `<TableRow>` để virtualizer đo chiều cao thật; undefined khi không ảo hoá. */
export type MeasureRef = (node: HTMLTableRowElement | null) => void;

export interface VirtualTableOptions {
  /** Chiều cao ước lượng một dòng (px). Dòng thật được đo lại qua `measureRef`. */
  estimateSize?: number;
  /** Số dòng dựng thêm ngoài cửa sổ mỗi chiều. */
  overscan?: number;
  /** Số dòng tối thiểu để bật ảo hoá. */
  threshold?: number;
}

interface VirtualRowsState {
  tableRef: RefObject<HTMLTableElement>;
  enabled: boolean;
  /** null khi không ảo hoá (render đủ). */
  items: VirtualItem[] | null;
  paddingTop: number;
  paddingBottom: number;
  measureElement: MeasureRef;
}

function useVirtualRows<T>(rows: readonly T[], options: VirtualTableOptions): VirtualRowsState {
  const tableRef = useRef<HTMLTableElement>(null);
  const enabled = rows.length >= (options.threshold ?? NGUONG_AO_HOA);
  const estimateSize = options.estimateSize ?? UOC_LUONG_DONG;

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: rows.length,
    getScrollElement: () => (tableRef.current?.parentElement as HTMLDivElement | null) ?? null,
    estimateSize: () => estimateSize,
    overscan: options.overscan ?? OVERSCAN,
    enabled,
  });

  const items = enabled ? virtualizer.getVirtualItems() : null;
  const first = items?.[0];
  const last = items?.[items.length - 1];

  return {
    tableRef,
    enabled,
    items,
    paddingTop: first ? first.start : 0,
    paddingBottom: last ? virtualizer.getTotalSize() - last.end : 0,
    measureElement: virtualizer.measureElement,
  };
}

/** Dòng đệm giữ đúng chiều cao tổng để thanh cuộn không nhảy. */
function SpacerRow({ height }: { height: number }) {
  return (
    <tr aria-hidden="true">
      <td style={{ height, padding: 0, border: 0 }} />
    </tr>
  );
}

export interface VirtualTableProps<T> {
  rows: readonly T[];
  /** `<TableRow>` chứa các `<TableHead>`; được đặt trong `<TableHeader>`. */
  header: ReactNode;
  /** Dựng khi `rows` rỗng (dòng "Đang tải…" / "Không có…"). */
  emptyRow?: ReactNode;
  /** `measureRef` là undefined khi không ảo hoá — gắn thẳng vào `ref` của TableRow. */
  renderRow: (row: T, index: number, measureRef: MeasureRef | undefined) => ReactNode;
  options?: VirtualTableOptions;
  /** Class thêm cho div bọc ngoài. */
  className?: string;
}

export function VirtualTable<T>({ rows, header, emptyRow, renderRow, options = {}, className }: VirtualTableProps<T>) {
  const virt = useVirtualRows(rows, options);

  let body: ReactNode;
  if (rows.length === 0) {
    body = emptyRow;
  } else if (!virt.items) {
    body = rows.map((row, index) => renderRow(row, index, undefined));
  } else {
    body = (
      <>
        {virt.paddingTop > 0 && <SpacerRow height={virt.paddingTop} />}
        {virt.items.map((item) => {
          const row = rows[item.index];
          return row === undefined ? null : renderRow(row, item.index, virt.measureElement);
        })}
        {virt.paddingBottom > 0 && <SpacerRow height={virt.paddingBottom} />}
      </>
    );
  }

  return (
    <div className={cn(virt.enabled && "[&>div]:max-h-[70vh]", className)}>
      <Table ref={virt.tableRef}>
        <TableHeader className={virt.enabled ? "sticky top-0 z-10 bg-card" : undefined}>{header}</TableHeader>
        <TableBody>{body}</TableBody>
      </Table>
    </div>
  );
}
