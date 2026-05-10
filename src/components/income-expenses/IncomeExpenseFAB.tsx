import { useEffect, useRef, useState } from "react";
import { Plus, X, ArrowUp, ArrowDown, Layers } from "lucide-react";

interface Props {
  onCreateIncome: () => void;
  onCreateExpense: () => void;
  onCreateBatch?: () => void;
}

export function IncomeExpenseFAB({
  onCreateIncome,
  onCreateExpense,
  onCreateBatch,
}: Props) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - lastY.current;
      // Cuộn xuống > 6px → ẩn, cuộn lên hoặc tới đỉnh → hiện
      if (dy > 6 && y > 80) setHidden(true);
      else if (dy < -6 || y < 40) setHidden(false);
      lastY.current = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const close = () => setOpen(false);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={close}
        className={`fixed inset-0 z-30 bg-black/30 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        aria-hidden="true"
      />

      {/* Speed-dial menu */}
      <div
        className={`fixed right-4 z-40 flex flex-col items-end gap-2.5 transition-all duration-200 ${
          open
            ? "opacity-100 translate-y-0"
            : "opacity-0 translate-y-2 pointer-events-none"
        }`}
        style={{ bottom: "calc(140px + env(safe-area-inset-bottom, 0px))" }}
      >
        <button
          type="button"
          className="inline-flex items-center gap-2.5 pl-4 pr-2 py-2 bg-white rounded-full shadow-lg border border-zinc-200 active:scale-95 transition-transform"
          onClick={() => {
            close();
            onCreateIncome();
          }}
        >
          <span className="text-sm font-medium text-zinc-700">Phiếu thu</span>
          <span className="w-9 h-9 rounded-full bg-emerald-500 grid place-items-center">
            <ArrowUp className="h-4 w-4 text-white" />
          </span>
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2.5 pl-4 pr-2 py-2 bg-white rounded-full shadow-lg border border-zinc-200 active:scale-95 transition-transform"
          onClick={() => {
            close();
            onCreateExpense();
          }}
        >
          <span className="text-sm font-medium text-zinc-700">Phiếu chi</span>
          <span className="w-9 h-9 rounded-full bg-red-500 grid place-items-center">
            <ArrowDown className="h-4 w-4 text-white" />
          </span>
        </button>
        {onCreateBatch && (
          <button
            type="button"
            className="inline-flex items-center gap-2.5 pl-4 pr-2 py-2 bg-white rounded-full shadow-lg border border-zinc-200 active:scale-95 transition-transform"
            onClick={() => {
              close();
              onCreateBatch();
            }}
          >
            <span className="text-sm font-medium text-zinc-700">Phiếu tổng</span>
            <span className="w-9 h-9 rounded-full bg-indigo-500 grid place-items-center">
              <Layers className="h-4 w-4 text-white" />
            </span>
          </button>
        )}
      </div>

      {/* Main FAB */}
      <button
        type="button"
        aria-label={open ? "Đóng menu" : "Thêm phiếu"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`fixed right-4 z-40 w-14 h-14 rounded-full bg-blue-600 text-white shadow-xl grid place-items-center transition-all duration-200 active:scale-95 ${
          open ? "rotate-45" : ""
        } ${hidden && !open ? "translate-y-24 opacity-0" : "translate-y-0 opacity-100"}`}
        style={{ bottom: "calc(72px + env(safe-area-inset-bottom, 0px))" }}
      >
        {open ? <X className="h-6 w-6" /> : <Plus className="h-6 w-6" />}
      </button>
    </>
  );
}

export default IncomeExpenseFAB;
