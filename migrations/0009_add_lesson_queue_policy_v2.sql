ALTER TABLE lesson_sessions
  ADD COLUMN queue_policy_version TEXT NOT NULL DEFAULT 'v1_5_8_unbounded'
  CHECK (queue_policy_version IN ('v1_5_8_unbounded', 'v2_3_6_cap3'));

ALTER TABLE review_logs
  ADD COLUMN queue_disposition TEXT
  CHECK (
    queue_disposition IS NULL
    OR queue_disposition IN ('scheduled', 'deferred_cap', 'deferred_capacity')
  );

CREATE INDEX idx_lesson_sessions_queue_policy_status
  ON lesson_sessions (queue_policy_version, status);

CREATE TRIGGER lesson_sessions_queue_policy_immutable
BEFORE UPDATE OF queue_policy_version ON lesson_sessions
FOR EACH ROW
WHEN NEW.queue_policy_version <> OLD.queue_policy_version
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_queue_policy_immutable');
END;

CREATE TRIGGER review_logs_queue_policy_insert
BEFORE INSERT ON review_logs
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_sessions
  WHERE lesson_sessions.id = NEW.session_id
    AND (
      (
        lesson_sessions.queue_policy_version = 'v1_5_8_unbounded'
        AND NEW.queue_disposition IS NULL
      )
      OR (
        lesson_sessions.queue_policy_version = 'v2_3_6_cap3'
        AND (
          (NEW.score >= 2 AND NEW.queue_disposition IS NULL)
          OR (
            NEW.score < 2
            AND NEW.queue_disposition IN (
              'scheduled',
              'deferred_cap',
              'deferred_capacity'
            )
          )
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'review_log_queue_policy_mismatch');
END;

CREATE TRIGGER review_logs_queue_policy_update
BEFORE UPDATE OF session_id, score, queue_disposition ON review_logs
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_sessions
  WHERE lesson_sessions.id = NEW.session_id
    AND (
      (
        lesson_sessions.queue_policy_version = 'v1_5_8_unbounded'
        AND NEW.queue_disposition IS NULL
      )
      OR (
        lesson_sessions.queue_policy_version = 'v2_3_6_cap3'
        AND (
          (NEW.score >= 2 AND NEW.queue_disposition IS NULL)
          OR (
            NEW.score < 2
            AND NEW.queue_disposition IN (
              'scheduled',
              'deferred_cap',
              'deferred_capacity'
            )
          )
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'review_log_queue_policy_mismatch');
END;

CREATE TRIGGER review_logs_queue_disposition_immutable
BEFORE UPDATE OF queue_disposition ON review_logs
FOR EACH ROW
WHEN NEW.queue_disposition IS NOT OLD.queue_disposition
BEGIN
  SELECT RAISE(ABORT, 'review_log_queue_disposition_immutable');
END;
