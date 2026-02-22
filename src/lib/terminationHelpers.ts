/**
 * Contract Termination Calculation Helpers
 * =========================================
 * Functions for calculating termination costs, prorated amounts, and refunds
 */

import { supabase } from '@/integrations/supabase/client';

// =============================================
// Types
// =============================================

export interface TerminationCostEstimate {
  // Contract info
  contract_id: string;
  contract_number: string;

  // Deposit info
  total_deposit: number;

  // Outstanding amounts
  outstanding_debt: number;
  unpaid_invoices: Array<{
    id: string;
    invoice_number: string;
    period: string;
    amount: number;
    paid: number;
    remaining: number;
  }>;

  // Prorated calculations
  prorated_rent: number;
  prorated_days: number;
  daily_rent_rate: number;

  prorated_services: number;
  service_details: Array<{
    name: string;
    amount: number;
  }>;

  // Meter readings (final)
  electricity_usage: number;
  electricity_cost: number;
  water_usage: number;
  water_cost: number;

  // Fees
  early_termination_fee: number;
  damage_fee: number;
  cleaning_fee: number;
  other_fees: number;
  total_fees: number;

  // Calculated amounts
  total_deductions: number;
  refund_amount: number; // positive = refund to tenant, negative = tenant owes

  // Summary
  is_early_termination: boolean;
  days_early: number;
  move_out_date: string;
  contract_end_date: string;
}

export interface TerminationCalculationInput {
  contract_id: string;
  move_out_date: string;
  damage_fee?: number;
  cleaning_fee?: number;
  early_termination_fee?: number;
  other_fees?: number;

  // Optional: final meter readings
  final_electricity_reading?: number;
  final_water_reading?: number;
}

// =============================================
// Calculate Termination Costs
// =============================================

