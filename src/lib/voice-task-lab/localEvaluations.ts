import { z } from 'zod';
import { evaluationSchema, scoredFields, type Evaluation } from './model';
import { LabApiError } from './client';

function metrics(records: Evaluation[]) {
  let reviewedFields = 0, correctFields = 0, usefulRecords = 0, fullyReviewedRecords = 0, fullyCorrectRecords = 0;
  for (const record of records) {
    const verdicts = scoredFields.map(field => record.verdicts[field]);
    const applicable = verdicts.filter(value => value === 'correct' || value === 'incorrect');
    reviewedFields += applicable.length; correctFields += applicable.filter(value => value === 'correct').length;
    if (record.usefulness >= 4) usefulRecords += 1;
    if (!verdicts.includes('unreviewed') && applicable.length) { fullyReviewedRecords += 1; if (applicable.every(value => value === 'correct')) fullyCorrectRecords += 1; }
  }
  return { totalRecords: records.length, reviewedFields, correctFields, fieldAccuracy: reviewedFields ? 100 * correctFields / reviewedFields : null, ratedRecords: records.length, usefulRecords, usefulnessRate: records.length ? 100 * usefulRecords / records.length : null, fullyReviewedRecords, fullyCorrectRecords, fullCorrectRate: fullyReviewedRecords ? 100 * fullyCorrectRecords / fullyReviewedRecords : null };
}

export function createLocalEvaluations(storage: Pick<Storage, 'getItem' | 'setItem'>, userId: string, organizationId: string) {
  if (!userId || !organizationId) throw new LabApiError('Cần chọn tài khoản và tổ chức trước khi đọc đánh giá.', 401);
  const key = `ihomecrm.voice-task-lab.v1:${encodeURIComponent(userId)}:${encodeURIComponent(organizationId)}`;
  const read = (): Evaluation[] => {
    try {
      const raw = storage.getItem(key);
      if (raw === null) return [];
      if (raw.length > 8 * 1024 * 1024) throw new Error('oversized');
      const records = z.array(evaluationSchema).max(100).parse(JSON.parse(raw));
      if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('duplicate');
      return records;
    } catch { throw new LabApiError('Không đọc được đánh giá trên thiết bị này. Dữ liệu cũ được giữ nguyên để kiểm tra.'); }
  };
  return {
    list() {
      const records = read();
      const grouped = new Map<string, Evaluation[]>();
      for (const record of records) { const group = JSON.stringify([record.transcriptSource, record.sttModel, record.chatModel]); const items = grouped.get(group) ?? []; items.push(record); grouped.set(group, items); }
      const groups = [...grouped.values()].map(items => ({ transcriptSource: items[0].transcriptSource, sttModel: items[0].sttModel, chatModel: items[0].chatModel, ...metrics(items) }));
      return { records, summary: { ...metrics(records), groups } };
    },
    save(value: Evaluation) {
      const record = evaluationSchema.parse(value);
      const records = read();
      const index = records.findIndex(item => item.id === record.id);
      if (index < 0) {
        if (records.length >= 100) throw new LabApiError('Thiết bị này đã lưu 100 lượt thử. Hãy tải báo cáo trước khi bắt đầu đợt mới.');
        records.push(record);
      } else {
        for (const field of ['transcript', 'transcriptSource', 'sttModel', 'chatModel', 'predicted', 'latencyMs'] as const) {
          if (JSON.stringify(records[index][field]) !== JSON.stringify(record[field])) throw new LabApiError('Không thể thay đổi bản gốc của lượt thử đã lưu. Hãy bắt đầu lượt thử mới.');
        }
        records[index] = record;
      }
      try { storage.setItem(key, JSON.stringify(records)); }
      catch { throw new LabApiError('Chưa lưu được đánh giá trên thiết bị này. Bộ nhớ có thể đã đầy hoặc bị chặn; dữ liệu trên màn hình vẫn được giữ.'); }
    },
  };
}
