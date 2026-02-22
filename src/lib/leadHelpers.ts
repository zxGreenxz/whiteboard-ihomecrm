// Hàm tính điểm Khách hẹn
// ================================

export interface LeadScoreBreakdown {
  total: number;
  budgetScore: number;
  appointmentScore: number;
  sourceScore: number;
  statusScore: number;
  emailScore: number;
  moveInScore: number;
}

/**
 * Tính điểm khách hẹn dựa trên nhiều yếu tố
 * Tổng điểm tối đa: 100 điểm
 */
export function calculateLeadScore(lead: {
  budget_min?: number | null;
  budget_max?: number | null;
  appointment_date?: string | null;
  source?: string | null;
  status?: string | null;
  email?: string | null;
  move_in_date?: string | null;
}): LeadScoreBreakdown {
  let budgetScore = 0;
  let appointmentScore = 0;
  let sourceScore = 0;
  let statusScore = 0;
  let emailScore = 0;
  let moveInScore = 0;

  // Điểm ngân sách (0-30 điểm)
  if (lead.budget_max) {
    budgetScore = 30;
  } else if (lead.budget_min) {
    budgetScore = 15;
  }

  // Điểm lịch hẹn (0-25 điểm)
  if (lead.appointment_date) {
    const appointmentDate = new Date(lead.appointment_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (appointmentDate >= today) {
      appointmentScore = 25; // Lịch hẹn trong tương lai
    } else {
      appointmentScore = 10; // Lịch hẹn đã qua
    }
  }

  // Điểm chất lượng nguồn (0-20 điểm)
  const sourceScores: Record<string, number> = {
    REFERRAL: 20,
    WALK_IN: 18,
    WEBSITE: 15,
    FACEBOOK: 12,
    ZALO: 12,
    PHONE: 10,
    OTHER: 5,
  };
  sourceScore = sourceScores[lead.source || 'OTHER'] || 5;

  // Điểm tiến trình trạng thái (0-15 điểm)
  const statusScores: Record<string, number> = {
    B3_CONSULTATION: 15,
    B2_APPOINTMENT: 10,
    B1_LEAD: 5,
    CONVERTED: 15,
    FAILED: 0,
  };
  statusScore = statusScores[lead.status || 'B1_LEAD'] || 5;

  // Điểm email (0-5 điểm)
  if (lead.email) {
    emailScore = 5;
  }

  // Điểm ngày chuyển vào sớm (0-5 điểm)
  if (lead.move_in_date) {
    const moveIn = new Date(lead.move_in_date);
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    if (moveIn <= thirtyDaysFromNow) {
      moveInScore = 5;
    }
  }

  const total = budgetScore + appointmentScore + sourceScore + statusScore + emailScore + moveInScore;

  return {
    total,
    budgetScore,
    appointmentScore,
    sourceScore,
    statusScore,
    emailScore,
    moveInScore,
  };
}

/**
 * Lấy màu điểm khách hẹn theo giá trị điểm
 */
export function getLeadScoreColor(score: number): string {
  if (score >= 80) return 'text-green-600 bg-green-100';
  if (score >= 60) return 'text-blue-600 bg-blue-100';
  if (score >= 40) return 'text-yellow-600 bg-yellow-100';
  if (score >= 20) return 'text-orange-600 bg-orange-100';
  return 'text-gray-600 bg-gray-100';
}

/**
 * Lấy nhãn điểm khách hẹn
 */
export function getLeadScoreLabel(score: number): string {
  if (score >= 80) return 'Rất tiềm năng';
  if (score >= 60) return 'Tiềm năng cao';
  if (score >= 40) return 'Tiềm năng';
  if (score >= 20) return 'Cần theo dõi';
  return 'Cần tìm hiểu thêm';
}

// Loại hoạt động Khách hẹn
export const LEAD_ACTIVITY_TYPES = {
  CALL: { label: 'Cuộc gọi', icon: 'Phone', color: 'blue' },
  EMAIL: { label: 'Email', icon: 'Mail', color: 'purple' },
  SMS: { label: 'Tin nhắn SMS', icon: 'MessageSquare', color: 'green' },
  ZALO: { label: 'Zalo', icon: 'MessageCircle', color: 'blue' },
  MEETING: { label: 'Gặp mặt', icon: 'Users', color: 'orange' },
  VIEWED_ROOM: { label: 'Xem căn hộ', icon: 'Eye', color: 'teal' },
  NOTE: { label: 'Ghi chú', icon: 'FileText', color: 'gray' },
  STATUS_CHANGE: { label: 'Thay đổi trạng thái', icon: 'RefreshCw', color: 'indigo' },
  FOLLOW_UP: { label: 'Theo dõi', icon: 'Clock', color: 'yellow' },
  CREATED: { label: 'Tạo mới', icon: 'Plus', color: 'green' },
} as const;

export type LeadActivityType = keyof typeof LEAD_ACTIVITY_TYPES;
