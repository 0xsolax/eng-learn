import type { StartedLesson, SubmittedAnswer } from '../../shared/domain/course'
import type { WordStage } from '../../shared/domain/content'
import type {
  CourseRecord,
  CourseRepository,
  CreateCourseInput,
  CreateLessonInput,
  LessonSessionRecord,
  LessonTaskRecord,
  RecordAnswerInput,
  ReviewLogRecord,
  UserWordStateRecord,
} from './courseRepository'

type CourseRow = {
  id: string
  learner_id: string
  source_version_id: string
  current_lesson_no: number
  status: CourseRecord['status']
  created_at: string
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
  created_at: string
}

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
  lesson_no: number
  created_at: string
}

export const createD1CourseRepository = (db: D1Database): CourseRepository => ({
  async createCourse(input: CreateCourseInput) {
    await db.batch([
      db
        .prepare('INSERT INTO learners (id, name, access_code, created_at) VALUES (?, ?, ?, ?)')
        .bind(
          input.learner.id,
          input.learner.name,
          input.learner.accessCode,
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

  async getCourseByAccessCode(accessCode: string) {
    const row = await db
      .prepare(
        'SELECT learners.id AS learner_id, learners.name AS learner_name, learners.access_code, courses.id AS course_id, courses.source_version_id, courses.current_lesson_no, courses.status FROM learners INNER JOIN courses ON courses.learner_id = learners.id WHERE learners.access_code = ? ORDER BY courses.created_at ASC LIMIT 1',
      )
      .bind(accessCode)
      .first<{
        learner_id: string
        learner_name: string
        access_code: string
        course_id: string
        source_version_id: string
        current_lesson_no: number
        status: CourseRecord['status']
      }>()

    if (!row) {
      return undefined
    }

    return {
      learner: {
        id: row.learner_id,
        name: row.learner_name,
        accessCode: row.access_code,
      },
      course: {
        id: row.course_id,
        learnerId: row.learner_id,
        sourceVersionId: row.source_version_id,
        currentLessonNo: row.current_lesson_no,
        status: row.status,
      },
    }
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

  async createLesson(input: CreateLessonInput) {
    await db.batch([
      insertLessonSession(db, input.session),
      ...input.tasks.map((task) => insertLessonTask(db, task)),
      ...input.wordStates.map((state) => insertWordState(db, state)),
    ])

    return toStartedLesson(db, input.session)
  },

  async getLessonTask(sessionId: string, taskId: string) {
    const row = await db
      .prepare('SELECT * FROM lesson_tasks WHERE session_id = ? AND id = ?')
      .bind(sessionId, taskId)
      .first<LessonTaskRow>()

    return row ? mapLessonTask(row) : undefined
  },

  async getLessonTasks(sessionId: string) {
    const rows = await db
      .prepare('SELECT * FROM lesson_tasks WHERE session_id = ? ORDER BY order_index ASC')
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

    return toSubmittedAnswer(mapReviewLog(row), state)
  },

  async recordAnswer(input: RecordAnswerInput) {
    await db.batch([
      updateLessonTask(db, input.task),
      updateWordState(db, input.wordState),
      insertReviewLog(db, input.reviewLog),
      ...(input.newTasks ?? []).map((task) => insertLessonTask(db, task)),
      ...(input.newTasks && input.newTasks.length > 0
        ? [
            db
              .prepare('UPDATE lesson_sessions SET task_count = task_count + ? WHERE id = ?')
              .bind(input.newTasks.length, input.task.sessionId),
          ]
        : []),
    ])

    return toSubmittedAnswer(input.reviewLog, input.wordState)
  },

  async completeLesson(sessionId: string, completedAt: string) {
    const session = await this.getLessonSession(sessionId)

    if (!session) {
      throw new Error(`Lesson session ${sessionId} is missing`)
    }

    const course = await this.getCourse(session.courseId)

    if (!course) {
      throw new Error(`Course ${session.courseId} is missing`)
    }

    if (session.status === 'completed') {
      return {
        course: toCourseView(course),
        session: toLessonSessionView(session),
      }
    }

    const tasks = await this.getLessonTasks(sessionId)
    const completedTaskCount = tasks.filter((task) => task.status === 'completed').length
    const completedSession: LessonSessionRecord = {
      ...session,
      status: 'completed',
      completedTaskCount,
      completedAt,
    }
    const advancedCourse: CourseRecord = {
      ...course,
      currentLessonNo: course.currentLessonNo + 1,
    }

    await db.batch([
      db
        .prepare(
          'UPDATE lesson_sessions SET status = ?, completed_task_count = ?, completed_at = ? WHERE id = ?',
        )
        .bind(
          completedSession.status,
          completedSession.completedTaskCount,
          completedSession.completedAt,
          completedSession.id,
        ),
      db
        .prepare('UPDATE courses SET current_lesson_no = ? WHERE id = ?')
        .bind(advancedCourse.currentLessonNo, advancedCourse.id),
    ])

    return {
      course: toCourseView(advancedCourse),
      session: toLessonSessionView(completedSession),
    }
  },
})

const toStartedLesson = async (
  db: D1Database,
  session: LessonSessionRecord,
): Promise<StartedLesson> => {
  const rows = await db
    .prepare('SELECT * FROM lesson_tasks WHERE session_id = ? ORDER BY order_index ASC')
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

const insertLessonSession = (db: D1Database, session: LessonSessionRecord): D1PreparedStatement =>
  db
    .prepare(
      'INSERT INTO lesson_sessions (id, course_id, lesson_no, status, task_count, completed_task_count, correct_count, wrong_count, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      session.startedAt,
    )

const insertLessonTask = (db: D1Database, task: LessonTaskRecord): D1PreparedStatement =>
  db
    .prepare(
      'INSERT INTO lesson_tasks (id, session_id, course_id, word_id, stage, task_type, prompt_json, answer_json, order_index, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      task.id,
      task.sessionId,
      task.courseId,
      task.wordId,
      task.stage,
      task.taskType,
      JSON.stringify(task.prompt),
      JSON.stringify(task.answer),
      task.orderIndex,
      task.status,
      task.createdAt,
    )

const insertWordState = (db: D1Database, state: UserWordStateRecord): D1PreparedStatement =>
  db
    .prepare(
      'INSERT INTO user_word_states (id, course_id, word_id, group_id, stage, total_attempt_count, total_correct_count, total_wrong_count, current_streak, wrong_streak, lapse_count, ease_factor, mastery_score, first_lesson_no, last_seen_lesson_no, next_due_lesson_no, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      state.id,
      state.courseId,
      state.wordId,
      state.groupId,
      state.stage,
      state.totalAttemptCount,
      state.totalCorrectCount,
      state.totalWrongCount,
      state.currentStreak,
      state.wrongStreak,
      state.lapseCount,
      state.easeFactor,
      state.masteryScore,
      state.firstLessonNo,
      state.lastSeenLessonNo ?? null,
      state.nextDueLessonNo,
      state.status,
      state.createdAt,
      state.updatedAt,
    )

const updateLessonTask = (db: D1Database, task: LessonTaskRecord): D1PreparedStatement =>
  db
    .prepare('UPDATE lesson_tasks SET status = ? WHERE session_id = ? AND id = ?')
    .bind(task.status, task.sessionId, task.id)

const updateWordState = (db: D1Database, state: UserWordStateRecord): D1PreparedStatement =>
  db
    .prepare(
      'UPDATE user_word_states SET stage = ?, total_attempt_count = ?, total_correct_count = ?, total_wrong_count = ?, current_streak = ?, wrong_streak = ?, lapse_count = ?, ease_factor = ?, mastery_score = ?, last_seen_lesson_no = ?, next_due_lesson_no = ?, status = ?, updated_at = ? WHERE course_id = ? AND word_id = ?',
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
    )

const insertReviewLog = (db: D1Database, reviewLog: ReviewLogRecord): D1PreparedStatement =>
  db
    .prepare(
      'INSERT INTO review_logs (id, session_id, task_id, course_id, word_id, stage, task_type, user_answer, correct_answer, score, lesson_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
    )

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
  startedAt: row.started_at,
  ...(row.completed_at ? { completedAt: row.completed_at } : {}),
})

const mapLessonTask = (row: LessonTaskRow): LessonTaskRecord => ({
  id: row.id,
  sessionId: row.session_id,
  courseId: row.course_id,
  wordId: row.word_id,
  stage: row.stage,
  taskType: row.task_type,
  prompt: JSON.parse(row.prompt_json) as unknown,
  answer: JSON.parse(row.answer_json) as unknown,
  orderIndex: row.order_index,
  status: row.status,
  createdAt: row.created_at,
})

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

const toLessonTaskView = (task: LessonTaskRecord) => ({
  id: task.id,
  sessionId: task.sessionId,
  courseId: task.courseId,
  wordId: task.wordId,
  stage: task.stage,
  taskType: task.taskType,
  prompt: task.prompt,
  orderIndex: task.orderIndex,
  status: task.status,
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
