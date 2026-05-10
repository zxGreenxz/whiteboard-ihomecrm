BEGIN;

INSERT INTO accounts (user_id, name, type, initial_amount, initial_date, is_default, description)
VALUES
  ('d45a7506-5250-4d99-ac94-9f73cbd4df17', 'Hiển Thối', 'cash', 0, CURRENT_DATE, false, 'Sổ quỹ ghi tiền thối lại cho khách (Joey)'),
  ('df8d1df5-1c24-4723-9733-4640c43c382b', 'Hiệp Thối', 'cash', 0, CURRENT_DATE, false, 'Sổ quỹ ghi tiền thối lại cho khách (Nathan)')
ON CONFLICT DO NOTHING;

INSERT INTO income_expense_types (user_id, name, type, is_default, description)
SELECT u.id, 'Tiền thối', 'expense', false, 'Tiền thừa thối lại cho khách khi thu hoá đơn'
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM income_expense_types t
  WHERE t.user_id = u.id AND t.type = 'expense' AND t.name = 'Tiền thối'
);

COMMIT;
