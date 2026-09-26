import { z } from 'zod';

export const scoredFields = ['title', 'building', 'room', 'jobType', 'assignee', 'deadline', 'priority'] as const;
export type ScoredField = typeof scoredFields[number];
export const fieldLabels: Record<ScoredField, string> = { title: 'Nội dung công việc', building: 'Tòa nhà', room: 'Phòng', jobType: 'Loại công việc', assignee: 'Người thực hiện', deadline: 'Hạn hoàn thành', priority: 'Mức ưu tiên' };
const shortText = z.string().max(500, 'Tối đa 500 ký tự.');
export const draftSchema = z.object({ title: shortText, description: z.string().max(12000), building: shortText, room: shortText, jobType: shortText, assignee: shortText, deadline: z.string().refine(value => !value || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+07:00$/.test(value), 'Chọn ngày giờ hợp lệ theo giờ Việt Nam.'), priority: z.enum(['NORMAL', 'LOW', 'URGENT']) });
export type TaskDraft = z.infer<typeof draftSchema>;
export const verdictSchema = z.enum(['correct', 'incorrect', 'not_applicable', 'unreviewed']);
export type Verdict = z.infer<typeof verdictSchema>;
export const verdictsSchema = z.object({ title: verdictSchema, building: verdictSchema, room: verdictSchema, jobType: verdictSchema, assignee: verdictSchema, deadline: verdictSchema, priority: verdictSchema });
export type Verdicts = z.infer<typeof verdictsSchema>;
export type TranscriptSource = '9router' | 'browser' | 'manual';
export const reviewFormSchema = z.object({ expected: draftSchema, verdicts: verdictsSchema, usefulness: z.number({ required_error: 'Chọn mức hữu ích từ 1 đến 5.' }).int().min(1).max(5), notes: z.string().max(4000) });
export type ReviewForm = z.infer<typeof reviewFormSchema>;
export const evaluationSchema = reviewFormSchema.extend({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), transcript: z.string().min(1).max(12000), transcriptSource: z.enum(['9router', 'browser', 'manual']), sttModel: z.string().nullable(), chatModel: z.string().min(1), predicted: draftSchema, latencyMs: z.object({ transcription: z.number().nonnegative().nullable(), extraction: z.number().nonnegative().nullable() }) });
export type Evaluation = z.infer<typeof evaluationSchema>;
export type Review = { predicted: Readonly<TaskDraft>; expected: TaskDraft; verdicts: Verdicts };

export function createReview(draft: TaskDraft): Review {
  return { predicted: Object.freeze({ ...draft }), expected: { ...draft }, verdicts: { title: 'unreviewed', building: 'unreviewed', room: 'unreviewed', jobType: 'unreviewed', assignee: 'unreviewed', deadline: 'unreviewed', priority: 'unreviewed' } };
}

export function editExpected(review: Review, field: ScoredField, value: string): Review {
  return { ...review, expected: { ...review.expected, [field]: value }, verdicts: { ...review.verdicts, [field]: 'incorrect' } };
}

const percent = z.number().min(0).max(100).nullable();
const count = z.number().int().nonnegative();
const metricsSchema = z.object({ totalRecords: count, reviewedFields: count, correctFields: count, fieldAccuracy: percent, ratedRecords: count, usefulRecords: count, usefulnessRate: percent, fullyReviewedRecords: count, fullyCorrectRecords: count, fullCorrectRate: percent });
export const summarySchema = metricsSchema.extend({ groups: z.array(metricsSchema.extend({ transcriptSource: z.enum(['9router', 'browser', 'manual']), sttModel: z.string().nullable(), chatModel: z.string() })).optional() });
export type EvaluationSummary = z.infer<typeof summarySchema>;
const providerStatusSchema = z.object({ authenticated: z.literal(true), chatModels: z.array(z.string()), sttModels: z.array(z.string()), defaultChatModel: z.string().nullable().optional(), defaultSttModel: z.string().nullable().optional(), providerReady: z.boolean(), capabilityError: z.string().nullable().optional() });
export const statusSchema = z.discriminatedUnion('authenticated', [z.object({ authenticated: z.literal(false) }), providerStatusSchema]);
export type LabStatus = z.infer<typeof statusSchema>;
export type ProviderStatus = z.infer<typeof providerStatusSchema>;
export const extractionSchema = z.object({ draft: draftSchema, warnings: z.array(z.string()), elapsedMs: z.number().nonnegative(), model: z.string(), referenceTime: z.string() });
export type Prediction = { id: string; transcript: string; transcriptSource: TranscriptSource; sttModel: string | null; chatModel: string; predicted: Readonly<TaskDraft>; warnings: string[]; referenceTime: string; latencyMs: Evaluation['latencyMs'] };

export function displayValue(field: ScoredField, value: string): string {
  if (!value) return 'Chưa xác định';
  if (field === 'priority') return ({ URGENT: 'Gấp', NORMAL: 'Bình thường', LOW: 'Thấp' } as Record<string, string>)[value] ?? value;
  if (field === 'deadline' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const time = new Date(value);
    if (!Number.isNaN(time.getTime())) return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(time);
  }
  return value;
}
