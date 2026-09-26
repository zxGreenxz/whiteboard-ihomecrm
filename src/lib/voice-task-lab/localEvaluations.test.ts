// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalEvaluations } from './localEvaluations';
import { createReview, type Evaluation } from './model';
const draft = { title: 'Sửa vòi', description: 'Sửa vòi phòng 201', room: '201', building: 'A', assignee: '', jobType: '', deadline: '', priority: 'NORMAL' as const };
const record: Evaluation = { id: 'trial-1', transcript: 'Sửa vòi phòng 201', transcriptSource: 'manual', sttModel: null, chatModel: 'chat-a', ...createReview(draft), usefulness: 4, notes: '', latencyMs: { transcription: null, extraction: 20 } };
beforeEach(() => localStorage.clear());
describe('device evaluation storage', () => {
  it('isolates users and organizations and does not count unreviewed fields as correct', () => {
    const store = createLocalEvaluations(localStorage, 'user-a', 'org-a');
    store.save(record);
    expect(createLocalEvaluations(localStorage, 'user-b', 'org-a').list().records).toHaveLength(0);
    expect(createLocalEvaluations(localStorage, 'user-a', 'org-b').list().records).toHaveLength(0);
    expect(store.list().summary).toMatchObject({ totalRecords: 1, fieldAccuracy: null, reviewedFields: 0, usefulnessRate: 100 });
  });
  it('upserts the same trial without allowing its original prediction to change', () => {
    const store = createLocalEvaluations(localStorage, 'user-a', 'org-a');
    store.save(record); store.save({ ...record, usefulness: 5 });
    expect(store.list().records).toHaveLength(1);
    expect(store.list().records[0].usefulness).toBe(5);
    expect(() => store.save({ ...record, predicted: { ...draft, room: '202' } })).toThrow(/bản gốc/i);
    expect(store.list().records[0].predicted.room).toBe('201');
  });
  it('preserves a corrupt file instead of treating it as an empty store', () => {
    const store = createLocalEvaluations(localStorage, 'u', 'o'); store.save(record);
    const key = localStorage.key(0)!; localStorage.setItem(key, 'corrupt');
    expect(() => store.list()).toThrow(/đọc/);
    expect(() => store.save(record)).toThrow(/đọc/);
    expect(localStorage.getItem(key)).toBe('corrupt');
  });
  it('allows updating at the hundred-record cap but rejects a new trial', () => {
    const store = createLocalEvaluations(localStorage, 'u', 'o');
    for (let i = 0; i < 100; i++) store.save({ ...record, id: `trial-${i}` });
    store.save({ ...record, id: 'trial-1', usefulness: 5 });
    expect(() => store.save({ ...record, id: 'trial-101' })).toThrow(/100/);
    expect(store.list().records).toHaveLength(100);
  });
});
