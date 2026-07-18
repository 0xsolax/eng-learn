import { DomainError } from '../errors/DomainError'
import { mapD1LessonTask, type D1LessonTaskRow } from './d1CourseRepository'
import type {
  CreateLessonReplayInput,
  LessonReplayRepository,
  LessonReplaySessionRecord,
  LessonReplaySnapshot,
  LessonReplayTaskRecord,
  LessonReplayTaskStateRecord,
  RecordLessonReplayAnswerInput,
} from './lessonReplayRepository'

type LessonReplaySessionRow = {
  id: string
  course_id: string
  source_session_id: string
  source_learning_run_no: number
  source_run_lesson_no: number
  status: LessonReplaySessionRecord['status']
  task_count: number
  completed_task_count: number
  correct_count: number
  wrong_count: number
  started_at: string
  completed_at: string | null
}

type JoinedReplayTaskRow = D1LessonTaskRow & {
  replay_task_id: string
  replay_session_id: string
  replay_source_task_id: string
  replay_order_index: number
  replay_status: LessonReplayTaskStateRecord['status']
  replay_submission_json: string | null
  replay_score: NonNullable<LessonReplayTaskStateRecord['score']> | null
  replay_draft_answer: string | null
  replay_reference_revealed_at: string | null
  replay_answered_at: string | null
}

type LessonReplaySnapshotRow = JoinedReplayTaskRow & {
  snapshot_session_id: string
  snapshot_course_id: string
  snapshot_source_session_id: string
  snapshot_source_learning_run_no: number
  snapshot_source_run_lesson_no: number
  snapshot_session_status: LessonReplaySessionRecord['status']
  snapshot_task_count: number
  snapshot_completed_task_count: number
  snapshot_correct_count: number
  snapshot_wrong_count: number
  snapshot_started_at: string
  snapshot_completed_at: string | null
}

const REPLAY_SNAPSHOT_SELECT = `SELECT
  replay_sessions.id AS snapshot_session_id,
  replay_sessions.course_id AS snapshot_course_id,
  replay_sessions.source_session_id AS snapshot_source_session_id,
  replay_sessions.source_learning_run_no AS snapshot_source_learning_run_no,
  replay_sessions.source_run_lesson_no AS snapshot_source_run_lesson_no,
  replay_sessions.status AS snapshot_session_status,
  replay_sessions.task_count AS snapshot_task_count,
  replay_sessions.completed_task_count AS snapshot_completed_task_count,
  replay_sessions.correct_count AS snapshot_correct_count,
  replay_sessions.wrong_count AS snapshot_wrong_count,
  replay_sessions.started_at AS snapshot_started_at,
  replay_sessions.completed_at AS snapshot_completed_at,
  lesson_tasks.*,
  words.word AS linked_word,
  words.example_sentence AS linked_example_sentence,
  replay_states.id AS replay_task_id,
  replay_states.replay_session_id AS replay_session_id,
  replay_states.source_task_id AS replay_source_task_id,
  replay_states.order_index AS replay_order_index,
  replay_states.status AS replay_status,
  replay_states.submission_json AS replay_submission_json,
  replay_states.score AS replay_score,
  replay_states.draft_answer AS replay_draft_answer,
  replay_states.reference_revealed_at AS replay_reference_revealed_at,
  replay_states.answered_at AS replay_answered_at
FROM lesson_replay_sessions AS replay_sessions
INNER JOIN lesson_replay_task_states AS replay_states
  ON replay_states.replay_session_id = replay_sessions.id
INNER JOIN lesson_tasks
  ON lesson_tasks.id = replay_states.source_task_id
INNER JOIN words ON words.id = lesson_tasks.word_id`

const REPLAY_SNAPSHOT_BY_ID_SQL = `${REPLAY_SNAPSHOT_SELECT}
WHERE replay_sessions.id = ?
ORDER BY replay_states.order_index ASC`

const STARTED_REPLAY_SNAPSHOT_SQL = `${REPLAY_SNAPSHOT_SELECT}
WHERE replay_sessions.course_id = ?
  AND replay_sessions.source_session_id = ?
  AND replay_sessions.status = 'started'
ORDER BY replay_states.order_index ASC`

const COURSE_REPLAY_SNAPSHOT_SQL = `${REPLAY_SNAPSHOT_SELECT}
WHERE replay_sessions.id = ? AND replay_sessions.course_id = ?
ORDER BY replay_states.order_index ASC`

