package vn.ihome.diemdanh;

import android.app.Activity;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.os.Bundle;
import android.text.InputFilter;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Pairing screen. A link only fills the code in: the person holding the phone confirms it. */
public final class PairActivity extends Activity {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private EditText code;
    private TextView status;
    private Button submit;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildScreen();
        fillFromLink(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        fillFromLink(intent);
    }

    private void buildScreen() {
        LinearLayout root = Ui.screen(this);
        Ui.text(root, "iHOME · ĐIỂM DANH", 12, Ui.GREEN, true);
        Ui.text(root, "Ghép máy với\ntài khoản CRM", 28, Ui.INK, true);
        Ui.text(root, "App tự ghi vị trí theo các mốc giờ chủ công ty đặt, kể cả khi khóa màn hình. Bạn không phải bấm gì mỗi lần.", 16, Ui.MUTED, false);
        LinearLayout card = Ui.card(root);
        Ui.text(card, "Mã ghép nối", 19, Ui.INK, true);
        Ui.text(card, "Trên CRM mở Hôm nay → Điểm danh tự động → Ghép máy. Bấm liên kết ngay trên điện thoại này, hoặc gõ mã 10 ký tự. Mã dùng một lần, hạn 10 phút.", 15, Ui.MUTED, false);
        code = new EditText(this);
        code.setTextSize(22);
        code.setSingleLine(true);
        code.setHint("VÍ DỤ: ABCD234EFG");
        code.setTextColor(Ui.INK);
        code.setHintTextColor(Ui.MUTED);
        code.setBackgroundTintList(ColorStateList.valueOf(Ui.GREEN));
        code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        code.setFilters(new InputFilter[]{new InputFilter.AllCaps(), new InputFilter.LengthFilter(10)});
        code.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        card.addView(code, new LinearLayout.LayoutParams(-1, Ui.dp(this, 60)));
        status = Ui.text(card, "", 15, Ui.MUTED, false);
        submit = Ui.button(card, "Ghép nối", true, this::submit);
        Ui.text(root, "Sau khi ghép nối, app sẽ hướng dẫn cấp từng quyền cần thiết.", 15, Ui.MUTED, false);
    }

    private void fillFromLink(Intent intent) {
        String fromLink = CheckinPolicy.codeFromLink(intent == null ? null : intent.getDataString());
        if (fromLink == null) return;
        code.setText(fromLink);
        status.setTextColor(Ui.GREEN);
        status.setText("Đã nhận mã từ liên kết. Bấm Ghép nối để xác nhận.");
        io.execute(() -> {
            boolean paired;
            try {
                paired = new CheckinSettings(this).load().isActive();
            } catch (RuntimeException error) {
                paired = false;
            }
            if (paired) runOnUiThread(() -> status.setText(
                    "Máy này đang được ghép nối. Bấm Ghép nối để thay bằng tài khoản của mã mới."));
        });
    }

    private void submit() {
        String value = code.getText().toString();
        submit.setEnabled(false);
        status.setTextColor(Ui.MUTED);
        status.setText("Đang ghép nối…");
        io.execute(() -> {
            Pairing.Result result = Pairing.pair(this, value);
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                submit.setEnabled(true);
                status.setTextColor(result.paired ? Ui.GREEN : Ui.ERROR);
                status.setText(result.message);
                if (result.paired) {
                    startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
                    finish();
                }
            });
        });
    }

    @Override protected void onDestroy() {
        io.shutdown();
        super.onDestroy();
    }
}
