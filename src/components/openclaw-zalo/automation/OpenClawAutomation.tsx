import {
  AUTOMATION_WIZARD_STEPS,
  dryRunClaim,
  publishGate,
  type AutomationWizardStepKey,
} from "@/lib/openclaw-zalo/automationWizard";
import type { OpenClawControlState, OpenClawMode } from "@/lib/openclaw-zalo/types";

interface OpenClawAutomationProps {
  automationName: string | null;
  mode: OpenClawMode;
  currentStep: number;
  control: OpenClawControlState | null;
  canManageAutomation: boolean;
  dryRunHash: string | null;
  dryRunResult: { eligible: boolean } | null;
  busy: boolean;
  onGoToStep: (step: number) => void;
  onRunDryRun: () => void;
  onPublish: () => void;
}

const STEP_COPY: Record<AutomationWizardStepKey, { title: string; detail: string }> = {
  explain: {
    title: "Giới thiệu và rủi ro",
    detail: "Đây là tài khoản Zalo cá nhân. Quét sai máy sẽ đá phiên; gửi sai sẽ tới người thật.",
  },
  recipients: {
    title: "Nguồn người nhận",
    detail: "Chọn nhóm hoặc tập người nhận đã xác minh.",
  },
  consent: {
    title: "Cơ sở đồng ý và chặn",
    detail: "Khai báo cơ sở pháp lý và cách xử lý khi khách yêu cầu ngừng nhận tin.",
  },
  hours: {
    title: "Giờ, múi giờ, tần suất, điểm dừng",
    detail: "Khai báo khung giờ được phép gửi và giới hạn số tin.",
  },
  template: {
    title: "Mẫu tin và tri thức",
    detail: "Chọn mẫu và các phiên bản tri thức mà bản nháp được phép trích.",
  },
  mode: {
    title: "Chế độ",
    detail: "Chỉ soạn nháp, cần người duyệt, hay tự động.",
  },
  dryRun: {
    title: "Chạy thử không gửi",
    detail: "Xác nhận phiên bản này gọi tới được trước khi xuất bản.",
  },
  publish: {
    title: "Xác nhận và xuất bản",
    detail: "Xuất bản tạo một phiên bản bất biến.",
  },
};

const PUBLISH_BLOCK_COPY = {
  PERMISSION: "Bạn không có quyền xuất bản tự động hoá.",
  FEATURE_DISABLED: "OpenClaw Zalo đang tắt cho tổ chức này.",
  GLOBAL_STOP: "GLOBAL_STOP đang bật. Gỡ dừng khẩn cấp trước.",
  MODE_DISABLED: "Chế độ này chưa được bật cho tổ chức.",
  NO_DRY_RUN: "Phải chạy thử phiên bản này trước khi xuất bản.",
} as const;

const DRY_RUN_COPY = {
  NOT_RUN: "Chưa chạy thử phiên bản này.",
  // Worded to the evidence: the RPC renders nothing and evaluates no policy.
  VERSION_ADDRESSABLE:
    "Chạy thử xong: phiên bản này gọi tới được. Lưu ý đây KHÔNG phải kiểm tra nội dung "
    + "hay chính sách — máy chủ không dựng thử tin nhắn và không đánh giá giờ gửi, đồng ý "
    + "nhận tin hay giới hạn tần suất ở bước này.",
  VERSION_NOT_ELIGIBLE: "Chạy thử cho biết phiên bản này không dùng được để xuất bản.",
} as const;

export default function OpenClawAutomation(props: OpenClawAutomationProps) {
  const gate = publishGate({
    canManageAutomation: props.canManageAutomation,
    control: props.control,
    mode: props.mode,
    dryRunHash: props.dryRunHash,
  });
  const claim = dryRunClaim(props.dryRunResult);

  return (
    <div className="p-4" data-openclaw-automation="wizard">
      <header>
        <h2 className="text-lg font-black tracking-[-0.02em]">
          {props.automationName ?? "Tự động hoá mới"}
        </h2>
        <p className="mt-1 text-xs leading-5 text-[#607585]">
          Bước {props.currentStep}/{AUTOMATION_WIZARD_STEPS.length} · chế độ {props.mode}
        </p>
      </header>

      <ol className="mt-4 grid gap-2">
        {AUTOMATION_WIZARD_STEPS.map(step => (
          <li key={step.key}>
            <button
              type="button"
              onClick={() => props.onGoToStep(step.id)}
              aria-current={step.id === props.currentStep ? "step" : undefined}
              data-openclaw-step={step.key}
              className={`w-full border px-3 py-2 text-left text-sm ${
                step.id === props.currentStep
                  ? "border-[#0f766e] bg-[#dfeee9]"
                  : "border-[#cbd5df] bg-white"
              }`}
            >
              <span className="font-bold">{step.id}. {STEP_COPY[step.key].title}</span>
              <span className="mt-1 block text-xs leading-5 text-[#607585]">
                {STEP_COPY[step.key].detail}
              </span>
              {/* Saying which steps the server does not enforce is the point: consent
                  lives in openclaw_consents and hours/caps in openclaw_policy_versions,
                  neither writable from a browser. Collecting a declaration and
                  implying it is enforced would be the dishonest version. */}
              {!step.serverBacked && step.key !== "explain" && (
                <span
                  data-openclaw-step-unbacked={step.key}
                  className="mt-1 block text-xs font-bold leading-5 text-[#8a4b12]"
                >
                  Phần này chỉ được ghi nhận như một khai báo. Máy chủ chưa ràng buộc nó, nên
                  đừng coi đây là đã kiểm tra.
                </span>
              )}
              {step.createTimeOnly && (
                <span
                  data-openclaw-step-frozen={step.key}
                  className="mt-1 block text-xs leading-5 text-[#607585]"
                >
                  Chỉ đặt được lúc tạo. Sau khi có bản nháp thì sửa ở đây sẽ không được lưu.
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>

      <div className="mt-4 border-t border-[#cbd5df] pt-4">
        <p data-openclaw-dry-run={claim} className="text-sm leading-6">
          {DRY_RUN_COPY[claim]}
        </p>
        <button
          type="button"
          onClick={props.onRunDryRun}
          disabled={props.busy || !props.canManageAutomation}
          data-openclaw-action="automation-dry-run"
          className="mt-2 min-h-11 w-full border border-[#9fb0bf] bg-white px-4 text-sm font-bold text-[#102a43] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Chạy thử không gửi
        </button>

        {gate.blockedBy !== null ? (
          <p
            data-openclaw-publish-blocked={gate.blockedBy}
            className="mt-3 border border-[#d99a6c] bg-[#fdf0e4] p-3 text-sm font-bold text-[#8a4b12]"
          >
            {PUBLISH_BLOCK_COPY[gate.blockedBy]}
          </p>
        ) : (
          <button
            type="button"
            onClick={props.onPublish}
            disabled={props.busy}
            data-openclaw-action="automation-publish"
            className="mt-3 min-h-11 w-full border border-[#0f766e] bg-[#0f766e] px-4 text-sm font-bold text-white disabled:opacity-60"
          >
            Xuất bản phiên bản này
          </button>
        )}

        {/* No badge claiming the disclosure was acknowledged: that gate guards QR
            login only and publish never looks at it. */}
        <p className="mt-2 text-xs leading-5 text-[#607585]">
          Máy chủ không kiểm các trường theo từng chế độ (phạm vi hội thoại, tập người nhận,
          giới hạn theo người, nhóm chính xác…). Wizard ghi lại lựa chọn của bạn nhưng không
          thể nói rằng chúng đã được kiểm.
        </p>
      </div>
    </div>
  );
}
