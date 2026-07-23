ALTER TABLE courses
  ADD COLUMN current_learning_run_no INTEGER NOT NULL DEFAULT 1
  CHECK (current_learning_run_no > 0);

ALTER TABLE courses
  ADD COLUMN current_run_start_lesson_no INTEGER NOT NULL DEFAULT 1
  CHECK (current_run_start_lesson_no > 0);

ALTER TABLE lesson_sessions
  ADD COLUMN learning_run_no INTEGER NOT NULL DEFAULT 1
  CHECK (learning_run_no > 0);

ALTER TABLE lesson_sessions
  ADD COLUMN run_lesson_no INTEGER NOT NULL DEFAULT 1
  CHECK (run_lesson_no > 0);

UPDATE lesson_sessions
SET run_lesson_no = lesson_no;

ALTER TABLE user_word_states
  ADD COLUMN learning_run_no INTEGER NOT NULL DEFAULT 1
  CHECK (learning_run_no > 0);

CREATE TABLE course_learning_runs (
  course_id TEXT NOT NULL,
  run_no INTEGER NOT NULL CHECK (run_no > 0),
  start_lesson_no INTEGER NOT NULL CHECK (start_lesson_no > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  started_by_reset_operation_hash TEXT,
  ended_by_reset_operation_hash TEXT,
  PRIMARY KEY (course_id, run_no),
  FOREIGN KEY (course_id) REFERENCES courses(id),
  CHECK (
    (status = 'active' AND ended_at IS NULL AND ended_by_reset_operation_hash IS NULL)
    OR
    (status = 'completed' AND ended_at IS NOT NULL AND ended_by_reset_operation_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_course_learning_runs_one_active
  ON course_learning_runs (course_id)
  WHERE status = 'active';

INSERT INTO course_learning_runs (
  course_id,
  run_no,
  start_lesson_no,
  status,
  started_at
)
SELECT
  id,
  1,
  1,
  'active',
  created_at
FROM courses;

CREATE TRIGGER courses_create_initial_learning_run
AFTER INSERT ON courses
FOR EACH ROW
BEGIN
  INSERT INTO course_learning_runs (
    course_id,
    run_no,
    start_lesson_no,
    status,
    started_at
  ) VALUES (
    NEW.id,
    NEW.current_learning_run_no,
    NEW.current_run_start_lesson_no,
    'active',
    NEW.created_at
  );
END;

CREATE TABLE course_learning_run_word_state_snapshots (
  course_id TEXT NOT NULL,
  learning_run_no INTEGER NOT NULL CHECK (learning_run_no > 0),
  word_id TEXT NOT NULL,
  state_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  stage_attempt_count INTEGER NOT NULL,
  stage_correct_count INTEGER NOT NULL,
  total_attempt_count INTEGER NOT NULL,
  total_correct_count INTEGER NOT NULL,
  total_wrong_count INTEGER NOT NULL,
  current_streak INTEGER NOT NULL,
  wrong_streak INTEGER NOT NULL,
  lapse_count INTEGER NOT NULL,
  ease_factor REAL NOT NULL,
  mastery_score INTEGER NOT NULL,
  first_lesson_no INTEGER NOT NULL,
  last_seen_lesson_no INTEGER,
  next_due_lesson_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  state_created_at TEXT NOT NULL,
  state_updated_at TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  reset_operation_hash TEXT NOT NULL,
  PRIMARY KEY (course_id, learning_run_no, word_id),
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (word_id) REFERENCES words(id),
  FOREIGN KEY (group_id) REFERENCES word_groups(id),
  FOREIGN KEY (reset_operation_hash)
    REFERENCES course_progress_reset_operations(operation_hash)
);

CREATE TABLE course_progress_reset_operations (
  operation_hash TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  from_learning_run_no INTEGER NOT NULL CHECK (from_learning_run_no > 0),
  expected_current_run_lesson_no INTEGER NOT NULL
    CHECK (expected_current_run_lesson_no > 0),
  from_physical_lesson_no INTEGER NOT NULL CHECK (from_physical_lesson_no > 0),
  to_learning_run_no INTEGER NOT NULL CHECK (to_learning_run_no > 1),
  to_physical_lesson_no INTEGER NOT NULL CHECK (to_physical_lesson_no > 1),
  abandoned_session_count INTEGER NOT NULL CHECK (abandoned_session_count >= 0),
  actor_source TEXT NOT NULL CHECK (
    actor_source IN ('cloudflare_access', 'application_session', 'service_token')
  ),
  actor_subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (course_id) REFERENCES courses(id),
  CHECK (length(operation_hash) = 71 AND operation_hash LIKE 'sha256:%'),
  CHECK (length(request_fingerprint) = 71 AND request_fingerprint LIKE 'sha256:%'),
  CHECK (to_learning_run_no = from_learning_run_no + 1),
  CHECK (to_physical_lesson_no > from_physical_lesson_no)
);

CREATE INDEX idx_course_progress_reset_operations_course
  ON course_progress_reset_operations (course_id, to_learning_run_no);

CREATE TRIGGER course_progress_reset_operation_hash_guard
BEFORE INSERT ON course_progress_reset_operations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM admin_operations
  WHERE operation_hash = NEW.operation_hash
)
BEGIN
  SELECT RAISE(ABORT, 'course_progress_reset_hash_reused');
END;

CREATE TRIGGER course_progress_reset_operation_validate
BEFORE INSERT ON course_progress_reset_operations
FOR EACH ROW
WHEN
  NOT EXISTS (
    SELECT 1
    FROM admin_operations
    WHERE operation_hash = NEW.operation_hash
  )
  AND NOT EXISTS (
    SELECT 1
    FROM courses
    INNER JOIN course_learning_runs
      ON course_learning_runs.course_id = courses.id
      AND course_learning_runs.run_no = courses.current_learning_run_no
      AND course_learning_runs.status = 'active'
    WHERE courses.id = NEW.course_id
      AND courses.status = 'active'
      AND courses.current_learning_run_no = NEW.from_learning_run_no
      AND courses.current_lesson_no = NEW.from_physical_lesson_no
      AND courses.current_lesson_no - courses.current_run_start_lesson_no + 1 =
        NEW.expected_current_run_lesson_no
      AND NEW.to_learning_run_no = courses.current_learning_run_no + 1
      AND NEW.to_physical_lesson_no = MAX(
        courses.current_lesson_no,
        COALESCE((
          SELECT MAX(lesson_no)
          FROM lesson_sessions
          WHERE lesson_sessions.course_id = courses.id
        ), 0)
      ) + 1
      AND NEW.abandoned_session_count = (
        SELECT COUNT(*)
        FROM lesson_sessions
        WHERE lesson_sessions.course_id = courses.id
          AND lesson_sessions.learning_run_no = courses.current_learning_run_no
          AND lesson_sessions.status = 'started'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'course_progress_reset_conflict');
END;

CREATE TRIGGER admin_operations_progress_reset_hash_guard
BEFORE INSERT ON admin_operations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM course_progress_reset_operations
  WHERE operation_hash = NEW.operation_hash
)
BEGIN
  SELECT RAISE(ABORT, 'admin_operation_hash_reused_by_progress_reset');
END;

CREATE TRIGGER course_progress_reset_operations_immutable_update
BEFORE UPDATE ON course_progress_reset_operations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'course_progress_reset_operation_immutable');
END;

CREATE TRIGGER course_progress_reset_operations_immutable_delete
BEFORE DELETE ON course_progress_reset_operations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'course_progress_reset_operation_immutable');
END;

CREATE TRIGGER course_learning_run_new_reset_guard
BEFORE INSERT ON course_learning_runs
FOR EACH ROW
WHEN NEW.run_no > 1 AND NOT EXISTS (
  SELECT 1
  FROM course_progress_reset_operations
  WHERE course_id = NEW.course_id
    AND to_learning_run_no = NEW.run_no
    AND to_physical_lesson_no = NEW.start_lesson_no
    AND operation_hash = NEW.started_by_reset_operation_hash
    AND NEW.status = 'active'
    AND NEW.ended_at IS NULL
    AND NEW.ended_by_reset_operation_hash IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'course_learning_run_reset_mismatch');
END;

CREATE TRIGGER course_learning_run_complete_only
BEFORE UPDATE ON course_learning_runs
FOR EACH ROW
WHEN
  OLD.status <> 'active'
  OR NEW.status <> 'completed'
  OR NEW.course_id <> OLD.course_id
  OR NEW.run_no <> OLD.run_no
  OR NEW.start_lesson_no <> OLD.start_lesson_no
  OR NEW.started_at <> OLD.started_at
  OR NEW.started_by_reset_operation_hash IS NOT OLD.started_by_reset_operation_hash
  OR NEW.ended_at IS NULL
  OR NEW.ended_by_reset_operation_hash IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM course_progress_reset_operations
    WHERE operation_hash = NEW.ended_by_reset_operation_hash
      AND course_id = NEW.course_id
      AND from_learning_run_no = NEW.run_no
  )
