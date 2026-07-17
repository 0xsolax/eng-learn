import {
  isPassingReviewScore,
  type StartedLesson,
  type SubmittedAnswer,
} from '../../shared/domain/course'
import type { WordStage } from '../../shared/domain/content'
import {
  lessonTaskSchema,
  type LessonTaskDto,
} from '../../shared/api/taskSchemas'
import {
  hashAccessCode,
  normalizeAccessCode,
  parseAccessCodeHash,
  parseRawAccessCode,
} from '../security/credentialCrypto'
import type {
  CourseRecord,
  CourseCredentialMatch,
  CourseRepository,
  CreateCourseInput,
  CreateLessonInput,
  LessonQueueSnapshot,
  LessonSessionRecord,
  LessonTaskRecord,
  QueueCapacityReason,
  QueueDisposition,
  RecordAnswerInput,
  ReviewLogRecord,
  UserWordStateRecord,
} from './courseRepository'
import { requireLearnerSafeExerciseItemContent } from '../errors/PersistedContentCompatibilityError'
import { DomainError } from '../errors/DomainError'
import { parsePersistedExerciseItemContent } from './persistedExerciseContent'
import { createD1AdminOperationInsert } from './adminOperationLedger'

type CourseRow = {
  id: string
  learner_id: string
  source_version_id: string
  current_lesson_no: number
  status: CourseRecord['status']
  created_at: string
}

type CourseAccessIdentityRow = {
  learner_id: string
  learner_name: string
  course_id: string
  source_version_id: string
  current_lesson_no: number
  status: CourseRecord['status']
  credential_version: number
}

type AdminCourseRow = CourseRow & {
  learner_name: string
  credential_version: number
}

type AdminLearnerCredentialRow = {
  access_code: string
  credential_version: number
}

type LessonSessionRow = {
  id: string
  course_id: string
  lesson_no: number
  status: LessonSessionRecord['status']
  task_count: number
  completed_task_count: number
  correct_count: number
  wrong_count: number
  queue_policy_version: LessonSessionRecord['queuePolicyVersion']
  flow_policy_version: LessonSessionRecord['flowPolicyVersion']
  started_at: string
  completed_at: string | null
}

type LessonTaskRow = {
  id: string
  session_id: string
  course_id: string
  word_id: string
  stage: string
  task_type: string
  prompt_json: string
  answer_json: string
  order_index: number
  status: LessonTaskRecord['status']
  role: LessonTaskRecord['role']
  required: number
  reflux_source_task_id: string | null
  reinforcement_source_task_id: string | null
  draft_answer: string | null
  reference_revealed_at: string | null
  created_at: string
  linked_word?: string
  linked_example_sentence?: string
}

const LESSON_TASKS_WITH_WORD_SELECT =
  'SELECT lesson_tasks.*, words.word AS linked_word, words.example_sentence AS linked_example_sentence FROM lesson_tasks INNER JOIN words ON words.id = lesson_tasks.word_id'

type UserWordStateRow = {
  id: string
  course_id: string
  word_id: string
  group_id: string
  stage: WordStage
  total_attempt_count: number
  total_correct_count: number
  total_wrong_count: number
  current_streak: number
  wrong_streak: number
  lapse_count: number
  ease_factor: number
  mastery_score: number
  first_lesson_no: number
  last_seen_lesson_no: number | null
  next_due_lesson_no: number
  status: UserWordStateRecord['status']
  created_at: string
  updated_at: string
}

type ReviewLogRow = {
  id: string
  session_id: string
  task_id: string | null
  course_id: string
  word_id: string
  stage: WordStage
  task_type: string
  user_answer: string | null
  correct_answer: string
  score: ReviewLogRecord['score']
  queue_disposition: QueueDisposition | null
  queue_capacity_reason: QueueCapacityReason | null
  lesson_no: number
  created_at: string
}

