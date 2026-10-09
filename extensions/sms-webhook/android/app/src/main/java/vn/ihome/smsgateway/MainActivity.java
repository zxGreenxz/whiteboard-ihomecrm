package vn.ihome.smsgateway;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.text.DateFormat;
import java.util.Date;

/** Visible, user-controlled configuration. No inbox contents appear on this screen. */
public final class MainActivity extends Activity {
    private static final int SMS_PERMISSION = 101;
    private static final int INK = Color.rgb(22, 41, 57);
    private static final int MUTED = Color.rgb(91, 110, 121);
    private static final int GREEN = Color.rgb(15, 118, 110);
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Set<String> selectedApps = new HashSet<>();
    private final List<Button> actions = new ArrayList<>();
    private EditText endpoint, token;
    private CheckBox sms, notifications;
    private TextView state, permissions, appSelection, counters, recent, heartbeat, device;
    private String deviceId = "";
    private Button start, stop;
    private boolean loaded, active, busy;
    private final Runnable refresh = new Runnable() {
        @Override public void run() { refreshStatus(); ui.postDelayed(this, 5000); }
    };

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(244, 248, 247));
        getWindow().setNavigationBarColor(Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        buildScreen();
        runTask(() -> {
            GatewaySettings.Settings current = new GatewaySettings(this).load();
            if (current.enabled) {
                GatewayWork.schedule(this);
                HeartbeatWork.schedule(this, true);
            }
            runOnUiThread(() -> {
                endpoint.setText(current.endpoint);
                token.setText(current.token);
                sms.setChecked(current.smsEnabled);
                notifications.setChecked(current.notificationsEnabled);
                selectedApps.addAll(current.notificationPackages);
                active = current.enabled;
                deviceId = current.deviceId;
                device.setText("Mã điện thoại: " + deviceId);
                loaded = true;
                updateSelection();
                updateState();
            });
        }, null);
    }

    private void buildScreen() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(244, 248, 247));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(24), dp(20), dp(32));
        scroll.addView(root);
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            root.setPadding(dp(20), dp(24) + insets.getSystemWindowInsetTop(),
                    dp(20), dp(32) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        text(root, "iHOME · CỔNG TIN NHẮN", 12, GREEN, true);
        text(root, "Kết nối điện thoại\nvới iHome CRM", 29, INK, true);
        text(root, "Nhận biến động số dư từ SMS và thông báo ngân hàng trên điện thoại của bạn.", 15, MUTED, false);
        state = text(root, "Đang đọc cấu hình…", 14, GREEN, true);
        state.setPadding(0, dp(16), 0, dp(12));

        LinearLayout connection = card(root);
        text(connection, "1. Kết nối CRM", 19, INK, true);
        text(connection, "Trên CRM, mở Biến động số dư → Nguồn kết nối → Thêm nguồn. Sao chép địa chỉ và mã kết nối riêng của nguồn vào đây.", 14, MUTED, false);
        text(connection, "Địa chỉ webhook HTTPS", 13, MUTED, false);
        endpoint = input(connection, "https://ten-mien-cua-ban/webhooks/sms",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        text(connection, "Mã xác thực · tối thiểu 32 ký tự", 13, MUTED, false);
        token = input(connection, "Mã kết nối riêng do CRM cấp",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        token.setSaveEnabled(false);
        text(connection, "Mỗi nguồn điện thoại có mã riêng. Đổi địa chỉ hoặc mã sẽ giữ lại các tin cũ, không gửi chúng sang nguồn mới.",
                13, MUTED, false);
        device = text(connection, "Đang đọc mã điện thoại…", 12, MUTED, false);
        button(connection, "Sao chép mã điện thoại", false, () -> {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("Mã điện thoại iHome", deviceId));
            toast("Đã sao chép mã điện thoại.");
        });

        LinearLayout sources = card(root);
        text(sources, "2. Nguồn dữ liệu", 19, INK, true);
        sms = check(sources, "Chuyển tất cả SMS mới nhận");
        text(sources, "Gồm cả SMS chứa OTP và tin cá nhân. App không đọc lại hộp thư cũ; việc lọc diễn ra trên máy chủ.",
                13, MUTED, false);
        notifications = check(sources, "Chuyển thông báo từ app đã chọn");
        appSelection = text(sources, "Chưa chọn app ngân hàng", 13, MUTED, false);
        button(sources, "Chọn app ngân hàng", false, this::chooseApps);
        text(sources, "Chỉ gửi thông báo mới hoặc được cập nhật từ các app bạn chọn. Có thể bao gồm tin quảng cáo; máy chủ sẽ phân loại. Nội dung bị Android hoặc ngân hàng ẩn có thể không đọc được.",
                13, MUTED, false);
        button(sources, "Cấp quyền truy cập thông báo", false, () ->
                openSettings(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        permissions = text(sources, "", 13, MUTED, false);

        LinearLayout control = card(root);
        text(control, "3. Điều khiển", 19, INK, true);
        button(control, "Lưu cấu hình", false, () -> save(active));
        start = button(control, "Bật chuyển tiếp", true, this::enable);
        stop = button(control, "Tạm dừng chuyển tiếp", false, this::pause);
        button(control, "Gửi tin thử đến CRM", false, () -> runTask(() -> {
            GatewayWork.enqueueTest(this);
        }, "Đã xếp tin thử vào hàng chờ."));
        text(control, "Tin thử là dữ liệu mẫu, không sử dụng SMS hoặc thông báo thật. Thay đổi địa chỉ máy chủ sẽ không tự chuyển các tin đang chờ sang địa chỉ mới.",
                13, MUTED, false);

        LinearLayout delivery = card(root);
        text(delivery, "Trạng thái gửi", 19, INK, true);
        heartbeat = text(delivery, "Chưa có xác nhận kết nối từ CRM.", 14, GREEN, true);
        text(delivery, "App gửi tín hiệu hoạt động khoảng mỗi 15 phút khi đã bật. Android có thể trì hoãn khi tiết kiệm pin; không có SMS mới không có nghĩa điện thoại mất kết nối.", 13, MUTED, false);
        button(delivery, "Kiểm tra kết nối ngay", false, () -> runTask(() -> {
            if (!new GatewaySettings(this).load().enabled) throw new IllegalArgumentException("Bật chuyển tiếp trước khi kiểm tra kết nối.");
            HeartbeatWork.schedule(this, true);
        }, "Đã yêu cầu kiểm tra. Trạng thái cập nhật sau khi CRM nhận được tín hiệu."));
        text(delivery, "Lưu tối đa 100 trạng thái gửi thành công gần nhất; bộ đếm tin không gồm tín hiệu hoạt động.", 13, MUTED, false);
        counters = text(delivery, "Đang đọc hàng chờ…", 17, INK, true);
        recent = text(delivery, "", 13, MUTED, false);
        button(delivery, "Thử lại các tin lỗi", false, () -> runTask(() -> {
            new QueueStore(this).retryFailed();
            GatewayWork.schedule(this);
        }, "Đã đưa các tin lỗi về hàng chờ. Cần bật chuyển tiếp để gửi."));
        button(delivery, "Xóa các tin chưa gửi", false, () -> new AlertDialog.Builder(this)
                .setTitle("Xóa tin chưa gửi?")
                .setMessage("Xóa các tin đang chờ hoặc gửi lỗi khỏi app. Không thể khôi phục. Yêu cầu đang gửi có thể vẫn tới VPS; tin trên điện thoại và VPS không bị xóa.")
                .setNegativeButton("Giữ lại", null)
                .setPositiveButton("Xóa", (dialog, which) -> runTask(() -> {
                    new QueueStore(this).clearPending();
                }, "Đã xóa các tin chưa gửi."))
                .show());
        button(delivery, "Mở cài đặt ứng dụng", false, () -> openSettings(
                new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getPackageName()))));
        text(root, "Giữ điện thoại có sóng và Internet. Android có thể trì hoãn gửi khi tiết kiệm pin; buộc dừng app sẽ ngừng nhận cho đến khi mở lại. App không tự xác nhận giao dịch hoặc ghi sổ kế toán.",
                13, MUTED, false);
        setContentView(scroll);
    }

    private void enable() {
        if (!loaded || busy) return;
        if (!sms.isChecked() && !notifications.isChecked()) {
            showError("Chọn ít nhất một nguồn dữ liệu."); return;
        }
        if (notifications.isChecked() && selectedApps.isEmpty()) {
            showError("Chọn app ngân hàng trước khi bật đọc thông báo."); return;
        }
        if (sms.isChecked() && checkSelfPermission(Manifest.permission.RECEIVE_SMS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECEIVE_SMS}, SMS_PERMISSION);
            return;
        }
        if (notifications.isChecked() && !hasNotificationAccess()) {
            showError("Hãy cấp quyền Truy cập thông báo cho iHome Gateway, rồi quay lại bấm Bật chuyển tiếp.");
            return;
        }
        save(true);
    }

    private void save(boolean enable) {
        if (!loaded || busy) return;
        final String url = endpoint.getText().toString().trim();
        final String secret = token.getText().toString().trim();
        final boolean withSms = sms.isChecked(), withNotifications = notifications.isChecked();
        final Set<String> apps = new HashSet<>(selectedApps);
        if (enable && (!withSms && !withNotifications)) { showError("Chọn ít nhất một nguồn dữ liệu."); return; }
        if (withNotifications && apps.isEmpty()) { showError("Chọn app ngân hàng cần đọc thông báo."); return; }
        if (enable && withSms && checkSelfPermission(Manifest.permission.RECEIVE_SMS)
                != PackageManager.PERMISSION_GRANTED) { showError("Chưa được cấp quyền nhận SMS."); return; }
        if (enable && withNotifications && !hasNotificationAccess()) { showError("Chưa được cấp quyền truy cập thông báo."); return; }
        runTask(() -> {
            GatewaySettings settings = new GatewaySettings(this);
            settings.saveAll(url, secret, enable, withSms, withNotifications, apps);
            if (enable) {
                GatewayWork.schedule(this);
                HeartbeatWork.schedule(this, true);
            }
            runOnUiThread(() -> { active = enable; updateState(); });
        }, enable ? "Đã lưu và bật chuyển tiếp." : "Đã lưu cấu hình.");
    }

    private void pause() {
        if (!loaded || busy) return;
        runTask(() -> {
            GatewaySettings settings = new GatewaySettings(this);
            GatewaySettings.Settings current = settings.load();
            settings.save(current.endpoint, current.token, false);
            HeartbeatWork.cancel(this);
            runOnUiThread(() -> { active = false; updateState(); });
        }, "Đã tạm dừng. Tin đang gửi có thể đã tới máy chủ.");
    }

    private boolean hasNotificationAccess() {
        return HeartbeatWork.hasNotificationAccess(this);
    }

    private void chooseApps() {
        runTask(() -> {
            Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            Map<String, AppChoice> unique = new LinkedHashMap<>();
            for (ResolveInfo info : getPackageManager().queryIntentActivities(launcher, 0)) {
                String pkg = info.activityInfo.packageName;
                if (!pkg.equals(getPackageName())) unique.put(pkg,
                        new AppChoice(pkg, info.loadLabel(getPackageManager()).toString()));
            }
            List<AppChoice> choices = new ArrayList<>(unique.values());
            choices.sort(Comparator.comparing(a -> a.label.toLowerCase(java.util.Locale.ROOT)));
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                String[] labels = new String[choices.size()];
                boolean[] checked = new boolean[choices.size()];
                Set<String> proposed = new HashSet<>(selectedApps);
                for (int i = 0; i < choices.size(); i++) {
                    labels[i] = choices.get(i).label + "\n" + choices.get(i).pkg;
                    checked[i] = proposed.contains(choices.get(i).pkg);
                }
                new AlertDialog.Builder(this).setTitle("Chọn app ngân hàng")
                        .setMultiChoiceItems(labels, checked, (dialog, index, checkedNow) -> {
                            if (checkedNow) proposed.add(choices.get(index).pkg);
                            else proposed.remove(choices.get(index).pkg);
                        })
                        .setNegativeButton("Hủy", null)
                        .setPositiveButton("Chọn", (dialog, which) -> {
                            selectedApps.clear(); selectedApps.addAll(proposed); updateSelection();
                            toast("Bấm Lưu cấu hình để áp dụng danh sách app.");
                        }).show();
            });
        }, null);
    }

    private void updateSelection() {
        if (selectedApps.isEmpty()) { appSelection.setText("Chưa chọn app ngân hàng"); return; }
        List<String> names = new ArrayList<>();
        for (String pkg : selectedApps) {
            try { names.add(getPackageManager().getApplicationLabel(
                    getPackageManager().getApplicationInfo(pkg, 0)).toString()); }
            catch (PackageManager.NameNotFoundException e) { names.add(pkg + " (không còn cài)"); }
        }
        names.sort(String.CASE_INSENSITIVE_ORDER);
        appSelection.setText("Đã chọn: " + String.join(", ", names));
    }

    private void updateState() {
        state.setText(active ? "● Đã bật chuyển tiếp" : "○ Đang tạm dừng");
        state.setTextColor(active ? GREEN : MUTED);
        start.setEnabled(loaded && !busy && !active);
        stop.setEnabled(loaded && !busy && active);
        boolean hasSms = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED;
        permissions.setText("Quyền SMS: " + (hasSms ? "đã cấp" : "chưa cấp")
                + "\nTruy cập thông báo: " + (hasNotificationAccess() ? "đã cấp" : "chưa cấp"));
    }

    private void refreshStatus() {
        if (!loaded || busy || isFinishing() || isDestroyed() || io.isShutdown()) return;
        io.execute(() -> {
            try {
                QueueStore queue = new QueueStore(this);
                QueueStore.Stats stats = queue.stats();
                String summary = queue.recentSummary();
                GatewaySettings.Settings current = new GatewaySettings(this).load();
                long lastHeartbeat = queue.lastHeartbeatFor(current.endpoint, current.token);
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    counters.setText(stats.pending + " chờ gửi   ·   " + stats.sent + " đã gửi   ·   " + stats.failed + " lỗi");
                    heartbeat.setText(lastHeartbeat > 0
                            ? "CRM đã nhận tín hiệu: " + DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(new Date(lastHeartbeat))
                            : "Chưa có xác nhận kết nối từ CRM.");
                    if (stats.heartbeatPending > 0) heartbeat.append("\nCó " + stats.heartbeatPending + " tín hiệu đang chờ gửi.");
                    recent.setText(summary.isEmpty() ? "Chưa có tin nào được ghi nhận." : summary);
                    updateState();
                });
            } catch (Exception e) {
                runOnUiThread(() -> recent.setText("Không đọc được hàng chờ. Hãy mở lại app; không xóa dữ liệu nếu còn tin chưa gửi."));
            }
        });
    }

    private void runTask(Task task, String success) {
        if (busy || isFinishing() || isDestroyed() || io.isShutdown()) return;
        busy = true;
        for (Button button : actions) button.setEnabled(false);
        io.execute(() -> {
            try {
                task.run();
                if (success != null) runOnUiThread(() -> toast(success));
            } catch (IllegalArgumentException e) {
                runOnUiThread(() -> showError(e.getMessage()));
            } catch (Exception e) {
                runOnUiThread(() -> showError("Không hoàn tất thao tác. Kiểm tra cấu hình và bộ nhớ điện thoại; dữ liệu chưa gửi vẫn được giữ lại."));
            } finally {
                runOnUiThread(() -> {
                    busy = false;
                    if (isFinishing() || isDestroyed()) return;
                    for (Button button : actions) button.setEnabled(loaded);
                    updateState(); refreshStatus();
                });
            }
        });
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == SMS_PERMISSION) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) enable();
            else showError("Chưa có quyền nhận SMS. Bạn có thể cấp lại trong cài đặt ứng dụng, hoặc bỏ chọn SMS để chỉ dùng thông báo.");
        }
    }

    @Override public void onResume() {
        super.onResume();
        ui.post(refresh);
        if (loaded && active && !io.isShutdown()) io.execute(() -> HeartbeatWork.schedule(this, true));
    }
    @Override public void onPause() { ui.removeCallbacks(refresh); super.onPause(); }
    @Override public void onDestroy() { ui.removeCallbacksAndMessages(null); io.shutdown(); super.onDestroy(); }

    private void openSettings(Intent intent) {
        try { startActivity(intent); }
        catch (android.content.ActivityNotFoundException e) { showError("Mở Cài đặt trên điện thoại để cấp quyền cho app."); }
    }
    private void toast(String message) { if (!isFinishing()) Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    private void showError(String message) {
        if (!isFinishing() && !isDestroyed()) new AlertDialog.Builder(this).setTitle("Cần kiểm tra")
                .setMessage(message).setPositiveButton("Đã hiểu", null).show();
    }
    private LinearLayout card(LinearLayout parent) {
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(16), dp(18), dp(18));
        GradientDrawable background = new GradientDrawable(); background.setColor(Color.WHITE);
        background.setCornerRadius(dp(18)); background.setStroke(dp(1), Color.rgb(223, 234, 230));
        box.setBackground(background);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(16); parent.addView(box, params); return box;
    }
    private TextView text(LinearLayout parent, String value, int size, int color, boolean bold) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color);
        view.setLineSpacing(dp(3), 1f); view.setPadding(0, dp(5), 0, dp(7));
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        parent.addView(view, new LinearLayout.LayoutParams(-1, -2)); return view;
    }
    private EditText input(LinearLayout parent, String hint, int type) {
        EditText view = new EditText(this); view.setTextSize(15); view.setSingleLine(true);
        view.setHint(hint); view.setInputType(type); view.setTextColor(INK); view.setHintTextColor(MUTED);
        view.setBackgroundTintList(ColorStateList.valueOf(GREEN));
        view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        parent.addView(view, new LinearLayout.LayoutParams(-1, dp(54))); return view;
    }
    private CheckBox check(LinearLayout parent, String label) {
        CheckBox view = new CheckBox(this); view.setText(label); view.setTextSize(15); view.setTextColor(INK);
        view.setButtonTintList(ColorStateList.valueOf(GREEN)); view.setPadding(0, dp(8), 0, dp(8));
        parent.addView(view, new LinearLayout.LayoutParams(-1, -2)); return view;
    }
    private Button button(LinearLayout parent, String label, boolean primary, Runnable action) {
        Button view = new Button(this); view.setText(label); view.setAllCaps(false); view.setTextSize(15);
        view.setTextColor(primary ? Color.WHITE : GREEN);
        view.setBackgroundTintList(ColorStateList.valueOf(primary ? GREEN : Color.rgb(231, 243, 239)));
        view.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(7); view.setMinHeight(dp(48)); parent.addView(view, params); actions.add(view); return view;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private interface Task { void run() throws Exception; }
    private static final class AppChoice {
        final String pkg, label;
        AppChoice(String pkg, String label) { this.pkg = pkg; this.label = label; }
    }
}
