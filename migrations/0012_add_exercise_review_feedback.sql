CREATE TABLE exercise_item_review_feedback (
  exercise_item_id TEXT PRIMARY KEY,
  feedback_text TEXT NOT NULL
    CHECK (length(trim(feedback_text)) BETWEEN 1 AND 2000),
  requested_at TEXT NOT NULL,
  FOREIGN KEY (exercise_item_id)
    REFERENCES exercise_items(id) ON DELETE CASCADE
);

CREATE TRIGGER exercise_item_review_feedback_requires_draft_insert
BEFORE INSERT ON exercise_item_review_feedback
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM exercise_items
  WHERE id = NEW.exercise_item_id AND status = 'draft'
)
BEGIN
  SELECT RAISE(ABORT, 'exercise_item_review_feedback_requires_draft');
END;

CREATE TRIGGER exercise_item_review_feedback_requires_draft_update
BEFORE UPDATE ON exercise_item_review_feedback
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM exercise_items
  WHERE id = NEW.exercise_item_id AND status = 'draft'
)
BEGIN
  SELECT RAISE(ABORT, 'exercise_item_review_feedback_requires_draft');
END;

CREATE TRIGGER exercise_items_block_open_feedback_status_change
BEFORE UPDATE OF status ON exercise_items
FOR EACH ROW
WHEN NEW.status IN ('approved', 'disabled')
  AND NEW.status IS NOT OLD.status
  AND EXISTS (
    SELECT 1
    FROM exercise_item_review_feedback
    WHERE exercise_item_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'exercise_item_review_feedback_open');
END;

CREATE TRIGGER exercise_items_clear_feedback_after_content_change
AFTER UPDATE OF prompt_json, answer_json ON exercise_items
FOR EACH ROW
WHEN NEW.prompt_json IS NOT OLD.prompt_json
  OR NEW.answer_json IS NOT OLD.answer_json
BEGIN
  DELETE FROM exercise_item_review_feedback
  WHERE exercise_item_id = NEW.id;
END;
