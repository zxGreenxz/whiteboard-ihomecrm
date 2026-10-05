import { DraftCard } from "./DraftCard";
import {
  QuickEntryComposer,
  type QuickEntryComposerProps,
} from "./QuickEntryComposer";
import {
  useQuickEntryController,
  type QuickEntryController,
} from "@/hooks/quick-entry/useQuickEntryController";
import { usePersonalFinanceMutation } from "@/hooks/personal-finance/usePersonalFinance";
import { Button } from "@/components/ui/button";
import { useState } from "react";

export function QuickEntryInput({
  controller: c,
  onSubmitted,
  appearance,
  launchAction,
}: {
  controller: QuickEntryController;
  onSubmitted?: () => void;
  appearance?: "personal";
  launchAction?: QuickEntryComposerProps["launchAction"];
}) {
  return (
    <div>
      {c.loading && <p role="status">Đang tải dữ liệu nhập khoản…</p>}
      {c.error && (
        <p role="alert">
          Không tải được dữ liệu{" "}
          {c.mode === "personal" ? "ví cá nhân" : "công ty"}. Thử tải lại.
        </p>
      )}
      {!c.loading && !c.error && !c.modes.length && (
        <p role="status">Bạn chưa có quyền nhập khoản tại đây.</p>
      )}
      <QuickEntryComposer
        launchAction={launchAction}
        appearance={appearance}
        disabled={!c.ready}
        placeholder="Nhập nội dung thu hoặc chi…"
        mode={c.mode}
        modes={c.modes}
        onModeChange={c.setMode}
        transcribe={c.feed.transcribe}
        onSubmitText={(text) => {
          void c.feed.submitText(text, c.mode);
          onSubmitted?.();
        }}
        onPhoto={(file, text) => {
          void c.feed.submitPhoto(file, c.mode, text);
          onSubmitted?.();
        }}
      />
    </div>
  );
}
export function QuickEntryDraftFeed({
  controller: c,
  inDialog,
  onlyCardId,
}: {
  controller: QuickEntryController;
  inDialog?: boolean;
  onlyCardId?: string;
}) {
  return (
    <div className="min-w-0 space-y-3" data-testid="quick-entry-feed">
      {c.feed.messages
        .filter((m) => !onlyCardId || m.cardIds.includes(onlyCardId))
        .map((m) => (
          <section className="space-y-2" key={m.id}>
            {m.text && (
              <p className="break-words text-sm text-muted-foreground">
                {m.text}
              </p>
            )}
            {m.reading && <p role="status">Đang đọc nội dung…</p>}
            {m.note && (
              <p role="status" className="text-sm text-amber-700">
                {m.note}
              </p>
            )}
            {m.aiRetry && (
              <Button
                variant="outline"
                onClick={() => void c.feed.retryAi(m.id)}
              >
                Thử AI lại
              </Button>
            )}
            {m.cardIds
              .filter((id) => !onlyCardId || id === onlyCardId)
              .map((id) => {
                const card = c.feed.cards[id];
                return card ? (
                  <DraftCard
                    inDialog={inDialog}
                    key={id}
                    state={card.state}
                    status={card.status}
                    today={c.today}
                    buildings={c.refs.buildings}
                    rooms={c.refs.rooms}
                    categories={c.refs.categories}
                    cashbooks={c.refs.cashbooks}
                    personalCategories={c.refs.personalCategories}
                    personalWallets={c.refs.personalWallets}
                    defaultAccountFor={c.refs.defaultAccountFor}
                    aiModel={card.aiModel}
                    photoUrl={card.previewUrl}
                    onChange={(state) => c.feed.changeCard(id, state)}
                    onSave={() => void c.feed.saveCard(id)}
                    onDiscard={() => c.feed.discardCard(id)}
                  />
                ) : null;
              })}
          </section>
        ))}
    </div>
  );
}
/** Also recovers manual wallet/category/budget/goal operations after reload. Never edits an unknown payload. */
export function PersonalPendingRequests({
  mayRetry,
}: { mayRetry?: (action: string) => boolean } = {}) {
  const writer = usePersonalFinanceMutation();
  const [error, setError] = useState<string | null>(null);
  if (writer.pendingError)
    return <p role="alert">{writer.pendingError.message}</p>;
  return (
    <div className="space-y-2">
      {writer.pending.map((p) => (
        <div key={p.requestKey} className="rounded-lg border p-3 text-sm">
          <p>
            Yêu cầu chưa xác nhận:{" "}
            {(
              {
                transaction: "giao dịch",
                wallet: "ví",
                category: "danh mục",
                budget: "ngân sách",
                goal: "mục tiêu",
                transfer: "chuyển tiền",
              } as Record<string, string>
            )[p.payload.action.split(".")[0]] ?? "thay đổi ví"}
          </p>
          {(!mayRetry || mayRetry(p.payload.action)) && (
            <Button
              disabled={writer.isPending}
              variant="outline"
              onClick={() => {
                setError(null);
                void writer
                  .retry(p.requestKey)
                  .catch((e) =>
                    setError(
                      e instanceof Error ? e.message : "Chưa xác nhận kết quả.",
                    ),
                  );
              }}
            >
              Gửi lại y nguyên
            </Button>
          )}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function EmbeddedQuickEntry() {
  const controller = useQuickEntryController();
  return (
    <div className="min-w-0 space-y-3">
      <QuickEntryInput controller={controller} />
      <QuickEntryDraftFeed controller={controller} />
      <PersonalPendingRequests />
    </div>
  );
}
