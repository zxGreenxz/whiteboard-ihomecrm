// Trang "Báo chi nhanh" (/chi-tieu): gõ, nói hoặc chụp bill ⇒ mỗi khoản thành một thẻ nháp sửa được ⇒
// bấm Lưu mới ghi. Khoản công ty thành phiếu chi (bộ máy chi quyết Đã duyệt/Chờ duyệt như phiếu lập
// tay); khoản cá nhân vào Ví thu chi cá nhân. Điện thoại: khung app (.cm-app), ô nhập dính đáy; máy
// tính: cột giữa trong MainLayout.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Loader2, MessageSquarePlus, RotateCcw, Sparkles } from "lucide-react";
import "@/styles/mobileApp.css";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/loading/LoadingState";
import { DraftCard } from "@/components/quick-entry/DraftCard";
import { QuickEntryComposer } from "@/components/quick-entry/QuickEntryComposer";
import { useAuth } from "@/hooks/useAuth";
import { usePhoneViewport } from "@/hooks/use-mobile";
import { useQuickEntryFeed, type FeedMessage } from "@/hooks/quick-entry/useQuickEntryFeed";
import { useQuickEntryRefs } from "@/hooks/quick-entry/useQuickEntryRefs";
import { PERSONAL_CATEGORIES } from "@/lib/personalCategories";
import type { DraftMode } from "@/lib/quickEntry/draft";
import { loadChoice, requestedModels, saveChoice, type ModelChoice } from "@/lib/quickEntry/models";
import { vnTodayISO } from "@/lib/vnDate";

const TITLE = "Báo chi nhanh";
const modeKey = (userId: string) => `ihome:quick-entry:mode:${userId}`;
const PARAM_MODE: Record<string, DraftMode> = { "cong-ty": "company", "ca-nhan": "personal" };

function storedMode(userId: string | null): DraftMode | null {
  if (!userId) return null;
  let v: string | null = null;
  try {
    v = localStorage.getItem(modeKey(userId));
  } catch {
    // Trình duyệt chặn lưu trữ ⇒ không nhớ chế độ lần trước; trang rơi về chế độ đầu tiên theo quyền.
  }
  return v === "company" || v === "personal" ? v : null;
}

function UserBubble({ m }: { m: FeedMessage }) {
  if (m.kind === "restored") return null;
  return (
    <div className="flex justify-end">
      {m.kind === "photo" ? (
        <div className="flex max-w-[85%] flex-col items-end gap-1">
          {m.previewUrl ? (
            <img src={m.previewUrl} alt="Ảnh bill đã gửi" className="max-h-40 rounded-xl border object-cover" />
          ) : (
            <span className="rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">Ảnh bill</span>
          )}
          {m.text && <p className="whitespace-pre-wrap break-words rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">{m.text}</p>}
        </div>
      ) : (
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">{m.text}</p>
      )}
    </div>
  );
}

function EmptyHint({ mode }: { mode: DraftMode }) {
  return (
    <div className="space-y-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid="quick-entry-empty">
      <p className="font-medium text-foreground">Gõ, nói hoặc chụp bill — mỗi khoản thành một thẻ để bạn soát rồi bấm Lưu.</p>
      {mode === "company" ? (
        <ul className="list-disc space-y-1 pl-5">
          <li>“102LVT sơn 300k, keo 20k”</li>
          <li>“hôm qua sửa điện p301 405PVB 350 nghìn”</li>
          <li>Chụp bill điện nước — AI đọc tổng tiền, kỳ và mã khách hàng.</li>
        </ul>
      ) : (
        <ul className="list-disc space-y-1 pl-5">
          <li>“bún bò 50k, xăng 100k”</li>
          <li>“tối qua đi chợ 1 triệu 2”</li>
        </ul>
      )}
    </div>
  );
}