export async function calculateTerminationCosts(
  input: TerminationCalculationInput
): Promise<TerminationCostEstimate> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // Fetch contract with relations
  const { data: contract, error: contractError } = await supabase
    .from('contracts')
    .select(`
      *,
      tenant:tenants(*),
      room:rooms(*, building:buildings(*)),
      bed:beds(*, room:rooms(*, building:buildings(*))),
      contract_services(*, service:services(*))
    `)
    .eq('id', input.contract_id)
    .eq('user_id', user.id)
    .single();

  if (contractError || !contract) {
    throw new Error('Contract not found');
  }

  // Fetch unpaid invoices
  const { data: unpaidInvoices } = await supabase
    .from('invoices')
    .select('*')
    .eq('contract_id', input.contract_id)
    .eq('user_id', user.id)
    .in('status', ['PENDING', 'OVERDUE', 'PARTIAL'])
    .is('deleted_at', null);

  // Fetch last meter readings
  const roomId = contract.room_id;
  const { data: lastMeterReading } = await supabase
    .from('meter_readings')
    .select('*')
    .eq('room_id', roomId)
    .eq('user_id', user.id)
    .order('reading_date', { ascending: false })
    .limit(1)
    .single();

  // Calculate dates
  const moveOutDate = new Date(input.move_out_date);
  const contractEndDate = new Date(contract.end_date);
  const contractStartDate = new Date(contract.start_date);

  const isEarlyTermination = moveOutDate < contractEndDate;
  const daysEarly = isEarlyTermination
    ? Math.ceil((contractEndDate.getTime() - moveOutDate.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  // Calculate prorated rent
  const monthlyRent = contract.rent_price || 0;
  const daysInMonth = new Date(moveOutDate.getFullYear(), moveOutDate.getMonth() + 1, 0).getDate();
  const dailyRentRate = monthlyRent / daysInMonth;
  const dayOfMonth = moveOutDate.getDate();
  const proratedRent = Math.round(dailyRentRate * dayOfMonth);

  // Calculate prorated services
  let proratedServices = 0;
  const serviceDetails: Array<{ name: string; amount: number }> = [];

  if (contract.contract_services) {
    for (const cs of contract.contract_services) {
      if (cs.service && cs.unit_price) {
        // For monthly services, prorate
        const serviceName = cs.service.name || 'Dịch vụ';
        const monthlyAmount = cs.unit_price * (cs.quantity || 1);
        const dailyAmount = monthlyAmount / daysInMonth;
        const proratedAmount = Math.round(dailyAmount * dayOfMonth);

        proratedServices += proratedAmount;
        serviceDetails.push({
          name: serviceName,
          amount: proratedAmount,
        });
      }
    }
  }

  // Calculate electricity/water costs (if final readings provided)
  let electricityCost = 0;
  let waterCost = 0;
  let electricityUsage = 0;
  let waterUsage = 0;

  // Get utility prices from contract services or settings
  let electricityPrice = 0;
  let waterPrice = 0;

  // First try to get prices from contract services
  if (contract.contract_services) {
    for (const cs of contract.contract_services) {
      if (cs.service && cs.unit_price) {
        const serviceName = (cs.service.name || '').toLowerCase();
        if (serviceName.includes('điện') || serviceName.includes('electric')) {
          electricityPrice = cs.unit_price;
        }
        if (serviceName.includes('nước') || serviceName.includes('water')) {
          waterPrice = cs.unit_price;
        }
      }
    }
  }

  // If not found in contract, try to get from user settings
  if (electricityPrice === 0 || waterPrice === 0) {
    const { data: utilitySettings } = await supabase
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'utility_prices')
      .maybeSingle();

    if (utilitySettings?.value) {
      const prices = utilitySettings.value as { electricity_price?: number; water_price?: number };
      if (electricityPrice === 0) electricityPrice = prices.electricity_price || 3500;
      if (waterPrice === 0) waterPrice = prices.water_price || 15000;
    } else {
      // Fallback to defaults if no settings found
      if (electricityPrice === 0) electricityPrice = 3500; // VND per kWh
      if (waterPrice === 0) waterPrice = 15000; // VND per m3
    }
  }

  if (input.final_electricity_reading && lastMeterReading?.electricity_reading) {
    electricityUsage = input.final_electricity_reading - lastMeterReading.electricity_reading;
    electricityCost = electricityUsage * electricityPrice;
  }

  if (input.final_water_reading && lastMeterReading?.water_reading) {
    waterUsage = input.final_water_reading - lastMeterReading.water_reading;
    waterCost = waterUsage * waterPrice;
  }

  // Calculate outstanding debt from unpaid invoices
  let outstandingDebt = 0;
  const invoiceDetails: TerminationCostEstimate['unpaid_invoices'] = [];

  if (unpaidInvoices) {
    for (const inv of unpaidInvoices) {
      const remaining = inv.total_amount - (inv.paid_amount || 0);
      if (remaining > 0) {
        outstandingDebt += remaining;
        invoiceDetails.push({
          id: inv.id,
          invoice_number: inv.invoice_number || '',
          period: inv.period_start || '',
          amount: inv.total_amount,
          paid: inv.paid_amount || 0,
          remaining,
        });
      }
    }
  }

  // Calculate fees
  const earlyTerminationFee = input.early_termination_fee || 0;
  const damageFee = input.damage_fee || 0;
  const cleaningFee = input.cleaning_fee || 0;
  const otherFees = input.other_fees || 0;
  const totalFees = earlyTerminationFee + damageFee + cleaningFee + otherFees;

  // Calculate total deductions
  const totalDeductions =
    outstandingDebt +
    proratedRent +
    proratedServices +
    electricityCost +
    waterCost +
    totalFees;

  // Calculate refund amount
  const totalDeposit = contract.total_deposit || 0;
  const refundAmount = totalDeposit - totalDeductions;

  return {
    contract_id: contract.id,
    contract_number: contract.contract_number || '',

    total_deposit: totalDeposit,

    outstanding_debt: outstandingDebt,
    unpaid_invoices: invoiceDetails,

    prorated_rent: proratedRent,
    prorated_days: dayOfMonth,
    daily_rent_rate: Math.round(dailyRentRate),

    prorated_services: proratedServices,
    service_details: serviceDetails,

    electricity_usage: electricityUsage,
    electricity_cost: electricityCost,
    water_usage: waterUsage,
    water_cost: waterCost,

    early_termination_fee: earlyTerminationFee,
    damage_fee: damageFee,
    cleaning_fee: cleaningFee,
    other_fees: otherFees,
    total_fees: totalFees,

    total_deductions: totalDeductions,
    refund_amount: refundAmount,

    is_early_termination: isEarlyTermination,
    days_early: daysEarly,
    move_out_date: input.move_out_date,
    contract_end_date: contract.end_date,
  };
}

// =============================================
// Calculate Early Termination Penalty
// =============================================

