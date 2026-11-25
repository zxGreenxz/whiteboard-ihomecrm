import { describe, expect, it, vi } from "vitest";
import { createDemoCameraAlertRepository, DEMO_CAMERA_ALERT_TYPES } from "@/lib/network-center/cameraDemo";
import { SupabaseCameraAlertRepository } from "@/lib/network-center/cameraRepository";
import type { NetworkCenterRpcCall } from "@/lib/network-center/supabaseRepository";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn() } }));

const org = "a0000000-0000-4000-8000-000000000001";
const scope = { organizationId: org, buildingId: "b0000000-0000-4000-8000-000000000001" };
const recorder = "c0000000-0000-4000-8000-000000000001";
const user = "e0000000-0000-4000-8000-000000000001";

/** Hình JSON mà camera_alert_get_settings_v1 trả (kể cả khoá thừa phải bị bỏ). */
function settingsPayload(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: org, exists: true, canEdit: false,
    settings: {
      enabled: true, mode: "SHADOW", zaloAccountId: null, zaloConversationId: null,
      types: DEMO_CAMERA_ALERT_TYPES, nightStart: "22:00", nightEnd: "07:00", digestAt: "08:00",
      dailyZaloCap: 6, pushEnabled: false, liveSince: null, updatedBy: user,
      updatedAt: "2026-11-24T03:00:00.123456+00:00", version: 3,
    },
    zalo: { account: null, conversation: null, warning: "NOT_CONFIGURED" },
    today: { date: "2026-11-24", zaloSent: 2, shadowWouldSend: 0, cap: 6 },
    defaults: DEMO_CAMERA_ALERT_TYPES,
    privateNote: "never render",
    ...overrides,
  };
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1000000-0000-4000-8000-000000000001", createdAt: "2026-11-24T01:00:00+00:00", kind: "OPENED", channel: "ZALO",
    status: "FAILED", storedStatus: "QUEUED", shadow: false, reason: null,
    body: "⚠ TOA-A: Ổ cứng 1 báo LỖI (08:12).\nXem: CRM › Trung tâm mạng › Camera",
    buildingIds: [scope.buildingId], recipients: null, pendingRelease: false, releasedAt: null,
    sentAt: "2026-11-24T01:00:00+00:00", zaloJobId: "d2000000-0000-4000-8000-000000000001", jobStatus: "failed",
    jobError: "PROVIDER: lỗi", ...overrides,
  };
}