export const createD1CourseRepository = (db: D1Database): CourseRepository => ({
  async createCourse(input: CreateCourseInput) {
    const rawAccessCode = parseRawAccessCode(input.learner.accessCode)

    if (!rawAccessCode) {
      throw new Error('Learner access code is invalid')
    }

    const accessCodeHash = await hashAccessCode(rawAccessCode)

    await db.batch([
      ...(input.adminOperation
        ? [createD1AdminOperationInsert(db, input.adminOperation)]
        : []),
      db
        .prepare('INSERT INTO learners (id, name, access_code, created_at) VALUES (?, ?, ?, ?)')
        .bind(
          input.learner.id,
          input.learner.name,
          accessCodeHash,
          input.learner.createdAt,
        ),
      db
        .prepare(
          'INSERT INTO courses (id, learner_id, source_version_id, current_lesson_no, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          input.course.id,
          input.course.learnerId,
          input.course.sourceVersionId,
          input.course.currentLessonNo,
          input.course.status,
          input.course.createdAt,
        ),
    ])

    return {
      learner: {
        id: input.learner.id,
        name: input.learner.name,
        accessCode: input.learner.accessCode,
      },
      course: toCourseView(input.course),
    }
  },

  async getCourse(courseId: string) {
    const row = await db
      .prepare('SELECT * FROM courses WHERE id = ?')
      .bind(courseId)
      .first<CourseRow>()

    return row ? mapCourse(row) : undefined
  },

  async getCourseForLearner(input) {
    const row = await db
      .prepare('SELECT * FROM courses WHERE id = ? AND learner_id = ?')
      .bind(input.courseId, input.learnerId)
      .first<CourseRow>()

    return row ? mapCourse(row) : undefined
  },

  async getCourseIdentityByAccessCode(accessCode: string) {
    return (await findCourseCredentialByAccessCode(db, accessCode))?.identity
  },

  async getCourseCredentialByAccessCode(accessCode: string) {
    return findCourseCredentialByAccessCode(db, accessCode)
  },

  async getCourseByAccessCode(accessCode: string) {
    const match = await findCourseCredentialByAccessCode(db, accessCode)

    if (!match) {
      return undefined
    }

    const { identity } = match

    return {
      learner: {
        ...identity.learner,
        accessCode: normalizeAccessCode(accessCode),
      },
      course: identity.course,
    }
  },

  async getAdminLearnerCredential(learnerId) {
    const row = await db
      .prepare('SELECT access_code, credential_version FROM learners WHERE id = ?')
      .bind(learnerId)
      .first<AdminLearnerCredentialRow>()

    if (!row) return undefined

    const accessCodeHash = parseAccessCodeHash(row.access_code)

    if (!accessCodeHash) {
      throw new Error('Stored learner access-code hash is invalid')
    }

    return { accessCodeHash, credentialVersion: row.credential_version }
  },

  async listAdminCourses() {
    const rows = await db
      .prepare(
        'SELECT courses.id, courses.learner_id, courses.source_version_id, courses.current_lesson_no, courses.status, courses.created_at, learners.name AS learner_name, learners.credential_version FROM courses INNER JOIN learners ON learners.id = courses.learner_id ORDER BY courses.created_at DESC, courses.id ASC',
      )
      .all<AdminCourseRow>()

    return rows.results.map((row) => ({
      learner: { id: row.learner_id, name: row.learner_name },
      course: mapCourse(row),
      credentialVersion: row.credential_version,
    }))
  },

  async advanceCourseLessonNo(input) {
    if (input.nextLessonNo <= input.expectedLessonNo) {
      const course = await this.getCourse(input.courseId)
      requireActiveCourse(course)
      return course
    }

    await db
      .prepare(
        "UPDATE courses SET current_lesson_no = ? WHERE id = ? AND current_lesson_no = ? AND status = 'active'",
      )
      .bind(input.nextLessonNo, input.courseId, input.expectedLessonNo)
      .run()

    const course = await this.getCourse(input.courseId)
    requireActiveCourse(course)
    return course
  },

  async getStartedLesson(courseId: string, lessonNo: number) {
    const row = await db
      .prepare(
        'SELECT * FROM lesson_sessions WHERE course_id = ? AND lesson_no = ? AND status = ?',
      )
      .bind(courseId, lessonNo, 'started')
      .first<LessonSessionRow>()

    return row ? toStartedLesson(db, mapLessonSession(row)) : undefined
  },

  async getLatestCompletedLessonBefore(input) {
    const row = await db
      .prepare(
        'SELECT * FROM lesson_sessions WHERE course_id = ? AND lesson_no < ? AND status = ? ORDER BY lesson_no DESC LIMIT 1',
      )
      .bind(input.courseId, input.beforeLessonNo, 'completed')
      .first<LessonSessionRow>()

    return row ? mapLessonSession(row) : undefined
  },

  async createLesson(input: CreateLessonInput) {
    let sessionInsertChanges = 0

    try {
      const results = await db.batch([
        insertLessonSession(db, input.session),
        ...createBulkLessonTaskStatements(db, input.tasks, undefined, input.session.id),
        ...createBulkWordStateStatements(db, input.wordStates, input.session.id),
      ])
      sessionInsertChanges = results[0]?.meta.changes ?? 0
    } catch (error) {
      const winner = await db
        .prepare(
          'SELECT * FROM lesson_sessions WHERE course_id = ? AND lesson_no = ? AND status = ?',
        )
        .bind(input.session.courseId, input.session.lessonNo, 'started')
        .first<LessonSessionRow>()

      if (winner) {
        requireActiveCourse(await this.getCourse(input.session.courseId))
        return toStartedLesson(db, mapLessonSession(winner))
      }

      throw error
    }

    if (sessionInsertChanges === 0) {
      throw new DomainError('course_unavailable', 'Course is not active')
    }

    return toStartedLesson(db, input.session)
  },

  async getLessonSessionForCourse(input) {
    const row = await db
      .prepare('SELECT * FROM lesson_sessions WHERE id = ? AND course_id = ?')
      .bind(input.sessionId, input.courseId)
      .first<LessonSessionRow>()

    return row ? mapLessonSession(row) : undefined
  },

  async getLessonTaskForResource(input) {
    const row = await db
      .prepare(
        `${LESSON_TASKS_WITH_WORD_SELECT} WHERE lesson_tasks.id = ? AND lesson_tasks.session_id = ? AND lesson_tasks.course_id = ?`,
      )
      .bind(input.taskId, input.sessionId, input.courseId)
      .first<LessonTaskRow>()

    return row ? mapLessonTask(row) : undefined
  },

  async getLessonTask(sessionId: string, taskId: string) {
    const row = await db
      .prepare(
        `${LESSON_TASKS_WITH_WORD_SELECT} WHERE lesson_tasks.session_id = ? AND lesson_tasks.id = ?`,
      )
      .bind(sessionId, taskId)
      .first<LessonTaskRow>()

    return row ? mapLessonTask(row) : undefined
  },

  async getLessonTasks(sessionId: string) {
    const rows = await db
      .prepare(
        `${LESSON_TASKS_WITH_WORD_SELECT} WHERE lesson_tasks.session_id = ? ORDER BY lesson_tasks.order_index ASC`,
      )
      .bind(sessionId)
      .all<LessonTaskRow>()

    return rows.results.map(mapLessonTask)
  },

  async getLessonSession(sessionId: string) {
    const row = await db
      .prepare('SELECT * FROM lesson_sessions WHERE id = ?')
      .bind(sessionId)
      .first<LessonSessionRow>()

    return row ? mapLessonSession(row) : undefined
  },

  async getLessonQueueSnapshot(input) {
    return readLessonQueueSnapshot(db, input)
  },

  async getLessonReportSnapshot(input) {
    return readLessonQueueSnapshot(db, input)
  },

  async saveSentenceOutputPreview(input) {
    const task = await this.getLessonTaskForResource(input)
    requireActiveCourse(await this.getCourse(input.courseId))

    if (!task || task.status !== 'pending' || task.taskType !== 'sentence_output') {
      return undefined
    }

    if (task.draftAnswer !== undefined || task.referenceRevealedAt !== undefined) {
      if (
        task.draftAnswer !== input.draft ||
        task.referenceRevealedAt === undefined
      ) {
        return undefined
      }

      return {
        taskId: task.id,
        draft: task.draftAnswer,
        referenceSentence: task.answer.referenceSentence,
        revealedAt: task.referenceRevealedAt,
      }
    }

    const result = await db
      .prepare(
        "UPDATE lesson_tasks SET draft_answer = ?, reference_revealed_at = ? WHERE id = ? AND session_id = ? AND course_id = ? AND status = 'pending' AND task_type = 'sentence_output' AND draft_answer IS NULL AND reference_revealed_at IS NULL AND EXISTS (SELECT 1 FROM lesson_sessions WHERE lesson_sessions.id = lesson_tasks.session_id AND lesson_sessions.course_id = lesson_tasks.course_id AND lesson_sessions.status = 'started') AND EXISTS (SELECT 1 FROM courses WHERE courses.id = lesson_tasks.course_id AND courses.status = 'active')",
      )
      .bind(
        input.draft,
        input.revealedAt,
        input.taskId,
        input.sessionId,
        input.courseId,
      )
      .run()

    if (result.meta.changes === 0) {
      const latestSession = await this.getLessonSessionForCourse({
        sessionId: input.sessionId,
        courseId: input.courseId,
      })

      if (latestSession && latestSession.status !== 'started') {
        throw new DomainError('lesson_not_active', 'Lesson session is not active')
      }

      requireActiveCourse(await this.getCourse(input.courseId))
      const racedTask = await this.getLessonTaskForResource(input)

      if (
        !racedTask ||
        racedTask.taskType !== 'sentence_output' ||
        racedTask.draftAnswer !== input.draft ||
        racedTask.referenceRevealedAt === undefined
      ) {
        return undefined
      }

      return {
        taskId: racedTask.id,
        draft: racedTask.draftAnswer,
        referenceSentence: racedTask.answer.referenceSentence,
        revealedAt: racedTask.referenceRevealedAt,
      }
    }

    return {
      taskId: task.id,
      draft: input.draft,
      referenceSentence: task.answer.referenceSentence,
      revealedAt: input.revealedAt,
    }
  },

  async getWordStates(courseId: string) {
    const rows = await db
      .prepare('SELECT * FROM user_word_states WHERE course_id = ? ORDER BY first_lesson_no ASC')
      .bind(courseId)
      .all<UserWordStateRow>()

    return rows.results.map(mapWordState)
  },

  async getWordState(courseId: string, wordId: string) {
    const row = await db
      .prepare('SELECT * FROM user_word_states WHERE course_id = ? AND word_id = ?')
      .bind(courseId, wordId)
      .first<UserWordStateRow>()

    return row ? mapWordState(row) : undefined
  },

  async getSubmittedAnswer(sessionId: string, taskId: string) {
    const row = await db
      .prepare('SELECT * FROM review_logs WHERE session_id = ? AND task_id = ?')
      .bind(sessionId, taskId)
      .first<ReviewLogRow>()

    if (!row) {
      return undefined
    }

    const state = await this.getWordState(row.course_id, row.word_id)

    if (!state) {
      throw new Error(`Word state is missing for ${row.word_id}`)
    }

    return toRecordedAnswerOutcome(mapReviewLog(row), state)
  },

  async recordAnswer(input: RecordAnswerInput) {
    const existing = await this.getSubmittedAnswer(input.task.sessionId, input.task.id)

    if (existing) {
      requireActiveCourse(await this.getCourse(input.task.courseId))
      return existing
    }

    try {
      await db.batch(createRecordAnswerStatements(db, input))
    } catch (error) {
      const racedAnswer = await this.getSubmittedAnswer(input.task.sessionId, input.task.id)

      if (racedAnswer) {
        requireActiveCourse(await this.getCourse(input.task.courseId))
        return racedAnswer
      }

      throw error
    }

    const recorded = await this.getSubmittedAnswer(input.task.sessionId, input.task.id)

    if (!recorded) {
      const latestSession = await this.getLessonSessionForCourse({
        sessionId: input.task.sessionId,
        courseId: input.task.courseId,
      })

      if (latestSession && latestSession.status !== 'started') {
        throw new DomainError('lesson_not_active', 'Lesson session is not active')
      }

      requireActiveCourse(await this.getCourse(input.task.courseId))
      throw new Error(`Lesson task ${input.task.id} is not pending`)
    }

    return recorded
  },

  async completeLesson(input) {
    const session = await this.getLessonSession(input.sessionId)

    if (!session) {
      return undefined
    }

    const course = await this.getCourse(session.courseId)

    if (!course) {
      throw new Error(`Course ${session.courseId} is missing`)
    }

    requireActiveCourse(course)

    if (input.nextLessonNo <= session.lessonNo) {
      return undefined
    }

    if (session.status !== 'started') {
      if (session.status !== 'completed' || session.completedAt === undefined) {
        throw new DomainError('lesson_not_active', 'Lesson session is not active')
      }

      return {
        course: toCourseView(course),
        session: toLessonSessionView(session),
      }
    }

    const tasks = await this.getLessonTasks(input.sessionId)
    const primaryTasks = tasks.filter((task) => task.role === 'primary')
    const completedPrimary = primaryTasks.filter(
      (task) => task.status === 'completed',
    ).length
    const pendingRequired = tasks.some(
      (task) => task.required && task.status !== 'completed',
    )
    const skippablePrimaryTaskIds = primaryTasks
      .filter((task) => task.status === 'pending')
      .map((task) => task.id)
    const providedSkippableIds = new Set(input.skippablePrimaryTaskIds)
    const canComplete =
      primaryTasks.length > 0 &&
      completedPrimary * 5 >= primaryTasks.length * 4 &&
      !pendingRequired &&
      skippablePrimaryTaskIds.length === providedSkippableIds.size &&
      skippablePrimaryTaskIds.every((taskId) => providedSkippableIds.has(taskId))

    if (!canComplete) {
      return undefined
    }

    await db.batch([
      ...createBulkSkipPrimaryStatements(
        db,
        input.sessionId,
        input.skippablePrimaryTaskIds,
      ),
      db
        .prepare(
          "UPDATE lesson_sessions SET status = 'completed', task_count = (SELECT COUNT(*) FROM lesson_tasks WHERE session_id = ?), completed_task_count = (SELECT COUNT(*) FROM lesson_tasks WHERE session_id = ? AND status = 'completed'), completed_at = ? WHERE id = ? AND status = 'started' AND 5 * (SELECT COUNT(*) FROM lesson_tasks WHERE session_id = ? AND role = 'primary' AND status = 'completed') >= 4 * (SELECT COUNT(*) FROM lesson_tasks WHERE session_id = ? AND role = 'primary') AND NOT EXISTS (SELECT 1 FROM lesson_tasks WHERE session_id = ? AND required = 1 AND status <> 'completed') AND EXISTS (SELECT 1 FROM courses WHERE courses.id = lesson_sessions.course_id AND courses.status = 'active')",
        )
        .bind(
          input.sessionId,
          input.sessionId,
          input.completedAt,
          input.sessionId,
          input.sessionId,
          input.sessionId,
          input.sessionId,
        ),
      db
        .prepare(
          "UPDATE courses SET current_lesson_no = ? WHERE id = ? AND current_lesson_no = ? AND status = 'active' AND EXISTS (SELECT 1 FROM lesson_sessions WHERE id = ? AND status = 'completed' AND completed_at = ?)",
        )
        .bind(
          input.nextLessonNo,
          course.id,
          session.lessonNo,
          session.id,
          input.completedAt,
        ),
    ])

    const completedSession = await this.getLessonSession(input.sessionId)
    const advancedCourse = await this.getCourse(course.id)

    if (!completedSession || !advancedCourse) {
      return undefined
    }

    if (completedSession.status !== 'completed') {
      requireActiveCourse(advancedCourse)

      if (completedSession.status !== 'started') {
        throw new DomainError('lesson_not_active', 'Lesson session is not active')
      }

      return undefined
    }

    return {
      course: toCourseView(advancedCourse),
      session: toLessonSessionView(completedSession),
    }
  },
})

