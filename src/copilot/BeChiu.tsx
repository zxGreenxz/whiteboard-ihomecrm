// Linh thú "Bé Chiu" — ngôi nhà xanh làm gương mặt của AI Copilot.
// SVG chép từ design "Trợ lý AI - Bé Chiu.dc.html"; các prop bật/tắt chi tiết
// theo đúng biến thể trong design: nút mở (đủ khói), header (không khói),
// màn trống (đủ khói + bóng đổ), avatar tin nhắn (tĩnh, tối giản),
// avatar đang-nghĩ (mắt nhắm).
import './copilot.css';

export const TEN_LINH_THU = 'Bé Chiu';

interface Props {
  size: number;
  /** float + chớp mắt + khói bay (tôn trọng prefers-reduced-motion). */
  animated?: boolean;
  /** Cụm khói trên ống khói — chỉ biến thể to. */
  smoke?: boolean;
  /** Má hồng. */
  blush?: boolean;
  /** Cửa sổ tròn trên mái. */
  cuaSo?: boolean;
  /** 'mo' = mắt tròn + miệng cười; 'nham' = hai vòng cung (đang nghĩ). */
  eyes?: 'mo' | 'nham';
  /** Bóng đổ ellipse dưới chân — chỉ màn hình trống. */
  shadow?: boolean;
  className?: string;
}

export function BeChiu({
  size,
  animated = false,
  smoke = false,
  blush = false,
  cuaSo = false,
  eyes = 'mo',
  shadow = false,
  className,
}: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {shadow && <ellipse cx="32" cy="59" rx="15" ry="2.6" fill="hsl(152 30% 90%)" />}
      <g className={animated ? 'bc-float' : undefined}>
        {smoke && (
          <circle cx="45" cy="12" r="3" fill="#b9e5cf" className={animated ? 'bc-smoke' : undefined} />
        )}
        <rect x="41" y="11" width="7" height="10" rx="2" fill="#0f6b40" />
        <path d="M8 28 L32 7 L56 28 Z" fill="#0f6b40" stroke="#0f6b40" strokeWidth="4" strokeLinejoin="round" />
        {cuaSo && <circle cx="32" cy="21" r="3.2" fill="#dff3ea" />}
        <rect x="13" y="26" width="38" height="30" rx="11" fill="#22a065" />
        {eyes === 'mo' ? (
          <>
            <g className={animated ? 'bc-blink' : undefined}>
              <circle cx="25" cy="40" r="2.7" fill="#06281a" />
              <circle cx="39" cy="40" r="2.7" fill="#06281a" />
            </g>
            <path d="M28.5 45.5 Q32 48.5 35.5 45.5" stroke="#06281a" strokeWidth="2" fill="none" strokeLinecap="round" />
          </>
        ) : (
          <path
            d="M22.5 40 Q25 42.5 27.5 40 M36.5 40 Q39 42.5 41.5 40"
            stroke="#06281a"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
          />
        )}
        {blush && (
          <>
            <circle cx="19.5" cy="44.5" r="2.6" fill="#ffb1b1" />
            <circle cx="44.5" cy="44.5" r="2.6" fill="#ffb1b1" />
          </>
        )}
      </g>
    </svg>
  );
}
