import { formatCurrency } from "@/lib/utils";
import { colorAt } from "./shareholderUtils";

/**
 * Biểu đồ thuần CSS cho trang Báo cáo Lợi Nhuận (desktop) — dựng đúng bản mock
 * Claude Design: cột bo góc 4px, donut conic-gradient viền 30px, thanh ngang
 * 12px. Không dùng recharts ở đây: mock không có trục/tooltip SVG, bản CSS nhẹ
 * hơn và khớp từng pixel; số chi tiết hiện qua title (hover).
 */

/** Số tiền → "12,3" triệu (dấu phẩy thập phân kiểu VN). */
export const toMillions = (n: number, digits = 0): string =>
  (Math.round((n / 1_000_000) * 10 ** digits) / 10 ** digits)
    .toFixed(digits)
    .replace(".", ",");

export interface BarDatum {
  label: string;
  value: number;
  /** Không có dữ liệu (tháng chưa tới) → vẽ vạch xám thay cột. */
  empty?: boolean;
}

/**
 * Cột dọc 12 tháng. Chiều cao cột lớn nhất = height − 48 (chừa nhãn số + trục),
 * đúng tỉ lệ mock (vùng 118px → cột cao nhất 70px).
 */
export function MiniBars({
  data,
  height = 118,
  highlight,
  tone = "green",
  digits = 0,
  footnote,
}: {
  data: BarDatum[];
  height?: number;
  /** index cột được tô đậm (tháng đang xem). */
  highlight?: number;
  tone?: "green" | "orange";
  digits?: number;
  footnote?: string;
}) {
  const max = Math.max(1, ...data.map((d) => (d.empty ? 0 : Math.abs(d.value))));
  const barMax = Math.max(24, height - 48);
  return (
    <>
      <div className={`ph-bars${tone === "orange" ? " ph-bars--orange" : ""}`} style={{ height }}>
        {data.map((d, i) => {
          const cur = i === highlight;
          if (d.empty || d.value === 0) {
            return (
              <div className="ph-bars__col" key={d.label}>
                <div className="ph-bars__bar ph-bars__bar--empty" />
              </div>
            );
          }
          return (
            <div className="ph-bars__col" key={d.label} title={`${d.label}: ${formatCurrency(d.value)}`}>
              <div className={`ph-bars__val${cur ? " ph-bars__val--cur" : ""}`}>
                {toMillions(d.value, digits)}
              </div>
              <div
                className={`ph-bars__bar${cur ? " ph-bars__bar--cur" : ""}`}
                style={{ height: Math.max(4, Math.round((Math.abs(d.value) / max) * barMax)) }}
              />
            </div>
          );
        })}
      </div>
      <div className="ph-bars__axis">
        {data.map((d, i) => (
          <div key={d.label} className={`ph-bars__tick${i === highlight ? " ph-bars__tick--cur" : ""}`}>
            {d.label}
          </div>
        ))}
      </div>
      {footnote && <div className="ph-hint">{footnote}</div>}
    </>
  );
}

export interface SliceDatum {
  name: string;
  value: number;
}

/** Donut conic-gradient + chú giải (tên · số tiền · %). */
export function DonutBreakdown({
  data,
  caption,
  emptyText = "Chưa có dữ liệu",
}: {
  data: SliceDatum[];
  caption: string;
  emptyText?: string;
}) {
  const total = data.reduce((s, d) => s + Math.abs(d.value), 0);
  if (!data.length || total === 0) {
    return <div className="ph-empty">{emptyText}</div>;
  }

  let acc = 0;
  const stops = data.map((d, i) => {
    const from = (acc / total) * 100;
    acc += Math.abs(d.value);
    const to = (acc / total) * 100;
    return `${colorAt(i)} ${from.toFixed(3)}% ${to.toFixed(3)}%`;
  });

  return (
    <div className="ph-donut-wrap">
      <div className="ph-donut" style={{ background: `conic-gradient(${stops.join(",")})` }}>
        <div className="ph-donut__hole">
          <div className="ph-donut__cap">{caption}</div>
          <div className="ph-donut__val">{toMillions(total, 1)}tr</div>
        </div>
      </div>
      <div className="ph-legend-list">
        {data.map((d, i) => (
          <div className="ph-legend-row" key={`${d.name}-${i}`}>
            <span className="ph-legend-row__sw" style={{ background: colorAt(i) }} />
            <span className="ph-legend-row__name" title={d.name}>{d.name}</span>
            <b className="ph-legend-row__val">{formatCurrency(d.value)}</b>
            <span className="ph-legend-row__pct">{Math.round((Math.abs(d.value) / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Thanh ngang so sánh (số còn lại theo cổ đông). */
export function HBars({
  data,
  emptyText = "Chưa có dữ liệu",
}: {
  data: SliceDatum[];
  emptyText?: string;
}) {
  if (!data.length) return <div className="ph-empty">{emptyText}</div>;
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  return (
    <div className="ph-hbars">
      {data.map((d, i) => (
        <div className="ph-hbar" key={`${d.name}-${i}`}>
          <span className="ph-hbar__name" title={d.name}>{d.name}</span>
          <div className="ph-hbar__track">
            <div
              className={`ph-hbar__fill${d.value < 0 ? " ph-hbar__fill--neg" : ""}`}
              style={{ width: `${Math.max(2, (Math.abs(d.value) / max) * 100)}%` }}
            />
          </div>
          <b className="ph-hbar__val">{formatCurrency(d.value)}</b>
        </div>
      ))}
    </div>
  );
}
