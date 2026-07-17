ALTER TABLE source_versions
  ADD COLUMN content_model TEXT NOT NULL DEFAULT 'v1_single_sentence'
  CHECK (content_model IN ('v1_single_sentence', 'v2_progressive_context'));

ALTER TABLE words
  ADD COLUMN example_phrase TEXT NOT NULL DEFAULT '';

ALTER TABLE words
  ADD COLUMN example_sentence_extended TEXT NOT NULL DEFAULT '';

CREATE TRIGGER source_versions_content_model_immutable
BEFORE UPDATE OF content_model ON source_versions
FOR EACH ROW
WHEN NEW.content_model <> OLD.content_model
BEGIN
  SELECT RAISE(ABORT, 'source_version_content_model_immutable');
END;