BEGIN
  SELECT RAISE(ABORT, 'course_learning_run_immutable');
END;

CREATE TRIGGER course_learning_runs_immutable_delete
BEFORE DELETE ON course_learning_runs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'course_learning_run_immutable');
END;

CREATE TRIGGER course_word_state_snapshots_immutable_update
BEFORE UPDATE ON course_learning_run_word_state_snapshots
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'course_word_state_snapshot_immutable');
END;

CREATE TRIGGER course_word_state_snapshots_immutable_delete
BEFORE DELETE ON course_learning_run_word_state_snapshots
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'course_word_state_snapshot_immutable');
END;

CREATE TRIGGER courses_learning_run_reset_guard
BEFORE UPDATE OF current_learning_run_no, current_run_start_lesson_no ON courses
FOR EACH ROW
WHEN
  (
    NEW.current_learning_run_no IS NOT OLD.current_learning_run_no
    OR NEW.current_run_start_lesson_no IS NOT OLD.current_run_start_lesson_no
  )
  AND NOT EXISTS (
    SELECT 1
    FROM course_progress_reset_operations
    WHERE course_id = OLD.id
      AND from_learning_run_no = OLD.current_learning_run_no
      AND from_physical_lesson_no = OLD.current_lesson_no
      AND to_learning_run_no = NEW.current_learning_run_no
      AND to_physical_lesson_no = NEW.current_lesson_no
      AND to_physical_lesson_no = NEW.current_run_start_lesson_no
  )
