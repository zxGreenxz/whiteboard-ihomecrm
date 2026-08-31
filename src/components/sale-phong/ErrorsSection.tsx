/**
 * Mục "Lỗi" của tab Thống kê /sale-phong.
 *
 * Bản cũ là một bảng phẳng liệt kê từng dòng sự kiện, và trong thực tế nó chỉ
 * lặp đi lặp lại MỘT thông điệp: `Can't find variable: zaloJSV2` — script cầu
 * nối do trình duyệt in-app của Zalo tiêm vào trang, không phải lỗi của mình.
 * Đo trên dữ liệu thật ngày 31/08/2026: 2.104 trên 2.114 dòng là loại đó. Lỗi
 * thật của ứng dụng bị chôn ở đâu đó giữa chúng.
 *
 * Nên mặc định ở đây là:
 *   - GỘP theo vân tay, xếp theo số lần xảy ra (bảng "Nhóm lỗi");
 *   - CHỈ hiện lỗi của ứng dụng, còn nhóm ngoài app nằm sau một bộ lọc — vẫn
 *     ghi, vẫn xem được, nhưng không được phép lấp mất lỗi thật;
 *   - thanh trạng thái in tổng THẬT theo bộ lọc (từ pra_summary) kèm khoảng
 *     ngày đang lọc — con số cũ nói "70" chỉ vì bộ lọc ngày đang là 4 ngày,
 *     khiến người đọc tưởng hệ thống chỉ ghi được 70 lỗi.
 *
 * HAI ĐƠN VỊ, ĐỪNG LẪN. `errors`/`errors_external` đếm CẶP (phiên × vân tay) —
 * "bao nhiêu lượt khách dính". `error_groups*` đếm VÂN TAY — "bao nhiêu lỗi
 * riêng biệt", đúng số dòng bảng dưới. Đo production 31/08: ngoài app có 688
 * lượt phiên nhưng chỉ 2 lỗi riêng biệt; gọi 688 là "nhóm" là sai 344 lần.
 */
import { useState } from "react";
import { format, parseISO } from "date-fns";
import { AlertTriangle, Globe, ChevronRight } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { ChartCard } from "@/components/finance-analysis/ChartCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { parseUA, sourceLabel } from "./analyticsUtils";
import {
  usePraErrorGroups, usePraErrors, usePraSummary,
  type PraErrorGroupRow, type PraErrorRow, type PraErrorSource, type PraFilters,
} from "@/hooks/usePublicRoomsAnalytics";

type SourceFilter = PraErrorSource | "all";
type ViewMode = "groups" | "timeline";

const SOURCE_TABS: { value: SourceFilter; label: string }[] = [
  { value: "app", label: "Lỗi ứng dụng" },
  { value: "external", label: "Ngoài app" },
  { value: "all", label: "Tất cả" },
];

const fmtTs = (iso: string) => {
  try { return format(parseISO(iso), "dd/MM HH:mm"); } catch { return iso; }
};
const num = (v: number) => v.toLocaleString("vi-VN");

function SourceBadge({ source }: { source: PraErrorSource }) {
  return source === "external" ? (
    <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700">
      <Globe className="h-3 w-3" />Ngoài app
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 border-red-300 text-red-700">
      <AlertTriangle className="h-3 w-3" />Ứng dụng
    </Badge>
  );
}