const readLessonQueueSnapshot = async (
  db: D1Database,
  input: { sessionId: string; courseId: string },
): Promise<LessonQueueSnapshot | undefined> => {
  const [sessionResult, taskResult, reviewResult] = await db.batch([
    db
      .prepare('SELECT * FROM lesson_sessions WHERE id = ? AND course_id = ?')
      .bind(input.sessionId, input.courseId),
    db
      .prepare(
        `${LESSON_TASKS_WITH_WORD_SELECT} WHERE lesson_tasks.session_id = ? AND lesson_tasks.course_id = ? ORDER BY lesson_tasks.order_index ASC`,
      )
      .bind(input.sessionId, input.courseId),
    db
      .prepare(
        'SELECT review_logs.* FROM review_logs INNER JOIN lesson_tasks ON lesson_tasks.id = review_logs.task_id AND lesson_tasks.session_id = review_logs.session_id AND lesson_tasks.course_id = review_logs.course_id WHERE review_logs.session_id = ? AND review_logs.course_id = ? ORDER BY lesson_tasks.order_index ASC',
      )
      .bind(input.sessionId, input.courseId),
  ])
  const sessionRow = sessionResult?.results[0] as LessonSessionRow | undefined

  if (!sessionRow) {
    return undefined
  }

  return {
    session: mapLessonSession(sessionRow),
    tasks: (taskResult?.results ?? []).map((row) => mapLessonTask(row as LessonTaskRow)),
    reviewLogs: (reviewResult?.results ?? []).map((row) =>
      mapReviewLog(row as ReviewLogRow),
    ),
  }
}