export const createD1LessonReplayRepository = (
  db: D1Database,
): LessonReplayRepository => {
  const getSnapshot = async (
    statement: D1PreparedStatement,
  ): Promise<LessonReplaySnapshot | undefined> => {
    const rows = await statement.all<LessonReplaySnapshotRow>()
    const first = rows.results[0]

    if (!first) return undefined

    return {
      session: mapSnapshotSession(first),
      tasks: rows.results.map(mapReplayTask),
    }
  }

  const getTask = async (
    replaySessionId: string,
    taskId: string,
  ): Promise<LessonReplayTaskRecord | undefined> => {
    const snapshot = await getSnapshot(
      db.prepare(REPLAY_SNAPSHOT_BY_ID_SQL).bind(replaySessionId),
    )
    return snapshot?.tasks.find((task) => task.id === taskId)
  }

  return {
    getStartedReplay(input) {
      return getSnapshot(
        db
          .prepare(STARTED_REPLAY_SNAPSHOT_SQL)
          .bind(input.courseId, input.sourceSessionId),
      )
    },

    getReplayForCourse(input) {
      return getSnapshot(
        db
          .prepare(COURSE_REPLAY_SNAPSHOT_SQL)
          .bind(input.replaySessionId, input.courseId),
      )
    },

    async createReplay(input) {
      try {
        await db.batch([
          createReplaySessionInsert(db, input.session),
          ...input.tasks.map((task) => createReplayTaskInsert(db, task)),
        ])
      } catch (error) {
        const winner = await getSnapshot(
          db
            .prepare(STARTED_REPLAY_SNAPSHOT_SQL)
            .bind(input.session.courseId, input.session.sourceSessionId),
        )
        if (winner) return winner
        throw error
      }

      const created = await getSnapshot(
        db.prepare(REPLAY_SNAPSHOT_BY_ID_SQL).bind(input.session.id),
      )
      if (!created || created.tasks.length !== input.tasks.length) {
        throw new Error('Created lesson replay snapshot is incomplete')
      }
      return created
    },

    async saveSentenceOutputPreview(input) {
      const existing = await getTask(input.replaySessionId, input.taskId)
      if (!existing) return undefined
      if (existing.draftAnswer !== undefined || existing.referenceRevealedAt !== undefined) {
        if (
          existing.draftAnswer === input.draft &&
          existing.referenceRevealedAt !== undefined
        ) {
          return existing
        }
      }

      try {
        const result = await db
          .prepare(
            "UPDATE lesson_replay_task_states SET draft_answer = ?, reference_revealed_at = ? WHERE id = ? AND replay_session_id = ? AND status = 'pending' AND draft_answer IS NULL AND reference_revealed_at IS NULL",
          )
          .bind(
            input.draft,
            input.revealedAt,
            input.taskId,
            input.replaySessionId,
          )
          .run()
        if (result.meta.changes === 0) {
          const raced = await getTask(input.replaySessionId, input.taskId)
          if (
            raced?.draftAnswer === input.draft &&
            raced.referenceRevealedAt !== undefined
          ) {
            return raced
          }
          if (raced?.draftAnswer !== undefined || raced?.referenceRevealedAt !== undefined) {
            throw new DomainError('conflict', 'Replay sentence preview is already fixed')
          }
          return undefined
        }
      } catch (error) {
        if (error instanceof DomainError) throw error
        const raced = await getTask(input.replaySessionId, input.taskId)
        if (
          raced?.draftAnswer === input.draft &&
          raced.referenceRevealedAt !== undefined
        ) {
          return raced
        }
        throw error
      }

      return getTask(input.replaySessionId, input.taskId)
    },

    async recordAnswer(input) {
      const existing = await getTask(input.replaySessionId, input.taskId)
      if (!existing) return undefined
      if (existing.status === 'completed') return existing

      try {
        await db.batch([
          createReplayAnswerUpdate(db, input),
          db
            .prepare(
              `UPDATE lesson_replay_sessions
               SET
                 completed_task_count = (
                   SELECT COUNT(*) FROM lesson_replay_task_states
                   WHERE replay_session_id = ? AND status = 'completed'
                 ),
                 correct_count = (
                   SELECT COUNT(*) FROM lesson_replay_task_states
                   WHERE replay_session_id = ? AND status = 'completed' AND score >= 2
                 ),
                 wrong_count = (
                   SELECT COUNT(*) FROM lesson_replay_task_states
                   WHERE replay_session_id = ? AND status = 'completed' AND score < 2
                 )
               WHERE id = ? AND status = 'started'`,
            )
            .bind(
              input.replaySessionId,
              input.replaySessionId,
              input.replaySessionId,
              input.replaySessionId,
            ),
        ])
      } catch (error) {
        const raced = await getTask(input.replaySessionId, input.taskId)
        if (raced?.status === 'completed') return raced
        throw error
      }

      return getTask(input.replaySessionId, input.taskId)
    },

    async completeReplay(input) {
      const existing = await getSnapshot(
        db.prepare(REPLAY_SNAPSHOT_BY_ID_SQL).bind(input.replaySessionId),
      )
      if (!existing) return undefined
      if (existing.session.status === 'completed') return existing

      const result = await db
        .prepare(
          `UPDATE lesson_replay_sessions
           SET status = 'completed', completed_at = ?
           WHERE id = ? AND status = 'started'
             AND NOT EXISTS (
               SELECT 1 FROM lesson_replay_task_states
               WHERE replay_session_id = ? AND status <> 'completed'
             )`,
        )
        .bind(input.completedAt, input.replaySessionId, input.replaySessionId)
        .run()

      const completed = await getSnapshot(
        db.prepare(REPLAY_SNAPSHOT_BY_ID_SQL).bind(input.replaySessionId),
      )
      if (result.meta.changes === 0 && completed?.session.status !== 'completed') {
        return undefined
      }
      return completed
    },
  }
}

