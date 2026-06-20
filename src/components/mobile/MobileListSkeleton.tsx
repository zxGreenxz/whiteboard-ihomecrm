// Skeleton danh sách cho các màn app mobile (.cm-app). Dùng lại đúng shell
// layout thật (.ctr / .cust / .lrow) + các thanh .sk (shimmer định nghĩa trong
// mobileApp.css / contractsMobile.css) để khung không nhảy khi data về.
// Chỉ hiện khi CHƯA có data (lần đầu cache nguội); đã prefetch/cache thì bỏ qua.

interface Props {
  variant: 'contract' | 'customer' | 'invoice';
  /** Số dòng giả. */
  rows?: number;
}

const Bar = ({ w, h = 13 }: { w: number | string; h?: number }) => (
  <span className="sk" style={{ display: 'block', width: w, height: h }} />
);

export default function MobileListSkeleton({ variant, rows = 6 }: Props) {
  const items = Array.from({ length: rows });

  if (variant === 'contract') {
    return (
      <div className="rowlist" aria-busy="true">
        {items.map((_, i) => (
          <div className="ctr" key={i} style={{ borderColor: 'var(--line)' }}>
            <span className="ctr-bar" style={{ background: 'var(--line-2)' }} />
            <div className="ctr-body" style={{ display: 'grid', gap: 8 }}>
              <Bar w="55%" />
              <Bar w="40%" h={12} />
              <Bar w="70%" h={12} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'customer') {
    return (
      <div className="rowlist" aria-busy="true">
        {items.map((_, i) => (
          <div className="cust" key={i}>
            <div className="cust-body" style={{ display: 'grid', gap: 8 }}>
              <Bar w="50%" />
              <Bar w="65%" h={12} />
              <Bar w="45%" h={12} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // invoice
  return (
    <div className="rowlist" aria-busy="true">
      {items.map((_, i) => (
        <div className="lrow" key={i}>
          <span className="lrow-bar" style={{ background: 'var(--line-2)' }} />
          <div className="lrow-body" style={{ display: 'grid', gap: 8 }}>
            <Bar w="55%" />
            <Bar w="75%" h={12} />
          </div>
          <div className="lrow-r">
            <Bar w={64} h={15} />
          </div>
        </div>
      ))}
    </div>
  );
}
