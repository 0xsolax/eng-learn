CREATE TABLE learner_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  learner_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (learner_id) REFERENCES learners(id),
  FOREIGN KEY (course_id) REFERENCES courses(id)
);

CREATE INDEX idx_learner_sessions_learner_active
  ON learner_sessions (learner_id, revoked_at, expires_at);

CREATE INDEX idx_learner_sessions_course_active
  ON learner_sessions (course_id, revoked_at, expires_at);
