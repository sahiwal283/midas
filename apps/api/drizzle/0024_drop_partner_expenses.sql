-- 0024: Remove the standalone partner expense tracker.
-- Partner spend is now expenses.expense_kind = 'partner'. The table held 0 rows.

DROP TABLE IF EXISTS partner_expenses;
DROP TYPE IF EXISTS partner_expense_category;
