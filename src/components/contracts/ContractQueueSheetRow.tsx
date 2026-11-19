import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** Một dòng hồ sơ trong bảng trượt hàng chờ của mobile: cùng cách ghi "P.phòng · toà" với thẻ hợp đồng. */
export function ContractQueueSheetRow({ contractId, room, building, tag, detail, code, note, actions }: {
  contractId: string; room?: string | null; building?: string | null; tag?: ReactNode;
  detail?: ReactNode; code?: ReactNode; note?: ReactNode; actions?: ReactNode;
}) {
  return <div className="cm-qrow">
    <div className="cm-qrow-main">
      <div className="cm-qrow-head">
        <Link to={`/contracts/${contractId}`} className="cm-qrow-loc">P.{room || '—'} · {building || '—'}</Link>
        {tag && <span className="cm-qrow-tag">{tag}</span>}
      </div>
      {detail && <p className="cm-qrow-detail">{detail}</p>}
      {code && <p className="cm-qrow-code">{code}</p>}
      {note}
    </div>
    {actions && <div className="cm-qrow-actions">{actions}</div>}
  </div>;
}
