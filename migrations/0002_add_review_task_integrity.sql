ALTER TABLE review_logs ADD COLUMN task_id TEXT;

CREATE UNIQUE INDEX idx_review_logs_session_task
  ON review_logs (session_id, task_id);

CREATE UNIQUE INDEX idx_lesson_sessions_course_lesson
  ON lesson_sessions (course_id, lesson_no);
