import { BookOpen, Database, Info } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { BusinessPerformanceFilters } from "@/lib/businessPerformance";

interface DataDefinitionsTabProps {
  filters: BusinessPerformanceFilters;
}

interface DefinitionRowProps {
  label: string;
  children: React.ReactNode;
}

const BUSINESS_MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
});

function currentBusinessMonth() {
  const parts = BUSINESS_MONTH_FORMATTER.formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}`;
}

function formatMonth(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `Tháng ${match[2]}/${match[1]}` : month;
}

function formatIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function formatOrganizationScope(organizationId: string) {
  if (organizationId.length <= 14) return organizationId;
  return `${organizationId.slice(0, 8)}…${organizationId.slice(-4)}`;
}

function DefinitionRow({ label, children }: DefinitionRowProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm leading-relaxed text-foreground">{children}</dd>
    </div>
  );
}

export function DataDefinitionsTab({ filters }: DataDefinitionsTabProps) {
  const isAccrual = filters.basis === "ACCRUAL";
  const isOpenMonth = filters.month === currentBusinessMonth();

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <BookOpen className="size-5 text-primary" aria-hidden="true" />
            Phạm vi và cơ sở đang áp dụng
          </CardTitle>
          <CardDescription>
            Các định nghĩa dưới đây phản ánh đúng bộ lọc đang dùng trên báo cáo
            này.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <dl className="grid gap-5 md:grid-cols-2 xl:grid-cols-5">
            <DefinitionRow label="Tổ chức">
              <span className="font-mono text-xs">
                {formatOrganizationScope(filters.organizationId)}
              </span>
            </DefinitionRow>
            <DefinitionRow label="Kỳ báo cáo">
              {formatMonth(filters.month)}
            </DefinitionRow>
            <DefinitionRow label="Khoảng ngày">
              {formatIsoDate(filters.periodStart)} –{" "}
              {formatIsoDate(filters.periodEnd)}
            </DefinitionRow>
            <DefinitionRow label="Cơ sở ghi nhận">
              {isAccrual
                ? "Dồn tích theo kỳ áp dụng"
                : "Theo voucher_date — dùng để đối chiếu"}
            </DefinitionRow>
            <DefinitionRow label="Phạm vi tòa nhà">
              {filters.buildingIds.length.toLocaleString("vi-VN")} tòa vật lý
              trong phạm vi được chọn
            </DefinitionRow>
          </dl>

          <Separator />

          <p className="text-sm leading-relaxed text-muted-foreground">
            Báo cáo chỉ tổng hợp một tổ chức đã chọn và không gộp dữ liệu giữa
            nhiều tổ chức. Chỉ số chính luôn giới hạn ở tòa vật lý; tòa ảo không
            được cộng vào tổng, xếp hạng hoặc so sánh hiệu quả.
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            ID và tên tổ chức chỉ lấy từ{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              business_performance_organizations_v1
            </code>
            ; trang không suy diễn tên tổ chức từ UUID hoặc danh sách tòa nhà.
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            RPC danh sách xác định tổ chức và các tòa vật lý người dùng được phép
            xem. Mười một RPC chỉ số nhận{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              organization_id
            </code>{" "}
            và{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              building_ids
            </code>
            . Mọi <code className="font-mono text-xs">building_id</code> được yêu
            cầu phải thuộc tổ chức đã chọn và có trong danh sách tòa vật lý được
            cấp quyền; nếu một ID không hợp lệ, toàn bộ yêu cầu bị từ chối trước
            khi trả dữ liệu.
          </p>
        </CardContent>
      </Card>

      {isOpenMonth ? (
        <Alert role="note">
          <Info aria-hidden="true" />
          <AlertTitle>Tháng hiện tại là kỳ đang mở</AlertTitle>
          <AlertDescription>
            Số liệu có thể tiếp tục thay đổi khi phiếu, hợp đồng, phòng và công
            nợ được cập nhật.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Database className="size-5 text-primary" aria-hidden="true" />
              Nguồn dữ liệu
            </CardTitle>
            <CardDescription>
              Nguồn đang được dùng cho từng nhóm chỉ số.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold">Kết quả kinh doanh</h4>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Tổng doanh thu, chi phí và lợi nhuận lấy từ{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  business_performance_pnl_v1
                </code>
                . Cơ cấu Thu/Chi theo hạng mục dùng RPC{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  business_performance_category_breakdown_v1
                </code>{" "}
                trên cùng cơ sở ghi nhận và phạm vi tòa vật lý.
              </p>
              {isAccrual ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Thứ tự ghi nhận ACCRUAL được áp dụng như sau:
                  </p>
                  <ul className="flex flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-primary">
                    <li className="list-disc">
                      Phiếu gắn hóa đơn ghi nhận toàn bộ theo{" "}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                        invoices.billing_month
                      </code>
                      , không theo ngày thu tiền.
                    </li>
                    <li className="list-disc">
                      Phiếu không gắn hóa đơn có kỳ áp dụng từ{" "}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                        start_date
                      </code>{" "}
                      đến{" "}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                        end_date
                      </code>{" "}
                      được phân bổ đều theo tháng trong kỳ hiệu lực.
                    </li>
                    <li className="list-disc">
                      Nếu không có kỳ áp dụng, toàn bộ giá trị rơi vào tháng của{" "}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                        voucher_date
                      </code>
                      .
                    </li>
                  </ul>
                </div>
              ) : (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  VOUCHER_DATE ghi nhận toàn bộ giá trị vào tháng của{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                    voucher_date
                  </code>
                  . Đây là mốc hạch toán và đối chiếu nghiệp vụ; nó không xác
                  nhận thời điểm thực nhận, thực chi hoặc ngân hàng tất toán.
                </p>
              )}
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold">Vai trò tài chính và hòa vốn</h4>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Mapping effective-dated đọc từ{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  business_performance_reporting_roles_v1
                </code>
                ; số hòa vốn tháng chọn và bình quân ba tháng lấy từ{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  business_performance_break_even_v1
                </code>
                . Hòa vốn chỉ trả tỷ lệ khi mapping, tiền thuê chủ nhà, tỷ lệ đóng góp
                và công suất đều hợp lệ.
              </p>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold">KPI thời điểm hiện tại</h4>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Phải thu, tuổi nợ, tiền cọc đang giữ và các KPI live lấy từ{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  business_performance_snapshot_v1
                </code>
                . Đây là ảnh chụp trạng thái hiện tại, không phải số liệu tại
                cuối tháng lịch sử đã chọn.
              </p>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold">Lấp đầy và phòng trống</h4>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Snapshot phòng vật lý hiện tại lấy từ{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  business_performance_occupancy_snapshot_v1
                </code>
                ; lịch phòng sắp trống lấy từ{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  business_performance_upcoming_vacancy_v1
                </code>
                ; xu hướng 12 tháng lấy từ{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  business_performance_occupancy_monthly_v1
                </code>
                . Lịch sử snapshot authoritative lấy từ{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  business_performance_inventory_history_v1
                </code>
                ; tháng trước rollout hoặc lỡ cutoff giữ trạng thái thiếu và giá trị null.
              </p>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold">Cohort hóa đơn và tiền thực thu</h4>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Cohort hóa đơn tách current charge, nợ chuyển tiếp, cọc và settlement qua{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  business_performance_invoice_cohort_v1
                </code>
                . Tiền giữ lại theo ngày payment lấy độc lập từ{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  business_performance_cash_received_v1
                </code>
                , đã loại reversal và collection bị đảo.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Snapshot, độ mới và lịch sử
            </CardTitle>
            <CardDescription>
              Cách đọc mốc thời gian của dữ liệu.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-primary">
              <li className="list-disc">
                Tháng hiện tại chưa kết thúc; nếu chọn kỳ này, số liệu có thể
                tiếp tục thay đổi theo các bản ghi mới.
              </li>
              <li className="list-disc">
                Snapshot hiện tại phản ánh trạng thái live tại thời điểm truy
                vấn; ước tính lịch sử phản ánh giao thoa hợp đồng và không thay
                thế snapshot đã chốt.
              </li>
              <li className="list-disc">
                Snapshot chuẩn chỉ có từ khi hệ thống bắt đầu ghi nhận. Không
                backfill các tháng trước đó từ bảng dữ liệu hiện đang thay đổi.
              </li>
              <li className="list-disc">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  generated_at
                </code>{" "}
                chỉ là thời điểm RPC chạy, không phải thời điểm nguồn dữ liệu
                thay đổi gần nhất.
              </li>
              <li className="list-disc">
                Độ mới của nguồn phải dựa trên timestamp thực tế của bản ghi
                nguồn, tách biệt với thời điểm tạo báo cáo.
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Giới hạn khi diễn giải chỉ số
          </CardTitle>
          <CardDescription>
            Các chỉ số tham chiếu không đại diện cho doanh thu hoặc lợi nhuận đã
            phát sinh.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">
              Giá trị cơ hội phòng available
            </h4>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Được tính từ giá niêm yết hiện tại theo tháng của các phòng đang
              available. Đây là giá trị cơ hội tại thời điểm xem, không phải
              doanh thu thực tế đã mất trong kỳ.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">LN/phòng hiện tại</h4>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Là lợi nhuận của tòa trong kỳ chia cho số phòng vật lý hiện tại.
              Chỉ số này không phải lợi nhuận thực tế của từng phòng và chưa
              phân bổ chi phí chung xuống từng phòng.
            </p>
          </div>
        </CardContent>
      </Card>

      <Alert role="note">
        <Info aria-hidden="true" />
        <AlertTitle>Quy tắc fail-closed vẫn áp dụng theo từng dòng</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <p>
            Hòa vốn chỉ trả tỷ lệ khi vai trò tài chính, tiền thuê chủ nhà, tỷ lệ
            đóng góp và công suất đạt điều kiện; nếu không, RPC trả lý do cụ thể.
          </p>
          <p>
            Cohort hóa đơn tách current charge khỏi nợ chuyển tiếp, tiền cọc và
            settlement. Thiếu payment allocation làm KPI cohort không khả dụng,
            nhưng không che số tiền thực thu theo payment date.
          </p>
          <p>
            Cơ cấu Thu/Chi theo hạng mục dùng RPC tự kiểm tra report action, tổ
            chức, phạm vi tòa và quyền xem hạng mục hạn chế; lỗi truy vấn không
            được đổi thành danh sách rỗng hoặc tổng 0.
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
