ALTER TABLE learners
  ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0);

ALTER TABLE learner_sessions
  ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0);

CREATE TRIGGER learner_sessions_owner_insert
BEFORE INSERT ON learner_sessions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM courses
  WHERE courses.id = NEW.course_id
    AND courses.learner_id = NEW.learner_id
)
BEGIN
  SELECT RAISE(ABORT, 'learner_session_course_owner_mismatch');
END;

CREATE TRIGGER learner_sessions_owner_update
BEFORE UPDATE OF learner_id, course_id ON learner_sessions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM courses
  WHERE courses.id = NEW.course_id
    AND courses.learner_id = NEW.learner_id
)
BEGIN
  SELECT RAISE(ABORT, 'learner_session_course_owner_mismatch');
END;

CREATE TRIGGER learner_sessions_credential_version_insert
BEFORE INSERT ON learner_sessions
FOR EACH ROW
WHEN NEW.credential_version != (
  SELECT learners.credential_version
  FROM learners
  WHERE learners.id = NEW.learner_id
)
BEGIN
  SELECT RAISE(ABORT, 'learner_session_credential_version_mismatch');
END;

CREATE TRIGGER learner_sessions_credential_version_update
BEFORE UPDATE OF learner_id, credential_version ON learner_sessions
FOR EACH ROW
WHEN NEW.credential_version != (
  SELECT learners.credential_version
  FROM learners
  WHERE learners.id = NEW.learner_id
)
BEGIN
  SELECT RAISE(ABORT, 'learner_session_credential_version_mismatch');
END;
