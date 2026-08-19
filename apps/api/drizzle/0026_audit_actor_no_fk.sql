-- 0026: audit_logs.user_id keeps the actor id as a historical snapshot.
-- The FK's ON DELETE SET NULL could never run: audit_logs is append-only
-- (a trigger rejects UPDATE), so deleting any user who appeared in the log
-- failed with 23000. An audit trail must outlive its actors anyway.

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_id_users_id_fk;
