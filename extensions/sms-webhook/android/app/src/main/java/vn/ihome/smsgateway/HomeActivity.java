package vn.ihome.smsgateway;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.RippleDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import vn.ihome.diemdanh.CheckinFeature;
import vn.ihome.diemdanh.Ui;

/**
 * First screen of the app: one card per feature. It never asks for a permission; each feature
 * asks for its own on its own screen, so a phone that uses one feature is never asked for the other's.
 */
public final class HomeActivity extends Activity {
    private static final int PRESSED = Color.rgb(223, 234, 230);

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private TextView checkinStatus, gatewayStatus;

    private static final class Line {
        final String text;
        final int color;

        Line(String text, int color) {
            this.text = text;
            this.color = color;
        }

        void show(TextView view) {
            view.setText(text);
            view.setTextColor(color);
        }
    }

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildScreen();
        io.execute(this::resumeGateway);
    }

    @Override protected void onResume() {
        super.onResume();
        io.execute(() -> {
            Line checkin = checkinLine();
            Line gateway = gatewayLine();
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                checkin.show(checkinStatus);
                gateway.show(gatewayStatus);
            });
        });
    }

    @Override protected void onDestroy() {
        io.shutdown();
        super.onDestroy();
    }

    private void buildScreen() {
        LinearLayout root = Ui.screen(this);
        Ui.text(root, "iHome Gateway", 28, Ui.INK, true);
        // Read from the installed package, so the line names the build that is really on the phone.
        String version = installedVersion();
        if (version != null) Ui.text(root, "Phiên bản " + version, 14, Ui.MUTED, false);
        Ui.text(root, "Chọn phần bạn dùng trên máy này.", 15, Ui.MUTED, false)
                .setPadding(0, Ui.dp(this, 5), 0, Ui.dp(this, 16));

        LinearLayout checkin = featureCard(root, "Điểm danh", null, vn.ihome.diemdanh.MainActivity.class);
        checkinStatus = Ui.text(checkin, "Đang đọc trạng thái…", 15, Ui.MUTED, false);

        LinearLayout gateway = featureCard(root, "Biến động số dư",
                "Chỉ dành cho máy được giao nhận tin ngân hàng.", MainActivity.class);
        gatewayStatus = Ui.text(gateway, "Đang đọc trạng thái…", 15, Ui.MUTED, false);

        Ui.text(root, "Mỗi phần chỉ xin quyền khi bạn vào phần đó và bấm thiết lập.", 14, Ui.MUTED, false);
    }

    private LinearLayout featureCard(LinearLayout root, String title, String note, Class<? extends Activity> screen) {
        LinearLayout card = Ui.card(root);
        card.setBackground(new RippleDrawable(ColorStateList.valueOf(PRESSED), card.getBackground(), null));
        card.setMinimumHeight(Ui.dp(this, 72));
        card.setClickable(true);
        card.setFocusable(true);
        // A plain start keeps this screen underneath, so Back returns here.
        card.setOnClickListener(clicked -> startActivity(new Intent(this, screen)));

        LinearLayout heading = new LinearLayout(this);
        heading.setOrientation(LinearLayout.HORIZONTAL);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        card.addView(heading, new LinearLayout.LayoutParams(-1, -2));
        Ui.text(heading, title, 19, Ui.INK, true).setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f));
        TextView arrow = Ui.text(heading, "›", 24, Ui.GREEN, true);
        arrow.setLayoutParams(new LinearLayout.LayoutParams(-2, -2));
        arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        if (note != null) Ui.text(card, note, 14, Ui.MUTED, false);
        return card;
    }

    private String installedVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException | RuntimeException error) {
            return null;
        }
    }

    /** What the gateway screen does when it starts, kept for a phone whose user only opens the app. */
    private void resumeGateway() {
        try {
            if (new GatewaySettings(this).load().enabled) {
                GatewayWork.schedule(this);
                HeartbeatWork.schedule(this, true);
            }
        } catch (RuntimeException error) {
            // The card reports a configuration that cannot be read.
        }
    }

    private Line checkinLine() {
        try {
            // The same repair the check-in screen runs when it is opened; an unpaired phone is left alone.
            CheckinFeature.heal(this);
            switch (CheckinFeature.status(this)) {
                case NOT_PAIRED:
                    return new Line("Chưa ghép máy. Mở trang Điểm danh trên CRM rồi bấm “Mở app để ghép”.", Ui.MUTED);
                case REVOKED:
                    return new Line("Máy đã bị gỡ khỏi điểm danh — bấm để ghép lại.", Ui.ERROR);
                case NEEDS_SETUP:
                    return new Line("Đã ghép máy — còn thiếu quyền, bấm để xử lý.", Ui.WARN);
                case SUSPENDED:
                    return new Line("Đã ghép máy — tài khoản chưa được phép điểm danh.", Ui.WARN);
                case PAUSED:
                    return new Line("Đã ghép máy — đang tạm dừng.", Ui.WARN);
                case SCHEDULE_OFF:
                    return new Line("Đã ghép máy — điểm danh tự động đang tắt.", Ui.MUTED);
                default:
                    return new Line("Đã ghép máy — tự ghi vị trí theo mốc.", Ui.GREEN);
            }
        } catch (RuntimeException error) {
            return new Line("Không đọc được cấu hình điểm danh — bấm để mở.", Ui.ERROR);
        }
    }

    private Line gatewayLine() {
        try {
            GatewaySettings.Settings settings = new GatewaySettings(this).load();
            if (settings.enabled) return new Line("Đã bật chuyển tiếp.", Ui.GREEN);
            if (settings.endpoint.isEmpty() || settings.token.isEmpty()) return new Line("Chưa cấu hình.", Ui.MUTED);
            return new Line("Đang tạm dừng.", Ui.MUTED);
        } catch (RuntimeException error) {
            return new Line("Không đọc được cấu hình — bấm để mở.", Ui.ERROR);
        }
    }
}
