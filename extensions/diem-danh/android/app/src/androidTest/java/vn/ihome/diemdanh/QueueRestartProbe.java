package vn.ihome.diemdanh;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.List;

import static org.junit.Assert.*;

/**
 * Two halves of one check, run by ci-device.sh as separate instrumentation processes with a
 * force-stop in between, so the record really comes back from disk and the AndroidKeyStore.
 */
@RunWith(AndroidJUnit4.class)
public final class QueueRestartProbe {
    private static final long SLOT_MS = 1_767_576_600_000L;

    @Test public void seed() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        CheckinSettings store = new CheckinSettings(context);
        store.clearForTest();
        CheckinSettings.State state = Fixtures.pair(store, Fixtures.allDaySettings(3));
        QueueStore queue = new QueueStore(context);
        queue.clearAll();
        JSONObject event = Fixtures.ping(state, SLOT_MS, Fixtures.freshFix());
        queue.enqueuePing(state, event.getString("id"), event.toString(), SLOT_MS,
                CheckinPolicy.FIX_FRESH, null);
        assertEquals(1, queue.stats().pending);
    }

    @Test public void verify() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        CheckinSettings.State state = new CheckinSettings(context).load();
        assertTrue(state.isActive());
        assertTrue(CheckinPolicy.validToken(state.token));
        QueueStore queue = new QueueStore(context);
        List<QueueStore.Pending> rows = queue.pending(10);
        assertEquals(1, rows.size());
        QueueStore.Pending row = rows.get(0);
        assertEquals(CheckinPolicy.slotId(state.deviceId, CheckinPolicy.formatInstant(SLOT_MS)), row.id);
        assertFalse(row.encryptedPayload.contains("location.ping"));
        assertEquals(CheckinPolicy.destinationBinding(BuildConfig.INGEST_ENDPOINT, state.token), row.destinationHash);
        JSONObject payload = new JSONObject(row.payload());
        assertEquals(CheckinPolicy.EVENT_PING, payload.getString("event"));
        assertEquals(CheckinPolicy.FIX_FRESH, payload.getJSONObject("fix").getString("status"));
    }
}
