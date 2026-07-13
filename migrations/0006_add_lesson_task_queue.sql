ALTER TABLE lesson_tasks
  ADD COLUMN role TEXT NOT NULL DEFAULT 'primary'
  CHECK (role IN ('primary', 'bridge', 'reflux'));

ALTER TABLE lesson_tasks
  ADD COLUMN required INTEGER NOT NULL DEFAULT 0
  CHECK (required IN (0, 1));

ALTER TABLE lesson_tasks
  ADD COLUMN reflux_source_task_id TEXT
  REFERENCES lesson_tasks(id);

ALTER TABLE lesson_tasks ADD COLUMN draft_answer TEXT;

ALTER TABLE lesson_tasks ADD COLUMN reference_revealed_at TEXT;

CREATE INDEX idx_lesson_tasks_session_queue
  ON lesson_tasks (session_id, status, order_index);

CREATE INDEX idx_lesson_tasks_reflux_source
  ON lesson_tasks (reflux_source_task_id, role);

CREATE UNIQUE INDEX idx_lesson_tasks_one_reflux_per_source
  ON lesson_tasks (reflux_source_task_id)
  WHERE role = 'reflux';

CREATE TRIGGER lesson_tasks_scope_insert
BEFORE INSERT ON lesson_tasks
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_sessions
  WHERE id = NEW.session_id AND course_id = NEW.course_id
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_task_scope_mismatch');
END;

CREATE TRIGGER lesson_tasks_scope_update
BEFORE UPDATE OF session_id, course_id ON lesson_tasks
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM lesson_sessions
  WHERE id = NEW.session_id AND course_id = NEW.course_id
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_task_scope_mismatch');
END;

CREATE TRIGGER lesson_tasks_reflux_source_insert
BEFORE INSERT ON lesson_tasks
FOR EACH ROW
WHEN (
  NEW.role = 'reflux'
  AND (
    NEW.reflux_source_task_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM lesson_tasks AS source_task
      WHERE source_task.id = NEW.reflux_source_task_id
        AND source_task.session_id = NEW.session_id
        AND source_task.course_id = NEW.course_id
    )
  )
) OR (
  NEW.role <> 'reflux' AND NEW.reflux_source_task_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_task_reflux_source_mismatch');
END;

CREATE TRIGGER lesson_tasks_reflux_source_update
BEFORE UPDATE OF role, reflux_source_task_id, session_id, course_id ON lesson_tasks
FOR EACH ROW
WHEN (
  NEW.role = 'reflux'
  AND (
    NEW.reflux_source_task_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM lesson_tasks AS source_task
      WHERE source_task.id = NEW.reflux_source_task_id
        AND source_task.session_id = NEW.session_id
        AND source_task.course_id = NEW.course_id
    )
  )
) OR (
  NEW.role <> 'reflux' AND NEW.reflux_source_task_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'lesson_task_reflux_source_mismatch');
END;
