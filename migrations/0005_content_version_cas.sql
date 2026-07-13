ALTER TABLE source_versions
  ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX idx_source_versions_one_draft
  ON source_versions (source_id)
  WHERE status = 'draft';

CREATE UNIQUE INDEX idx_exercise_items_identity
  ON exercise_items (source_version_id, word_id, stage, task_type);