const requireActiveCourse = (course: CourseRecord | undefined): void => {
  if (!course || course.status !== 'active') {
    throw new DomainError('course_unavailable', 'Course is not active')
  }
}

const findCourseCredentialByAccessCode = async (
  db: D1Database,
  accessCode: string,
): Promise<CourseCredentialMatch | undefined> => {
  const rawAccessCode = parseRawAccessCode(accessCode)

  if (!rawAccessCode) {
    return undefined
  }

  const normalizedAccessCode = normalizeAccessCode(rawAccessCode)
  const accessCodeHash = await hashAccessCode(rawAccessCode)
  const query =
    'SELECT learners.id AS learner_id, learners.name AS learner_name, learners.credential_version, courses.id AS course_id, courses.source_version_id, courses.current_lesson_no, courses.status FROM learners INNER JOIN courses ON courses.learner_id = learners.id WHERE learners.access_code = ? ORDER BY courses.created_at ASC LIMIT 1'
  let row = await db.prepare(query).bind(accessCodeHash).first<CourseAccessIdentityRow>()

  if (!row) {
    row = await db.prepare(query).bind(normalizedAccessCode).first<CourseAccessIdentityRow>()

    if (row) {
      const migration = await db
        .prepare('UPDATE learners SET access_code = ? WHERE id = ? AND access_code = ?')
        .bind(accessCodeHash, row.learner_id, normalizedAccessCode)
        .run()

      if (migration.meta.changes === 0) {
        row = await db.prepare(query).bind(accessCodeHash).first<CourseAccessIdentityRow>()
      }
    }
  }

  if (!row) {
    return undefined
  }

  return {
    identity: {
      learner: {
        id: row.learner_id,
        name: row.learner_name,
      },
      course: {
        id: row.course_id,
        learnerId: row.learner_id,
        sourceVersionId: row.source_version_id,
        currentLessonNo: row.current_lesson_no,
        status: row.status,
      },
    },
    credentialVersion: row.credential_version,
  }
}

const toStartedLesson = async (
  db: D1Database,
  session: LessonSessionRecord,
): Promise<StartedLesson> => {
  const rows = await db
    .prepare(
      `${LESSON_TASKS_WITH_WORD_SELECT} WHERE lesson_tasks.session_id = ? ORDER BY lesson_tasks.order_index ASC`,
    )
    .bind(session.id)
    .all<LessonTaskRow>()

  return {
    session: toLessonSessionView(session),
    tasks: rows.results.map(mapLessonTask).map(toLessonTaskView),
  }
}

const toSubmittedAnswer = (
  reviewLog: ReviewLogRecord,
  wordState: UserWordStateRecord,
): SubmittedAnswer => ({
  wordState: toWordStateView(wordState),
  reviewLog: {
    id: reviewLog.id,
    sessionId: reviewLog.sessionId,
    courseId: reviewLog.courseId,
    wordId: reviewLog.wordId,
    stage: reviewLog.stage,
    taskType: reviewLog.taskType,
    ...(reviewLog.userAnswer ? { userAnswer: reviewLog.userAnswer } : {}),
    correctAnswer: reviewLog.correctAnswer,
    score: reviewLog.score,
    lessonNo: reviewLog.lessonNo,
    createdAt: reviewLog.createdAt,
  },
})

const toRecordedAnswerOutcome = (
  reviewLog: ReviewLogRecord,
  wordState: UserWordStateRecord,
) => ({
  submittedAnswer: toSubmittedAnswer(reviewLog, wordState),
  ...(reviewLog.queueDisposition === undefined
    ? {}
    : { queueDisposition: reviewLog.queueDisposition }),
  ...(reviewLog.queueCapacityReason === undefined
    ? {}
    : { queueCapacityReason: reviewLog.queueCapacityReason }),
})

const insertLessonSession = (db: D1Database, session: LessonSessionRecord): D1PreparedStatement =>
  db
    .prepare(
      "INSERT INTO lesson_sessions (id, course_id, lesson_no, status, task_count, completed_task_count, correct_count, wrong_count, queue_policy_version, flow_policy_version, started_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM courses WHERE id = ? AND status = 'active')",
    )
    .bind(
      session.id,
      session.courseId,
      session.lessonNo,
      session.status,
      session.taskCount,
      session.completedTaskCount,
      session.correctCount,
      session.wrongCount,
      session.queuePolicyVersion,
      withLegacyFlowPolicyDefault(session.flowPolicyVersion),
      session.startedAt,
      session.courseId,
    )

const TARGET_BULK_BOUND_BYTES = 512_000
const MAX_BULK_BOUND_BYTES = 1_500_000
const MAX_TASK_GROUPS_PER_QUERY = 12
const MAX_SINGLE_PAYLOAD_GROUPS_PER_QUERY = 90
const utf8Encoder = new TextEncoder()

