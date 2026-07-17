ALTER TABLE lesson_sessions
  ADD COLUMN flow_policy_version TEXT NOT NULL DEFAULT 'v1_due_then_new_unbounded'
  CHECK (
    flow_policy_version IN (
      'v1_due_then_new_unbounded',
      'v2_rolling_reinforcement_budget24'
    )
  );

ALTER TABLE lesson_tasks
  ADD COLUMN reinforcement_source_task_id TEXT
  REFERENCES lesson_tasks(id);

ALTER TABLE review_logs
  ADD COLUMN queue_capacity_reason TEXT
  CHECK (
    queue_capacity_reason IS NULL
    OR queue_capacity_reason IN (
      'short_pool',
      'interval_infeasible',
      'lesson_task_budget'
    )
  );

CREATE INDEX idx_lesson_sessions_flow_policy_status
  ON lesson_sessions (flow_policy_version, status);

CREATE TRIGGER lesson_sessions_flow_policy_immutable
BEFORE UPDATE OF flow_policy_version ON lesson_sessions
FOR EACH ROW
WHEN NEW.flow_policy_version <> OLD.flow_policy_version
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_flow_policy_immutable');
END;

CREATE TRIGGER lesson_sessions_flow_queue_policy_insert
BEFORE INSERT ON lesson_sessions
FOR EACH ROW
WHEN NEW.flow_policy_version = 'v2_rolling_reinforcement_budget24'
  AND NEW.queue_policy_version <> 'v2_3_6_cap3'
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_flow_queue_policy_mismatch');
END;

CREATE TRIGGER lesson_sessions_flow_queue_policy_update
BEFORE UPDATE OF flow_policy_version, queue_policy_version ON lesson_sessions
FOR EACH ROW
WHEN NEW.flow_policy_version = 'v2_rolling_reinforcement_budget24'
  AND NEW.queue_policy_version <> 'v2_3_6_cap3'
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_flow_queue_policy_mismatch');
END;

CREATE INDEX idx_lesson_tasks_reinforcement_source
  ON lesson_tasks (reinforcement_source_task_id, role);

CREATE UNIQUE INDEX idx_lesson_tasks_one_reinforcement_per_source
  ON lesson_tasks (reinforcement_source_task_id)
  WHERE reinforcement_source_task_id IS NOT NULL;

CREATE TRIGGER lesson_tasks_reinforcement_insert
BEFORE INSERT ON lesson_tasks
FOR EACH ROW
WHEN NEW.reinforcement_source_task_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM lesson_tasks AS source_task
    INNER JOIN lesson_sessions AS source_session
      ON source_session.id = source_task.session_id
      AND source_session.course_id = source_task.course_id
    INNER JOIN user_word_states AS source_state
      ON source_state.course_id = source_task.course_id
      AND source_state.word_id = source_task.word_id
    INNER JOIN review_logs AS source_log
      ON source_log.task_id = source_task.id
      AND source_log.session_id = source_task.session_id
      AND source_log.course_id = source_task.course_id
      AND source_log.word_id = source_task.word_id
      AND source_log.stage = source_task.stage
      AND source_log.task_type = source_task.task_type
      AND source_log.score >= 2
    WHERE source_task.id = NEW.reinforcement_source_task_id
      AND source_task.session_id = NEW.session_id
      AND source_task.course_id = NEW.course_id
      AND source_task.word_id = NEW.word_id
      AND source_task.stage = 'S0'
      AND source_task.role = 'primary'
      AND source_task.status = 'completed'
      AND source_session.lesson_no = source_state.first_lesson_no
      AND source_session.flow_policy_version =
        'v2_rolling_reinforcement_budget24'
      AND source_session.queue_policy_version = 'v2_3_6_cap3'
      AND NEW.stage = 'S1'
      AND NEW.role = 'bridge'
      AND NEW.required = 1
      AND NEW.reflux_source_task_id IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'lesson_task_reinforcement_mismatch');
END;

CREATE TRIGGER lesson_tasks_reinforcement_update
BEFORE UPDATE OF
  reinforcement_source_task_id,
  session_id,
  course_id,
  word_id,
  stage,
  role,
  required,
  reflux_source_task_id
ON lesson_tasks
FOR EACH ROW
WHEN NEW.reinforcement_source_task_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM lesson_tasks AS source_task
    INNER JOIN lesson_sessions AS source_session
      ON source_session.id = source_task.session_id
      AND source_session.course_id = source_task.course_id
    INNER JOIN user_word_states AS source_state
      ON source_state.course_id = source_task.course_id
      AND source_state.word_id = source_task.word_id
    INNER JOIN review_logs AS source_log
      ON source_log.task_id = source_task.id
      AND source_log.session_id = source_task.session_id
      AND source_log.course_id = source_task.course_id
      AND source_log.word_id = source_task.word_id
      AND source_log.stage = source_task.stage
      AND source_log.task_type = source_task.task_type
      AND source_log.score >= 2
    WHERE source_task.id = NEW.reinforcement_source_task_id
      AND source_task.session_id = NEW.session_id
      AND source_task.course_id = NEW.course_id
      AND source_task.word_id = NEW.word_id
      AND source_task.stage = 'S0'
      AND source_task.role = 'primary'
      AND source_task.status = 'completed'
      AND source_session.lesson_no = source_state.first_lesson_no
      AND source_session.flow_policy_version =
        'v2_rolling_reinforcement_budget24'
      AND source_session.queue_policy_version = 'v2_3_6_cap3'
      AND NEW.stage = 'S1'
      AND NEW.role = 'bridge'
      AND NEW.required = 1
      AND NEW.reflux_source_task_id IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'lesson_task_reinforcement_mismatch');
