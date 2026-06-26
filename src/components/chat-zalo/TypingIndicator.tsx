/** Chỉ báo đang gõ — 3 chấm nảy (keyframes wzdot trong index.css). */
export default function TypingIndicator() {
  const dot = (delay: string) => ({
    width: 7, height: 7, borderRadius: '50%', background: 'hsl(210 12% 60%)',
    animation: `wzdot 1.2s infinite ${delay}`,
  } as const);
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 8 }}>
      <div style={{ background: '#fff', border: '1px solid hsl(210 20% 89%)', borderRadius: 16, padding: '11px 15px', display: 'flex', gap: 4, alignItems: 'center' }}>
        <span style={dot('0s')} />
        <span style={dot('.2s')} />
        <span style={dot('.4s')} />
      </div>
    </div>
  );
}