export default function QuickEntryPage() {
  const isPhone = usePhoneViewport();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const refs = useQuickEntryRefs();
  const today = vnTodayISO();
  // Mô hình AI người dùng chọn để tự so sánh — nhớ theo người dùng trên máy; lựa chọn trong phiên gắn với
  // đúng người đã chọn (đăng nhập người khác thì đọc lại lựa chọn của người đó).
  const storedChoice = useMemo(() => loadChoice(userId), [userId]);
  const [picked, setPicked] = useState<{ userId: string | null; choice: ModelChoice } | null>(null);
  const modelChoice = picked && picked.userId === userId ? picked.choice : storedChoice;
  const changeModelChoice = (choice: ModelChoice) => {
    setPicked({ userId, choice });
    saveChoice(userId, choice);
  };
  const feed = useQuickEntryFeed({ refs, userId, today, models: requestedModels(modelChoice) });

  const modes = useMemo<DraftMode[]>(
    () => [...(refs.canCompany ? (["company"] as const) : []), ...(refs.canPersonal ? (["personal"] as const) : [])],
    [refs.canCompany, refs.canPersonal],
  );
  const [chosen, setChosen] = useState<DraftMode | null>(null);
  const wanted = chosen ?? PARAM_MODE[params.get("che-do") ?? ""] ?? storedMode(userId);
  const mode: DraftMode = wanted && modes.includes(wanted) ? wanted : modes[0] ?? "personal";
  const chooseMode = (m: DraftMode) => {
    setChosen(m);
    if (!userId) return;
    try {
      localStorage.setItem(modeKey(userId), m);
    } catch {
      // tiện ích theo máy — mất cũng không sao
    }
  };

  // Tin/thẻ mới ⇒ cuộn tới cuối. Mốc cuối danh sách chạy cho cả hai bố cục (điện thoại cuộn trong
  // .mbody, máy tính cuộn cả trang); scroll-margin chừa chỗ cho ô nhập dính đáy trên máy tính.
  const end = useRef<HTMLDivElement>(null);
  const itemCount = feed.messages.length + Object.keys(feed.cards).length;
  useEffect(() => {
    if (itemCount > 0) end.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [itemCount]);

  const noAccess = !refs.loading && modes.length === 0;

  const feedView: ReactNode = noAccess ? (
    <p className="rounded-xl border p-4 text-sm text-muted-foreground" role="alert">
      Bạn chưa có quyền lập phiếu chi hay ghi Ví cá nhân, nên chưa dùng được trang này.
    </p>
  ) : (
    <div className="space-y-4" data-testid="quick-entry-feed">
      {feed.aiOff && (
        <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground" role="status">
          <Sparkles className="mt-0.5 h-3 w-3 shrink-0" /> {feed.aiOff.message}
        </p>
      )}
      {feed.messages.length === 0 && !refs.loading && <EmptyHint mode={mode} />}
      {feed.messages.map((m) => (
        <section key={m.id} className="space-y-2">
          <UserBubble m={m} />
          {m.reading && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> AI đang đọc…
            </p>
          )}
          {m.note && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-amber-700">
              <span>{m.note}</span>
              {m.aiRetry && !feed.aiOff && (
                <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void feed.retryAi(m.id)}>
                  <RotateCcw className="mr-1 h-3 w-3" /> Thử AI lại
                </Button>
              )}
            </p>
          )}
          {m.cardIds.map((id) => {
            const c = feed.cards[id];
            if (!c) return null;
            return (
              <DraftCard
                key={id}
                state={c.state}
                status={c.status}
                today={today}
                buildings={refs.buildings}
                rooms={refs.rooms}
                categories={refs.categories}
                cashbooks={refs.cashbooks}
                personalCategories={PERSONAL_CATEGORIES}
                photoUrl={c.previewUrl}
                aiModel={c.aiModel}
                defaultAccountFor={refs.defaultAccountFor}
                onChange={(next) => feed.changeCard(id, next)}
                onSave={() => void feed.saveCard(id)}
                onDiscard={() => feed.discardCard(id)}
              />
            );
          })}
        </section>
      ))}
      <div ref={end} style={{ scrollMarginBottom: 160 }} />
    </div>
  );

  // Chờ toà/hạng mục/sổ quỹ: ô soạn là khối xám (chưa cho nhập để khỏi lập thẻ thiếu dữ
  // liệu nền), không chữ "Đang tải…" — chủ chốt 02/10/2026.
  const composer: ReactNode = refs.loading ? (
    <div className="border-t p-3">
      <LoadingState label="toà, hạng mục và sổ quỹ" variant="lines" rows={2} />
    </div>
  ) : noAccess ? null : (
    <QuickEntryComposer
      key={`${userId}:${refs.orgId}`}
      mode={mode}
      modes={modes}
      onModeChange={chooseMode}
      onSubmitText={(text) => void feed.submitText(text, mode)}
      onPhoto={(file, text) => void feed.submitPhoto(file, mode, text)}
      transcribe={feed.transcribe}
      modelChoice={modelChoice}
      onModelChoiceChange={changeModelChoice}
    />
  );

  if (isPhone) {
    return (
      <div className="cm-stage">
        <div className="cm-app">
          <div className="route route-anim">
            <div className="mtop">
              <button className="mback" onClick={() => navigate("/")} aria-label="Về trang chủ">
                <ArrowLeft />
              </button>
              <div className="mtitle">
                <h1>{TITLE}</h1>
                <p>{mode === "company" ? "Ghi phiếu chi công ty" : "Ghi vào Ví cá nhân"}</p>
              </div>
            </div>
            <div className="mbody" style={{ paddingBottom: 16 }}>
              {feedView}
            </div>
            <div style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>{composer}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <MainLayout title={TITLE} subtitle="Tài chính → Nhập nhanh bằng tin nhắn, giọng nói, ảnh bill" icon={MessageSquarePlus}>
      <div className="mx-auto flex max-w-2xl flex-col">
        <div className="pb-4">{feedView}</div>
        <div className="sticky bottom-0 z-10 rounded-t-xl bg-background shadow-[0_-4px_12px_rgba(0,0,0,0.04)]">{composer}</div>
      </div>
    </MainLayout>
  );
}
