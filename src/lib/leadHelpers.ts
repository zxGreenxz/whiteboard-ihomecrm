// Lead Scoring Helper Functions
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
 * Calculate lead score based on various factors
 * Total possible score: 100 points
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

  // Budget score (0-30 points)
  if (lead.budget_max) {
    budgetScore = 30;
  } else if (lead.budget_min) {
    budgetScore = 15;
  }

  // Appointment date (0-25 points)
  if (lead.appointment_date) {
    const appointmentDate = new Date(lead.appointment_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (appointmentDate >= today) {
      appointmentScore = 25; // Future appointment
    } else {
      appointmentScore = 10; // Past appointment
    }
  }

  // Source quality (0-20 points)
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

  // Status progression (0-15 points)
  const statusScores: Record<string, number> = {
    VIEWED: 15,
    CONTACTED: 10,
    NEW: 5,
    DEPOSITED: 15,
    CONVERTED: 15,
    FAILED: 0,
  };
  statusScore = statusScores[lead.status || 'NEW'] || 5;

  // Email provided (0-5 points)
  if (lead.email) {
    emailScore = 5;
  }

  // Move-in date soon (0-5 points)
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
 * Get lead score color based on score value
 */
export function getLeadScoreColor(score: number): string {
  if (score >= 80) return 'text-green-600 bg-green-100';
  if (score >= 60) return 'text-blue-600 bg-blue-100';
  if (score >= 40) return 'text-yellow-600 bg-yellow-100';
  if (score >= 20) return 'text-orange-600 bg-orange-100';
  return 'text-gray-600 bg-gray-100';
}

/**
 * Get lead score label
 */
export function getLeadScoreLabel(score: number): string {
  if (score >= 80) return 'Rất tiềm năng';
  if (score >= 60) return 'Tiềm năng cao';
  if (score >= 40) return 'Tiềm năng';
  if (score >= 20) return 'Cần theo dõi';
  return 'Cần tìm hiểu thêm';
}

// Lead Activity Types
export const LEAD_ACTIVITY_TYPES = {
  CALL: { label: 'Cuộc gọi', icon: 'Phone', color: 'blue' },
  EMAIL: { label: 'Email', icon: 'Mail', color: 'purple' },
  SMS: { label: 'Tin nhắn SMS', icon: 'MessageSquare', color: 'green' },
  ZALO: { label: 'Zalo', icon: 'MessageCircle', color: 'blue' },
  MEETING: { label: 'Gặp mặt', icon: 'Users', color: 'orange' },
  VIEWED_ROOM: { label: 'Xem phòng', icon: 'Eye', color: 'teal' },
  NOTE: { label: 'Ghi chú', icon: 'FileText', color: 'gray' },
  STATUS_CHANGE: { label: 'Thay đổi trạng thái', icon: 'RefreshCw', color: 'indigo' },
  FOLLOW_UP: { label: 'Theo dõi', icon: 'Clock', color: 'yellow' },
  CREATED: { label: 'Tạo mới', icon: 'Plus', color: 'green' },
} as const;

export type LeadActivityType = keyof typeof LEAD_ACTIVITY_TYPES;