export function calculateEarlyTerminationPenalty(params: {
  contract_start_date: string;
  contract_end_date: string;
  move_out_date: string;
  monthly_rent: number;
  deposit_amount: number;
  penalty_type: 'FIXED' | 'PERCENTAGE' | 'MONTHS' | 'FORFEIT_DEPOSIT';
  penalty_value?: number; // For FIXED, PERCENTAGE, or MONTHS
  minimum_stay_months?: number; // Minimum stay before no penalty
}): {
  penalty_amount: number;
  penalty_description: string;
  is_penalty_applicable: boolean;
} {
  const {
    contract_start_date,
    contract_end_date,
    move_out_date,
    monthly_rent,
    deposit_amount,
    penalty_type,
    penalty_value = 0,
    minimum_stay_months = 0,
  } = params;

  const startDate = new Date(contract_start_date);
  const endDate = new Date(contract_end_date);
  const moveOutDate = new Date(move_out_date);

  // Check if early termination
  if (moveOutDate >= endDate) {
    return {
      penalty_amount: 0,
      penalty_description: 'Không có phí phạt - hết hạn hợp đồng bình thường',
      is_penalty_applicable: false,
    };
  }

  // Check minimum stay
  const monthsStayed = Math.floor(
    (moveOutDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 30)
  );

  if (minimum_stay_months > 0 && monthsStayed >= minimum_stay_months) {
    return {
      penalty_amount: 0,
      penalty_description: `Không có phí phạt - đã ở đủ ${minimum_stay_months} tháng tối thiểu`,
      is_penalty_applicable: false,
    };
  }

  let penaltyAmount = 0;
  let penaltyDescription = '';

  switch (penalty_type) {
    case 'FIXED':
      penaltyAmount = penalty_value;
      penaltyDescription = `Phí phạt cố định: ${penaltyAmount.toLocaleString('vi-VN')} VND`;
      break;

    case 'PERCENTAGE':
      penaltyAmount = Math.round(deposit_amount * (penalty_value / 100));
      penaltyDescription = `${penalty_value}% tiền cọc: ${penaltyAmount.toLocaleString('vi-VN')} VND`;
      break;

    case 'MONTHS':
      penaltyAmount = Math.round(monthly_rent * penalty_value);
      penaltyDescription = `${penalty_value} tháng tiền thuê: ${penaltyAmount.toLocaleString('vi-VN')} VND`;
      break;

    case 'FORFEIT_DEPOSIT':
      penaltyAmount = deposit_amount;
      penaltyDescription = 'Mất toàn bộ tiền cọc';
      break;
  }

  return {
    penalty_amount: penaltyAmount,
    penalty_description: penaltyDescription,
    is_penalty_applicable: true,
  };
}

// =============================================
// Generate Termination Summary Text
// =============================================

export function generateTerminationSummary(estimate: TerminationCostEstimate): string {
  const lines: string[] = [];

  lines.push('='.repeat(50));
  lines.push('BẢNG TÍNH THANH LÝ HỢP ĐỒNG');
  lines.push('='.repeat(50));
  lines.push('');
  lines.push(`Mã hợp đồng: ${estimate.contract_number}`);
  lines.push(`Ngày chuyển đi: ${estimate.move_out_date}`);
  lines.push(`Ngày hết hạn HĐ: ${estimate.contract_end_date}`);

  if (estimate.is_early_termination) {
    lines.push(`** CHẤM DỨT SỚM ${estimate.days_early} NGÀY **`);
  }

  lines.push('');
  lines.push('-'.repeat(50));
  lines.push('TIỀN CỌC BAN ĐẦU');
  lines.push('-'.repeat(50));
  lines.push(`Tổng tiền cọc: ${estimate.total_deposit.toLocaleString('vi-VN')} VND`);

  lines.push('');
  lines.push('-'.repeat(50));
  lines.push('CÁC KHOẢN TRỪ');
  lines.push('-'.repeat(50));

  if (estimate.outstanding_debt > 0) {
    lines.push(`1. Công nợ cũ: ${estimate.outstanding_debt.toLocaleString('vi-VN')} VND`);
    for (const inv of estimate.unpaid_invoices) {
      lines.push(`   - HĐ ${inv.invoice_number}: còn ${inv.remaining.toLocaleString('vi-VN')} VND`);
    }
  }

  lines.push(`2. Tiền căn hộ ngày lẻ (${estimate.prorated_days} ngày): ${estimate.prorated_rent.toLocaleString('vi-VN')} VND`);
  lines.push(`   (Đơn giá: ${estimate.daily_rent_rate.toLocaleString('vi-VN')} VND/ngày)`);

  if (estimate.prorated_services > 0) {
    lines.push(`3. Dịch vụ ngày lẻ: ${estimate.prorated_services.toLocaleString('vi-VN')} VND`);
    for (const svc of estimate.service_details) {
      lines.push(`   - ${svc.name}: ${svc.amount.toLocaleString('vi-VN')} VND`);
    }
  }

  if (estimate.electricity_cost > 0 || estimate.water_cost > 0) {
    lines.push('4. Tiện ích cuối:');
    if (estimate.electricity_cost > 0) {
      lines.push(`   - Điện (${estimate.electricity_usage} kWh): ${estimate.electricity_cost.toLocaleString('vi-VN')} VND`);
    }
    if (estimate.water_cost > 0) {
      lines.push(`   - Nước (${estimate.water_usage} m³): ${estimate.water_cost.toLocaleString('vi-VN')} VND`);
    }
  }

  if (estimate.total_fees > 0) {
    lines.push('5. Phí phạt/hư hỏng:');
    if (estimate.early_termination_fee > 0) {
      lines.push(`   - Phí chấm dứt sớm: ${estimate.early_termination_fee.toLocaleString('vi-VN')} VND`);
    }
    if (estimate.damage_fee > 0) {
      lines.push(`   - Phí hư hỏng: ${estimate.damage_fee.toLocaleString('vi-VN')} VND`);
    }
    if (estimate.cleaning_fee > 0) {
      lines.push(`   - Phí vệ sinh: ${estimate.cleaning_fee.toLocaleString('vi-VN')} VND`);
    }
    if (estimate.other_fees > 0) {
      lines.push(`   - Phí khác: ${estimate.other_fees.toLocaleString('vi-VN')} VND`);
    }
  }

  lines.push('');
  lines.push('-'.repeat(50));
  lines.push(`TỔNG KHẤU TRỪ: ${estimate.total_deductions.toLocaleString('vi-VN')} VND`);
  lines.push('='.repeat(50));

  if (estimate.refund_amount >= 0) {
    lines.push(`HOÀN TRẢ KHÁCH: ${estimate.refund_amount.toLocaleString('vi-VN')} VND`);
  } else {
    lines.push(`KHÁCH CẦN TRẢ THÊM: ${Math.abs(estimate.refund_amount).toLocaleString('vi-VN')} VND`);
  }

  lines.push('='.repeat(50));

  return lines.join('\n');
}

