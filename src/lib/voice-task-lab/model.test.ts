import { describe, expect, it } from 'vitest';
import { createReview, editExpected, evaluationSchema } from './model';

const draft = { title: 'Sửa vòi nước', description: '', building: '1392QT', room: '201', jobType: 'Sửa', assignee: 'Nam', deadline: '2026-09-27T17:00:00+07:00', priority: 'URGENT' as const };

describe('voice task evaluation integrity', () => {
  it('starts every field unreviewed and keeps the model prediction when correcting an expected value', () => {
    const review = createReview(draft);
    expect(Object.values(review.verdicts)).toEqual(Array(7).fill('unreviewed'));
    const changed = editExpected(review, 'room', '202');
    expect(changed.predicted.room).toBe('201');
    expect(changed.expected.room).toBe('202');
    expect(changed.verdicts.room).toBe('incorrect');
    expect(review.expected.room).toBe('201');
  });

  it('does not treat restoring a value as an automatic correct review', () => {
    const changed = editExpected(editExpected(createReview(draft), 'room', '202'), 'room', '201');
    expect(changed.verdicts.room).toBe('incorrect');
  });

  it('requires a human usefulness rating and all seven verdict fields', () => {
    const review = createReview(draft);
    const payload = { id: '3ac15c73-bd19-4cf4-87eb-eaf974e59389', transcript: 'Sửa vòi nước phòng 201', transcriptSource: 'manual', sttModel: null, chatModel: 'chat-1', ...review, notes: '', latencyMs: { transcription: null, extraction: 320 } };
    expect(evaluationSchema.safeParse(payload).success).toBe(false);
    expect(evaluationSchema.safeParse({ ...payload, usefulness: 4 }).success).toBe(true);
    expect(evaluationSchema.safeParse({ ...payload, usefulness: 4, verdicts: { room: 'correct' } }).success).toBe(false);
  });
});