type TaskJsonGroup = {
  metadataJson: string
  promptsJson: string
  answersJson: string
}

const createBulkLessonTaskStatements = (
  db: D1Database,
  tasks: LessonTaskRecord[],
  reviewLogId?: string,
  lessonSessionId?: string,
): D1PreparedStatement[] =>
  chunkArray(createTaskJsonGroups(tasks), MAX_TASK_GROUPS_PER_QUERY).map((groups) => {
    const rowsSql = groups
      .map(
        (_, groupIndex) =>
          `SELECT ${String(groupIndex)} AS group_index, CAST(metadata.key AS INTEGER) AS row_index, metadata.value AS metadata_json, prompt.value AS prompt_json, answer.value AS answer_json FROM json_each(?) AS metadata INNER JOIN json_each(?) AS prompt ON prompt.key = metadata.key INNER JOIN json_each(?) AS answer ON answer.key = metadata.key`,
      )
      .join(' UNION ALL ')
    const writeGuardSql =
      reviewLogId !== undefined
        ? ' WHERE EXISTS (SELECT 1 FROM review_logs WHERE id = ?)'
        : lessonSessionId !== undefined
          ? " WHERE EXISTS (SELECT 1 FROM lesson_sessions INNER JOIN courses ON courses.id = lesson_sessions.course_id WHERE lesson_sessions.id = ? AND lesson_sessions.status = 'started' AND courses.status = 'active' AND lesson_sessions.course_id = json_extract(metadata_json, '$.courseId'))"
          : ''
    const bindings = groups.flatMap((group) => [
      group.metadataJson,
      group.promptsJson,
      group.answersJson,
    ])

    return db
      .prepare(
        `WITH rows AS (${rowsSql}) INSERT INTO lesson_tasks (id, session_id, course_id, word_id, stage, task_type, prompt_json, answer_json, order_index, status, role, required, reflux_source_task_id, reinforcement_source_task_id, draft_answer, reference_revealed_at, created_at) SELECT json_extract(metadata_json, '$.id'), json_extract(metadata_json, '$.sessionId'), json_extract(metadata_json, '$.courseId'), json_extract(metadata_json, '$.wordId'), json_extract(metadata_json, '$.stage'), json_extract(metadata_json, '$.taskType'), prompt_json, answer_json, json_extract(metadata_json, '$.orderIndex'), json_extract(metadata_json, '$.status'), json_extract(metadata_json, '$.role'), json_extract(metadata_json, '$.required'), json_extract(metadata_json, '$.refluxSourceTaskId'), json_extract(metadata_json, '$.reinforcementSourceTaskId'), json_extract(metadata_json, '$.draftAnswer'), json_extract(metadata_json, '$.referenceRevealedAt'), json_extract(metadata_json, '$.createdAt') FROM rows${writeGuardSql} ORDER BY group_index ASC, row_index ASC`,
      )
      .bind(
        ...bindings,
        ...(reviewLogId !== undefined
          ? [reviewLogId]
          : lessonSessionId !== undefined
            ? [lessonSessionId]
            : []),
      )
  })

const createTaskJsonGroups = (tasks: LessonTaskRecord[]): TaskJsonGroup[] => {
  const groups: TaskJsonGroup[] = []
  let metadataRows: string[] = []
  let promptRows: string[] = []
  let answerRows: string[] = []
  let metadataBytes = 2
  let promptBytes = 2
  let answerBytes = 2

  const flush = (): void => {
    if (metadataRows.length === 0) {
      return
    }

    groups.push({
      metadataJson: `[${metadataRows.join(',')}]`,
      promptsJson: `[${promptRows.join(',')}]`,
      answersJson: `[${answerRows.join(',')}]`,
    })
    metadataRows = []
    promptRows = []
    answerRows = []
    metadataBytes = 2
    promptBytes = 2
    answerBytes = 2
  }

  for (const task of tasks) {
    const metadata = JSON.stringify({
      id: task.id,
      sessionId: task.sessionId,
      courseId: task.courseId,
      wordId: task.wordId,
      stage: task.stage,
      taskType: task.taskType,
      orderIndex: task.orderIndex,
      status: task.status,
      role: task.role,
      required: task.required ? 1 : 0,
      refluxSourceTaskId: task.refluxSourceTaskId ?? null,
      reinforcementSourceTaskId: task.reinforcementSourceTaskId ?? null,
      draftAnswer: task.draftAnswer ?? null,
      referenceRevealedAt: task.referenceRevealedAt ?? null,
      createdAt: task.createdAt,
    })
    const prompt = JSON.stringify(task.prompt)
    const answer = JSON.stringify(task.answer)
    const metadataRowBytes = utf8ByteLength(metadata)
    const promptRowBytes = utf8ByteLength(prompt)
    const answerRowBytes = utf8ByteLength(answer)

    if (
      [metadataRowBytes, promptRowBytes, answerRowBytes].some(
        (bytes) => bytes + 2 > MAX_BULK_BOUND_BYTES,
      )
    ) {
      throw new Error(`Lesson task ${task.id} exceeds the D1 bulk binding budget`)
    }

    const delimiterBytes = metadataRows.length === 0 ? 0 : 1
    if (
      metadataRows.length > 0 &&
      (metadataBytes + delimiterBytes + metadataRowBytes > TARGET_BULK_BOUND_BYTES ||
        promptBytes + delimiterBytes + promptRowBytes > TARGET_BULK_BOUND_BYTES ||
        answerBytes + delimiterBytes + answerRowBytes > TARGET_BULK_BOUND_BYTES)
    ) {
      flush()
    }

    const nextDelimiterBytes = metadataRows.length === 0 ? 0 : 1
    metadataRows.push(metadata)
    promptRows.push(prompt)
    answerRows.push(answer)
    metadataBytes += nextDelimiterBytes + metadataRowBytes
    promptBytes += nextDelimiterBytes + promptRowBytes
    answerBytes += nextDelimiterBytes + answerRowBytes
  }

  flush()
  return groups
}