BEGIN
  SELECT RAISE(ABORT, 'course_learning_run_reset_mismatch');
END;

CREATE TRIGGER courses_physical_lesson_monotonic
BEFORE UPDATE OF current_lesson_no ON courses
FOR EACH ROW
WHEN NEW.current_lesson_no < OLD.current_lesson_no
BEGIN
  SELECT RAISE(ABORT, 'course_physical_lesson_not_monotonic');
END;

CREATE TRIGGER lesson_sessions_learning_run_insert
BEFORE INSERT ON lesson_sessions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM courses
  WHERE courses.id = NEW.course_id
    AND (
      (
        NEW.learning_run_no = courses.current_learning_run_no
        AND NEW.run_lesson_no =
          NEW.lesson_no - courses.current_run_start_lesson_no + 1
      )
      OR (
        courses.current_learning_run_no = 1
        AND courses.current_run_start_lesson_no = 1
        AND NEW.learning_run_no = 1
        AND NEW.run_lesson_no = 1
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_learning_run_mismatch');
END;

CREATE TRIGGER lesson_sessions_legacy_run_lesson_backfill
AFTER INSERT ON lesson_sessions
FOR EACH ROW
WHEN
  NEW.learning_run_no = 1
  AND NEW.run_lesson_no = 1
  AND NEW.lesson_no <> 1
  AND EXISTS (
    SELECT 1
    FROM courses
    WHERE courses.id = NEW.course_id
      AND courses.current_learning_run_no = 1
      AND courses.current_run_start_lesson_no = 1
  )
BEGIN
  UPDATE lesson_sessions
  SET run_lesson_no = NEW.lesson_no
  WHERE id = NEW.id;
END;

CREATE TRIGGER lesson_sessions_learning_run_immutable
BEFORE UPDATE OF learning_run_no, run_lesson_no ON lesson_sessions
FOR EACH ROW
WHEN
  (
    NEW.learning_run_no IS NOT OLD.learning_run_no
    OR NEW.run_lesson_no IS NOT OLD.run_lesson_no
  )
  AND NOT (
    OLD.learning_run_no = 1
    AND NEW.learning_run_no = 1
    AND OLD.run_lesson_no = 1
    AND NEW.run_lesson_no = OLD.lesson_no
    AND EXISTS (
      SELECT 1
      FROM courses
      WHERE courses.id = OLD.course_id
        AND courses.current_learning_run_no = 1
        AND courses.current_run_start_lesson_no = 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_learning_run_immutable');
END;

CREATE TRIGGER lesson_sessions_stale_run_write_guard
BEFORE UPDATE OF
  status,
  task_count,
  completed_task_count,
  correct_count,
  wrong_count,
  completed_at
ON lesson_sessions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM courses
  WHERE courses.id = OLD.course_id
    AND courses.current_learning_run_no = OLD.learning_run_no
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_learning_run_inactive');
END;

CREATE TRIGGER lesson_sessions_identity_immutable
BEFORE UPDATE ON lesson_sessions
FOR EACH ROW
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.course_id IS NOT OLD.course_id
  OR NEW.lesson_no IS NOT OLD.lesson_no
  OR NEW.queue_policy_version IS NOT OLD.queue_policy_version
  OR NEW.flow_policy_version IS NOT OLD.flow_policy_version
  OR NEW.started_at IS NOT OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_identity_immutable');
END;

CREATE TRIGGER lesson_sessions_final_state_immutable
BEFORE UPDATE ON lesson_sessions
FOR EACH ROW
WHEN
  OLD.status <> 'started'
  AND NOT (
    NEW.run_lesson_no IS NOT OLD.run_lesson_no
    AND
    OLD.learning_run_no = 1
    AND NEW.learning_run_no = 1
    AND OLD.run_lesson_no = 1
    AND NEW.run_lesson_no = OLD.lesson_no
    AND EXISTS (
      SELECT 1
      FROM courses
      WHERE courses.id = OLD.course_id
        AND courses.current_learning_run_no = 1
        AND courses.current_run_start_lesson_no = 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_final_state_immutable');
END;

CREATE TRIGGER lesson_sessions_immutable_delete
BEFORE DELETE ON lesson_sessions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'lesson_session_immutable');
END;

CREATE TRIGGER lesson_tasks_current_learning_run_insert
BEFORE INSERT ON lesson_tasks
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_sessions
  INNER JOIN courses ON courses.id = lesson_sessions.course_id
  WHERE lesson_sessions.id = NEW.session_id
    AND lesson_sessions.course_id = NEW.course_id
    AND lesson_sessions.status = 'started'
    AND lesson_sessions.learning_run_no = courses.current_learning_run_no
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_task_learning_run_inactive');
END;

CREATE TRIGGER lesson_tasks_current_learning_run_update
BEFORE UPDATE ON lesson_tasks
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_sessions
  INNER JOIN courses ON courses.id = lesson_sessions.course_id
  WHERE lesson_sessions.id = OLD.session_id
    AND lesson_sessions.course_id = OLD.course_id
    AND lesson_sessions.status = 'started'
    AND lesson_sessions.learning_run_no = courses.current_learning_run_no
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_task_learning_run_inactive');
END;

CREATE TRIGGER lesson_tasks_snapshot_identity_immutable
BEFORE UPDATE ON lesson_tasks
FOR EACH ROW
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.course_id IS NOT OLD.course_id
  OR NEW.word_id IS NOT OLD.word_id
  OR NEW.stage IS NOT OLD.stage
  OR NEW.task_type IS NOT OLD.task_type
  OR NEW.prompt_json IS NOT OLD.prompt_json
  OR NEW.answer_json IS NOT OLD.answer_json
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'lesson_task_snapshot_identity_immutable');
END;

CREATE TRIGGER lesson_tasks_immutable_delete
BEFORE DELETE ON lesson_tasks
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'lesson_task_immutable');
END;

CREATE TRIGGER review_logs_current_learning_run_insert
BEFORE INSERT ON review_logs
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_sessions
  INNER JOIN courses ON courses.id = lesson_sessions.course_id
  WHERE lesson_sessions.id = NEW.session_id
    AND lesson_sessions.course_id = NEW.course_id
    AND lesson_sessions.status = 'started'
    AND lesson_sessions.learning_run_no = courses.current_learning_run_no
)
BEGIN
  SELECT RAISE(ABORT, 'review_log_learning_run_inactive');
END;

CREATE TRIGGER review_logs_immutable_update
BEFORE UPDATE ON review_logs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'review_log_immutable');
END;

CREATE TRIGGER review_logs_immutable_delete
BEFORE DELETE ON review_logs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'review_log_immutable');
END;