describe("camera alert repository", () => {
  it("reads settings of the requested organization and strips fields outside the contract", async () => {
    const call = vi.fn<NetworkCenterRpcCall>().mockResolvedValue({ data: settingsPayload(), error: null });
    const view = await new SupabaseCameraAlertRepository(call).getSettings(org);
    expect(call).toHaveBeenCalledWith("camera_alert_get_settings_v1", { p_organization_id: org });
    expect(view.settings.version).toBe(3);
    expect(view.settings.types.CAMERA_CHANNEL_FLAPPING.threshold_count).toBe(5);
    expect(view.zalo.warning).toBe("NOT_CONFIGURED");
    expect(view).not.toHaveProperty("privateNote");
  });

  it("rejects settings of another organization and malformed settings", async () => {
    const other = new SupabaseCameraAlertRepository(async () => ({ data: settingsPayload({ organizationId: "a0000000-0000-4000-8000-000000000002" }), error: null }));
    await expect(other.getSettings(org)).rejects.toMatchObject({ code: "CAMERA_SCOPE_MISMATCH" });
    const broken = settingsPayload();
    (broken.settings as Record<string, unknown>).dailyZaloCap = 50;
    const invalid = new SupabaseCameraAlertRepository(async () => ({ data: broken, error: null }));
    await expect(invalid.getSettings(org)).rejects.toMatchObject({ code: "CAMERA_ALERT_INVALID_DATA" });
  });

  it("saves with the expected version and keeps the conflict, permission and validation codes apart", async () => {
    const call = vi.fn<NetworkCenterRpcCall>().mockResolvedValue({ data: settingsPayload({ canEdit: true }), error: null });
    const patch = { mode: "LIVE" as const, types: { CAMERA_CHANNEL_LOST: { threshold_seconds: 1200 } } };
    await new SupabaseCameraAlertRepository(call).saveSettings(org, 3, patch);
    expect(call).toHaveBeenCalledWith("camera_alert_save_settings_v1", { p_organization_id: org, p_expected_version: 3, p_patch: patch });

    const fail = (code: string, message: string) =>
      new SupabaseCameraAlertRepository(async () => ({ data: null, error: { code, message } })).saveSettings(org, 3, {});
    await expect(fail("PT409", "Cài đặt vừa đổi")).rejects.toMatchObject({ code: "PT409", message: expect.stringMatching(/người khác thay đổi/) });
    await expect(fail("42501", "private internal error")).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/không có quyền/) });
    await expect(fail("42501", "private internal error")).rejects.not.toHaveProperty("message", "private internal error");
    await expect(fail("22023", "Giá trị cài đặt không hợp lệ: dailyZaloCap")).rejects.toMatchObject({
      code: "22023", message: "Giá trị cài đặt không hợp lệ: dailyZaloCap",
    });
    await expect(fail("22023", "x".repeat(500))).rejects.toMatchObject({ code: "22023", message: "Giá trị nhập chưa hợp lệ." });
    await expect(fail("PGRST202", "Could not find the function")).rejects.toMatchObject({ code: "PGRST202", message: expect.stringMatching(/chưa được triển khai/) });
  });

  it("passes the snooze end only for SNOOZE and trims the note", async () => {
    const mute = { recorderId: recorder, channel: 3, kind: "IGNORE", untilAt: null, note: "chưa lắp", setBy: user, setAt: "2026-11-24T01:00:00+00:00" };
    const call = vi.fn<NetworkCenterRpcCall>().mockResolvedValue({ data: mute, error: null });
    const repository = new SupabaseCameraAlertRepository(call);
    await repository.setChannelMute({ recorderId: recorder, channel: 3, kind: "IGNORE", untilAt: "2026-12-01T00:00:00Z", note: "  chưa lắp  " });
    expect(call).toHaveBeenLastCalledWith("camera_alert_set_channel_mute_v1",
      { p_recorder_id: recorder, p_channel: 3, p_kind: "IGNORE", p_until: null, p_note: "chưa lắp" });
    call.mockResolvedValue({ data: { ...mute, kind: "SNOOZE", untilAt: "2026-12-01T00:00:00+00:00" }, error: null });
    await repository.setChannelMute({ recorderId: recorder, channel: 3, kind: "SNOOZE", untilAt: "2026-12-01T00:00:00Z", note: " " });
    expect(call).toHaveBeenLastCalledWith("camera_alert_set_channel_mute_v1",
      { p_recorder_id: recorder, p_channel: 3, p_kind: "SNOOZE", p_until: "2026-12-01T00:00:00Z", p_note: null });
    call.mockResolvedValue({ data: { recorderId: recorder, channel: 3, cleared: true }, error: null });
    await expect(repository.clearChannelMute(recorder, 3)).resolves.toEqual({ recorderId: recorder, channel: 3, cleared: true });
  });

  it("rejects channel mutes or incidents of another building instead of rendering them", async () => {
    const mute = { recorderId: recorder, channel: 3, kind: "KNOWN_BROKEN", untilAt: null, note: null, setBy: user,
      setAt: "2026-11-24T01:00:00+00:00", organizationId: org, buildingId: "b0000000-0000-4000-8000-000000000002", setByName: "Chủ" };
    const mutes = new SupabaseCameraAlertRepository(async () => ({ data: { canEdit: false, items: [mute] }, error: null }));
    await expect(mutes.listBuildingMutes(scope)).rejects.toMatchObject({ code: "CAMERA_SCOPE_MISMATCH" });
    const ok = new SupabaseCameraAlertRepository(async () => ({ data: { canEdit: false, items: [{ ...mute, buildingId: scope.buildingId }] }, error: null }));
    await expect(ok.listBuildingMutes(scope)).resolves.toMatchObject({ canEdit: false, items: [{ kind: "KNOWN_BROKEN", setByName: "Chủ" }] });

    const incident = {
      id: "f0000000-0000-4000-8000-000000000001", organization_id: org, building_id: "b0000000-0000-4000-8000-000000000002",
      incident_type: "CAMERA_STORAGE_ERROR", severity: "CRITICAL", status: "OPEN", title: "Ổ cứng", summary: "Ổ cứng lỗi",
      opened_at: "2026-11-24T01:00:00+00:00", acknowledged_at: null, recorder_id: recorder, subject: "storage:1",
    };
    const call = vi.fn<NetworkCenterRpcCall>().mockResolvedValue({ data: { items: [incident] }, error: null });
    await expect(new SupabaseCameraAlertRepository(call).listIncidents(scope)).rejects.toMatchObject({ code: "CAMERA_SCOPE_MISMATCH" });
    expect(call).toHaveBeenCalledWith("camera_building_incidents_v1", { p_building_id: scope.buildingId });
  });

  it("lists deliveries with the filter and the 7-day page cursor, refusing an empty page that claims more", async () => {
    const call = vi.fn<NetworkCenterRpcCall>().mockResolvedValue({ data: { items: [delivery()], hasMore: false }, error: null });
    const page = await new SupabaseCameraAlertRepository(call).listDeliveries(org, { status: "FAILED", before: { createdAt: "2026-11-24T02:00:00Z", id: "d1000000-0000-4000-8000-000000000002" } });
    expect(call).toHaveBeenCalledWith("camera_alert_list_deliveries_v1",
      { p_organization_id: org, p_status: "FAILED", p_limit: 100, p_before: "2026-11-24T02:00:00Z", p_before_id: "d1000000-0000-4000-8000-000000000002" });
    expect(page.items[0]).toMatchObject({ status: "FAILED", storedStatus: "QUEUED", jobError: "PROVIDER: lỗi" });
    call.mockResolvedValue({ data: { items: [], hasMore: true }, error: null });
    await expect(new SupabaseCameraAlertRepository(call).listDeliveries(org)).rejects.toMatchObject({ code: "CAMERA_ALERT_INVALID_DATA" });
    call.mockResolvedValue({ data: { items: [delivery({ status: "MAYBE" })], hasMore: false }, error: null });
    await expect(new SupabaseCameraAlertRepository(call).listDeliveries(org)).rejects.toMatchObject({ code: "CAMERA_ALERT_INVALID_DATA" });
  });

  it("calls the Zalo group list, test message and acknowledge RPCs with exact arguments", async () => {
    const call = vi.fn<NetworkCenterRpcCall>();
    const repository = new SupabaseCameraAlertRepository(call);
    call.mockResolvedValueOnce({ data: { items: [{ id: "d3000000-0000-4000-8000-000000000001", name: "Nhóm thử",
      accountId: "d4000000-0000-4000-8000-000000000001", accountName: "Nick", lastMessageAt: null }] }, error: null });
    await repository.listZaloGroups(org, "  thử ");
    expect(call).toHaveBeenLastCalledWith("camera_alert_list_zalo_groups_v1", { p_organization_id: org, p_search: "thử", p_limit: 50 });
    call.mockResolvedValueOnce({ data: { deliveryId: "d1000000-0000-4000-8000-000000000009", status: "QUEUED", reason: null,
      jobId: "d2000000-0000-4000-8000-000000000009" }, error: null });
    await expect(repository.sendTest(org)).resolves.toMatchObject({ status: "QUEUED" });
    expect(call).toHaveBeenLastCalledWith("camera_alert_send_test_v1", { p_organization_id: org });
    call.mockResolvedValueOnce({ data: { incidentId: "f0000000-0000-4000-8000-000000000001", status: "ACKNOWLEDGED",
      acknowledgedAt: "2026-11-24T01:00:00+00:00", acknowledgedBy: user }, error: null });
    await repository.acknowledgeIncident("f0000000-0000-4000-8000-000000000001");
    expect(call).toHaveBeenLastCalledWith("camera_alert_acknowledge_incident_v1", { p_incident_id: "f0000000-0000-4000-8000-000000000001" });
  });
});