export default function ErrorsSection({ f }: { f: PraFilters }) {
  const [source, setSource] = useState<SourceFilter>("app");
  const [view, setView] = useState<ViewMode>("groups");
  const [chiTiet, setChiTiet] = useState<PraErrorGroupRow | PraErrorRow | null>(null);

  const summary = usePraSummary(f);
  const s = summary.data;

  const period =
    f.start && f.end
      ? `${format(parseISO(f.start), "dd/MM/yyyy")} – ${format(parseISO(f.end), "dd/MM/yyyy")}`
      : "";

  return (
    <div className="space-y-4">
      {/* Thanh trạng thái: nói thẳng tổng thật của kỳ đang lọc, kèm khoảng ngày,
          để không ai đọc nhầm "số dòng đang hiện" thành "tất cả lỗi từng ghi". */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
        <span className="text-muted-foreground">{period ? `Kỳ ${period}` : "Chưa chọn khoảng ngày"}</span>
        <span>
          <b className="text-red-600">{num(s?.error_groups ?? 0)}</b> lỗi ứng dụng
          <span className="text-muted-foreground">
            {" · "}{num(s?.errors ?? 0)} lượt phiên dính
            {s?.error_hits ? ` · ${num(s.error_hits)} lần xảy ra` : ""}
          </span>
        </span>
        <span className="text-muted-foreground">
          <b className="text-amber-600">{num(s?.error_groups_external ?? 0)}</b> lỗi ngoài app
          {" · "}{num(s?.errors_external ?? 0)} lượt phiên (WebView / tiện ích bên thứ ba)
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {SOURCE_TABS.map((t) => (
          <Button
            key={t.value}
            size="sm"
            variant={source === t.value ? "default" : "outline"}
            aria-pressed={source === t.value}
            onClick={() => setSource(t.value)}
          >
            {t.label}
          </Button>
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        <Button
          size="sm"
          variant={view === "groups" ? "secondary" : "ghost"}
          aria-pressed={view === "groups"}
          onClick={() => setView("groups")}
        >
          Nhóm lỗi
        </Button>
        <Button
          size="sm"
          variant={view === "timeline" ? "secondary" : "ghost"}
          aria-pressed={view === "timeline"}
          onClick={() => setView("timeline")}
        >
          Dòng thời gian
        </Button>
      </div>

      {view === "groups" ? (
        <GroupsTable f={f} source={source} onOpen={setChiTiet} />
      ) : (
        <TimelineTable f={f} source={source} onOpen={setChiTiet} />
      )}

      <ChiTietDialog row={chiTiet} onClose={() => setChiTiet(null)} />
    </div>
  );
}

/* ===== Nhóm lỗi ===== */
function GroupsTable({
  f, source, onOpen,
}: { f: PraFilters; source: SourceFilter; onOpen: (r: PraErrorGroupRow) => void }) {
  const LIMIT = 100;
  const { data = [], isLoading, isPlaceholderData } = usePraErrorGroups(f, source, LIMIT);
  const chamTran = data.length >= LIMIT;

  const exportRows = data.map((r) => ({
    "Thông điệp": r.message ?? "",
    "Loại": r.kind ?? "",
    "Nguồn": sourceLabel(r.source),
    "Số lần": r.total_count,
    "Số phiên": r.sessions,
    "Lần đầu": r.first_seen,
    "Lần cuối": r.last_seen,
    "Vị trí": r.context ?? "",
    "Trình duyệt mẫu": parseUA(r.sample_user_agent),
    "Bản build": r.sample_build ?? "",
    "Trang": r.sample_href ?? "",
    "Vân tay": r.fingerprint,
  }));

  return (
    <ChartCard
      title={`Nhóm lỗi (${data.length})`}
      loading={isLoading || isPlaceholderData}
      height={200}
      action={data.length ? <ExportButtons data={exportRows} filename={`nhom-loi-${f.start}_${f.end}`} /> : undefined}
      footnote={
        <p className="text-xs text-muted-foreground">
          Mỗi dòng là một lỗi riêng biệt (gộp theo vân tay). "Số lần" cộng cả những
          lần lặp lại trong cùng một phiên. Tối đa {LIMIT} nhóm mỗi lần xem.
          {chamTran ? (
            <b className="text-amber-700">
              {" "}Đã chạm trần {LIMIT} — còn nhóm chưa hiện (kể cả trong file xuất), hãy thu hẹp khoảng ngày.
            </b>
          ) : null}
        </p>
      }
    >
      {!data.length ? (
        <div className="grid h-[180px] place-items-center text-sm text-muted-foreground">
          Không có nhóm lỗi nào trong kỳ — tốt!
        </div>
      ) : (
        <div className="max-h-[520px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Thông điệp</TableHead>
                <TableHead className="w-[130px]">Nguồn</TableHead>
                <TableHead className="w-[90px] text-right">Số lần</TableHead>
                <TableHead className="w-[90px] text-right">Phiên</TableHead>
                <TableHead className="w-[110px]">Lần cuối</TableHead>
                <TableHead className="w-[140px]">Trình duyệt</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow
                  key={r.fingerprint}
                  className="cursor-pointer"
                  tabIndex={0}
                  role="button"
                  aria-label={`Xem chi tiết lỗi: ${r.message ?? "không có thông điệp"}`}
                  onClick={() => onOpen(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(r); }
                  }}
                >
                  <TableCell className="max-w-[420px] text-xs">
                    <div className="truncate font-medium" title={r.message ?? ""}>{r.message ?? "—"}</div>
                    <div className="truncate text-muted-foreground" title={r.context ?? ""}>
                      {r.kind ?? "—"}{r.context ? ` · ${r.context}` : ""}
                    </div>
                  </TableCell>
                  <TableCell><SourceBadge source={r.source} /></TableCell>
                  <TableCell className="text-right text-xs tabular-nums font-medium">{num(r.total_count)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{num(r.sessions)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtTs(r.last_seen)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{parseUA(r.sample_user_agent)}</TableCell>
                  <TableCell><ChevronRight className="h-4 w-4 text-muted-foreground" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </ChartCard>
  );
}

/* ===== Dòng thời gian ===== */
function TimelineTable({
  f, source, onOpen,
}: { f: PraFilters; source: SourceFilter; onOpen: (r: PraErrorRow) => void }) {
  const LIMIT = 300;
  const { data = [], isLoading, isPlaceholderData } = usePraErrors(f, LIMIT, source);
  const chamTran = data.length >= LIMIT;

  const exportRows = data.map((r) => ({
    "Thời điểm": r.created_at,
    "Loại": r.kind ?? "",
    "Nguồn": sourceLabel(r.source),
    "Thông điệp": r.message ?? "",
    "Số lần": r.n,
    "Vị trí": r.context ?? "",
    "Dòng": r.line_no ?? "",
    "Cột": r.col_no ?? "",
    "Trang": r.href ?? "",
    "Link": r.token,
    "Phiên": r.session_id,
    "Trình duyệt": parseUA(r.user_agent),
    "Màn hình": r.viewport ?? "",
    "Bản build": r.build ?? "",
    "User agent": r.user_agent ?? "",
    "Stack": r.stack ?? "",
  }));

  return (
    <ChartCard
      title={`Nhật ký lỗi (${data.length})`}
      loading={isLoading || isPlaceholderData}
      height={200}
      action={data.length ? <ExportButtons data={exportRows} filename={`nhat-ky-loi-${f.start}_${f.end}`} /> : undefined}
      footnote={
        <p className="text-xs text-muted-foreground">
          Một dòng cho mỗi (phiên · lỗi); lỗi lặp trong cùng phiên hiện ở cột "Số
          lần". Tối đa {LIMIT} dòng mới nhất.
          {chamTran ? (
            <b className="text-amber-700">
              {" "}Đã chạm trần {LIMIT} — còn dòng chưa hiện (kể cả trong file xuất), hãy thu hẹp khoảng ngày.
            </b>
          ) : null}
        </p>
      }
    >
      {!data.length ? (
        <div className="grid h-[180px] place-items-center text-sm text-muted-foreground">
          Chưa có lỗi nào trong kỳ — tốt!
        </div>
      ) : (
        <div className="max-h-[520px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">Thời điểm</TableHead>
                <TableHead className="w-[120px]">Loại</TableHead>
                <TableHead className="w-[130px]">Nguồn</TableHead>
                <TableHead>Thông điệp</TableHead>
                <TableHead className="w-[70px] text-right">Số lần</TableHead>
                <TableHead className="w-[140px]">Trình duyệt</TableHead>
                <TableHead className="w-[110px]">Link</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow
                  key={`${r.session_id}-${r.fingerprint}-${r.created_at}`}
                  className="cursor-pointer"
                  tabIndex={0}
                  role="button"
                  aria-label={`Xem chi tiết lỗi: ${r.message ?? "không có thông điệp"}`}
                  onClick={() => onOpen(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(r); }
                  }}
                >
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtTs(r.created_at)}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{r.kind ?? "—"}</Badge></TableCell>
                  <TableCell><SourceBadge source={r.source} /></TableCell>
                  <TableCell className="max-w-[360px] text-xs">
                    <div className="truncate" title={r.message ?? ""}>{r.message ?? "—"}</div>
                    {r.context ? (
                      <div className="truncate text-muted-foreground" title={r.context}>
                        {r.context}{r.line_no != null ? `:${r.line_no}` : ""}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{num(r.n)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{parseUA(r.user_agent)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.token}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </ChartCard>
  );
}

/* ===== Chi tiết ===== */
const isGroup = (r: PraErrorGroupRow | PraErrorRow): r is PraErrorGroupRow =>
  "total_count" in r;

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all">{value}</span>
    </div>
  );
}

function ChiTietDialog({
  row, onClose,
}: { row: PraErrorGroupRow | PraErrorRow | null; onClose: () => void }) {
  if (!row) return null;
  const group = isGroup(row);
  const stack = group ? row.sample_stack : row.stack;
  const ua = group ? row.sample_user_agent : row.user_agent;
  const href = group ? row.sample_href : row.href;
  const build = group ? row.sample_build : row.build;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <SourceBadge source={row.source} />
            <span className="truncate">{row.kind ?? "lỗi"}</span>
          </DialogTitle>
          <DialogDescription className="break-words text-left font-medium text-foreground">
            {row.message ?? "(không có thông điệp)"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          {group ? (
            <>
              <Field label="Số lần" value={`${num(row.total_count)} lần · ${num(row.sessions)} phiên`} />
              <Field label="Lần đầu" value={fmtTs(row.first_seen)} />
              <Field label="Lần cuối" value={fmtTs(row.last_seen)} />
              <Field label="Link mẫu" value={row.sample_token} />
            </>
          ) : (
            <>
              <Field label="Thời điểm" value={fmtTs(row.created_at)} />
              <Field label="Số lần" value={`${num(row.n)} lần trong phiên`} />
              <Field label="Phiên" value={row.session_id} />
              <Field label="Link" value={row.token} />
              <Field label="Màn hình" value={row.viewport} />
            </>
          )}
          <Field label="Vị trí" value={row.context} />
          <Field label="Trang" value={href} />
          <Field label="Trình duyệt" value={ua ? `${parseUA(ua)} — ${ua}` : null} />
          <Field label="Bản build" value={build} />
          <Field label="Vân tay" value={row.fingerprint} />
        </div>

        {stack ? (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Ngăn xếp</div>
            <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-[11px] leading-relaxed">{stack}</pre>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Không có ngăn xếp. Trình duyệt giấu chi tiết với script khác nguồn, và
            các dòng ghi trước 31/08/2026 chưa lưu trường này.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
