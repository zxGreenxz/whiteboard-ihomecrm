package vn.ihome.smsgateway;

/** Lets a suite outside this package pin the CRM source, as a valid receipt does on a phone in use. */
public final class GatewayFixtures {
    private GatewayFixtures() {}

    public static void pinSource(GatewaySettings settings, String endpoint, String token, String sourceId)
            throws Exception {
        settings.confirmSource(endpoint, token, sourceId);
    }
}