CREATE TRIGGER user_word_states_current_learning_run_insert
BEFORE INSERT ON user_word_states
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM courses
  WHERE courses.id = NEW.course_id
    AND courses.current_learning_run_no = NEW.learning_run_no
)
BEGIN
  SELECT RAISE(ABORT, 'word_state_learning_run_inactive');
END;

CREATE TRIGGER user_word_states_current_learning_run_update
BEFORE UPDATE ON user_word_states
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM courses
  WHERE courses.id = NEW.course_id
    AND courses.current_learning_run_no = NEW.learning_run_no
)
BEGIN
  SELECT RAISE(ABORT, 'word_state_learning_run_inactive');
END;

CREATE TABLE lesson_replay_sessions (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_learning_run_no INTEGER NOT NULL CHECK (source_learning_run_no > 0),
  source_run_lesson_no INTEGER NOT NULL CHECK (source_run_lesson_no > 0),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed')),
  task_count INTEGER NOT NULL CHECK (task_count > 0),
  completed_task_count INTEGER NOT NULL DEFAULT 0
    CHECK (completed_task_count >= 0 AND completed_task_count <= task_count),
  correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  wrong_count INTEGER NOT NULL DEFAULT 0 CHECK (wrong_count >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (source_session_id) REFERENCES lesson_sessions(id),
  CHECK (correct_count + wrong_count = completed_task_count),
  CHECK (
    (status = 'started' AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_lesson_replay_one_started_per_source
  ON lesson_replay_sessions (course_id, source_session_id)
  WHERE status = 'started';

CREATE INDEX idx_lesson_replay_sessions_course_started
  ON lesson_replay_sessions (course_id, status, started_at);

CREATE TRIGGER lesson_replay_sessions_source_insert
BEFORE INSERT ON lesson_replay_sessions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_sessions
  WHERE lesson_sessions.id = NEW.source_session_id
    AND lesson_sessions.course_id = NEW.course_id
    AND lesson_sessions.status = 'completed'
    AND lesson_sessions.learning_run_no = NEW.source_learning_run_no
    AND lesson_sessions.run_lesson_no = NEW.source_run_lesson_no
    AND NEW.task_count = (
      SELECT COUNT(*)
      FROM lesson_tasks
      WHERE lesson_tasks.session_id = lesson_sessions.id
    )
    AND NEW.task_count > 0
    AND NEW.status = 'started'
    AND NEW.completed_task_count = 0
    AND NEW.correct_count = 0
    AND NEW.wrong_count = 0
    AND NEW.completed_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_replay_source_mismatch');
END;

CREATE TABLE lesson_replay_task_states (
  id TEXT PRIMARY KEY,
  replay_session_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  order_index INTEGER NOT NULL CHECK (order_index > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  submission_json TEXT,
  score INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 3),
  draft_answer TEXT,
  reference_revealed_at TEXT,
  answered_at TEXT,
  FOREIGN KEY (replay_session_id) REFERENCES lesson_replay_sessions(id),
  FOREIGN KEY (source_task_id) REFERENCES lesson_tasks(id),
  UNIQUE (replay_session_id, source_task_id),
  UNIQUE (replay_session_id, order_index),
  CHECK (
    (draft_answer IS NULL AND reference_revealed_at IS NULL)
    OR (draft_answer IS NOT NULL AND reference_revealed_at IS NOT NULL)
  ),
  CHECK (
    (status = 'pending' AND submission_json IS NULL AND score IS NULL AND answered_at IS NULL)
    OR
    (status = 'completed' AND submission_json IS NOT NULL AND score IS NOT NULL AND answered_at IS NOT NULL)
  )
);

CREATE INDEX idx_lesson_replay_tasks_pending
  ON lesson_replay_task_states (replay_session_id, status, order_index);

CREATE TRIGGER lesson_replay_task_initial_state
BEFORE INSERT ON lesson_replay_task_states
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_replay_sessions
  INNER JOIN lesson_tasks
    ON lesson_tasks.id = NEW.source_task_id
    AND lesson_tasks.session_id = lesson_replay_sessions.source_session_id
    AND lesson_tasks.course_id = lesson_replay_sessions.course_id
  WHERE lesson_replay_sessions.id = NEW.replay_session_id
    AND lesson_replay_sessions.status = 'started'
    AND lesson_tasks.order_index = NEW.order_index
    AND NEW.status = 'pending'
    AND NEW.submission_json IS NULL
    AND NEW.score IS NULL
    AND NEW.draft_answer IS NULL
    AND NEW.reference_revealed_at IS NULL
    AND NEW.answered_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_replay_task_initial_state_mismatch');
END;

CREATE TRIGGER lesson_replay_task_identity_immutable
BEFORE UPDATE OF replay_session_id, source_task_id, order_index ON lesson_replay_task_states
FOR EACH ROW
WHEN
  NEW.replay_session_id IS NOT OLD.replay_session_id
  OR NEW.source_task_id IS NOT OLD.source_task_id
  OR NEW.order_index IS NOT OLD.order_index
BEGIN
  SELECT RAISE(ABORT, 'lesson_replay_task_identity_immutable');
END;

CREATE TRIGGER lesson_replay_task_completed_immutable
BEFORE UPDATE ON lesson_replay_task_states
FOR EACH ROW
WHEN OLD.status = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'lesson_replay_task_completed_immutable');
END;

CREATE TRIGGER lesson_replay_task_preview_update
BEFORE UPDATE OF draft_answer, reference_revealed_at ON lesson_replay_task_states
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_replay_sessions
  INNER JOIN lesson_tasks ON lesson_tasks.id = OLD.source_task_id
  WHERE lesson_replay_sessions.id = OLD.replay_session_id
    AND lesson_replay_sessions.status = 'started'
    AND OLD.status = 'pending'
    AND lesson_tasks.task_type = 'sentence_output'
    AND OLD.draft_answer IS NULL
    AND OLD.reference_revealed_at IS NULL
    AND NEW.draft_answer IS NOT NULL
    AND NEW.reference_revealed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM lesson_replay_task_states AS earlier
      WHERE earlier.replay_session_id = OLD.replay_session_id
        AND earlier.status = 'pending'
        AND earlier.order_index < OLD.order_index
    )
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_replay_preview_mismatch');
END;

CREATE TRIGGER lesson_replay_task_answer_update
BEFORE UPDATE OF status, submission_json, score, answered_at ON lesson_replay_task_states
FOR EACH ROW
WHEN NEW.status = 'completed' AND NOT EXISTS (
  SELECT 1
  FROM lesson_replay_sessions
  INNER JOIN lesson_tasks ON lesson_tasks.id = OLD.source_task_id
  WHERE lesson_replay_sessions.id = OLD.replay_session_id
    AND lesson_replay_sessions.status = 'started'
    AND OLD.status = 'pending'
    AND NEW.submission_json IS NOT NULL
    AND NEW.score BETWEEN 0 AND 3
    AND NEW.answered_at IS NOT NULL
    AND (
      lesson_tasks.task_type <> 'sentence_output'
      OR (OLD.draft_answer IS NOT NULL AND OLD.reference_revealed_at IS NOT NULL)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM lesson_replay_task_states AS earlier
      WHERE earlier.replay_session_id = OLD.replay_session_id
        AND earlier.status = 'pending'
        AND earlier.order_index < OLD.order_index
    )
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_replay_answer_mismatch');
END;

CREATE TRIGGER lesson_replay_sessions_update_guard
BEFORE UPDATE ON lesson_replay_sessions
FOR EACH ROW
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.course_id IS NOT OLD.course_id
  OR NEW.source_session_id IS NOT OLD.source_session_id
  OR NEW.source_learning_run_no IS NOT OLD.source_learning_run_no
  OR NEW.source_run_lesson_no IS NOT OLD.source_run_lesson_no
  OR NEW.task_count IS NOT OLD.task_count
  OR NEW.started_at IS NOT OLD.started_at
  OR NEW.completed_task_count <> (
    SELECT COUNT(*)
    FROM lesson_replay_task_states
    WHERE replay_session_id = OLD.id AND status = 'completed'
  )
  OR NEW.correct_count <> (
    SELECT COUNT(*)
    FROM lesson_replay_task_states
    WHERE replay_session_id = OLD.id AND status = 'completed' AND score >= 2
  )
  OR NEW.wrong_count <> (
    SELECT COUNT(*)
    FROM lesson_replay_task_states
    WHERE replay_session_id = OLD.id AND status = 'completed' AND score < 2
  )
  OR (
    NEW.status = 'completed'
    AND (
      OLD.status <> 'started'
      OR NEW.completed_at IS NULL
      OR NEW.completed_task_count <> NEW.task_count
    )
  )
  OR (
    NEW.status = 'started'
    AND (OLD.status <> 'started' OR NEW.completed_at IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'lesson_replay_session_update_mismatch');
END;

CREATE TRIGGER lesson_replay_sessions_immutable_delete
BEFORE DELETE ON lesson_replay_sessions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'lesson_replay_session_immutable');
END;

CREATE TRIGGER lesson_replay_tasks_immutable_delete
BEFORE DELETE ON lesson_replay_task_states
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'lesson_replay_task_immutable');
END;
