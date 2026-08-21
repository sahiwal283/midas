-- One-time migration of the standalone Cashbook app's data into Midas.
-- Run against the MIDAS database after loading the two CSVs exported from
-- cashbook-db (see docs/superpowers/specs/2026-08-21-cashbook-merge-design.md):
--
--   on CT 120:
--     \copy (SELECT id, name, payroll_linked, archived_at, created_at FROM businesses) TO '/tmp/cash_biz.csv' CSV HEADER
--     \copy (SELECT e.id, e.business_id, e.kind, e.amount_cents, e.invoice_number, e.notes, e.category, e.receipt_path, e.entry_date, u.email AS created_by_email, e.voided_at, e.created_at FROM drawer_entries e LEFT JOIN users u ON u.id = e.created_by_id) TO '/tmp/cash_entries.csv' CSV HEADER
--
-- Idempotent: re-running skips rows that already exist (by original UUID).

BEGIN;

CREATE TEMP TABLE t_biz (
  id uuid, name text, payroll_linked boolean, archived_at timestamptz, created_at timestamptz
);
\copy t_biz FROM '/tmp/cash_biz.csv' CSV HEADER

INSERT INTO cash_businesses (id, name, payroll_linked, archived_at, created_at)
SELECT id, name, payroll_linked, archived_at, created_at FROM t_biz
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE t_entries (
  id uuid, business_id uuid, kind text, amount_cents bigint, invoice_number text,
  notes text, category text, receipt_path text, entry_date date,
  created_by_email text, voided_at timestamptz, created_at timestamptz
);
\copy t_entries FROM '/tmp/cash_entries.csv' CSV HEADER

-- Authors map by email to Midas users; otherwise the email is kept as a label.
INSERT INTO cash_drawer_entries (
  id, business_id, kind, amount_cents, invoice_number, notes, category,
  receipt_path, entry_date, created_by_id, created_by_label, voided_at, created_at
)
SELECT e.id, e.business_id, e.kind::cash_entry_kind, e.amount_cents, e.invoice_number,
       e.notes, e.category, e.receipt_path, e.entry_date,
       mu.id,
       CASE WHEN mu.id IS NULL THEN e.created_by_email END,
       e.voided_at, e.created_at
FROM t_entries e
LEFT JOIN users mu ON lower(mu.email) = lower(e.created_by_email)
ON CONFLICT (id) DO NOTHING;

-- Verification: per-business on-hand balance (compare to the cashbook site).
SELECT b.name,
       COALESCE(SUM(CASE WHEN e.kind = 'DEPOSIT' THEN e.amount_cents WHEN e.kind = 'WITHDRAWAL' THEN -e.amount_cents END)
                FILTER (WHERE e.voided_at IS NULL), 0) / 100.0 AS on_hand_dollars,
       COUNT(e.id) AS entries
FROM cash_businesses b
LEFT JOIN cash_drawer_entries e ON e.business_id = b.id
GROUP BY b.name ORDER BY b.name;

COMMIT;
