package vn.ihome.smsgateway;

import org.junit.Test;

import static org.junit.Assert.*;

public final class GatewayPolicyTest {
    @Test public void acceptsHttpsEndpointsAndEncodedPaths() {
        assertEquals("https://example.test/api/sms", GatewayPolicy.validateEndpoint(" https://example.test/api/sms "));
        assertEquals("https://example.test/a%20b", GatewayPolicy.validateEndpoint("https://example.test/a%20b"));
        assertEquals("https://example.test:8443/sms?key=value", GatewayPolicy.validateEndpoint("https://example.test:8443/sms?key=value"));
    }

    @Test public void rejectsCleartextCredentialsFragmentsAndInvalidHosts() {
        for (String endpoint : new String[]{"http://example.test/sms", "https://user:pass@example.test",
                "https://example.test/#secret", "https:///sms", "file:///sms", "https://example.test:0",
                "https://example.test:65536", "https://exa mple.test/sms", "//example.test/sms"}) {
            assertThrows(endpoint, IllegalArgumentException.class, () -> GatewayPolicy.validateEndpoint(endpoint));
        }
    }

    @Test public void enforcesStrongHeaderSafeToken() {
        assertEquals("a".repeat(32), GatewayPolicy.validateToken("a".repeat(32)));
        assertEquals("a".repeat(256), GatewayPolicy.validateToken("a".repeat(256)));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateToken("short"));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateToken("a".repeat(32) + "\r\nInjected: yes"));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateToken("a".repeat(257)));
    }

    @Test public void retriesOnlyTransientHttpStatuses() {
        for (int status : new int[]{408, 429, 500, 503, 599}) assertTrue(GatewayPolicy.shouldRetry(status));
        for (int status : new int[]{200, 204, 301, 302, 307, 308, 400, 401, 403, 404, 409, 422, 600}) {
            assertFalse(GatewayPolicy.shouldRetry(status));
        }
    }

    @Test public void idsDeduplicateRedeliveryButDistinguishDifferentSmsAndSims() {
        String id = GatewayPolicy.messageId("device", "BANK", "OTP 123456", 1234, 1);
        assertEquals(64, id.length());
        assertEquals(id, GatewayPolicy.messageId("device", "BANK", "OTP 123456", 1234, 1));
        assertNotEquals(id, GatewayPolicy.messageId("device", "BANK", "OTP 123456", 1235, 1));
        assertNotEquals(id, GatewayPolicy.messageId("device", "BANK", "OTP 123456", 1234, 2));
        assertNotEquals(id, GatewayPolicy.messageId("device-2", "BANK", "OTP 123456", 1234, 1));
        assertNotEquals(GatewayPolicy.messageId("ab", "c", "d", 1, null),
                GatewayPolicy.messageId("a", "bc", "d", 1, null));
    }

    @Test public void allowsAllSmsContentsIncludingOtpAndMeasuresUtf8Bytes() {
        GatewayPolicy.validateBody("OTP 123456. Không chia sẻ mã này.");
        GatewayPolicy.validateBody("Tin nhắn cá nhân bất kỳ");
        GatewayPolicy.validateBody("a".repeat(8192));
        GatewayPolicy.validateBody("đ".repeat(4096));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateBody("a".repeat(8193)));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateBody("đ".repeat(4097)));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateBody(null));
    }

    @Test public void notificationIdsDeduplicateCallbacksAndCaptureContentChanges() {
        String id = GatewayPolicy.notificationId("device", "bank.app", "notification-key", 1234, "Biến động", "Số dư +1");
        assertEquals(id, GatewayPolicy.notificationId("device", "bank.app", "notification-key", 1234, "Biến động", "Số dư +1"));
        assertNotEquals(id, GatewayPolicy.notificationId("device", "bank.app", "notification-key", 1234, "Biến động", "Số dư +2"));
        assertNotEquals(id, GatewayPolicy.notificationId("device", "bank.app", "notification-key-2", 1234, "Biến động", "Số dư +1"));
        assertNotEquals(id, GatewayPolicy.notificationId("device", "other.app", "notification-key", 1234, "Biến động", "Số dư +1"));
        assertNotEquals(GatewayPolicy.notificationId("device", "bank.app", "key", 1, "ab", "c"),
                GatewayPolicy.notificationId("device", "bank.app", "key", 1, "a", "bc"));
    }

    @Test public void metadataLimitsUseUtf8Bytes() {
        GatewayPolicy.validateShortField("đ".repeat(256), 512, "title");
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateShortField("đ".repeat(257), 512, "title"));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateShortField("a".repeat(256), 255, "package"));
    }

    @Test public void wireLimitAccountsForUtf8AndRejectsOversizeEnvelopes() {
        GatewayPolicy.validateWirePayload("đ".repeat(32768));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateWirePayload("đ".repeat(32769)));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateWirePayload(null));
    }

    @Test public void destinationBindingIncludesSourceTokenSoQueuedDataCannotMoveToAnotherSource() {
        String first = GatewayPolicy.destinationBinding("https://example.test/webhook", "a".repeat(32));
        assertEquals(first, GatewayPolicy.destinationBinding("https://example.test/webhook", "a".repeat(32)));
        assertNotEquals(first, GatewayPolicy.destinationBinding("https://example.test/webhook", "b".repeat(32)));
        assertNotEquals(first, GatewayPolicy.destinationBinding("https://other.test/webhook", "a".repeat(32)));
    }

    @Test public void receiptRequiresRequestSourceAndEventTypeMatch() {
        String id = "a".repeat(64);
        String source = "00000000-0000-4000-8000-000000000001";
        String event = "00000000-0000-4000-8000-000000000002";
        String accepted = "2026-10-09T12:00:00Z";
        GatewayPolicy.validateReceipt(1, true, "accepted", id, source, event, accepted, id, "", false);
        GatewayPolicy.validateReceipt(1, true, "duplicate", id, source, event, accepted, id, source, false);
        GatewayPolicy.validateReceipt(1, true, "heartbeat", id, source, null, accepted, id, source, true);
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateReceipt(1, true,
                "accepted", "b".repeat(64), source, event, accepted, id, source, false));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateReceipt(1, true,
                "accepted", id, source, event, accepted, id, event, false));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateReceipt(1, true,
                "heartbeat", id, source, event, accepted, id, source, true));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateReceipt(1, true,
                "heartbeat", id, source, null, accepted, id, source, false));
    }

    @Test public void emptyMalformedAndUnsupportedReceiptsNeverAcknowledgeData() {
        String id = "a".repeat(64);
        String source = "00000000-0000-4000-8000-000000000001";
        String event = "00000000-0000-4000-8000-000000000002";
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateReceipt(0, true,
                "accepted", id, source, event, "2026-10-09T12:00:00Z", id, source, false));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateReceipt(1, false,
                "accepted", id, source, event, "2026-10-09T12:00:00Z", id, source, false));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateReceipt(1, true,
                "accepted", id, "not-a-source", event, "2026-10-09T12:00:00Z", id, "", false));
        assertThrows(IllegalArgumentException.class, () -> GatewayPolicy.validateReceipt(1, true,
                "accepted", id, source, event, "not-a-timestamp", id, source, false));
    }
}
