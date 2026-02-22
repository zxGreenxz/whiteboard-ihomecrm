/**
 * Issue Helper Functions
 *
 * Provides utilities for issue management including:
 * - Create auto-notifications for issue events
 * - Notify when issue is resolved
 */

import { supabase } from '@/integrations/supabase/client';

/**
 * Create notification when issue is resolved
 *
 * @param issueId - Issue ID
 * @param userId - User ID
 * @param issueTitle - Issue title
 * @param roomName - Room name
 */
export async function createIssueResolvedNotification(
  issueId: string,
  userId: string,
  issueTitle: string,
  roomName: string
): Promise<void> {
  // Check notification settings
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'notification_config')
    .maybeSingle();

  // Default: send notifications
  if (settings?.value && (settings.value as any).send_issue_updates === false) {
    return; // Don't send if disabled
  }

  // Create notification
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'ISSUE_RESOLVED',
    channel: 'IN_APP',
    subject: 'Công việc đã được giải quyết',
    content: `Công việc "${issueTitle}" tại căn hộ ${roomName} đã được giải quyết thành công.`,
    issue_id: issueId,
    status: 'PENDING',
  });
}

/**
 * Create notification for new issue assignment
 *
 * @param issueId - Issue ID
 * @param userId - User ID
 * @param issueTitle - Issue title
 * @param roomName - Room name
 * @param assignedToName - Name of assigned staff
 */
export async function createIssueAssignedNotification(
  issueId: string,
  userId: string,
  issueTitle: string,
  roomName: string,
  assignedToName: string
): Promise<void> {
  // Check notification settings
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'notification_config')
    .maybeSingle();

  if (settings?.value && (settings.value as any).send_issue_updates === false) {
    return;
  }

  // Create notification
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'CUSTOM',
    channel: 'IN_APP',
    subject: 'Công việc mới được phân công',
    content: `Công việc "${issueTitle}" tại căn hộ ${roomName} đã được phân công cho ${assignedToName}.`,
    issue_id: issueId,
    status: 'PENDING',
  });
}

/**
 * Create notification for high-priority issue
 *
 * @param issueId - Issue ID
 * @param userId - User ID
 * @param issueTitle - Issue title
 * @param roomName - Room name
 */
export async function createUrgentIssueNotification(
  issueId: string,
  userId: string,
  issueTitle: string,
  roomName: string
): Promise<void> {
  // Create urgent notification
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'CUSTOM',
    channel: 'IN_APP',
    subject: '⚠️ Công việc KHẨN CẤP',
    content: `Công việc KHẨN CẤP: "${issueTitle}" tại căn hộ ${roomName}. Cần xử lý ngay!`,
    issue_id: issueId,
    status: 'PENDING',
  });
}
