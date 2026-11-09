package vn.ihome.diemdanh;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Status of the phone plus the step-by-step permission flow. No consent screen by design. */
public final class MainActivity extends Activity {
    private static final int REQUEST_PERMISSION = 201;
    private static final int RECENT_ROWS = 8;
    private static final long REFRESH_MS = 8_000L;

    private enum Step { NOTIFICATIONS, LOCATION, BACKGROUND, LOCATION_ON, BATTERY, EXACT_ALARM }

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            load();
            ui.postDelayed(this, REFRESH_MS);
        }
    };

    private LinearLayout stepCard, revokedCard, failedCard, recentList;
    private TextView headline, subline, lastRecord, nextSlot, windows, stepProgress, stepTitle, stepBody, failedText;
    private Button stepAction, pauseButton;
    private HealthRow appRow, permissionRow, backgroundRow, batteryRow;
    private Step currentStep;
    private boolean paused;

    private static final class HealthRow {
        final TextView mark;
        final TextView detail;

        HealthRow(TextView mark, TextView detail) {
            this.mark = mark;
            this.detail = detail;
        }

        void set(boolean ok, String text) {
            mark.setText(ok ? "✓" : "!");
            mark.setTextColor(ok ? Ui.GREEN : Ui.WARN);
            detail.setText(text);
        }
    }

    private static final class Snapshot {
        CheckinSettings.State state;
        QueueStore.Stats stats;
        List<QueueStore.SlotRow> recent;
        List<Step> steps;
        String locationPermission;
        boolean locationEnabled;
        boolean batteryIgnored;
        boolean exactAllowed;
        Integer batteryPct;
    }

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildScreen();
    }

    @Override protected void onResume() {
        super.onResume();
        ui.post(refresh);
        io.execute(this::heal);
    }

    @Override protected void onPause() {
        ui.removeCallbacks(refresh);
        super.onPause();
    }

    @Override protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        io.shutdown();
        super.onDestroy();
    }

    /** Opening the app repairs anything a vendor battery manager may have cleared. */
    private void heal() {
        try {
            if (new CheckinSettings(this).load().isActive()) {
                SlotScheduler.ensureArmed(this);
                SafetyNetWork.schedule(this);
                DeliveryWork.schedule(this);
            }
        } catch (RuntimeException error) {
            runOnUiThread(() -> toast("Không đọc được cấu hình của app."));
        }
    }

    private void buildScreen() {
        LinearLayout root = Ui.screen(this);
        Ui.text(root, "iHOME · ĐIỂM DANH", 12, Ui.GREEN, true);
        Ui.text(root, "Điểm danh tự động", 28, Ui.INK, true);

        revokedCard = Ui.card(root);
        Ui.text(revokedCard, "Máy này đã bị gỡ khỏi điểm danh", 19, Ui.ERROR, true);
        Ui.text(revokedCard, "App đã dừng ghi vị trí. Muốn dùng lại, hãy ghép nối bằng mã mới trên CRM.", 15, Ui.MUTED, false);
        Ui.button(revokedCard, "Ghép nối lại", true, this::openPairing);
        revokedCard.setVisibility(View.GONE);

        stepCard = Ui.card(root);
        stepProgress = Ui.text(stepCard, "", 14, Ui.GREEN, true);
        stepTitle = Ui.text(stepCard, "", 19, Ui.INK, true);
        stepBody = Ui.text(stepCard, "", 15, Ui.MUTED, false);
        stepAction = Ui.button(stepCard, "", true, this::runStep);
        Ui.button(stepCard, "Mở cài đặt ứng dụng", false, this::openAppSettings);
        stepCard.setVisibility(View.GONE);

        LinearLayout statusCard = Ui.card(root);
        headline = Ui.text(statusCard, "Đang đọc trạng thái…", 20, Ui.INK, true);
        subline = Ui.text(statusCard, "", 15, Ui.MUTED, false);
        lastRecord = Ui.text(statusCard, "", 16, Ui.INK, false);
        nextSlot = Ui.text(statusCard, "", 16, Ui.INK, false);
        windows = Ui.text(statusCard, "", 15, Ui.MUTED, false);

        LinearLayout healthCard = Ui.card(root);
        Ui.text(healthCard, "Máy của bạn", 19, Ui.INK, true);
        appRow = healthRow(healthCard, "App điểm danh");
        permissionRow = healthRow(healthCard, "Quyền vị trí");
        backgroundRow = healthRow(healthCard, "Chạy nền");
        batteryRow = healthRow(healthCard, "Pin");

        LinearLayout recentCard = Ui.card(root);
        Ui.text(recentCard, "Các mốc gần đây", 19, Ui.INK, true);
        recentList = new LinearLayout(this);
        recentList.setOrientation(LinearLayout.VERTICAL);
        recentCard.addView(recentList, new LinearLayout.LayoutParams(-1, -2));

        failedCard = Ui.card(root);
        failedText = Ui.text(failedCard, "", 15, Ui.WARN, false);
        Ui.button(failedCard, "Gửi lại các mốc lỗi", false, this::retryFailed);
        failedCard.setVisibility(View.GONE);

        pauseButton = Ui.button(root, "Tạm dừng", false, this::togglePause);
        Ui.text(root, "Ngoài khung giờ chủ công ty đặt, app không lấy vị trí và không gửi gì. Khi tạm dừng, các mốc được ghi là «đã tắt» và chủ công ty nhìn thấy.", 14, Ui.MUTED, false);
    }

    private HealthRow healthRow(LinearLayout parent, String title) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, Ui.dp(this, 10), 0, Ui.dp(this, 10));
        TextView mark = new TextView(this);
        mark.setTextSize(16);
        mark.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        row.addView(mark, new LinearLayout.LayoutParams(Ui.dp(this, 26), -2));
        TextView name = new TextView(this);
        name.setText(title);
        name.setTextSize(15);
        name.setTextColor(Ui.INK);
        name.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        row.addView(name, new LinearLayout.LayoutParams(0, -2, 1f));
        TextView detail = new TextView(this);
        detail.setTextSize(14);
        detail.setTextColor(Ui.MUTED);
        detail.setGravity(Gravity.END);
        row.addView(detail, new LinearLayout.LayoutParams(0, -2, 1.4f));
        parent.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return new HealthRow(mark, detail);
    }

    private void load() {
        if (io.isShutdown()) return;
        io.execute(() -> {
            try {
                Snapshot snapshot = new Snapshot();
                snapshot.state = new CheckinSettings(this).load();
                QueueStore queue = new QueueStore(this);
                snapshot.stats = queue.stats();
                snapshot.recent = queue.recentSlots(RECENT_ROWS);
                snapshot.locationPermission = DeviceHealth.locationPermission(this);
                snapshot.locationEnabled = DeviceHealth.locationEnabled(this);
                snapshot.batteryIgnored = DeviceHealth.batteryOptimizationIgnored(this);
                snapshot.exactAllowed = DeviceHealth.exactAlarmAllowed(this);
                snapshot.batteryPct = DeviceHealth.batteryPct(this);
                snapshot.steps = pendingSteps(snapshot);
                runOnUiThread(() -> render(snapshot));
            } catch (RuntimeException error) {
                runOnUiThread(() -> {
                    headline.setText("Không đọc được cấu hình của app");
                    subline.setText("Hãy mở lại app. Dữ liệu chưa gửi vẫn được giữ.");
                });
            }
        });
    }

    private List<Step> pendingSteps(Snapshot snapshot) {
        List<Step> steps = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && !DeviceHealth.granted(this, Manifest.permission.POST_NOTIFICATIONS)) {
            steps.add(Step.NOTIFICATIONS);
        }
        boolean fine = DeviceHealth.granted(this, Manifest.permission.ACCESS_FINE_LOCATION);
        if (!fine) steps.add(Step.LOCATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && !DeviceHealth.granted(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            steps.add(Step.BACKGROUND);
        }
        if (!snapshot.locationEnabled) steps.add(Step.LOCATION_ON);
        if (!snapshot.batteryIgnored) steps.add(Step.BATTERY);
        if (!snapshot.exactAllowed) steps.add(Step.EXACT_ALARM);
        return steps;
    }

    private void render(Snapshot snapshot) {
        if (isFinishing() || isDestroyed()) return;
        CheckinSettings.State state = snapshot.state;
        if (!state.paired) {
            openPairing();
            return;
        }
        paused = state.paused;
        revokedCard.setVisibility(state.revoked ? View.VISIBLE : View.GONE);
        CheckinPolicy.Schedule schedule = state.schedule;
        boolean applies = schedule != null && schedule.enabled && schedule.applies;
        if (state.revoked) {
            headline.setText("Đã dừng ghi vị trí");
            subline.setText("Máy không còn được ghép với tài khoản CRM.");
        } else if (state.paused) {
            headline.setText("Đang tạm dừng");
            subline.setText("Các mốc đến giờ được ghi là «đã tắt», không lấy vị trí.");
        } else if (!applies) {
            headline.setText("Điểm danh tự động đang tắt");
            subline.setText("Chủ công ty chưa bật cho tài khoản của bạn.");
        } else if (needsSetup(snapshot.steps)) {
            headline.setText("Cần thiết lập thêm");
            subline.setText("Làm theo từng bước bên trên để app ghi được vị trí.");
        } else {
            headline.setText("Máy đang tự ghi vị trí");
            subline.setText("Bạn không phải bấm gì, kể cả khi khóa màn hình.");
        }
        long now = state.correctedNow();
        lastRecord.setText("Dấu gần nhất: " + (snapshot.recent.isEmpty() ? "chưa có"
                : CheckinPolicy.slotLabel(snapshot.recent.get(0).slotMs, now, CheckinPolicy.VIETNAM) + " · "
                + CheckinPolicy.outcomeLabel(snapshot.recent.get(0).fixStatus, snapshot.recent.get(0).reason)));
        nextSlot.setText("Mốc kế tiếp: " + (state.armedSlotMs > 0L
                ? CheckinPolicy.slotLabel(state.armedSlotMs, now, CheckinPolicy.VIETNAM) : "chưa có"));
        String windowText = CheckinPolicy.windowsLabel(schedule);
        windows.setText(windowText.isEmpty() ? "" : "Khung giờ: " + windowText);

        renderSteps(snapshot.steps);
        renderHealth(snapshot, state);
        renderRecent(snapshot.recent, now);

        failedCard.setVisibility(snapshot.stats.failed > 0 ? View.VISIBLE : View.GONE);
        failedText.setText(snapshot.stats.failed + " mốc gửi lỗi. Máy chủ từ chối hoặc chưa xác nhận các mốc này.");
        pauseButton.setText(state.paused ? "Tiếp tục ghi vị trí" : "Tạm dừng");
        pauseButton.setVisibility(state.revoked ? View.GONE : View.VISIBLE);
    }

    /** Notifications are the one step a capture can do without. */
    private static boolean needsSetup(List<Step> steps) {
        for (Step step : steps) {
            if (step != Step.NOTIFICATIONS) return true;
        }
        return false;
    }

    private void renderHealth(Snapshot snapshot, CheckinSettings.State state) {
        appRow.set(state.isActive(), state.isActive()
                ? (state.userName.isEmpty() ? "đã ghép với tài khoản của bạn" : "đã ghép · " + state.userName)
                : "đã bị gỡ");
        boolean always = CheckinPolicy.LOCATION_ALWAYS.equals(snapshot.locationPermission);
        String permissionText = always ? "Luôn cho phép"
                : CheckinPolicy.LOCATION_WHILE_IN_USE.equals(snapshot.locationPermission) ? "Chỉ khi dùng app" : "Chưa cấp";
        permissionRow.set(always && snapshot.locationEnabled,
                snapshot.locationEnabled ? permissionText : permissionText + " · định vị đang tắt");
        boolean background = snapshot.batteryIgnored && snapshot.exactAllowed;
        backgroundRow.set(background, !snapshot.batteryIgnored ? "cần tắt tiết kiệm pin cho app"
                : !snapshot.exactAllowed ? "chưa được đặt báo thức đúng giờ" : "không bị tiết kiệm pin chặn");
        batteryRow.set(snapshot.batteryPct == null || snapshot.batteryPct > 15,
                snapshot.batteryPct == null ? "chưa rõ" : snapshot.batteryPct + "%");
    }

    private void renderRecent(List<QueueStore.SlotRow> rows, long now) {
        recentList.removeAllViews();
        if (rows.isEmpty()) {
            Ui.text(recentList, "Chưa có mốc nào.", 15, Ui.MUTED, false);
            return;
        }
        for (QueueStore.SlotRow row : rows) {
            String delivered = "pending".equals(row.state) ? " · chờ gửi"
                    : "failed".equals(row.state) ? " · gửi lỗi"
                    : "ignored_out_of_window".equals(row.receiptStatus) ? " · ngoài khung giờ"
                    : "ignored_off_day".equals(row.receiptStatus) ? " · ngày nghỉ" : "";
            boolean warn = CheckinPolicy.FIX_NONE.equals(row.fixStatus) || "failed".equals(row.state);
            Ui.text(recentList, CheckinPolicy.slotLabel(row.slotMs, now, CheckinPolicy.VIETNAM) + "  "
                    + CheckinPolicy.outcomeLabel(row.fixStatus, row.reason) + delivered,
                    15, warn ? Ui.WARN : Ui.INK, false);
        }
    }

    private void renderSteps(List<Step> steps) {
        if (steps.isEmpty()) {
            currentStep = null;
            stepCard.setVisibility(View.GONE);
            return;
        }
        currentStep = steps.get(0);
        stepCard.setVisibility(View.VISIBLE);
        stepProgress.setText("Cần thiết lập · còn " + steps.size() + " bước");
        switch (currentStep) {
            case NOTIFICATIONS:
                setStep("Cho phép thông báo",
                        "Android hiện một thông báo ngắn lúc app lấy vị trí. Bấm nút dưới rồi chọn Cho phép.",
                        "Cho phép thông báo");
                break;
            case LOCATION:
                setStep("Cho phép lấy vị trí",
                        "Bấm nút dưới, chọn Vị trí chính xác rồi chọn Khi dùng ứng dụng. Bước sau sẽ đổi sang Luôn cho phép.",
                        "Cấp quyền vị trí");
                break;
            case BACKGROUND:
                setStep("Chọn «Luôn cho phép»",
                        "Để ghi vị trí khi khóa màn hình, bấm nút dưới, trong màn Quyền vị trí chọn Luôn cho phép (Allow all the time) rồi quay lại app.",
                        "Chọn Luôn cho phép");
                break;
            case LOCATION_ON:
                setStep("Bật định vị của điện thoại",
                        "Định vị (GPS) đang tắt nên app không lấy được vị trí. Bấm nút dưới rồi bật Vị trí.",
                        "Mở cài đặt vị trí");
                break;
            case BATTERY:
                setStep("Tắt tiết kiệm pin cho app",
                        "Nếu không, Android sẽ tạm ngưng app lúc máy nằm yên. Bấm nút dưới rồi chọn Cho phép (Không tối ưu hóa). Máy Xiaomi, Oppo, Samsung còn cần bật thêm Tự khởi chạy — xem hướng dẫn cài.",
                        "Tắt tiết kiệm pin");
                break;
            case EXACT_ALARM:
                setStep("Cho phép báo thức đúng giờ",
                        "App cần đặt báo thức theo đúng mốc. Bấm nút dưới rồi bật Cho phép đặt báo thức và lời nhắc.",
                        "Mở cài đặt báo thức");
                break;
            default:
                break;
        }
    }

    private void setStep(String title, String body, String action) {
        stepTitle.setText(title);
        stepBody.setText(body);
        stepAction.setText(action);
    }

    private void runStep() {
        if (currentStep == null) return;
        switch (currentStep) {
            case NOTIFICATIONS:
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_PERMISSION);
                break;
            case LOCATION:
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION}, REQUEST_PERMISSION);
                break;
            case BACKGROUND:
                requestPermissions(new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, REQUEST_PERMISSION);
                break;
            case LOCATION_ON:
                open(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
                break;
            case BATTERY:
                open(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri()));
                break;
            case EXACT_ALARM:
                open(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, packageUri()));
                break;
            default:
                break;
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_PERMISSION) load();
    }

    private void togglePause() {
        boolean next = !paused;
        io.execute(() -> {
            try {
                CheckinSettings.State state = new CheckinSettings(this).setPaused(next);
                SafetyNetWork.reportDeviceState(this, state);
            } catch (Exception error) {
                runOnUiThread(() -> toast("Chưa lưu được. Hãy thử lại."));
            }
            runOnUiThread(this::load);
        });
    }

    private void retryFailed() {
        io.execute(() -> {
            new QueueStore(this).retryFailed();
            DeliveryWork.schedule(this);
            runOnUiThread(this::load);
        });
    }

    private void openPairing() {
        startActivity(new Intent(this, PairActivity.class));
        finish();
    }

    private void openAppSettings() {
        open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri()));
    }

    private Uri packageUri() {
        return Uri.parse("package:" + getPackageName());
    }

    private void open(Intent intent) {
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException error) {
            openAppSettings();
        }
    }

    private void toast(String message) {
        if (!isFinishing()) Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }
}