// =============================================
// Process Termination (Execute)
// =============================================

export async function processTermination(params: {
  contract_id: string;
  termination_id: string;
  refund_amount: number;
  payment_method?: string;
  notes?: string;
}): Promise<{
  success: boolean;
  message: string;
  cash_book_entry_id?: string;
}> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // 1. Update contract status to TERMINATED
  const { error: contractError } = await supabase
    .from('contracts')
    .update({
      status: 'TERMINATED',
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.contract_id)
    .eq('user_id', user.id);

  if (contractError) throw contractError;

  // 2. Update termination record status
  const { error: terminationError } = await supabase
    .from('contract_terminations')
    .update({
      status: 'COMPLETED',
      refund_amount: params.refund_amount,
      refund_date: new Date().toISOString(),
    })
    .eq('id', params.termination_id)
    .eq('user_id', user.id);

  if (terminationError) throw terminationError;

  // 3. Create cash book entry for refund/collection
  let cashBookEntryId: string | undefined;

  if (params.refund_amount !== 0) {
    const isRefund = params.refund_amount > 0;

    const { data: cashEntry, error: cashError } = await supabase
      .from('cash_book')
      .insert([{
        user_id: user.id,
        transaction_date: new Date().toISOString(),
        transaction_type: isRefund ? 'EXPENSE' : 'INCOME',
        category: isRefund ? 'DEPOSIT_REFUND' : 'DEPOSIT_FORFEIT',
        amount: Math.abs(params.refund_amount),
        description: isRefund
          ? `Hoàn cọc thanh lý hợp đồng`
          : `Thu thêm từ thanh lý hợp đồng`,
        reference_type: 'CONTRACT_TERMINATION',
        reference_id: params.termination_id,
        payment_method: params.payment_method || 'CASH',
        notes: params.notes,
      }])
      .select()
      .single();

    if (cashError) throw cashError;
    cashBookEntryId = cashEntry?.id;
  }

  // 4. Update room/bed status to AVAILABLE
  const { data: contract } = await supabase
    .from('contracts')
    .select('room_id, bed_id')
    .eq('id', params.contract_id)
    .single();

  if (contract?.room_id) {
    await supabase
      .from('rooms')
      .update({ status: 'AVAILABLE' })
      .eq('id', contract.room_id);
  }

  if (contract?.bed_id) {
    await supabase
      .from('beds')
      .update({ status: 'AVAILABLE' })
      .eq('id', contract.bed_id);
  }

  return {
    success: true,
    message: 'Thanh lý hợp đồng thành công',
    cash_book_entry_id: cashBookEntryId,
  };
}
