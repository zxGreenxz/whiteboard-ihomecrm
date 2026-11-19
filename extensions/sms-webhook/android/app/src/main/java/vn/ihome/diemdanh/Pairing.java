package vn.ihome.diemdanh;

import android.content.Context;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

import vn.ihome.smsgateway.BuildConfig;

/** Trades a one-time code for this phone's credential; the code never leaves this exchange. */
final class Pairing {
    private static final String TAG = "DiemDanhPairing";

    static final class Result {
        final boolean paired;
        final String message;

        Result(boolean paired, String message) {
            this.paired = paired;
            this.message = message;
        }
    }

    private Pairing() {}

    static Result pair(Context context, String rawCode) {
        String code;
        try {
            code = CheckinPolicy.normalizePairCode(rawCode);
        } catch (IllegalArgumentException error) {
            return new Result(false, error.getMessage());
        }
        Context app = context.getApplicationContext();
        CheckinSettings settings = new CheckinSettings(app);
        try {
            // Persisted before sending: a repeat with the same code replays this exact credential.
            String token = settings.beginPairing(code);
            CheckinSettings.State state = settings.load();
            long startedMs = System.currentTimeMillis();
            JSONObject event = CheckinPolicy.pairEvent(state.deviceId, code,
                    CheckinPolicy.formatInstant(state.correctedNow()), DeviceHealth.pairBlock(app));
            String id = event.getString("id");
            DeliveryWork.HttpResult response = DeliveryWork.transport.post(BuildConfig.INGEST_ENDPOINT, token, id, event.toString());
            long finishedMs = System.currentTimeMillis();
            if (response.status >= 200 && response.status <= 299) {
                return complete(app, settings, response, id, token, startedMs, finishedMs);
            }
            return new Result(false, messageFor(response.status));
        } catch (IOException error) {
            return new Result(false, "Không có mạng hoặc máy chủ chưa phản hồi. Kiểm tra mạng rồi bấm lại.");
        } catch (JSONException | RuntimeException error) {
            Log.w(TAG, "pairing failed: " + error.getClass().getSimpleName());
            return new Result(false, "Không ghép nối được trên máy này. Hãy thử lại.");
        }
    }

    private static Result complete(Context app, CheckinSettings settings, DeliveryWork.HttpResult response, String id,
                                   String token, long startedMs, long finishedMs) {
        CheckinPolicy.Receipt receipt;
        try {
            if (!response.isJson()) throw new CheckinPolicy.InvalidReceiptException("content type");
            receipt = CheckinPolicy.parseReceipt(response.body, id, CheckinPolicy.EVENT_PAIR);
        } catch (CheckinPolicy.InvalidReceiptException error) {
            return new Result(false, "CRM chưa trả xác nhận hợp lệ. Hãy thử lại.");
        }
        settings.completePairing(token, receipt.settings, startedMs, finishedMs, receipt.userName);
        SlotScheduler.ensureArmed(app);
        SafetyNetWork.schedule(app);
        return new Result(true, receipt.userName.isEmpty() ? "Đã ghép nối." : "Đã ghép nối với " + receipt.userName + ".");
    }

    private static String messageFor(int status) {
        if (status == 401) return "Mã không đúng, đã hết hạn hoặc đã dùng. Mở CRM lấy mã mới.";
        if (status == 403) return "Tài khoản này không được phép ghép máy. Hãy báo chủ công ty.";
        if (status == 400) return "Mã không hợp lệ. Kiểm tra lại 10 ký tự.";
        if (CheckinPolicy.shouldRetry(status)) return "Máy chủ đang bận. Hãy thử lại sau ít phút.";
        return "Không ghép nối được (mã lỗi " + status + ").";
    }
}
