ALTER TABLE learners
  ADD COLUMN login_account TEXT;

ALTER TABLE learners
  ADD COLUMN login_pin_hash TEXT;

ALTER TABLE learners
  ADD COLUMN legacy_access_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (legacy_access_enabled IN (0, 1));

CREATE UNIQUE INDEX idx_learners_login_account
  ON learners (login_account)
  WHERE login_account IS NOT NULL;

CREATE TRIGGER learners_login_credential_insert_guard
BEFORE INSERT ON learners
FOR EACH ROW
WHEN
  (NEW.login_account IS NULL AND NEW.login_pin_hash IS NOT NULL)
  OR (NEW.login_account IS NOT NULL AND NEW.login_pin_hash IS NULL)
  OR (
    NEW.login_account IS NOT NULL
    AND (
      NEW.login_account <> lower(trim(NEW.login_account))
      OR length(NEW.login_account) < 3
      OR length(NEW.login_account) > 32
      OR substr(NEW.login_account, 1, 1) NOT GLOB '[a-z0-9]'
      OR NEW.login_account GLOB '*[^a-z0-9._-]*'
      OR length(NEW.login_pin_hash) = 0
      OR NEW.login_pin_hash NOT LIKE 'pbkdf2-sha256:%'
      OR NEW.legacy_access_enabled <> 0
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'learner_login_credential_invalid');
END;

CREATE TRIGGER learners_login_credential_update_guard
BEFORE UPDATE OF login_account, login_pin_hash, legacy_access_enabled ON learners
FOR EACH ROW
WHEN
  (NEW.login_account IS NULL AND NEW.login_pin_hash IS NOT NULL)
  OR (NEW.login_account IS NOT NULL AND NEW.login_pin_hash IS NULL)
  OR (
    NEW.login_account IS NOT NULL
    AND (
      NEW.login_account <> lower(trim(NEW.login_account))
      OR length(NEW.login_account) < 3
      OR length(NEW.login_account) > 32
      OR substr(NEW.login_account, 1, 1) NOT GLOB '[a-z0-9]'
      OR NEW.login_account GLOB '*[^a-z0-9._-]*'
      OR length(NEW.login_pin_hash) = 0
      OR NEW.login_pin_hash NOT LIKE 'pbkdf2-sha256:%'
      OR NEW.legacy_access_enabled <> 0
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'learner_login_credential_invalid');
END;

CREATE TABLE learner_login_attempts (
  account_hash TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
  blocked_until TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    length(account_hash) = 64
    AND account_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (julianday(window_started_at) IS NOT NULL),
  CHECK (blocked_until IS NULL OR julianday(blocked_until) IS NOT NULL),
  CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE INDEX idx_learner_login_attempts_cleanup
  ON learner_login_attempts (updated_at, blocked_until);

CREATE TABLE learner_login_credential_operations (
  operation_hash TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  outcome_login_account TEXT NOT NULL,
  outcome_credential_version INTEGER NOT NULL
    CHECK (outcome_credential_version > 0),
  revoked_session_count INTEGER NOT NULL CHECK (revoked_session_count >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (learner_id) REFERENCES learners(id),
  CHECK (length(operation_hash) = 71 AND operation_hash LIKE 'sha256:%'),
  CHECK (
    length(request_fingerprint) = 71
    AND request_fingerprint LIKE 'sha256:%'
  ),
  CHECK (
    outcome_login_account = lower(trim(outcome_login_account))
    AND length(outcome_login_account) BETWEEN 3 AND 32
    AND substr(outcome_login_account, 1, 1) GLOB '[a-z0-9]'
    AND outcome_login_account NOT GLOB '*[^a-z0-9._-]*'
  ),
  CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX idx_learner_login_credential_operations_learner
  ON learner_login_credential_operations (learner_id, created_at);

CREATE TRIGGER learner_login_credential_operation_insert_guard
BEFORE INSERT ON learner_login_credential_operations
FOR EACH ROW
WHEN
  EXISTS (
    SELECT 1 FROM admin_operations WHERE operation_hash = NEW.operation_hash
  )
  OR EXISTS (
    SELECT 1
    FROM course_progress_reset_operations
    WHERE operation_hash = NEW.operation_hash
  )
BEGIN
  SELECT RAISE(ABORT, 'learner_login_operation_hash_reused');
END;

CREATE TRIGGER admin_operations_learner_login_hash_guard
BEFORE INSERT ON admin_operations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM learner_login_credential_operations
  WHERE operation_hash = NEW.operation_hash
)
BEGIN
  SELECT RAISE(ABORT, 'learner_login_operation_hash_reused');
END;

CREATE TRIGGER course_progress_reset_learner_login_hash_guard
BEFORE INSERT ON course_progress_reset_operations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM learner_login_credential_operations
  WHERE operation_hash = NEW.operation_hash
)
BEGIN
  SELECT RAISE(ABORT, 'learner_login_operation_hash_reused');
END;

CREATE TRIGGER learner_login_credential_operations_immutable_update
BEFORE UPDATE ON learner_login_credential_operations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'learner_login_credential_operation_immutable');
END;

CREATE TRIGGER learner_login_credential_operations_immutable_delete
BEFORE DELETE ON learner_login_credential_operations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'learner_login_credential_operation_immutable');
END;