describe("camera alert DEMO repository", () => {
  it("keeps state, enforces the version check and never claims a real send", async () => {
    const repository = createDemoCameraAlertRepository(Date.parse("2026-11-24T01:00:00Z"));
    const view = await repository.getSettings(org);
    expect(view.settings.mode).toBe("SHADOW");
    const saved = await repository.saveSettings(org, view.settings.version, { dailyZaloCap: 4, types: { CAMERA_CHANNEL_LOST: { delivery: "DIGEST" } } });
    expect(saved.settings).toMatchObject({ dailyZaloCap: 4, version: view.settings.version + 1 });
    expect(saved.settings.types.CAMERA_CHANNEL_LOST).toEqual({ enabled: true, delivery: "DIGEST", threshold_seconds: 900 });
    await expect(repository.saveSettings(org, view.settings.version, {})).rejects.toMatchObject({ code: "PT409" });
    await expect(repository.saveSettings(org, saved.settings.version, { dailyZaloCap: 21 })).rejects.toMatchObject({ code: "22023" });
    await expect(repository.sendTest(org)).resolves.toMatchObject({ status: "SHADOW" });

    await repository.setChannelMute({ recorderId: recorder, channel: 2, kind: "KNOWN_BROKEN" });
    expect((await repository.listBuildingMutes(scope)).items).toMatchObject([{ channel: 2, kind: "KNOWN_BROKEN", buildingId: scope.buildingId }]);
    await expect(repository.clearChannelMute(recorder, 2)).resolves.toMatchObject({ cleared: true });
    expect((await repository.listBuildingMutes(scope)).items).toEqual([]);

    const [incident] = (await repository.listIncidents(scope)).items;
    expect(incident.status).toBe("OPEN");
    await repository.acknowledgeIncident(incident.id);
    expect((await repository.listIncidents(scope)).items[0]).toMatchObject({ status: "ACKNOWLEDGED" });
    expect((await repository.listDeliveries(org, { status: "SHADOW" })).items.every((row) => row.shadow)).toBe(true);
  });
});
