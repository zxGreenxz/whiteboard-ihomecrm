// @vitest-environment jsdom
import { useEffect, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HermesConnectionsPage from './HermesConnectionsPage';

// Chỉ kiểm khung tab của trang; các khối con đã có test riêng nên được thay bằng bản giả.
const probe = vi.hoisted(() => ({ learningMounts: 0, workspaceModelCalls: 0, admin: true }));
vi.mock('@/hooks/useMyPermissions', async importOriginal => ({ ...(await importOriginal<typeof import('@/hooks/useMyPermissions')>()),
  useMyPermissions: () => ({ data: probe.admin ? { __superadmin: true } : {}, isLoading: false, isError: false }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: '11111111-1111-4111-8111-111111111111', email: 'fixture@example.invalid' },
  isLoading: false, isError: false }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: '22222222-2222-4222-8222-222222222222',
  organization: { name: 'Công ty A' }, isLoading: false, isError: false }) }));
vi.mock('@/components/layout/MainLayout', () => ({ default: ({ children, title }: { children: ReactNode; title: string }) =>
  <main><h1>{title}</h1>{children}</main> }));
vi.mock('@/hermes/useHermesConnections', () => ({ useHermesConnections: () => {
  probe.workspaceModelCalls++;
  return { connectorStatus: null, connectorStatusError: false, message: null, needsReload: false, busy: null, connections: [], context: null,
    optionsState: 'idle', options: null, handoff: null, ensureOptions: async () => {}, reload: async () => {}, revoke: async () => {},
    contextFor: async () => {}, restrict: async () => {}, settings: async () => {}, invalidatePolicy: () => {}, policyChanged: async () => {},
    clearHandoff: () => {}, connect: async () => {} };
} }));
vi.mock('@/hermes/HermesWorkAssistant', () => ({ HermesWorkAssistant: () => null }));
vi.mock('@/hermes/HermesOrgPolicySettings', () => ({ HermesOrgPolicySettings: () => null }));
vi.mock('@/hermes/HermesZaloBotSettings', () => ({ HermesZaloBotSettings: () => null }));
vi.mock('@/hermes/HermesZaloBindings', () => ({ HermesZaloBindings: () => null }));
vi.mock('@/hermes/HermesDeliveryReconcile', () => ({ HermesDeliveryReconcile: () => null }));
vi.mock('@/hermes/HermesLearningReview', () => ({ HermesLearningReview: ({ organizationId }: { organizationId: string }) => {
  useEffect(() => { probe.learningMounts++; }, []);
  return <p>Khối bài học của {organizationId}</p>;
} }));

const activate = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });

beforeEach(() => { probe.learningMounts = 0; probe.workspaceModelCalls = 0; probe.admin = true; window.history.replaceState({}, '', '/settings/hermes'); });
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); });

describe('Cài đặt › Hermes: tab Kết nối và tab Bài học chờ duyệt', () => {
  it('mặc định mở tab cài đặt; tab bài học chỉ dựng khi chọn, phần cài đặt vẫn giữ trong cây', () => {
    render(<HermesConnectionsPage />);
    expect(screen.getByRole('tab', { name: 'Cài đặt & kết nối' }).getAttribute('aria-selected')).toBe('true');
    const workspacePanel = screen.getAllByRole('tabpanel')[0]!;
    const workspaceNodes = workspacePanel.childElementCount;
    expect(workspaceNodes).toBeGreaterThan(0);
    expect(probe.learningMounts).toBe(0);
    const modelCalls = probe.workspaceModelCalls;
    activate('Bài học chờ duyệt');
    expect(screen.getByText('Khối bài học của 22222222-2222-4222-8222-222222222222')).toBeTruthy();
    expect(probe.learningMounts).toBe(1);
    expect(workspacePanel.isConnected).toBe(true);
    expect(workspacePanel.getAttribute('data-state')).toBe('inactive');
    expect(workspacePanel.className).toContain('data-[state=inactive]:hidden');
    expect(workspacePanel.childElementCount).toBe(workspaceNodes);
    expect(probe.workspaceModelCalls).toBeGreaterThanOrEqual(modelCalls); // không bị gỡ/dựng lại từ đầu
    activate('Cài đặt & kết nối');
    expect(screen.queryByText(/Khối bài học của/)).toBeNull();
  });

  it('người không giữ users.edit không thấy tab duyệt; mở bằng link thì vẫn có tab (máy chủ báo thiếu quyền)', () => {
    probe.admin = false;
    render(<HermesConnectionsPage />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText(/Khối bài học của/)).toBeNull();
    cleanup();
    window.history.replaceState({}, '', '/settings/hermes?tab=bai-hoc');
    render(<HermesConnectionsPage />);
    expect(screen.getByRole('tab', { name: 'Bài học chờ duyệt' }).getAttribute('aria-selected')).toBe('true');
  });

  it('mất quyền khi đang ở tab duyệt: tab bị gỡ và trang về "Cài đặt & kết nối" (không trang trắng)', () => {
    const { rerender } = render(<HermesConnectionsPage />);
    activate('Bài học chờ duyệt');
    expect(screen.getByText(/Khối bài học của/)).toBeTruthy();
    probe.admin = false;
    rerender(<HermesConnectionsPage />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText(/Khối bài học của/)).toBeNull();
    const panels = screen.getAllByRole('tabpanel');
    expect(panels).toHaveLength(1);
    expect(panels[0]!.getAttribute('data-state')).toBe('active');
    expect(panels[0]!.childElementCount).toBeGreaterThan(0);
  });

  it('link ?tab=bai-hoc (tin Zalo buổi tối) mở thẳng tab duyệt', () => {
    window.history.replaceState({}, '', '/settings/hermes?tab=bai-hoc');
    render(<HermesConnectionsPage />);
    expect(screen.getByRole('tab', { name: 'Bài học chờ duyệt' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Khối bài học của 22222222-2222-4222-8222-222222222222')).toBeTruthy();
  });
});
