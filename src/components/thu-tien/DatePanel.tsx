import { ChevronRight } from 'lucide-react';

export interface CollectDateRange {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD (== start khi chọn 1 ngày)
}

interface Props {
  mode: 'single' | 'range';
  onModeChange: (m: 'single' | 'range') => void;
  value: CollectDateRange;
  onChange: (r: CollectDateRange) => void;
  resultText: React.ReactNode;
}

export function DatePanel({ mode, onModeChange, value, onChange, resultText }: Props) {
  return (
    <div className="date-panel">
      <div className="dp-modes">
        <button
          type="button"
          className={'dp-mode' + (mode === 'single' ? ' on' : '')}
          onClick={() => onModeChange('single')}
        >
          Một ngày
        </button>
        <button
          type="button"
          className={'dp-mode' + (mode === 'range' ? ' on' : '')}
          onClick={() => onModeChange('range')}
        >
          Khoảng ngày
        </button>
      </div>
      <div className="dp-inputs">
        <input
          type="date"
          value={value.start}
          onChange={(e) =>
            onChange(
              mode === 'single'
                ? { start: e.target.value, end: e.target.value }
                : { ...value, start: e.target.value },
            )
          }
        />
        {mode === 'range' && (
          <>
            <span className="dp-arrow">
              <ChevronRight />
            </span>
            <input
              type="date"
              value={value.end}
              onChange={(e) => onChange({ ...value, end: e.target.value })}
            />
          </>
        )}
      </div>
      <div className="dp-result">{resultText}</div>
    </div>
  );
}

export default DatePanel;
