// =============================================
// UtilityChart — biểu đồ cột "Chi điện nước qua các tháng".
// Port 100% từ mockup DienNuocChart.dc.html: 2 panel điện/nước, mỗi panel có
// cột "Đã chi NCC" (đặc) vs "Phải thu — hoá đơn" (viền), toggle theo legend,
// segmented Tất cả/Điện/Nước. compact = bản mobile (nhỏ, ẩn nhãn lưới/cột).
//
// Dùng inline style (màu literal như mockup) để khớp tuyệt đối — chart tự chứa.
// =============================================

import { useState } from 'react';
import { Zap, Droplet } from 'lucide-react';
import type { ChartMonth } from '@/hooks/useUtilityBills';

type CType = 'all' | 'elec' | 'water';
type Metric = 'both' | 'chi' | 'thu';

interface Props {
  months: ChartMonth[];
  compact?: boolean;
}

const fmtBig = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2).replace('.', ',') + ' tỷ₫' : Math.round(n / 1e6) + 'tr₫';
const fmtTr = (n: number) => Math.round(n / 1e6) + 'tr';

export function UtilityChart({ months, compact = false }: Props) {
  const [ctype, setCtype] = useState<CType>('all');
  const [metric, setMetric] = useState<Metric>('both');
  const toggleMetric = (k: 'chi' | 'thu') => setMetric((m) => (m === k ? 'both' : k));

  const types: ('elec' | 'water')[] = ctype === 'all' ? ['elec', 'water'] : [ctype];
  const two = types.length > 1;

  const segStyle = (on: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'inherit',
    fontSize: 12.5, fontWeight: 700, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
    whiteSpace: 'nowrap', border: 0, transition: '.14s',
    background: on ? '#fff' : 'transparent', color: on ? '#1b1813' : '#8d8678',
    boxShadow: on ? '0 1px 2px rgba(27,24,19,.1)' : 'none',
  });

  const renderPanel = (t: 'elec' | 'water', idx: number) => {
    const isElec = t === 'elec';
    const solid = isElec ? '#d98c1f' : '#2f74d0';
    const tint = isElec ? 'rgba(217,140,31,.26)' : 'rgba(47,116,208,.24)';
    const lblColor = isElec ? '#b07d1a' : '#2f74d0';
    const chiKey = isElec ? 'elec' : 'water';
    const billKey = isElec ? 'elecBill' : 'waterBill';

    const plotH = compact ? (two ? 150 : 190) : (two ? 224 : 300);
    const showChi = metric === 'both' || metric === 'chi';
    const showThu = metric === 'both' || metric === 'thu';
    const single = metric !== 'both';
    const barW = compact ? (single ? 20 : 14) : (single ? 40 : 26);

    const vals = months.flatMap((m) => [m[chiKey] as number, m[billKey] as number]);
    const rawMax = Math.max(...vals, 1);
    const step = rawMax <= 60e6 ? 10e6 : 50e6;
    const niceMax = (Math.floor(rawMax / step) + 2) * step;
    const h = (v: number) => Math.max(1.5, (v / niceMax) * 100) + '%';

    const gridLines: { label: string; bottom: string }[] = [];
    for (let v = niceMax; v >= 0; v -= step) gridLines.push({ label: fmtTr(v), bottom: (v / niceMax) * 100 + '%' });

    const chi = months.reduce((s, m) => s + (m[chiKey] as number), 0);
    const bill = months.reduce((s, m) => s + (m[billKey] as number), 0);

    const legendBtn = (on: boolean): React.CSSProperties => ({
      display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit',
      fontSize: 12, fontWeight: 700, color: '#514c42', background: 'transparent', border: 0,
      cursor: 'pointer', padding: '3px 6px', borderRadius: 7, transition: '.14s', opacity: on ? 1 : 0.35,
    });
    const sw = (bg: string, bd?: string): React.CSSProperties => ({
      width: 12, height: 12, borderRadius: 3, background: bg,
      border: bd ? `1.5px solid ${bd}` : undefined, flexShrink: 0,
    });
    const lblStyle: React.CSSProperties = {
      position: 'absolute', top: -14, left: '50%', transform: 'translateX(-50%)',
      fontFamily: "'Space Mono',monospace", fontSize: 9, fontWeight: 700, color: lblColor, whiteSpace: 'nowrap',
    };

    return (
      <div
        key={t}
        style={{
          display: 'flex', flexDirection: 'column', gap: 13,
          padding: idx > 0 ? '18px 0 0' : '0',
          borderTop: idx > 0 ? '1px solid #efece4' : undefined,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{
            width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', flexShrink: 0,
            background: isElec ? '#fbf1da' : '#e7f1fb', color: isElec ? '#c97a10' : '#2563c9',
          }}>
            {isElec ? <Zap size={15} /> : <Droplet size={15} />}
          </span>
          <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-.2px' }}>
            {isElec ? 'Tiền điện · EVN' : 'Tiền nước · Cấp nước'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginLeft: 4 }}>
            <button type="button" onClick={() => toggleMetric('chi')} style={legendBtn(showChi)}>
              <span style={sw(solid)} />Đã chi NCC
            </button>
            <button type="button" onClick={() => toggleMetric('thu')} style={legendBtn(showThu)}>
              <span style={sw(tint, solid)} />Phải thu (hóa đơn)
            </button>
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: '#8d8678' }}>
            Chi {fmtBig(chi)} · Phải thu {fmtBig(bill)} · Chênh +{fmtBig(bill - chi)}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 0 }}>
          {!compact && (
            <div style={{ width: 46, position: 'relative', height: plotH, flexShrink: 0 }}>
              {gridLines.map((g, i) => (
                <span key={i} style={{
                  position: 'absolute', right: 8, bottom: g.bottom, transform: 'translateY(50%)',
                  fontFamily: "'Space Mono',monospace", fontSize: 10, fontWeight: 700, color: '#b6b0a3', whiteSpace: 'nowrap',
                }}>{g.label}</span>
              ))}
            </div>
          )}
          <div style={{
            flex: 1, minWidth: 0, position: 'relative', height: plotH,
            borderLeft: '1px solid #e7e3da', borderBottom: '1px solid #e7e3da',
          }}>
            {!compact && gridLines.map((g, i) => (
              <span key={i} style={{ position: 'absolute', left: 0, right: 0, bottom: g.bottom, borderTop: '1px dashed #efece4' }} />
            ))}
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', padding: '0 6px', gap: compact ? 5 : 12 }}>
              {months.map((m, mi) => (
                <div key={mi} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: compact ? 3 : 5, height: '100%' }}>
                  {showChi && (
                    <div style={{ position: 'relative', width: barW, borderRadius: '4px 4px 0 0', height: h(m[chiKey] as number), background: solid, transition: 'height .45s cubic-bezier(.22,.61,.36,1)' }}>
                      {!compact && <span style={lblStyle}>{fmtTr(m[chiKey] as number)}</span>}
                    </div>
                  )}
                  {showThu && (
                    <div style={{ position: 'relative', width: barW, borderRadius: '4px 4px 0 0', height: h(m[billKey] as number), background: tint, border: `1.5px solid ${solid}`, transition: 'height .45s cubic-bezier(.22,.61,.36,1)' }}>
                      {!compact && <span style={lblStyle}>{fmtTr(m[billKey] as number)}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', padding: '0 6px', paddingLeft: compact ? 6 : 46, gap: compact ? 5 : 12 }}>
          {months.map((m, mi) => (
            <div key={mi} style={{ flex: 1, textAlign: 'center' }}>
              <span style={{ fontSize: compact ? 10 : 11, fontWeight: 700, color: m.current ? '#1a6645' : '#514c42' }}>{m.label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div style={{ fontFamily: "'Be Vietnam Pro',system-ui,sans-serif", color: '#1b1813', display: 'flex', flexDirection: 'column', gap: 18, width: '100%' }}>
      <div style={{ display: 'flex', gap: 5, background: '#f0efe9', border: '1px solid #e7e3da', borderRadius: 10, padding: 3, alignSelf: 'flex-start' }}>
        <button type="button" onClick={() => setCtype('all')} style={segStyle(ctype === 'all')}>Tất cả</button>
        <button type="button" onClick={() => setCtype('elec')} style={segStyle(ctype === 'elec')}><Zap size={13} />Điện</button>
        <button type="button" onClick={() => setCtype('water')} style={segStyle(ctype === 'water')}><Droplet size={13} />Nước</button>
      </div>
      {types.map((t, i) => renderPanel(t, i))}
    </div>
  );
}

export default UtilityChart;
