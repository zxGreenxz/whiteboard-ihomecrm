// v5Copy — TOÀN BỘ chữ hiển thị của hệ v5 tập trung ở đây để lint gain-framing.
// LUẬT (US-3.6): cấm "−/mất/trừ/phạt/rớt" trên MỌI surface phía nhân viên.
// Fail luôn là "còn X ... nữa là đủ ...". Số realtime luôn kèm "TẠM TÍNH".
// Quy ước C13: mốc streak hiển thị DELTA (+500k); tổng luỹ kế ghi tách riêng.

export const V5_BANNED_SUBSTRINGS = [
  "−", // dấu trừ U+2212
  "mất",
  "bị trừ",
  "phạt",
  "rớt",
  "mất chuỗi",
  "thiếu chuẩn",
] as const;

const k = (n: number) => `${Math.round(n / 1000)}k`;

export const v5Copy = {
  // ── Toast / popup realtime ────────────────────────────────────────────
  tickedToast: (amountVnd: number, streak: number, nextInDays: number, nextDeltaVnd: number) =>
    `+${amountVnd.toLocaleString("vi-VN")}đ TẠM TÍNH · chuỗi ${streak} ngày · còn ${nextInDays} ngày tới mốc +${k(nextDeltaVnd)}`,
  tickedToastNoNext: (amountVnd: number, streak: number) =>
    `+${amountVnd.toLocaleString("vi-VN")}đ TẠM TÍNH · chuỗi ${streak} ngày · đã chạm mốc cao nhất tháng này 🏆`,
  milestoneBanked: (milestone: number | "full_month", deltaVnd: number, top?: boolean) =>
    milestone === "full_month" || top
      ? `Trọn tháng! +${k(deltaVnd)} đã KHOÁ 🔒 (giữ nguyên dù nghỉ)`
      : `Mốc ${milestone} ngày! +${k(deltaVnd)} đã KHOÁ 🔒 (giữ nguyên dù nghỉ)`,
  streakNewCycle: "Bắt đầu chuỗi mới 🔥",

  // ── Fail gate tại toà (gain-framing) ─────────────────────────────────
  failBanner: (missingCount: number) => `Còn ${missingCount} mục nữa là đủ công hôm nay`,
  failBannerDwell: (minutesLeft: number) => `Ở lại thêm ${minutesLeft} phút nữa là đủ công hôm nay`,
  presenceSaved: "Đã ghi nhận có mặt tại toà — bổ sung mục còn thiếu trước 23:59 để chốt ngày công",

  // ── Thu tiền + check-nhà-nhanh (A1#3) ────────────────────────────────
  pendingCheckNotify: (buildingName: string) =>
    `Cần check nhà${buildingName ? ` ${buildingName}` : ""} sau khi thu tiền — hoàn thành để chốt ngày công hôm nay`,
  pendingCheckSnoozed: (buildingName: string, remindAt: string) =>
    `Sẽ nhắc lại lúc ${remindAt} — check nhà ${buildingName} để chốt ngày công`,
  quickCheckDone: "Đã check nhanh xong — ngày công hôm nay đã chốt ✅",

  // ── Ngày hôm nay của tôi ─────────────────────────────────────────────
  dayTicked: (source: string) => `Hôm nay đã có ngày công ✅ (${source})`,
  dayNotYet: "Hôm nay chưa có ngày công — con đường ngắn nhất bên dưới 👇",
  missionReason: (vacantRooms: number) =>
    vacantRooms > 0
      ? `${vacantRooms} phòng đang chào khách — ghé hôm nay là chắc 1 ngày công`
      : "Ghé hôm nay là chắc 1 ngày công",
  progressAttend: (ticked: number, n: number) => `${ticked}/${n} ngày công · TẠM TÍNH — chốt khi khoá sổ`,

  // ── Ngày nghỉ (Chủ nhật) ──────────────────────────────────────────────
  restDayTitle: "Hôm nay là Chủ nhật — ngày nghỉ của bạn 🌿",
  restDaySubtitle: "Cứ nghỉ ngơi cho lại sức nhé — chuyên cần và tiền của bạn vẫn nguyên vẹn.",
  restDayThanksWorking:
    "Chủ nhật mà bạn vẫn đi làm — cảm ơn sự tận tâm với khách hàng và với công ty 🙏",
  restDayShowRoute: "Vẫn muốn xem tuyến gợi ý?",

  // ── Phép 1-chạm ──────────────────────────────────────────────────────
  leaveRequested: (date: string) => `Đã gửi xin phép ngày ${date} — đang chờ duyệt (chuỗi được giữ tạm)`,
  leaveApproved: (date: string) =>
    `Phép ngày ${date} đã duyệt ✅ — ngày trung tính, chuỗi được bắc cầu, đơn giá ngày tự điều chỉnh`,
  leaveDeclined: (date: string) => `Phép ngày ${date} chưa được duyệt — trao đổi thêm với chủ nhé`,

  // ── Digest / recap ───────────────────────────────────────────────────
  digestTitle: (count: number) => `Tuyến hôm nay: ${count} toà nên ghé`,
  recapLine: (ticked: boolean, sessions: number, streak: number) =>
    ticked
      ? `Hôm nay: 1 ngày công ✅ · ${sessions} lượt ghé toà · chuỗi ${streak} ngày`
      : `Hôm nay: ${sessions} lượt ghé toà · ngày công sẽ chốt khi hoàn tất phiên đạt chuẩn`,

  // ── Kháng nghị / nghi án (phía nhân viên — trung tính, không buộc tội) ─
  flagNotice: (date: string) =>
    `Ngày ${date} đang được chủ xem lại bằng chứng — bạn có 48h để phản hồi trong app`,
  expiredNeutral: "Phiên hôm đó đã đóng lúc 23:59 — hôm nay là cơ hội mới 💪",
} as const;

export type V5CopyKey = keyof typeof v5Copy;