END;

CREATE TRIGGER lesson_tasks_reinforcement_source_immutable
BEFORE UPDATE OF reinforcement_source_task_id ON lesson_tasks
FOR EACH ROW
WHEN NEW.reinforcement_source_task_id IS NOT OLD.reinforcement_source_task_id
BEGIN
  SELECT RAISE(ABORT, 'lesson_task_reinforcement_source_immutable');
END;

CREATE TRIGGER lesson_tasks_planned_reinforcement_limit_insert
BEFORE INSERT ON lesson_tasks
FOR EACH ROW
WHEN NEW.reinforcement_source_task_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM lesson_tasks
    WHERE id = NEW.id
  )
  AND (
    SELECT COUNT(*)
    FROM lesson_tasks
    WHERE session_id = NEW.session_id
      AND reinforcement_source_task_id IS NOT NULL
  ) >= 3
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_planned_reinforcement_limit');
END;

CREATE TRIGGER lesson_tasks_flow_v2_task_limit_insert
BEFORE INSERT ON lesson_tasks
FOR EACH ROW
WHEN NOT EXISTS (
    SELECT 1
    FROM lesson_tasks
    WHERE id = NEW.id
  )
  AND EXISTS (
    SELECT 1
    FROM lesson_sessions
    WHERE id = NEW.session_id
      AND flow_policy_version = 'v2_rolling_reinforcement_budget24'
  )
  AND (
    SELECT COUNT(*)
    FROM lesson_tasks
    WHERE session_id = NEW.session_id
  ) >= 24
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_task_limit');
END;

CREATE TRIGGER lesson_tasks_flow_v2_task_limit_move
BEFORE UPDATE OF session_id ON lesson_tasks
FOR EACH ROW
WHEN NEW.session_id IS NOT OLD.session_id
  AND EXISTS (
    SELECT 1
    FROM lesson_sessions
    WHERE id = NEW.session_id
      AND flow_policy_version = 'v2_rolling_reinforcement_budget24'
  )
  AND (
    SELECT COUNT(*)
    FROM lesson_tasks
    WHERE session_id = NEW.session_id
      AND id <> OLD.id
  ) >= 24
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_task_limit');
END;

CREATE TRIGGER review_logs_queue_capacity_reason_insert
BEFORE INSERT ON review_logs
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_sessions
  WHERE lesson_sessions.id = NEW.session_id
    AND (
      (
        lesson_sessions.flow_policy_version = 'v1_due_then_new_unbounded'
        AND NEW.queue_capacity_reason IS NULL
      )
      OR (
        lesson_sessions.flow_policy_version =
          'v2_rolling_reinforcement_budget24'
        AND (
          (
            NEW.queue_disposition = 'deferred_capacity'
            AND NEW.queue_capacity_reason IS NOT NULL
          )
          OR (
            NEW.queue_disposition IS NOT 'deferred_capacity'
            AND NEW.queue_capacity_reason IS NULL
          )
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'review_log_queue_capacity_reason_mismatch');
END;

CREATE TRIGGER review_logs_queue_capacity_reason_update
BEFORE UPDATE OF session_id, queue_disposition, queue_capacity_reason ON review_logs
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_sessions
  WHERE lesson_sessions.id = NEW.session_id
    AND (
      (
        lesson_sessions.flow_policy_version = 'v1_due_then_new_unbounded'
        AND NEW.queue_capacity_reason IS NULL
      )
      OR (
        lesson_sessions.flow_policy_version =
          'v2_rolling_reinforcement_budget24'
        AND (
          (
            NEW.queue_disposition = 'deferred_capacity'
            AND NEW.queue_capacity_reason IS NOT NULL
          )
          OR (
            NEW.queue_disposition IS NOT 'deferred_capacity'
            AND NEW.queue_capacity_reason IS NULL
          )
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'review_log_queue_capacity_reason_mismatch');
END;

CREATE TRIGGER review_logs_queue_capacity_reason_immutable
BEFORE UPDATE OF queue_capacity_reason ON review_logs
FOR EACH ROW
WHEN NEW.queue_capacity_reason IS NOT OLD.queue_capacity_reason
BEGIN
  SELECT RAISE(ABORT, 'review_log_queue_capacity_reason_immutable');
END;
