import { Ban, ShieldCheck } from "lucide-react";

import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { NETWORK_ACTION_DEFINITIONS } from "@/lib/network-center/model";
import { NetworkActionDialog } from "../NetworkActionDialog";

export function ConfigurationTab({ site, controller }: { site: NetworkBuilding; controller: NetworkCenterController }) {
  return (
    <div className="nc-tab-stack">
      <section className="nc-panel">
        <div className="nc-panel-heading">
          <div><p className="nc-eyebrow">Trạng thái mong muốn</p><h3>Cấu hình an toàn</h3></div>
          <NetworkActionDialog site={site} canExecute={controller.canExecute} disabledReason={controller.executeDisabledMessage} isDemo={controller.isDemo} onExecute={(request) => controller.executeAction(site.buildingId, request)} />
        </div>
        <p className="nc-footnote">{controller.isDemo
          ? "Mọi thao tác trong màn hình này chỉ mô phỏng cục bộ trong bộ nhớ trình duyệt."
          : "Mọi thao tác được kiểm tra quyền, backup trước thay đổi và ghi audit trước khi worker thực thi."}</p>
        <dl className="nc-definition-grid">
          <div><dt>Định danh router</dt><dd>{site.router.identity}</dd></div>
          <div><dt>RouterOS</dt><dd>{site.router.firmware} · chuẩn {site.router.targetFirmware}</dd></div>
          <div><dt>WAN</dt><dd>Theo dõi và gia hạn kết nối; không thiết kế lại tuyến mặc định</dd></div>
          <div><dt>Firewall</dt><dd>Giữ nguyên thứ tự; không sửa luật thô</dd></div>
          <div><dt>Quy tắc backup</dt><dd>Bắt buộc trước thao tác có rủi ro</dd></div>
          <div><dt>Aruba</dt><dd>Chỉ để theo dõi</dd></div>
        </dl>
      </section>
      <section className="nc-action-catalog" aria-label="Danh mục thao tác được phép">
        {NETWORK_ACTION_DEFINITIONS.map((action) => (
          <article key={action.type}>
            <span><ShieldCheck /> Được phép · {action.risk}</span>
            <h4>{action.label}</h4><p>{action.description}</p>
            <dl><div><dt>Xem trước</dt><dd>{action.preview}</dd></div><div><dt>Kiểm tra sau</dt><dd>{action.postCheck}</dd></div></dl>
          </article>
        ))}
        <article className="nc-action-denied"><span><Ban /> Không hỗ trợ</span><h4>Phạm vi bị khoá</h4><p>CLI tuỳ ý, thiết kế lại tuyến WAN mặc định, sắp xếp lại firewall, khôi phục toàn bộ và mọi thao tác ghi Aruba.</p></article>
      </section>
    </div>
  );
}