const createBulkWordStateStatements = (
  db: D1Database,
  states: UserWordStateRecord[],
  lessonSessionId?: string,
): D1PreparedStatement[] => {
  const payloads = createJsonPayloadGroups(
    states.map((state) => ({
      id: state.id,
      courseId: state.courseId,
      wordId: state.wordId,
      groupId: state.groupId,
      stage: state.stage,
      totalAttemptCount: state.totalAttemptCount,
      totalCorrectCount: state.totalCorrectCount,
      totalWrongCount: state.totalWrongCount,
      currentStreak: state.currentStreak,
      wrongStreak: state.wrongStreak,
      lapseCount: state.lapseCount,
      easeFactor: state.easeFactor,
      masteryScore: state.masteryScore,
      firstLessonNo: state.firstLessonNo,
      lastSeenLessonNo: state.lastSeenLessonNo ?? null,
      nextDueLessonNo: state.nextDueLessonNo,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    })),
  )

  return chunkArray(payloads, MAX_SINGLE_PAYLOAD_GROUPS_PER_QUERY).map((groups) => {
    const rowsSql = groups
      .map(
        (_, groupIndex) =>
          `SELECT ${String(groupIndex)} AS group_index, CAST(row.key AS INTEGER) AS row_index, row.value AS row_json FROM json_each(?) AS row`,
      )
      .join(' UNION ALL ')

    return db
      .prepare(
        `WITH rows AS (${rowsSql}) INSERT INTO user_word_states (id, course_id, word_id, group_id, stage, total_attempt_count, total_correct_count, total_wrong_count, current_streak, wrong_streak, lapse_count, ease_factor, mastery_score, first_lesson_no, last_seen_lesson_no, next_due_lesson_no, status, created_at, updated_at) SELECT json_extract(row_json, '$.id'), json_extract(row_json, '$.courseId'), json_extract(row_json, '$.wordId'), json_extract(row_json, '$.groupId'), json_extract(row_json, '$.stage'), json_extract(row_json, '$.totalAttemptCount'), json_extract(row_json, '$.totalCorrectCount'), json_extract(row_json, '$.totalWrongCount'), json_extract(row_json, '$.currentStreak'), json_extract(row_json, '$.wrongStreak'), json_extract(row_json, '$.lapseCount'), json_extract(row_json, '$.easeFactor'), json_extract(row_json, '$.masteryScore'), json_extract(row_json, '$.firstLessonNo'), json_extract(row_json, '$.lastSeenLessonNo'), json_extract(row_json, '$.nextDueLessonNo'), json_extract(row_json, '$.status'), json_extract(row_json, '$.createdAt'), json_extract(row_json, '$.updatedAt') FROM rows${lessonSessionId === undefined ? '' : " WHERE EXISTS (SELECT 1 FROM lesson_sessions INNER JOIN courses ON courses.id = lesson_sessions.course_id WHERE lesson_sessions.id = ? AND lesson_sessions.status = 'started' AND courses.status = 'active' AND lesson_sessions.course_id = json_extract(row_json, '$.courseId'))"} ORDER BY group_index ASC, row_index ASC`,
      )
      .bind(...groups, ...(lessonSessionId === undefined ? [] : [lessonSessionId]))
  })
}

const updateWordState = (
  db: D1Database,
  state: UserWordStateRecord,
  reviewLogId?: string,
): D1PreparedStatement =>
  db
    .prepare(
      `UPDATE user_word_states SET stage = ?, total_attempt_count = ?, total_correct_count = ?, total_wrong_count = ?, current_streak = ?, wrong_streak = ?, lapse_count = ?, ease_factor = ?, mastery_score = ?, last_seen_lesson_no = ?, next_due_lesson_no = ?, status = ?, updated_at = ? WHERE course_id = ? AND word_id = ?${reviewLogId === undefined ? '' : ' AND EXISTS (SELECT 1 FROM review_logs WHERE id = ?)'}`,
    )
    .bind(
      state.stage,
      state.totalAttemptCount,
      state.totalCorrectCount,
      state.totalWrongCount,
      state.currentStreak,
      state.wrongStreak,
      state.lapseCount,
      state.easeFactor,
      state.masteryScore,
      state.lastSeenLessonNo ?? null,
      state.nextDueLessonNo,
      state.status,
      state.updatedAt,
      state.courseId,
      state.wordId,
      ...(reviewLogId === undefined ? [] : [reviewLogId]),
    )

const updateExistingLessonTasks = (
  db: D1Database,
  tasks: LessonTaskRecord[],
  reviewLogId: string,
): D1PreparedStatement[] => {
  const payloads = createJsonPayloadGroups(
    tasks.map((task) => ({
      id: task.id,
      sessionId: task.sessionId,
      courseId: task.courseId,
      orderIndex: task.orderIndex,
      status: task.status,
      role: task.role,
      required: task.required,
      refluxSourceTaskId: task.refluxSourceTaskId ?? null,
      reinforcementSourceTaskId: task.reinforcementSourceTaskId ?? null,
      draftAnswer: task.draftAnswer ?? null,
      referenceRevealedAt: task.referenceRevealedAt ?? null,
    })),
  )

  return chunkArray(payloads, MAX_SINGLE_PAYLOAD_GROUPS_PER_QUERY).map((groups) => {
    const rowsSql = groups
      .map(() => 'SELECT value AS row_json FROM json_each(?)')
      .join(' UNION ALL ')

    return db
      .prepare(
        `WITH rows AS (${rowsSql}) UPDATE lesson_tasks SET order_index = CAST(json_extract(rows.row_json, '$.orderIndex') AS INTEGER), status = json_extract(rows.row_json, '$.status'), role = json_extract(rows.row_json, '$.role'), required = CAST(json_extract(rows.row_json, '$.required') AS INTEGER), reflux_source_task_id = json_extract(rows.row_json, '$.refluxSourceTaskId'), reinforcement_source_task_id = json_extract(rows.row_json, '$.reinforcementSourceTaskId'), draft_answer = json_extract(rows.row_json, '$.draftAnswer'), reference_revealed_at = json_extract(rows.row_json, '$.referenceRevealedAt') FROM rows WHERE lesson_tasks.id = json_extract(rows.row_json, '$.id') AND lesson_tasks.session_id = json_extract(rows.row_json, '$.sessionId') AND lesson_tasks.course_id = json_extract(rows.row_json, '$.courseId') AND EXISTS (SELECT 1 FROM review_logs WHERE id = ?)`,
      )
      .bind(...groups, reviewLogId)
  })
}

