// Shell tương thích — god-hook cũ đã được tách thành module
// src/hooks/income-expenses/ (types / queries / mutations / statusMutations /
// batch / recurring / specialized). Giữ file này để mọi import cũ từ
// "@/hooks/useIncomeExpenses" tiếp tục hoạt động y hệt.
export * from "./income-expenses";
