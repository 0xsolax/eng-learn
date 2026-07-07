CREATE TABLE word_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE source_versions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  FOREIGN KEY (source_id) REFERENCES word_sources(id),
  UNIQUE (source_id, version_no)
);

CREATE TABLE words (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  word TEXT NOT NULL,
  meaning TEXT NOT NULL,
  example_sentence TEXT NOT NULL,
  part_of_speech TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_version_id) REFERENCES source_versions(id),
  UNIQUE (source_version_id, order_index)
);

CREATE TABLE word_groups (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL,
  group_index INTEGER NOT NULL,
  start_order_index INTEGER NOT NULL,
  end_order_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_version_id) REFERENCES source_versions(id),
  UNIQUE (source_version_id, group_index)
);

CREATE TABLE exercise_packs (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL,
  word_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_version_id) REFERENCES source_versions(id),
  FOREIGN KEY (word_id) REFERENCES words(id),
  UNIQUE (source_version_id, word_id)
);

CREATE TABLE exercise_items (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL,
  word_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  task_type TEXT NOT NULL,
  prompt_json TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_version_id) REFERENCES source_versions(id),
  FOREIGN KEY (word_id) REFERENCES words(id)
);

CREATE INDEX idx_exercise_items_version_word_stage_status
  ON exercise_items (source_version_id, word_id, stage, status);

CREATE TABLE learners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  access_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  current_lesson_no INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (learner_id) REFERENCES learners(id),
  FOREIGN KEY (source_version_id) REFERENCES source_versions(id),
  UNIQUE (learner_id, source_version_id)
);

CREATE TABLE user_word_states (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  word_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  stage_attempt_count INTEGER NOT NULL DEFAULT 0,
  stage_correct_count INTEGER NOT NULL DEFAULT 0,
  total_attempt_count INTEGER NOT NULL DEFAULT 0,
  total_correct_count INTEGER NOT NULL DEFAULT 0,
  total_wrong_count INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  wrong_streak INTEGER NOT NULL DEFAULT 0,
  lapse_count INTEGER NOT NULL DEFAULT 0,
  ease_factor REAL NOT NULL DEFAULT 1.0,
  mastery_score INTEGER NOT NULL DEFAULT 0,
  first_lesson_no INTEGER NOT NULL,
  last_seen_lesson_no INTEGER,
  next_due_lesson_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (word_id) REFERENCES words(id),
  FOREIGN KEY (group_id) REFERENCES word_groups(id),
  UNIQUE (course_id, word_id)
);

CREATE INDEX idx_user_word_states_due
  ON user_word_states (course_id, next_due_lesson_no, status);

CREATE TABLE lesson_sessions (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  lesson_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  task_count INTEGER NOT NULL DEFAULT 0,
  completed_task_count INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (course_id) REFERENCES courses(id)
);

CREATE INDEX idx_lesson_sessions_course_lesson_status
  ON lesson_sessions (course_id, lesson_no, status);

CREATE TABLE lesson_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  word_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  task_type TEXT NOT NULL,
  prompt_json TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES lesson_sessions(id),
  FOREIGN KEY (word_id) REFERENCES words(id),
  UNIQUE (session_id, order_index)
);

CREATE TABLE review_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  word_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  task_type TEXT NOT NULL,
  user_answer TEXT,
  correct_answer TEXT,
  score INTEGER NOT NULL,
  response_time_ms INTEGER,
  error_type TEXT,
  lesson_no INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES lesson_sessions(id),
  FOREIGN KEY (word_id) REFERENCES words(id)
);

CREATE INDEX idx_review_logs_course_word_lesson
  ON review_logs (course_id, word_id, lesson_no);