const insertReviewLogIfPending = (
  db: D1Database,
  reviewLog: ReviewLogRecord,
  expectedQueuePolicyVersion: RecordAnswerInput['expectedQueuePolicyVersion'],
  expectedFlowPolicyVersion: RecordAnswerInput['expectedFlowPolicyVersion'],
): D1PreparedStatement =>
  db
    .prepare(
      "INSERT INTO review_logs (id, session_id, task_id, course_id, word_id, stage, task_type, user_answer, correct_answer, score, lesson_no, created_at, queue_disposition, queue_capacity_reason) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM lesson_tasks INNER JOIN lesson_sessions ON lesson_sessions.id = lesson_tasks.session_id AND lesson_sessions.course_id = lesson_tasks.course_id INNER JOIN courses ON courses.id = lesson_tasks.course_id WHERE lesson_tasks.id = ? AND lesson_tasks.session_id = ? AND lesson_tasks.course_id = ? AND lesson_tasks.status = 'pending' AND lesson_sessions.status = 'started' AND lesson_sessions.queue_policy_version = ? AND lesson_sessions.flow_policy_version = ? AND courses.status = 'active' AND NOT EXISTS (SELECT 1 FROM lesson_tasks AS earlier_task WHERE earlier_task.session_id = lesson_tasks.session_id AND earlier_task.status = 'pending' AND earlier_task.order_index < lesson_tasks.order_index))",
    )
    .bind(
      reviewLog.id,
      reviewLog.sessionId,
      reviewLog.taskId,
      reviewLog.courseId,
      reviewLog.wordId,
      reviewLog.stage,
      reviewLog.taskType,
      reviewLog.userAnswer ?? null,
      reviewLog.correctAnswer,
      reviewLog.score,
      reviewLog.lessonNo,
      reviewLog.createdAt,
      reviewLog.queueDisposition ?? null,
      reviewLog.queueCapacityReason ?? null,
      reviewLog.taskId,
      reviewLog.sessionId,
      reviewLog.courseId,
      expectedQueuePolicyVersion,
      withLegacyFlowPolicyDefault(expectedFlowPolicyVersion),
    )

const withLegacyFlowPolicyDefault = (
  value: LessonSessionRecord['flowPolicyVersion'] | undefined,
): LessonSessionRecord['flowPolicyVersion'] =>
  value ?? 'v1_due_then_new_unbounded'

const createRecordAnswerStatements = (
  db: D1Database,
  input: RecordAnswerInput,
): D1PreparedStatement[] => {
  const isPrimary = input.task.role === 'primary'
  const correctIncrement = isPrimary && isPassingReviewScore(input.reviewLog.score) ? 1 : 0
  const wrongIncrement = isPrimary && !isPassingReviewScore(input.reviewLog.score) ? 1 : 0
  const newTaskIds = new Set(input.newTaskIds)
  const newTasks = input.taskMutations.filter((task) => newTaskIds.has(task.id))
  const existingTaskMutations = input.taskMutations.filter(
    (task) => !newTaskIds.has(task.id),
  )

  return [
    insertReviewLogIfPending(
      db,
      input.reviewLog,
      input.expectedQueuePolicyVersion,
      input.expectedFlowPolicyVersion,
    ),
    ...createTemporarilyNegativeOrderStatements(
      db,
      input.task.sessionId,
      input.reorderedExistingTaskIds,
      input.reviewLog.id,
    ),
    ...updateExistingLessonTasks(db, existingTaskMutations, input.reviewLog.id),
    ...createBulkLessonTaskStatements(db, newTasks, input.reviewLog.id),
    ...(input.persistWordState
      ? [updateWordState(db, input.wordState, input.reviewLog.id)]
      : []),
    db
      .prepare(
        'UPDATE lesson_sessions SET task_count = ?, completed_task_count = ?, correct_count = correct_count + ?, wrong_count = wrong_count + ? WHERE id = ? AND EXISTS (SELECT 1 FROM review_logs WHERE id = ?)',
      )
      .bind(
        input.taskCount,
        input.completedTaskCount,
        correctIncrement,
        wrongIncrement,
        input.task.sessionId,
        input.reviewLog.id,
      ),
  ]
}

const createTemporarilyNegativeOrderStatements = (
  db: D1Database,
  sessionId: string,
  taskIds: string[],
  reviewLogId: string,
): D1PreparedStatement[] =>
  chunkArray(
    createJsonPayloadGroups(taskIds),
    MAX_SINGLE_PAYLOAD_GROUPS_PER_QUERY,
  ).map((groups) => {
    const idsSql = groups.map(() => 'SELECT value FROM json_each(?)').join(' UNION ALL ')

    return db
      .prepare(
        `UPDATE lesson_tasks SET order_index = -order_index WHERE session_id = ? AND id IN (${idsSql}) AND order_index > 0 AND EXISTS (SELECT 1 FROM review_logs WHERE id = ?)`,
      )
      .bind(sessionId, ...groups, reviewLogId)
  })

const completionEligibilitySql =
  "EXISTS (SELECT 1 FROM lesson_sessions INNER JOIN courses ON courses.id = lesson_sessions.course_id WHERE lesson_sessions.id = ? AND lesson_sessions.status = 'started' AND courses.status = 'active') AND 5 * (SELECT COUNT(*) FROM lesson_tasks WHERE session_id = ? AND role = 'primary' AND status = 'completed') >= 4 * (SELECT COUNT(*) FROM lesson_tasks WHERE session_id = ? AND role = 'primary') AND NOT EXISTS (SELECT 1 FROM lesson_tasks WHERE session_id = ? AND required = 1 AND status <> 'completed')"

const createBulkSkipPrimaryStatements = (
  db: D1Database,
  sessionId: string,
  taskIds: string[],
): D1PreparedStatement[] =>
  chunkArray(
    createJsonPayloadGroups(taskIds),
    MAX_SINGLE_PAYLOAD_GROUPS_PER_QUERY,
  ).map((groups) => {
    const idsSql = groups.map(() => 'SELECT value FROM json_each(?)').join(' UNION ALL ')

    return db
      .prepare(
        `UPDATE lesson_tasks SET status = 'skipped' WHERE session_id = ? AND id IN (${idsSql}) AND role = 'primary' AND status = 'pending' AND ${completionEligibilitySql}`,
      )
      .bind(
        sessionId,
        ...groups,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
      )
  })

const createJsonPayloadGroups = (rows: unknown[]): string[] => {
  const groups: string[] = []
  let serializedRows: string[] = []
  let payloadBytes = 2

  const flush = (): void => {
    if (serializedRows.length === 0) {
      return
    }

    groups.push(`[${serializedRows.join(',')}]`)
    serializedRows = []
    payloadBytes = 2
  }

  for (const row of rows) {
    const serialized = JSON.stringify(row)
    const rowBytes = utf8ByteLength(serialized)

    if (rowBytes + 2 > MAX_BULK_BOUND_BYTES) {
      throw new Error('D1 bulk row exceeds the binding budget')
    }

    const delimiterBytes = serializedRows.length === 0 ? 0 : 1
    if (
      serializedRows.length > 0 &&
      payloadBytes + delimiterBytes + rowBytes > TARGET_BULK_BOUND_BYTES
    ) {
      flush()
    }

    const nextDelimiterBytes = serializedRows.length === 0 ? 0 : 1
    serializedRows.push(serialized)
    payloadBytes += nextDelimiterBytes + rowBytes
  }

  flush()
  return groups
}

