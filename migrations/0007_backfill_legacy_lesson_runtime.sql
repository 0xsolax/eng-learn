-- Reconstruct queue metadata for tasks created before migration 0006.
-- A legacy lesson had at most one primary task per word/stage/type; each later
-- duplicate was the reflux task created from the immediately preceding task.
WITH legacy_sessions AS (
  SELECT session_id
  FROM lesson_tasks
  GROUP BY session_id
  HAVING SUM(
    CASE
      WHEN role <> 'primary' OR required <> 0 OR reflux_source_task_id IS NOT NULL THEN 1
      ELSE 0
    END
  ) = 0
),
ranked_tasks AS (
  SELECT
    lesson_tasks.id,
    ROW_NUMBER() OVER (
      PARTITION BY
        lesson_tasks.session_id,
        lesson_tasks.course_id,
        lesson_tasks.word_id,
        lesson_tasks.stage,
        lesson_tasks.task_type
      ORDER BY lesson_tasks.order_index ASC, lesson_tasks.id ASC
    ) AS task_rank,
    LAG(lesson_tasks.id) OVER (
      PARTITION BY
        lesson_tasks.session_id,
        lesson_tasks.course_id,
        lesson_tasks.word_id,
        lesson_tasks.stage,
        lesson_tasks.task_type
      ORDER BY lesson_tasks.order_index ASC, lesson_tasks.id ASC
    ) AS previous_task_id
  FROM lesson_tasks
  INNER JOIN legacy_sessions
    ON legacy_sessions.session_id = lesson_tasks.session_id
)
UPDATE lesson_tasks
SET
  role = 'reflux',
  required = 1,
  reflux_source_task_id = (
    SELECT ranked_tasks.previous_task_id
    FROM ranked_tasks
    WHERE ranked_tasks.id = lesson_tasks.id
  )
WHERE id IN (
  SELECT ranked_tasks.id
  FROM ranked_tasks
  WHERE ranked_tasks.task_rank > 1
);

-- Migration 0002 added task_id after review rows could already exist. Link only
-- previously unlinked logs to still-unclaimed tasks in their deterministic
-- legacy order. Existing links are never overwritten.
WITH unlinked_log_groups AS (
  SELECT
    session_id,
    course_id,
    word_id,
    stage,
    task_type,
    COUNT(*) AS log_count
  FROM review_logs
  WHERE task_id IS NULL
  GROUP BY session_id, course_id, word_id, stage, task_type
),
unclaimed_completed_task_groups AS (
  SELECT
    lesson_tasks.session_id,
    lesson_tasks.course_id,
    lesson_tasks.word_id,
    lesson_tasks.stage,
    lesson_tasks.task_type,
    COUNT(*) AS task_count
  FROM lesson_tasks
  WHERE lesson_tasks.status = 'completed'
    AND NOT EXISTS (
      SELECT 1
      FROM review_logs
      WHERE review_logs.task_id = lesson_tasks.id
    )
  GROUP BY
    lesson_tasks.session_id,
    lesson_tasks.course_id,
    lesson_tasks.word_id,
    lesson_tasks.stage,
    lesson_tasks.task_type
),
unambiguous_groups AS (
  SELECT
    unlinked_log_groups.session_id,
    unlinked_log_groups.course_id,
    unlinked_log_groups.word_id,
    unlinked_log_groups.stage,
    unlinked_log_groups.task_type
  FROM unlinked_log_groups
  INNER JOIN unclaimed_completed_task_groups
    ON unclaimed_completed_task_groups.session_id = unlinked_log_groups.session_id
    AND unclaimed_completed_task_groups.course_id = unlinked_log_groups.course_id
    AND unclaimed_completed_task_groups.word_id = unlinked_log_groups.word_id
    AND unclaimed_completed_task_groups.stage = unlinked_log_groups.stage
    AND unclaimed_completed_task_groups.task_type = unlinked_log_groups.task_type
    AND unclaimed_completed_task_groups.task_count = unlinked_log_groups.log_count
),
ranked_unlinked_logs AS (
  SELECT
    review_logs.id,
    review_logs.session_id,
    review_logs.course_id,
    review_logs.word_id,
    review_logs.stage,
    review_logs.task_type,
    ROW_NUMBER() OVER (
      PARTITION BY
        review_logs.session_id,
        review_logs.course_id,
        review_logs.word_id,
        review_logs.stage,
        review_logs.task_type
      ORDER BY review_logs.created_at ASC, review_logs.id ASC
    ) AS log_rank
  FROM review_logs
  INNER JOIN unambiguous_groups
    ON unambiguous_groups.session_id = review_logs.session_id
    AND unambiguous_groups.course_id = review_logs.course_id
    AND unambiguous_groups.word_id = review_logs.word_id
    AND unambiguous_groups.stage = review_logs.stage
    AND unambiguous_groups.task_type = review_logs.task_type
  WHERE review_logs.task_id IS NULL
),
ranked_unclaimed_tasks AS (
  SELECT
    lesson_tasks.id,
    lesson_tasks.session_id,
    lesson_tasks.course_id,
    lesson_tasks.word_id,
    lesson_tasks.stage,
    lesson_tasks.task_type,
    ROW_NUMBER() OVER (
      PARTITION BY
        lesson_tasks.session_id,
        lesson_tasks.course_id,
        lesson_tasks.word_id,
        lesson_tasks.stage,
        lesson_tasks.task_type
      ORDER BY lesson_tasks.order_index ASC, lesson_tasks.id ASC
    ) AS task_rank
  FROM lesson_tasks
  INNER JOIN unambiguous_groups
    ON unambiguous_groups.session_id = lesson_tasks.session_id
    AND unambiguous_groups.course_id = lesson_tasks.course_id
    AND unambiguous_groups.word_id = lesson_tasks.word_id
    AND unambiguous_groups.stage = lesson_tasks.stage
    AND unambiguous_groups.task_type = lesson_tasks.task_type
  WHERE lesson_tasks.status = 'completed'
    AND NOT EXISTS (
    SELECT 1
    FROM review_logs
    WHERE review_logs.task_id = lesson_tasks.id
  )
)
UPDATE review_logs
SET task_id = (
  SELECT ranked_unclaimed_tasks.id
  FROM ranked_unlinked_logs
  INNER JOIN ranked_unclaimed_tasks
    ON ranked_unclaimed_tasks.session_id = ranked_unlinked_logs.session_id
    AND ranked_unclaimed_tasks.course_id = ranked_unlinked_logs.course_id
    AND ranked_unclaimed_tasks.word_id = ranked_unlinked_logs.word_id
    AND ranked_unclaimed_tasks.stage = ranked_unlinked_logs.stage
    AND ranked_unclaimed_tasks.task_type = ranked_unlinked_logs.task_type
    AND ranked_unclaimed_tasks.task_rank = ranked_unlinked_logs.log_rank
  WHERE ranked_unlinked_logs.id = review_logs.id
)
WHERE task_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM ranked_unlinked_logs
    INNER JOIN ranked_unclaimed_tasks
      ON ranked_unclaimed_tasks.session_id = ranked_unlinked_logs.session_id
      AND ranked_unclaimed_tasks.course_id = ranked_unlinked_logs.course_id
      AND ranked_unclaimed_tasks.word_id = ranked_unlinked_logs.word_id
      AND ranked_unclaimed_tasks.stage = ranked_unlinked_logs.stage
      AND ranked_unclaimed_tasks.task_type = ranked_unlinked_logs.task_type
      AND ranked_unclaimed_tasks.task_rank = ranked_unlinked_logs.log_rank
    WHERE ranked_unlinked_logs.id = review_logs.id
  );