const createReplaySessionInsert = (
  db: D1Database,
  session: CreateLessonReplayInput['session'],
) =>
  db
    .prepare(
      `INSERT INTO lesson_replay_sessions (
        id, course_id, source_session_id, source_learning_run_no,
        source_run_lesson_no, status, task_count, completed_task_count,
        correct_count, wrong_count, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      session.id,
      session.courseId,
      session.sourceSessionId,
      session.sourceLearningRunNo,
      session.sourceRunLessonNo,
      session.status,
      session.taskCount,
      session.completedTaskCount,
      session.correctCount,
      session.wrongCount,
      session.startedAt,
      session.completedAt ?? null,
    )

const createReplayTaskInsert = (
  db: D1Database,
  task: CreateLessonReplayInput['tasks'][number],
) =>
  db
    .prepare(
      `INSERT INTO lesson_replay_task_states (
        id, replay_session_id, source_task_id, order_index, status,
        submission_json, score, draft_answer, reference_revealed_at, answered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      task.id,
      task.replaySessionId,
      task.sourceTaskId,
      task.orderIndex,
      task.status,
      task.submissionJson ?? null,
      task.score ?? null,
      task.draftAnswer ?? null,
      task.referenceRevealedAt ?? null,
      task.answeredAt ?? null,
    )

const createReplayAnswerUpdate = (
  db: D1Database,
  input: RecordLessonReplayAnswerInput,
) =>
  db
    .prepare(
      `UPDATE lesson_replay_task_states
       SET status = 'completed', submission_json = ?, score = ?, answered_at = ?
       WHERE id = ? AND replay_session_id = ? AND status = 'pending'`,
    )
    .bind(
      input.submissionJson,
      input.score,
      input.answeredAt,
      input.taskId,
      input.replaySessionId,
    )

const mapSession = (row: LessonReplaySessionRow): LessonReplaySessionRecord => ({
  id: row.id,
  courseId: row.course_id,
  sourceSessionId: row.source_session_id,
  sourceLearningRunNo: row.source_learning_run_no,
  sourceRunLessonNo: row.source_run_lesson_no,
  status: row.status,
  taskCount: row.task_count,
  completedTaskCount: row.completed_task_count,
  correctCount: row.correct_count,
  wrongCount: row.wrong_count,
  startedAt: row.started_at,
  ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
})

const mapSnapshotSession = (
  row: LessonReplaySnapshotRow,
): LessonReplaySessionRecord =>
  mapSession({
    id: row.snapshot_session_id,
    course_id: row.snapshot_course_id,
    source_session_id: row.snapshot_source_session_id,
    source_learning_run_no: row.snapshot_source_learning_run_no,
    source_run_lesson_no: row.snapshot_source_run_lesson_no,
    status: row.snapshot_session_status,
    task_count: row.snapshot_task_count,
    completed_task_count: row.snapshot_completed_task_count,
    correct_count: row.snapshot_correct_count,
    wrong_count: row.snapshot_wrong_count,
    started_at: row.snapshot_started_at,
    completed_at: row.snapshot_completed_at,
  })

const mapReplayTask = (row: JoinedReplayTaskRow): LessonReplayTaskRecord => ({
  id: row.replay_task_id,
  replaySessionId: row.replay_session_id,
  sourceTaskId: row.replay_source_task_id,
  orderIndex: row.replay_order_index,
  status: row.replay_status,
  ...(row.replay_submission_json === null
    ? {}
    : { submissionJson: row.replay_submission_json }),
  ...(row.replay_score === null ? {} : { score: row.replay_score }),
  ...(row.replay_draft_answer === null
    ? {}
    : { draftAnswer: row.replay_draft_answer }),
  ...(row.replay_reference_revealed_at === null
    ? {}
    : { referenceRevealedAt: row.replay_reference_revealed_at }),
  ...(row.replay_answered_at === null ? {} : { answeredAt: row.replay_answered_at }),
  sourceTask: mapD1LessonTask(row),
})
