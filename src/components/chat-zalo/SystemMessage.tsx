import { Zap } from 'lucide-react';

/** Thông báo hệ thống / tự động hoá — pill xanh ở giữa luồng. */
export default function SystemMessage({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', margin: '2px 0 12px' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'hsl(152 40% 95%)', color: 'hsl(152 50% 28%)', fontSize: 11.5, fontWeight: 600, padding: '6px 13px', borderRadius: 11, border: '1px solid hsl(152 35% 84%)' }}>
        <Zap size={13} />
        {text}
      </span>
    </div>
  );
}
