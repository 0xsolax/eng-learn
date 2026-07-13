CREATE TABLE admin_operations (
  operation_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN ('create_source', 'create_course', 'rotate_access_code')
  ),
  target_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  outcome_source_id TEXT,
  outcome_source_version_id TEXT,
  outcome_learner_id TEXT,
  outcome_course_id TEXT,
  outcome_credential_version INTEGER CHECK (
    outcome_credential_version IS NULL OR outcome_credential_version > 0
  ),
  revoked_session_count INTEGER CHECK (
    revoked_session_count IS NULL OR revoked_session_count >= 0
  ),
  created_at TEXT NOT NULL,
  CHECK (length(operation_hash) = 71 AND operation_hash LIKE 'sha256:%'),
  CHECK (length(request_fingerprint) = 71 AND request_fingerprint LIKE 'sha256:%'),
  CHECK (
    (
      kind = 'create_source'
      AND outcome_source_id IS NOT NULL
      AND outcome_source_version_id IS NOT NULL
      AND outcome_learner_id IS NULL
      AND outcome_course_id IS NULL
      AND outcome_credential_version IS NULL
      AND revoked_session_count IS NULL
    )
    OR (
      kind = 'create_course'
      AND outcome_source_id IS NULL
      AND outcome_source_version_id IS NULL
      AND outcome_learner_id IS NOT NULL
      AND outcome_course_id IS NOT NULL
      AND outcome_credential_version IS NOT NULL
      AND revoked_session_count IS NULL
    )
    OR (
      kind = 'rotate_access_code'
      AND outcome_source_id IS NULL
      AND outcome_source_version_id IS NULL
      AND outcome_learner_id IS NOT NULL
      AND outcome_course_id IS NULL
      AND outcome_credential_version IS NOT NULL
      AND revoked_session_count IS NOT NULL
    )
  )
);

CREATE INDEX idx_admin_operations_target_kind
  ON admin_operations (target_id, kind, created_at);
