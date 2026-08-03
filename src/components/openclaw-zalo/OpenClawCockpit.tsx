import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  BookOpenText,
  CalendarClock,
  Inbox,
  LayoutDashboard,
  Settings2,
} from "lucide-react";
import OpenClawBoundaryState from "./OpenClawBoundaryState";
import OpenClawCommandBar from "./OpenClawCommandBar";
import OpenClawSectionNav, {
  type OpenClawSection,
} from "./OpenClawSectionNav";
import { useOpenClawRouteContext } from "./OpenClawRouteGuard";
import OpenClawConnectionSection from "./dialogs/OpenClawConnectionSection";
import OpenClawSectionBody from "./OpenClawSectionBody";
import { openClawQueryKeys } from "@/hooks/openclaw-zalo/queryKeys";

interface OpenClawCockpitProps {
  mobile: boolean;
}

const SECTION_COPY = {
  overview: {
    icon: LayoutDashboard,
    eyebrow: "Tình trạng tức thời",
    title: "Tổng quan vận hành",
    description: "Kết nối, lưu lượng, hàng đợi, automation, consent và cảnh báo của tổ chức.",
  },
  inbox: {
    icon: Inbox,
    eyebrow: "Hội thoại theo tài khoản",
    title: "Hộp thư",
    description: "Conversation list, thread, bản nháp AI, gửi thủ công, takeover và media.",
  },
  automation: {
    icon: Bot,
    eyebrow: "Mặc định an toàn",
    title: "Tự động hóa",
    description: "Inbound reply, proactive sequence, policy wizard, dry-run và phiên bản bất biến.",
  },
  knowledge: {
    icon: BookOpenText,
    eyebrow: "Nguồn có kiểm soát",
    title: "Tri thức",
    description: "Nguồn nội dung, bản nháp, bản published, retrieval preview và audit.",
  },
  schedules: {
    icon: CalendarClock,
    eyebrow: "Đúng nhóm, đúng thời điểm",
    title: "Lịch & Nhóm sale",
    description: "Lịch gửi, allowlist nhóm, directory freshness và CRM event trigger.",
  },
  operations: {
    icon: Settings2,
    eyebrow: "Kiểm soát và bằng chứng",
    title: "Vận hành",
    description: "Cell, queue, UNKNOWN, dead-letter, retention, health và emergency controls.",
  },
} as const;

export default function OpenClawCockpit({ mobile }: OpenClawCockpitProps) {
  const {
    organizations,
    organization,
    selectedOrganizationId,
    selectOrganization,
    bootstrap,
    can,
  } = useOpenClawRouteContext();
  const [activeSection, setActiveSection] = useState<OpenClawSection>("overview");
  const [connectionOpen, setConnectionOpen] = useState(false);
  const queryClient = useQueryClient();
  const account = bootstrap.account;
  const control = bootstrap.control;
  const section = SECTION_COPY[activeSection];
  const SectionIcon = section.icon;
  const paused = Boolean(
    control?.globalStop
      || control?.featureEnabled === false
      || (account && account.configuredMode !== account.effectiveMode),
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden bg-[#f7f2e8] text-[#102a43]">
      <OpenClawCommandBar
        organizations={organizations}
        selectedOrganizationId={selectedOrganizationId}
        onOrganizationChange={selectOrganization}
        organizationName={organization.name}
        accountName={account?.displayName ?? null}
        connectionHealth={account?.sessionRiskState ?? "NO_ACCOUNT"}
        configuredMode={account?.configuredMode ?? null}
        effectiveMode={account?.effectiveMode ?? null}
        paused={paused}
        globalStop={control?.globalStop ?? false}
        canManageOperations={can("manage_operations")}
        onGlobalStop={() => setActiveSection("operations")}
      />

      {!mobile && (
        <OpenClawSectionNav
          activeSection={activeSection}
          onSectionChange={setActiveSection}
          mobile={false}
        />
      )}

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3 pb-20 sm:p-5 md:pb-5">
        {!account ? (
          <OpenClawBoundaryState state="no-account" />
        ) : (
          <section className="mx-auto w-full max-w-6xl border border-[#aebdc8] bg-[#fffdf8]">
            <header className="flex items-start gap-4 border-b border-[#d3dce2] p-5 sm:p-7">
              <span className="grid h-12 w-12 shrink-0 place-items-center border border-[#78a99e] bg-[#dfeee9] text-[#0b5d51]">
                <SectionIcon className="h-6 w-6" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#0f766e]">{section.eyebrow}</p>
                <h1 className="mt-1 text-2xl font-black tracking-[-0.035em] sm:text-3xl">{section.title}</h1>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-[#526777]">{section.description}</p>
              </div>
            </header>

            <OpenClawSectionBody
              activeSection={activeSection}
              connectionState={account.connectionState}
              canManageConnections={can("manage_connections")}
              onReconnect={() => setConnectionOpen(true)}
            >
              <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-7 lg:grid-cols-3">
                <article className="min-h-32 border border-[#cbd5df] bg-white p-4">
                  <p className="text-xs font-extrabold uppercase tracking-[0.1em] text-[#607585]">Phạm vi</p>
                  <p className="mt-3 text-sm font-bold">{organization.name}</p>
                  <p className="mt-1 text-xs leading-5 text-[#607585]">Tài khoản: {account.displayName}</p>
                </article>
                <article className="min-h-32 border border-[#cbd5df] bg-white p-4">
                  <p className="text-xs font-extrabold uppercase tracking-[0.1em] text-[#607585]">Trạng thái</p>
                  <p className="mt-3 text-sm font-bold">{account.connectionState}</p>
                  <p className="mt-1 text-xs leading-5 text-[#607585]">Mọi trạng thái luôn có nhãn chữ và bằng chứng canonical.</p>
                </article>
                <article className="min-h-32 border border-[#cbd5df] bg-white p-4 sm:col-span-2 lg:col-span-1">
                  <p className="text-xs font-extrabold uppercase tracking-[0.1em] text-[#607585]">Khu vực đang mở</p>
                  <p className="mt-3 text-sm font-bold">{section.title}</p>
                  <p className="mt-1 text-xs leading-5 text-[#607585]">Các workflow chi tiết được gắn vào shell theo từng phase kế tiếp.</p>
                </article>
              </div>
            </OpenClawSectionBody>
          </section>
        )}
      </main>

      <OpenClawConnectionSection
        open={connectionOpen}
        onClose={() => setConnectionOpen(false)}
        onConnected={() => {
          // The bootstrap has staleTime 15s and no refetchInterval, so without this
          // a successful scan left the cockpit showing the disconnected boundary
          // until something unrelated happened to refetch.
          setConnectionOpen(false);
          void queryClient.invalidateQueries({ queryKey: openClawQueryKeys.all });
        }}
      />

      {mobile && (
        <OpenClawSectionNav
          activeSection={activeSection}
          onSectionChange={setActiveSection}
          mobile
        />
      )}
    </div>
  );
}
