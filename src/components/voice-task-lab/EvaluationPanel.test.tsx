// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvaluationPanel } from './EvaluationPanel';
import type { Prediction } from '@/lib/voice-task-lab/model';

afterEach(cleanup);
const prediction: Prediction = { id: 'trial-a', transcript: 'Sửa vòi phòng 202', transcriptSource: 'manual', sttModel: null, chatModel: 'chat-a', predicted: { title: 'Sửa vòi', description: 'Sửa vòi phòng 201', building: 'A', room: '201', jobType: '', assignee: '', deadline: '', priority: 'NORMAL' }, warnings: [], referenceTime: '2026-09-26T12:00:00Z', latencyMs: { transcription: null, extraction: 340 } };

describe('human review form', () => {
  it('retains the visible model prediction and saves only explicit verdicts with a human rating', async () => {
    const save = vi.fn();
    render(<EvaluationPanel prediction={prediction} busy={false} saving={false} stale={false} saved={false} onSave={save} onNew={() => {}} />);
    const room = within(screen.getByRole('group', { name: 'Phòng' }));
    fireEvent.click(room.getByRole('radio', { name: 'Sai' }));
    fireEvent.change(room.getByLabelText('Giá trị bạn mong đợi'), { target: { value: '202' } });
    expect(room.getByText('201')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lưu đánh giá' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chọn mức hữu ích'));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: '4 trên 5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu đánh giá' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({ expected: { room: '202' }, verdicts: { room: 'incorrect', title: 'unreviewed', building: 'unreviewed' }, usefulness: 4 });
    expect(prediction.predicted.room).toBe('201');
  });

  it('keeps edited transcript reviews unsavable until reanalysis', () => {
    render(<EvaluationPanel prediction={prediction} busy={false} saving={false} stale={true} saved={false} onSave={vi.fn()} onNew={() => {}} />);
    expect((screen.getByRole('button', { name: 'Lưu đánh giá' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('phân tích lại');
  });

  it('restores the original expected value when the reviewer changes their verdict back to correct', async () => {
    const save = vi.fn();
    render(<EvaluationPanel prediction={prediction} busy={false} saving={false} stale={false} saved={false} onSave={save} onNew={() => {}} />);
    const room = within(screen.getByRole('group', { name: 'Phòng' }));
    fireEvent.click(room.getByRole('radio', { name: 'Sai' }));
    fireEvent.change(room.getByLabelText('Giá trị bạn mong đợi'), { target: { value: '202' } });
    fireEvent.click(room.getByRole('radio', { name: 'Đúng' }));
    fireEvent.click(screen.getByRole('radio', { name: '4 trên 5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu đánh giá' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({ expected: { room: '201' }, verdicts: { room: 'correct' } });
  });
});