const chunkArray = <T>(values: T[], chunkSize: number): T[][] => {
  const chunks: T[][] = []

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize))
  }

  return chunks
}

const utf8ByteLength = (value: string): number => utf8Encoder.encode(value).byteLength

const mapCourse = (row: CourseRow): CourseRecord => ({
  id: row.id,
  learnerId: row.learner_id,
  sourceVersionId: row.source_version_id,
  currentLessonNo: row.current_lesson_no,
  status: row.status,
  createdAt: row.created_at,
})

const mapLessonSession = (row: LessonSessionRow): LessonSessionRecord => ({
  id: row.id,
  courseId: row.course_id,
  lessonNo: row.lesson_no,
  status: row.status,
  taskCount: row.task_count,
  completedTaskCount: row.completed_task_count,
  correctCount: row.correct_count,
  wrongCount: row.wrong_count,
  queuePolicyVersion: row.queue_policy_version,
  flowPolicyVersion: row.flow_policy_version,
  startedAt: row.started_at,
  ...(row.completed_at ? { completedAt: row.completed_at } : {}),
})

const mapLessonTask = (row: LessonTaskRow): LessonTaskRecord => {
  const content = parsePersistedExerciseItemContent(
    {
      stage: row.stage,
      taskType: row.task_type,
      prompt: JSON.parse(row.prompt_json) as unknown,
      answer: JSON.parse(row.answer_json) as unknown,
    },
    row.linked_word === undefined || row.linked_example_sentence === undefined
      ? undefined
      : {
          word: row.linked_word,
          exampleSentence: row.linked_example_sentence,
        },
  )

  if (row.linked_word !== undefined) {
    requireLearnerSafeExerciseItemContent(content, row.linked_word)
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    courseId: row.course_id,
    wordId: row.word_id,
    orderIndex: row.order_index,
    status: row.status,
    role: row.role,
    required: row.required === 1,
    ...(row.reflux_source_task_id === null
      ? {}
      : { refluxSourceTaskId: row.reflux_source_task_id }),
    ...(row.reinforcement_source_task_id === null
      ? {}
      : { reinforcementSourceTaskId: row.reinforcement_source_task_id }),
    ...(row.draft_answer === null ? {} : { draftAnswer: row.draft_answer }),
    ...(row.reference_revealed_at === null
      ? {}
      : { referenceRevealedAt: row.reference_revealed_at }),
    createdAt: row.created_at,
    ...content,
  }
}

const mapWordState = (row: UserWordStateRow): UserWordStateRecord => ({
  id: row.id,
  courseId: row.course_id,
  wordId: row.word_id,
  groupId: row.group_id,
  stage: row.stage,
  totalAttemptCount: row.total_attempt_count,
  totalCorrectCount: row.total_correct_count,
  totalWrongCount: row.total_wrong_count,
  currentStreak: row.current_streak,
  wrongStreak: row.wrong_streak,
  lapseCount: row.lapse_count,
  easeFactor: row.ease_factor,
  masteryScore: row.mastery_score,
  firstLessonNo: row.first_lesson_no,
  ...(row.last_seen_lesson_no === null ? {} : { lastSeenLessonNo: row.last_seen_lesson_no }),
  nextDueLessonNo: row.next_due_lesson_no,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const mapReviewLog = (row: ReviewLogRow): ReviewLogRecord => ({
  id: row.id,
  sessionId: row.session_id,
  taskId: row.task_id ?? '',
  courseId: row.course_id,
  wordId: row.word_id,
  stage: row.stage,
  taskType: row.task_type,
  ...(row.user_answer ? { userAnswer: row.user_answer } : {}),
  correctAnswer: row.correct_answer,
  score: row.score,
  ...(row.queue_disposition === null
    ? {}
    : { queueDisposition: row.queue_disposition }),
  ...(row.queue_capacity_reason === null
    ? {}
    : { queueCapacityReason: row.queue_capacity_reason }),
  lessonNo: row.lesson_no,
  createdAt: row.created_at,
})

const toCourseView = (course: CourseRecord) => ({
  id: course.id,
  learnerId: course.learnerId,
  sourceVersionId: course.sourceVersionId,
  currentLessonNo: course.currentLessonNo,
  status: course.status,
})

const toLessonSessionView = (session: LessonSessionRecord) => ({
  id: session.id,
  courseId: session.courseId,
  lessonNo: session.lessonNo,
  status: session.status,
  taskCount: session.taskCount,
  completedTaskCount: session.completedTaskCount,
})

const toLessonTaskView = (task: LessonTaskRecord): LessonTaskDto =>
  lessonTaskSchema.parse({
    id: task.id,
    sessionId: task.sessionId,
    courseId: task.courseId,
    wordId: task.wordId,
    stage: task.stage,
    taskType: task.taskType,
    prompt: task.prompt,
    orderIndex: task.orderIndex,
    status: task.status,
    role: task.role,
    required: task.required,
    ...(task.refluxSourceTaskId === undefined
      ? {}
      : { refluxSourceTaskId: task.refluxSourceTaskId }),
    ...(task.reinforcementSourceTaskId === undefined
      ? {}
      : { reinforcementSourceTaskId: task.reinforcementSourceTaskId }),
    ...(task.taskType === 'sentence_output' &&
    task.draftAnswer !== undefined &&
    task.referenceRevealedAt !== undefined
      ? {
          preview: {
            draft: task.draftAnswer,
            referenceSentence: task.answer.referenceSentence,
            revealedAt: task.referenceRevealedAt,
          },
        }
      : {}),
  })

const toWordStateView = (state: UserWordStateRecord) => ({
  id: state.id,
  courseId: state.courseId,
  wordId: state.wordId,
  groupId: state.groupId,
  stage: state.stage,
  totalAttemptCount: state.totalAttemptCount,
  totalCorrectCount: state.totalCorrectCount,
  totalWrongCount: state.totalWrongCount,
  currentStreak: state.currentStreak,
  wrongStreak: state.wrongStreak,
  lapseCount: state.lapseCount,
  easeFactor: state.easeFactor,
  masteryScore: state.masteryScore,
  firstLessonNo: state.firstLessonNo,
  ...(state.lastSeenLessonNo === undefined ? {} : { lastSeenLessonNo: state.lastSeenLessonNo }),
  nextDueLessonNo: state.nextDueLessonNo,
  status: state.status,
})
