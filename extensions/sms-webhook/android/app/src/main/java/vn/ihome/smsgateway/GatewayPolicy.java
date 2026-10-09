package vn.ihome.smsgateway;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.format.DateTimeParseException;

/** Pure Java validation, shared by the receiver, settings and focused unit tests. */
public final class GatewayPolicy {
    public static final int MAX_BODY_BYTES = 8192;
    public static final int MAX_WIRE_BYTES = 64 * 1024;

    private GatewayPolicy() {}

    public static String validateEndpoint(String value) {
        String endpoint = value == null ? "" : value.trim();
        try {
            URI uri = new URI(endpoint);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getHost().isEmpty() || uri.getRawUserInfo() != null
                    || uri.getRawFragment() != null || uri.getPort() == 0
                    || uri.getPort() > 65535 || uri.isOpaque()) {
                throw new IllegalArgumentException("Webhook phải là HTTPS, không có tên đăng nhập hoặc fragment.");
            }
            return uri.normalize().toASCIIString();
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Địa chỉ webhook không hợp lệ.");
        }
    }

    public static String validateToken(String value) {
        String token = value == null ? "" : value.trim();
        if (token.length() < 32 || token.length() > 256
                || !token.matches("[A-Za-z0-9._~+/-]+={0,2}")) {
            throw new IllegalArgumentException("Token cần 32–256 ký tự ASCII hợp lệ, không chứa khoảng trắng.");
        }
        return token;
    }

    public static void validateBody(String body) {
        if (body == null || body.getBytes(StandardCharsets.UTF_8).length > MAX_BODY_BYTES) {
            throw new IllegalArgumentException("SMS vượt giới hạn 8192 byte; nội dung không bị cắt.");
        }
    }

    public static void validateShortField(String value, int maxBytes, String field) {
        if (value == null || value.getBytes(StandardCharsets.UTF_8).length > maxBytes) {
            throw new IllegalArgumentException(field + " vượt giới hạn " + maxBytes + " byte.");
        }
    }

    public static void validateWirePayload(String payload) {
        if (payload == null || payload.getBytes(StandardCharsets.UTF_8).length > MAX_WIRE_BYTES) {
            throw new IllegalArgumentException("Dữ liệu gửi vượt giới hạn 64 KiB.");
        }
    }

    public static String destinationBinding(String endpoint, String token) {
        return sha256(validateEndpoint(endpoint) + "\n" + validateToken(token));
    }

    public static void validateReceipt(int schemaVersion, boolean ok, String status, String externalId,
                                       String sourceId, String eventId, String acceptedAt,
                                       String expectedId, String expectedSourceId, boolean heartbeat) {
        if (schemaVersion != 1 || !ok || expectedId == null || !expectedId.equals(externalId)
                || !canonicalUuid(sourceId)
                || (expectedSourceId != null && !expectedSourceId.isEmpty() && !expectedSourceId.equals(sourceId))) {
            throw new IllegalArgumentException("Biên nhận CRM không khớp yêu cầu hoặc nguồn đã kết nối.");
        }
        if (heartbeat ? (!"heartbeat".equals(status) || eventId != null)
                : ((!"accepted".equals(status) && !"duplicate".equals(status)) || !canonicalUuid(eventId))) {
            throw new IllegalArgumentException("Biên nhận CRM không đúng loại dữ liệu.");
        }
        try {
            Instant.parse(acceptedAt == null ? "" : acceptedAt);
        } catch (DateTimeParseException error) {
            throw new IllegalArgumentException("Biên nhận CRM thiếu thời điểm nhận hợp lệ.");
        }
    }

    private static boolean canonicalUuid(String value) {
        return value != null && value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    }

    public static String notificationId(String deviceId, String packageName, String key,
                                        long postTime, String title, String body) {
        return messageId(deviceId, packageName + ":" + key,
                title.length() + ":" + title + body, postTime, null);
    }

    public static boolean shouldRetry(int status) {
        return status == 408 || status == 429 || (status >= 500 && status <= 599);
    }

    /** Length prefixes avoid ambiguous concatenation; timestamp is the original SMS timestamp. */
    public static String messageId(String deviceId, String sender, String body,
                                   long messageTimestamp, Integer subscriptionId) {
        return sha256(part(deviceId) + part(sender) + part(body)
                + part(Long.toString(messageTimestamp))
                + part(subscriptionId == null ? "" : subscriptionId.toString()));
    }

    private static String part(String value) {
        String safe = value == null ? "" : value;
        return safe.length() + ":" + safe;
    }

    public static String sha256(String input) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(64);
            for (byte value : digest) {
                result.append(Character.forDigit((value >>> 4) & 15, 16));
                result.append(Character.forDigit(value & 15, 16));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 không khả dụng.", error);
        }
    }
}
