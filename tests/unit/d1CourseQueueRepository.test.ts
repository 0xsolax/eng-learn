import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createD1CourseRepository } from '../../server/repositories/d1CourseRepository'
import { createD1ContentRepository } from '../../server/repositories/d1ContentRepository'
import { createD1SessionRepository } from '../../server/repositories/d1SessionRepository'
import { createCourseQueryService } from '../../server/services/CourseQueryService'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import type {
  CourseRepository,
  LessonTaskRecord,
  UserWordStateRecord,
} from '../../server/repositories/courseRepository'

const NOW = '2026-07-13T00:00:00.000Z'
const migrationPaths = [
  '../../migrations/0001_initial.sql',
  '../../migrations/0002_add_review_task_integrity.sql',
  '../../migrations/0003_add_learner_sessions.sql',
  '../../migrations/0004_harden_learner_sessions.sql',
  '../../migrations/0005_content_version_cas.sql',
  '../../migrations/0006_add_lesson_task_queue.sql',
  '../../migrations/0007_backfill_legacy_lesson_runtime.sql',
  '../../migrations/0008_add_admin_operation_ledger.sql',
]

type SqliteD1Statement = {
  bind(...values: unknown[]): SqliteD1Statement
  run(): Promise<{ success: true; meta: { changes: number } }>
  first(): Promise<unknown>
  all(): Promise<{ success: true; results: unknown[]; meta: Record<string, never> }>
  reserve(): void
  execute(): { success: true; meta: { changes: number } }
}

type D1QueryBudgetProbe = {
  queries: Array<{
    sqlBytes: number
    boundCount: number
    maxStringBytes: number
  }>
  reset(): void
  failNextBatchAt(statementIndex: number): void
}

const FREE_QUERY_LIMIT = 50
const MAX_BOUND_PARAMETERS = 100
const MAX_SQL_BYTES = 100_000
const MAX_BOUND_STRING_BYTES = 2_000_000
const IMPLEMENTATION_BOUND_STRING_BUDGET = 1_500_000
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength

const createSqliteD1 = (
  database: DatabaseSync,
): { db: D1Database; budget: D1QueryBudgetProbe } => {
  let injectedFailureIndex: number | undefined
  const budget: D1QueryBudgetProbe = {
    queries: [],
    reset() {
      this.queries.length = 0
    },
    failNextBatchAt(statementIndex) {
      injectedFailureIndex = statementIndex
    },
  }
  const prepare = (sql: string): SqliteD1Statement => {
    let bindings: SQLInputValue[] = []
    const statement = database.prepare(sql)
    const reserve = (): void => {
      const query = {
        sqlBytes: utf8Bytes(sql),
        boundCount: bindings.length,
        maxStringBytes: Math.max(
          0,
          ...bindings.map((value) =>
            typeof value === 'string' ? utf8Bytes(value) : 0,
          ),
        ),
      }
      budget.queries.push(query)

      if (budget.queries.length > FREE_QUERY_LIMIT) {
        throw new Error(`D1 query budget exceeded: ${String(budget.queries.length)}`)
      }

      if (query.boundCount > MAX_BOUND_PARAMETERS) {
        throw new Error(`D1 bound parameter limit exceeded: ${String(query.boundCount)}`)
      }

      if (query.sqlBytes > MAX_SQL_BYTES) {
        throw new Error(`D1 SQL byte limit exceeded: ${String(query.sqlBytes)}`)
      }

      if (query.maxStringBytes > MAX_BOUND_STRING_BYTES) {
        throw new Error(
          `D1 bound string byte limit exceeded: ${String(query.maxStringBytes)}`,
        )
      }
    }
    const adapter: SqliteD1Statement = {
      bind(...values) {
        bindings = values as SQLInputValue[]
        return adapter
      },
      run() {
        reserve()
        return Promise.resolve(adapter.execute())
      },
      first() {
        reserve()
        return Promise.resolve(statement.get(...bindings) ?? null)
      },
      all() {
        reserve()
        return Promise.resolve({
          success: true,
          results: statement.all(...bindings),
          meta: {},
        })
      },
      reserve,
      execute() {
        const result = statement.run(...bindings)

        return { success: true, meta: { changes: Number(result.changes) } }
      },
    }

    return adapter
  }

  const db = {
    prepare(sql: string) {
      return prepare(sql) as unknown as D1PreparedStatement
    },
    batch(statements: D1PreparedStatement[]) {
      const sqliteStatements = statements as unknown as SqliteD1Statement[]

      for (const statement of sqliteStatements) {
        statement.reserve()
      }

      database.exec('BEGIN IMMEDIATE')

      try {
        const results = sqliteStatements.map((statement, index) => {
          if (index === injectedFailureIndex) {
            throw new Error('Injected D1 batch failure')
          }

          return statement.execute()
        })
        database.exec('COMMIT')
        injectedFailureIndex = undefined
        return Promise.resolve(results as unknown as D1Result[])
      } catch (error) {
        database.exec('ROLLBACK')
        injectedFailureIndex = undefined
        return Promise.reject(
          error instanceof Error ? error : new Error('SQLite D1 batch failed'),
        )
      }
    },
  } as unknown as D1Database

  return { db, budget }
}

const createDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')

  for (const migrationPath of migrationPaths) {
    database.exec(readFileSync(new URL(migrationPath, import.meta.url), 'utf8'))
  }

  database.exec(`
    INSERT INTO word_sources (id, name, created_at) VALUES ('source-1', 'Source', '${NOW}');
    INSERT INTO source_versions (
      id, source_id, version_no, status, created_at, published_at
    ) VALUES ('version-1', 'source-1', 1, 'published', '${NOW}', '${NOW}');
    INSERT INTO words (
      id, source_version_id, order_index, word, meaning, example_sentence, created_at
    ) VALUES ('word-1', 'version-1', 1, 'hello', '你好', '', '${NOW}');
    INSERT INTO word_groups (
      id, source_version_id, group_index, start_order_index, end_order_index, created_at
    ) VALUES ('group-1', 'version-1', 1, 1, 1, '${NOW}');
  `)

  return database
}

const createRepositoryFixture = async () => {
  const database = createDatabase()
  const { db, budget } = createSqliteD1(database)
  const repository = createD1CourseRepository(db)

  await repository.createCourse({
    learner: { id: 'learner-1', name: 'Alice', accessCode: 'ABCDEFGH23', createdAt: NOW },
    course: {
      id: 'course-1',
      learnerId: 'learner-1',
      sourceVersionId: 'version-1',
      currentLessonNo: 1,
      status: 'active',
      createdAt: NOW,
    },
  })

  budget.reset()

  return { database, db, repository, budget }
}

const createTask = (
  id: string,
  orderIndex: number,
  overrides: Partial<LessonTaskRecord> = {},
): LessonTaskRecord => ({
  id,
  sessionId: 'lesson-1',
  courseId: 'course-1',
  wordId: 'word-1',
  stage: 'S0',
  taskType: 'recognize_meaning',
  prompt: { word: 'hello', meaning: '你好', exampleSentence: '' },
  answer: { word: 'hello', expectedResponse: 'known' },
  orderIndex,
  status: 'pending',
  role: 'primary',
  required: false,
  createdAt: NOW,
  ...overrides,
})

const createSentenceOutputTask = (): LessonTaskRecord => ({
  id: 'task-s5',
  sessionId: 'lesson-1',
  courseId: 'course-1',
  wordId: 'word-1',
  stage: 'S5',
  taskType: 'sentence_output',
  prompt: { meaning: '我吃了一个苹果。', instruction: '写一个英文句子' },
  answer: { referenceSentence: 'I ate an apple.' },
  orderIndex: 1,
  status: 'pending',
  role: 'primary',
  required: false,
  createdAt: NOW,
})

const createWordState = (overrides: Partial<UserWordStateRecord> = {}): UserWordStateRecord => ({
  id: 'state-1',
  courseId: 'course-1',
  wordId: 'word-1',
  groupId: 'group-1',
  stage: 'S0',
  totalAttemptCount: 0,
  totalCorrectCount: 0,
  totalWrongCount: 0,
  currentStreak: 0,
  wrongStreak: 0,
  lapseCount: 0,
  easeFactor: 1,
  masteryScore: 0,
  firstLessonNo: 1,
  nextDueLessonNo: 1,
  status: 'new',
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
})

const createSentenceBuildTask = (
  id: string,
  orderIndex: number,
  options: {
    pieceCount: number
    pieceIdLength: number
    pieceTextLength: number
  },
): LessonTaskRecord => {
  const pieces = Array.from({ length: options.pieceCount }, (_, index) => {
    const label = `${String(index)}-`

    return {
      id: `${label}${'标'.repeat(options.pieceIdLength - label.length)}`,
      text: `${label}${'词'.repeat(options.pieceTextLength - label.length)}`,
    }
  })

  return {
    id,
    sessionId: 'lesson-1',
    courseId: 'course-1',
    wordId: 'word-1',
    stage: 'S4',
    taskType: 'sentence_build',
    prompt: { pieces },
    answer: {
      pieceIds: pieces.map((piece) => piece.id).reverse(),
      referenceSentence: '参考句子',
    },
    orderIndex,
    status: 'pending',
    role: 'primary',
    required: false,
    createdAt: NOW,
  }
}

const expectD1FreeInvocation = (
  budget: D1QueryBudgetProbe,
  expectedQueryCount?: number,
): void => {
  expect(budget.queries.length).toBeLessThanOrEqual(FREE_QUERY_LIMIT)
  expect(Math.max(0, ...budget.queries.map((query) => query.boundCount))).toBeLessThanOrEqual(
    MAX_BOUND_PARAMETERS,
  )
  expect(Math.max(0, ...budget.queries.map((query) => query.sqlBytes))).toBeLessThan(
    MAX_SQL_BYTES,
  )
  expect(
    Math.max(0, ...budget.queries.map((query) => query.maxStringBytes)),
  ).toBeLessThanOrEqual(IMPLEMENTATION_BOUND_STRING_BUDGET)

  if (expectedQueryCount !== undefined) {
    expect(budget.queries).toHaveLength(expectedQueryCount)
  }
}

describe('D1 course queue repository', () => {
  it('creates a 65-task lesson within the D1 Free per-invocation query budget', async () => {
    const { database, budget, repository } = await createRepositoryFixture()
    const tasks = Array.from({ length: 65 }, (_, index) =>
      createTask(`task-budget-${String(index + 1)}`, index + 1),
    )

    const lesson = await repository.createLesson({
      session: {
        id: 'lesson-1',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: tasks.length,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        startedAt: NOW,
      },
      tasks,
      wordStates: [createWordState()],
    })

    expect(lesson.tasks).toHaveLength(65)
    expectD1FreeInvocation(budget, 4)

    database.close()
  })

  it.each(['paused', 'completed'] as const)(
    'does not create lesson rows for a %s course',
    async (status) => {
      const { database, repository } = await createRepositoryFixture()
      database.prepare('UPDATE courses SET status = ? WHERE id = ?').run(status, 'course-1')

      await expect(
        repository.createLesson({
          session: {
            id: 'lesson-1',
            courseId: 'course-1',
            lessonNo: 1,
            status: 'started',
            taskCount: 1,
            completedTaskCount: 0,
            correctCount: 0,
            wrongCount: 0,
            startedAt: NOW,
          },
          tasks: [createTask('task-inactive-course', 1)],
          wordStates: [createWordState()],
        }),
      ).rejects.toMatchObject({ code: 'course_unavailable' })
      expect(database.prepare('SELECT COUNT(*) AS count FROM lesson_sessions').get()).toEqual({
        count: 0,
      })
      expect(database.prepare('SELECT COUNT(*) AS count FROM lesson_tasks').get()).toEqual({
        count: 0,
      })
      expect(database.prepare('SELECT COUNT(*) AS count FROM user_word_states').get()).toEqual({
        count: 0,
      })

      database.close()
    },
  )

  it(
    'creates 500 tasks including a maximum-size legal multibyte prompt with byte-safe chunks',
    async () => {
      const { database, budget, repository } = await createRepositoryFixture()
      const tasks = [
        createSentenceBuildTask('task-max-prompt', 1, {
          pieceCount: 100,
          pieceIdLength: 2_000,
          pieceTextLength: 2_000,
        }),
        ...Array.from({ length: 499 }, (_, index) =>
          createSentenceBuildTask(`task-large-${String(index + 2)}`, index + 2, {
            pieceCount: 10,
            pieceIdLength: 12,
            pieceTextLength: 500,
          }),
        ),
      ]

      const lesson = await repository.createLesson({
        session: {
          id: 'lesson-1',
          courseId: 'course-1',
          lessonNo: 1,
          status: 'started',
          taskCount: tasks.length,
          completedTaskCount: 0,
          correctCount: 0,
          wrongCount: 0,
          startedAt: NOW,
        },
        tasks,
        wordStates: [createWordState()],
      })

      expect(lesson.tasks).toHaveLength(500)
      expect(lesson.tasks[0]?.id).toBe('task-max-prompt')
      expect(lesson.tasks[499]?.id).toBe('task-large-500')
      expect(
        Math.max(...budget.queries.map((query) => query.maxStringBytes)),
      ).toBeGreaterThan(512 * 1024)
      expectD1FreeInvocation(budget, 5)

      database.close()
    },
    30_000,
  )

  it('records a 500-task queue once within the D1 Free invocation budget', async () => {
    const { database, budget, repository } = await createRepositoryFixture()
    const tasks = Array.from({ length: 500 }, (_, index) =>
      createTask(`task-answer-${String(index + 1)}`, index + 1),
    )
    await repository.createLesson({
      session: {
        id: 'lesson-1',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: tasks.length,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        startedAt: NOW,
      },
      tasks,
      wordStates: [createWordState()],
    })
    const completedTask = createTask(tasks[0]?.id ?? '', 1, { status: 'completed' })
    const updatedTasks = [completedTask, ...tasks.slice(1)]
    const updatedState = createWordState({
      stage: 'S1',
      totalAttemptCount: 1,
      totalCorrectCount: 1,
      currentStreak: 1,
      nextDueLessonNo: 2,
      status: 'learning',
    })
    const input = {
      task: completedTask,
      wordState: updatedState,
      reviewLog: {
        id: 'review-budget-500',
        sessionId: 'lesson-1',
        taskId: completedTask.id,
        courseId: 'course-1',
        wordId: 'word-1',
        stage: 'S0' as const,
        taskType: 'recognize_meaning',
        userAnswer: JSON.stringify({ taskType: 'recognize_meaning', response: 'known' }),
        correctAnswer: 'known',
        score: 2 as const,
        lessonNo: 1,
        createdAt: NOW,
      },
      tasks: updatedTasks,
      advanceWordState: true,
    }

    budget.reset()
    const first = await repository.recordAnswer(input)

    expect(first.reviewLog.id).toBe('review-budget-500')
    expectD1FreeInvocation(budget, 8)

    budget.reset()
    const retry = await repository.recordAnswer(input)

    expect(retry).toEqual(first)
    expectD1FreeInvocation(budget, 3)
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM review_logs').get(),
    ).toEqual({ count: 1 })

    database.close()
  })

  it('completes and skips a 500-task lesson with an atomic dormant-lesson jump', async () => {
    const { database, budget, repository } = await createRepositoryFixture()
    const tasks = Array.from({ length: 500 }, (_, index) =>
      createTask(`task-complete-${String(index + 1)}`, index + 1, {
        status: index < 400 ? 'completed' : 'pending',
      }),
    )
    await repository.createLesson({
      session: {
        id: 'lesson-1',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: tasks.length,
        completedTaskCount: 400,
        correctCount: 400,
        wrongCount: 0,
        startedAt: NOW,
      },
      tasks,
      wordStates: [createWordState()],
    })
    const skippablePrimaryTaskIds = tasks.slice(400).map((task) => task.id)

    budget.reset()
    await expect(
      repository.completeLesson({
        sessionId: 'lesson-1',
        completedAt: NOW,
        nextLessonNo: 1,
        skippablePrimaryTaskIds,
      }),
    ).resolves.toBeUndefined()
    expectD1FreeInvocation(budget, 2)

    budget.reset()
    const completed = await repository.completeLesson({
      sessionId: 'lesson-1',
      completedAt: NOW,
      nextLessonNo: 4,
      skippablePrimaryTaskIds,
    })

    expect(completed?.course.currentLessonNo).toBe(4)
    expect(completed?.session.status).toBe('completed')
    expectD1FreeInvocation(budget, 8)
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM lesson_tasks WHERE status = 'skipped'")
        .get(),
    ).toEqual({ count: 100 })
    expect(
      database.prepare('SELECT current_lesson_no FROM courses WHERE id = ?').get('course-1'),
    ).toEqual({ current_lesson_no: 4 })

    budget.reset()
    const retry = await repository.completeLesson({
      sessionId: 'lesson-1',
      completedAt: NOW,
      nextLessonNo: 4,
      skippablePrimaryTaskIds,
    })

    expect(retry).toEqual(completed)
    expectD1FreeInvocation(budget, 2)

    database.close()
  })

  it('rolls back bulk batches on injected failure and invalid reflux scope', async () => {
    const { database, budget, repository } = await createRepositoryFixture()
    const session = {
      id: 'lesson-1',
      courseId: 'course-1',
      lessonNo: 1,
      status: 'started' as const,
      taskCount: 1,
      completedTaskCount: 0,
      correctCount: 0,
      wrongCount: 0,
      startedAt: NOW,
    }

    budget.failNextBatchAt(2)
    await expect(
      repository.createLesson({
        session,
        tasks: [createTask('task-create-rollback', 1)],
        wordStates: [createWordState()],
      }),
    ).rejects.toThrow('Injected D1 batch failure')
    expect(database.prepare('SELECT COUNT(*) AS count FROM lesson_sessions').get()).toEqual({
      count: 0,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM lesson_tasks').get()).toEqual({
      count: 0,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM user_word_states').get()).toEqual({
      count: 0,
    })

    const invalidReflux = createTask('task-invalid-reflux', 2, {
      role: 'reflux',
      required: true,
      refluxSourceTaskId: 'missing-source-task',
    })
    await expect(
      repository.createLesson({
        session: { ...session, taskCount: 2 },
        tasks: [createTask('task-source', 1), invalidReflux],
        wordStates: [createWordState()],
      }),
    ).rejects.toThrow('lesson_task_reflux_source_mismatch')
    expect(database.prepare('SELECT COUNT(*) AS count FROM lesson_sessions').get()).toEqual({
      count: 0,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM lesson_tasks').get()).toEqual({
      count: 0,
    })

    const primary = createTask('task-record-rollback', 1)
    await repository.createLesson({
      session,
      tasks: [primary],
      wordStates: [createWordState()],
    })
    const completedTask = createTask(primary.id, 1, { status: 'completed' })
    budget.reset()
    budget.failNextBatchAt(4)
    await expect(
      repository.recordAnswer({
        task: completedTask,
        wordState: createWordState({
          stage: 'S1',
          totalAttemptCount: 1,
          totalCorrectCount: 1,
          currentStreak: 1,
          nextDueLessonNo: 2,
          status: 'learning',
        }),
        reviewLog: {
          id: 'review-rollback',
          sessionId: 'lesson-1',
          taskId: primary.id,
          courseId: 'course-1',
          wordId: 'word-1',
          stage: 'S0',
          taskType: 'recognize_meaning',
          userAnswer: JSON.stringify({ taskType: 'recognize_meaning', response: 'known' }),
          correctAnswer: 'known',
          score: 2,
          lessonNo: 1,
          createdAt: NOW,
        },
        tasks: [completedTask],
        advanceWordState: true,
      }),
    ).rejects.toThrow('Injected D1 batch failure')
    expect(database.prepare('SELECT COUNT(*) AS count FROM review_logs').get()).toEqual({
      count: 0,
    })
    expect(
      database.prepare('SELECT status, order_index FROM lesson_tasks WHERE id = ?').get(primary.id),
    ).toEqual({ status: 'pending', order_index: 1 })
    expect(
      database
        .prepare(
          'SELECT total_attempt_count, total_correct_count FROM user_word_states WHERE id = ?',
        )
        .get('state-1'),
    ).toEqual({ total_attempt_count: 0, total_correct_count: 0 })
    expectD1FreeInvocation(budget, 7)

    database.close()
  })

  it('advances a dormant course lesson number with compare-and-set semantics', async () => {
    const { database, repository } = await createRepositoryFixture()

    const advanced = await repository.advanceCourseLessonNo({
      courseId: 'course-1',
      expectedLessonNo: 1,
      nextLessonNo: 4,
    })
    const staleRetry = await repository.advanceCourseLessonNo({
      courseId: 'course-1',
      expectedLessonNo: 1,
      nextLessonNo: 9,
    })

    expect(advanced?.currentLessonNo).toBe(4)
    expect(staleRetry?.currentLessonNo).toBe(4)
    expect(
      database.prepare('SELECT current_lesson_no FROM courses WHERE id = ?').get('course-1'),
    ).toEqual({ current_lesson_no: 4 })

    database.close()
  })

  it.each(['paused', 'completed'] as const)(
    'does not advance the lesson number for a %s course',
    async (status) => {
      const { database, repository } = await createRepositoryFixture()
      database
        .prepare('UPDATE courses SET status = ? WHERE id = ?')
        .run(status, 'course-1')

      await expect(
        repository.advanceCourseLessonNo({
          courseId: 'course-1',
          expectedLessonNo: 1,
          nextLessonNo: 4,
        }),
      ).rejects.toMatchObject({ code: 'course_unavailable' })
      expect(
        database.prepare('SELECT current_lesson_no FROM courses WHERE id = ?').get('course-1'),
      ).toEqual({ current_lesson_no: 1 })

      database.close()
    },
  )

  it.each(['paused', 'completed'] as const)(
    'does not create a learner session for a %s course',
    async (status) => {
      const { database, db } = await createRepositoryFixture()
      const repository = createD1SessionRepository(db)
      database
        .prepare('UPDATE courses SET status = ? WHERE id = ?')
        .run(status, 'course-1')

      await expect(
        repository.create({
          id: 'learner-session-1',
          tokenHash: 'sha256:stored-only',
          learnerId: 'learner-1',
          courseId: 'course-1',
          createdAt: NOW,
          expiresAt: '2026-08-12T00:00:00.000Z',
          credentialVersion: 1,
        }),
      ).resolves.toBeUndefined()
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM learner_sessions').get(),
      ).toEqual({ count: 0 })

      database.close()
    },
  )

  it('reads the latest completed lesson before current within one course and one query', async () => {
    const { database, budget, repository } = await createRepositoryFixture()
    database.exec(`
      INSERT INTO learners (id, name, access_code, created_at)
      VALUES ('learner-other', 'Bob', 'unused-hash', '${NOW}');
      INSERT INTO courses (
        id, learner_id, source_version_id, current_lesson_no, status, created_at
      ) VALUES ('course-other', 'learner-other', 'version-1', 4, 'active', '${NOW}');
      INSERT INTO lesson_sessions (
        id, course_id, lesson_no, status, task_count, completed_task_count,
        correct_count, wrong_count, started_at, completed_at
      ) VALUES
        ('completed-1', 'course-1', 1, 'completed', 1, 1, 1, 0, '${NOW}', '${NOW}'),
        ('completed-2', 'course-1', 2, 'completed', 1, 1, 1, 0, '${NOW}', '${NOW}'),
        ('started-3', 'course-1', 3, 'started', 1, 0, 0, 0, '${NOW}', NULL),
        ('other-completed-3', 'course-other', 3, 'completed', 1, 1, 1, 0, '${NOW}', '${NOW}');
    `)

    budget.reset()
    const latest = await repository.getLatestCompletedLessonBefore({
      courseId: 'course-1',
      beforeLessonNo: 4,
    })

    expect(latest).toMatchObject({
      id: 'completed-2',
      courseId: 'course-1',
      lessonNo: 2,
      status: 'completed',
    })
    expectD1FreeInvocation(budget, 1)
    expect(budget.queries[0]?.boundCount).toBe(3)

    database.close()
  })

  it('returns the winning lesson snapshot after a concurrent unique-key conflict', async () => {
    const { database, repository } = await createRepositoryFixture()
    const firstTask = createTask('task-winner', 1)

    const winner = await repository.createLesson({
      session: {
        id: 'lesson-1',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        startedAt: NOW,
      },
      tasks: [firstTask],
      wordStates: [createWordState()],
    })
    const loserTask = createTask('task-loser', 1, {
      sessionId: 'lesson-loser',
    })
    const retried = await repository.createLesson({
      session: {
        id: 'lesson-loser',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        startedAt: NOW,
      },
      tasks: [loserTask],
      wordStates: [],
    })

    expect(retried).toEqual(winner)
    expect(retried.session.id).toBe('lesson-1')
    expect(retried.tasks.map((task) => task.id)).toEqual(['task-winner'])

    database.close()
  })

  it('reads explicit admin course columns without returning the stored credential hash', async () => {
    const { database, repository } = await createRepositoryFixture()

    const result = await repository.listAdminCourses()

    expect(result).toEqual([
      {
        learner: { id: 'learner-1', name: 'Alice' },
        credentialVersion: 1,
        course: {
          id: 'course-1',
          learnerId: 'learner-1',
          sourceVersionId: 'version-1',
          currentLessonNo: 1,
          status: 'active',
          createdAt: NOW,
        },
      },
    ])
    expect(JSON.stringify(result)).not.toMatch(/accessCode|access_code|sha256:/u)

    database.close()
  })

  it('loads report tasks and logs only through the asserted session-course scope', async () => {
    const { database, db, repository } = await createRepositoryFixture()
    const primary = createTask('task-primary', 1)
    const initialState = createWordState()
    await repository.createLesson({
      session: {
        id: 'lesson-1',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        startedAt: NOW,
      },
      tasks: [primary],
      wordStates: [initialState],
    })
    const completedTask = createTask(primary.id, 1, { status: 'completed' })
    await repository.recordAnswer({
      task: completedTask,
      wordState: createWordState({
        stage: 'S1',
        totalAttemptCount: 1,
        totalCorrectCount: 1,
        currentStreak: 1,
        nextDueLessonNo: 2,
        status: 'learning',
      }),
      reviewLog: {
        id: 'review-report',
        sessionId: 'lesson-1',
        taskId: primary.id,
        courseId: 'course-1',
        wordId: 'word-1',
        stage: 'S0',
        taskType: 'recognize_meaning',
        userAnswer: JSON.stringify({ taskType: 'recognize_meaning', response: 'known' }),
        correctAnswer: 'known',
        score: 2,
        lessonNo: 1,
        createdAt: NOW,
      },
      tasks: [completedTask],
      advanceWordState: true,
    })
    await repository.completeLesson({
      sessionId: 'lesson-1',
      completedAt: NOW,
      skippablePrimaryTaskIds: [],
      nextLessonNo: 2,
    })

    const snapshot = await repository.getLessonReportSnapshot({
      sessionId: 'lesson-1',
      courseId: 'course-1',
    })
    const crossCourse = await repository.getLessonReportSnapshot({
      sessionId: 'lesson-1',
      courseId: 'course-other',
    })

    expect(snapshot).toMatchObject({
      session: { id: 'lesson-1', status: 'completed' },
      tasks: [{ id: primary.id, role: 'primary', status: 'completed' }],
      reviewLogs: [{ id: 'review-report', taskId: primary.id, score: 2 }],
    })
    expect(crossCourse).toBeUndefined()

    const report = await createCourseQueryService({
      contentRepository: createD1ContentRepository(db),
      courseRepository: repository,
    }).getLessonReport(
      { learnerId: 'learner-1', courseId: 'course-1' },
      'lesson-1',
    )
    expect(report).toEqual({
      lessonNo: 1,
      completedTaskCount: 1,
      totalTaskCount: 1,
      correctRate: 1,
      needsPracticeWords: [],
      progressWords: [{ id: 'word-1', word: 'hello' }],
      nextLessonNo: 2,
      courseStatus: 'active',
    })

    database.close()
  })

  it('persists the S5 draft and reveal timestamp without writing a review log', async () => {
    const { database, repository } = await createRepositoryFixture()
    const task = createSentenceOutputTask()
    await repository.createLesson({
      session: {
        id: 'lesson-1',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        startedAt: NOW,
      },
      tasks: [task],
      wordStates: [createWordState({ stage: 'S5', status: 'reviewing' })],
    })
    const input = {
      sessionId: 'lesson-1',
      courseId: 'course-1',
      taskId: task.id,
      draft: 'I eat an apple.',
      revealedAt: NOW,
    }

    const first = await repository.saveSentenceOutputPreview(input)
    const retry = await repository.saveSentenceOutputPreview(input)
    const restored = await repository.getLessonTask('lesson-1', task.id)

    expect(retry).toEqual(first)
    expect(restored).toMatchObject({
      draftAnswer: input.draft,
      referenceRevealedAt: input.revealedAt,
    })
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM review_logs').get() as { count: number },
    ).toEqual({ count: 0 })

    database.close()
  })

  it.each(['paused', 'completed'] as const)(
    'does not persist an S5 preview for a %s course',
    async (status) => {
      const { database, repository } = await createRepositoryFixture()
      const task = createSentenceOutputTask()
      await repository.createLesson({
        session: {
          id: 'lesson-1',
          courseId: 'course-1',
          lessonNo: 1,
          status: 'started',
          taskCount: 1,
          completedTaskCount: 0,
          correctCount: 0,
          wrongCount: 0,
          startedAt: NOW,
        },
        tasks: [task],
        wordStates: [createWordState({ stage: 'S5', status: 'reviewing' })],
      })
      database.prepare('UPDATE courses SET status = ? WHERE id = ?').run(status, 'course-1')

      await expect(
        repository.saveSentenceOutputPreview({
          sessionId: 'lesson-1',
          courseId: 'course-1',
          taskId: task.id,
          draft: 'I eat an apple.',
          revealedAt: NOW,
        }),
      ).rejects.toMatchObject({ code: 'course_unavailable' })
      expect(
        database
          .prepare(
            'SELECT draft_answer AS draftAnswer, reference_revealed_at AS referenceRevealedAt FROM lesson_tasks WHERE id = ?',
          )
          .get(task.id),
      ).toEqual({ draftAnswer: null, referenceRevealedAt: null })

      database.close()
    },
  )

  it.each(['completed', 'abandoned'] as const)(
    'does not persist an S5 preview after the lesson is %s',
    async (sessionStatus) => {
      const { database, repository } = await createRepositoryFixture()
      const task = createSentenceOutputTask()
      await repository.createLesson({
        session: {
          id: 'lesson-1',
          courseId: 'course-1',
          lessonNo: 1,
          status: 'started',
          taskCount: 1,
          completedTaskCount: 0,
          correctCount: 0,
          wrongCount: 0,
          startedAt: NOW,
        },
        tasks: [task],
        wordStates: [createWordState({ stage: 'S5', status: 'reviewing' })],
      })
      database
        .prepare('UPDATE lesson_sessions SET status = ? WHERE id = ?')
        .run(sessionStatus, 'lesson-1')

      await expect(
        repository.saveSentenceOutputPreview({
          sessionId: 'lesson-1',
          courseId: 'course-1',
          taskId: task.id,
          draft: 'I eat an apple.',
          revealedAt: NOW,
        }),
      ).rejects.toMatchObject({ code: 'lesson_not_active' })
      expect(
        database.prepare(`
          SELECT draft_answer AS draftAnswer, reference_revealed_at AS referenceRevealedAt
          FROM lesson_tasks
          WHERE id = 'task-s5'
        `).get(),
      ).toEqual({ draftAnswer: null, referenceRevealedAt: null })

      database.close()
    },
  )

  it.each(['completed', 'abandoned'] as const)(
    'maps an S5 preview race to lesson_not_active when the D1 lesson becomes %s',
    async (sessionStatus) => {
      const { database, db, repository } = await createRepositoryFixture()
      const task = createSentenceOutputTask()
      await repository.createLesson({
        session: {
          id: 'lesson-1',
          courseId: 'course-1',
          lessonNo: 1,
          status: 'started',
          taskCount: 1,
          completedTaskCount: 0,
          correctCount: 0,
          wrongCount: 0,
          startedAt: NOW,
        },
        tasks: [task],
        wordStates: [createWordState({ stage: 'S5', status: 'reviewing' })],
      })
      const racingRepository: CourseRepository = {
        ...repository,
        async saveSentenceOutputPreview(input) {
          database
            .prepare('UPDATE lesson_sessions SET status = ? WHERE id = ? AND course_id = ?')
            .run(sessionStatus, input.sessionId, input.courseId)
          return repository.saveSentenceOutputPreview(input)
        },
      }
      const runtime = createCourseRuntime({
        contentRepository: createD1ContentRepository(db),
        courseRepository: racingRepository,
        now: () => new Date(NOW),
      })

      await expect(
        runtime.previewSentenceOutput({
          sessionId: 'lesson-1',
          taskId: task.id,
          preview: { taskType: 'sentence_output', draft: 'I eat an apple.' },
        }),
      ).rejects.toMatchObject({ code: 'lesson_not_active' })
      expect(
        database.prepare(`
          SELECT draft_answer AS draftAnswer, reference_revealed_at AS referenceRevealedAt
          FROM lesson_tasks
          WHERE id = 'task-s5'
        `).get(),
      ).toEqual({ draftAnswer: null, referenceRevealedAt: null })
      expect(database.prepare('SELECT COUNT(*) AS count FROM review_logs').get()).toEqual({
        count: 0,
      })
      expect(
        database.prepare(`
          SELECT total_attempt_count AS totalAttemptCount, stage
          FROM user_word_states
          WHERE id = 'state-1'
        `).get(),
      ).toEqual({ totalAttemptCount: 0, stage: 'S5' })
      expect(
        database.prepare(`
          SELECT status, completed_task_count AS completedTaskCount,
            correct_count AS correctCount, wrong_count AS wrongCount
          FROM lesson_sessions
          WHERE id = 'lesson-1'
        `).get(),
      ).toEqual({
        status: sessionStatus,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
      })
      expect(
        database.prepare('SELECT current_lesson_no AS currentLessonNo FROM courses WHERE id = ?')
          .get('course-1'),
      ).toEqual({ currentLessonNo: 1 })

      database.close()
    },
  )

  it.each(['paused', 'completed'] as const)(
    'does not record an answer for a %s course',
    async (status) => {
      const { database, repository } = await createRepositoryFixture()
      const task = createTask('task-inactive-answer', 1)
      await repository.createLesson({
        session: {
          id: 'lesson-1',
          courseId: 'course-1',
          lessonNo: 1,
          status: 'started',
          taskCount: 1,
          completedTaskCount: 0,
          correctCount: 0,
          wrongCount: 0,
          startedAt: NOW,
        },
        tasks: [task],
        wordStates: [createWordState()],
      })
      database.prepare('UPDATE courses SET status = ? WHERE id = ?').run(status, 'course-1')
      const completedTask = createTask(task.id, 1, { status: 'completed' })

      await expect(
        repository.recordAnswer({
          task: completedTask,
          wordState: createWordState({
            stage: 'S1',
            totalAttemptCount: 1,
            totalCorrectCount: 1,
            currentStreak: 1,
            nextDueLessonNo: 2,
            status: 'learning',
          }),
          reviewLog: {
            id: `review-${status}`,
            sessionId: 'lesson-1',
            taskId: task.id,
            courseId: 'course-1',
            wordId: 'word-1',
            stage: 'S0',
            taskType: 'recognize_meaning',
            userAnswer: JSON.stringify({ taskType: 'recognize_meaning', response: 'known' }),
            correctAnswer: 'known',
            score: 2,
            lessonNo: 1,
            createdAt: NOW,
          },
          tasks: [completedTask],
          advanceWordState: true,
        }),
      ).rejects.toMatchObject({ code: 'course_unavailable' })
      expect(database.prepare('SELECT COUNT(*) AS count FROM review_logs').get()).toEqual({
        count: 0,
      })
      expect(
        database.prepare('SELECT status FROM lesson_tasks WHERE id = ?').get(task.id),
      ).toEqual({ status: 'pending' })
      expect(
        database
          .prepare(
            'SELECT stage, total_attempt_count AS totalAttemptCount FROM user_word_states WHERE id = ?',
          )
          .get('state-1'),
      ).toEqual({ stage: 'S0', totalAttemptCount: 0 })
      expect(
        database
          .prepare(
            'SELECT completed_task_count AS completedTaskCount, correct_count AS correctCount, wrong_count AS wrongCount FROM lesson_sessions WHERE id = ?',
          )
          .get('lesson-1'),
      ).toEqual({ completedTaskCount: 0, correctCount: 0, wrongCount: 0 })
      expect(
        database
          .prepare('SELECT current_lesson_no AS currentLessonNo, status FROM courses WHERE id = ?')
          .get('course-1'),
      ).toEqual({ currentLessonNo: 1, status })

      database.close()
    },
  )

  it.each(['completed', 'abandoned'] as const)(
    'does not record an answer after the lesson is %s',
    async (sessionStatus) => {
      const { database, repository } = await createRepositoryFixture()
      const task = createTask('task-closed-session', 1)
      const initialState = createWordState()
      await repository.createLesson({
        session: {
          id: 'lesson-1',
          courseId: 'course-1',
          lessonNo: 1,
          status: 'started',
          taskCount: 1,
          completedTaskCount: 0,
          correctCount: 0,
          wrongCount: 0,
          startedAt: NOW,
        },
        tasks: [task],
        wordStates: [initialState],
      })
      database
        .prepare('UPDATE lesson_sessions SET status = ? WHERE id = ?')
        .run(sessionStatus, 'lesson-1')
      const completedTask = createTask(task.id, 1, { status: 'completed' })

      await expect(
        repository.recordAnswer({
          task: completedTask,
          wordState: createWordState({
            stage: 'S1',
            totalAttemptCount: 1,
            totalCorrectCount: 1,
            currentStreak: 1,
            nextDueLessonNo: 2,
            status: 'learning',
          }),
          reviewLog: {
            id: `review-${sessionStatus}`,
            sessionId: 'lesson-1',
            taskId: task.id,
            courseId: 'course-1',
            wordId: 'word-1',
            stage: 'S0',
            taskType: 'recognize_meaning',
            userAnswer: JSON.stringify({ taskType: 'recognize_meaning', response: 'known' }),
            correctAnswer: 'known',
            score: 2,
            lessonNo: 1,
            createdAt: NOW,
          },
          tasks: [completedTask],
          advanceWordState: true,
        }),
      ).rejects.toMatchObject({ code: 'lesson_not_active' })
      expect(database.prepare('SELECT COUNT(*) AS count FROM review_logs').get()).toEqual({
        count: 0,
      })
      expect(
        database.prepare('SELECT status FROM lesson_tasks WHERE id = ?').get(task.id),
      ).toEqual({ status: 'pending' })
      expect(
        database.prepare(`
          SELECT total_attempt_count AS totalAttemptCount,
            total_correct_count AS totalCorrectCount,
            stage
          FROM user_word_states
          WHERE id = 'state-1'
        `).get(),
      ).toEqual({ totalAttemptCount: 0, totalCorrectCount: 0, stage: 'S0' })

      database.close()
    },
  )

  it.each(['completed', 'abandoned'] as const)(
    'maps an answer race to lesson_not_active when the D1 lesson becomes %s',
    async (sessionStatus) => {
      const { database, db, repository } = await createRepositoryFixture()
      const task = createTask('task-answer-race', 1)
      await repository.createLesson({
        session: {
          id: 'lesson-1',
          courseId: 'course-1',
          lessonNo: 1,
          status: 'started',
          taskCount: 1,
          completedTaskCount: 0,
          correctCount: 0,
          wrongCount: 0,
          startedAt: NOW,
        },
        tasks: [task],
        wordStates: [createWordState()],
      })
      const racingRepository: CourseRepository = {
        ...repository,
        async recordAnswer(input) {
          database
            .prepare('UPDATE lesson_sessions SET status = ? WHERE id = ? AND course_id = ?')
            .run(sessionStatus, input.task.sessionId, input.task.courseId)
          return repository.recordAnswer(input)
        },
      }
      const runtime = createCourseRuntime({
        contentRepository: createD1ContentRepository(db),
        courseRepository: racingRepository,
        now: () => new Date(NOW),
      })

      await expect(
        runtime.submitAnswer({
          sessionId: 'lesson-1',
          taskId: task.id,
          submission: { taskType: 'recognize_meaning', response: 'known' },
        }),
      ).rejects.toMatchObject({ code: 'lesson_not_active' })
      expect(database.prepare('SELECT COUNT(*) AS count FROM review_logs').get()).toEqual({
        count: 0,
      })
      expect(
        database.prepare('SELECT status FROM lesson_tasks WHERE id = ?').get(task.id),
      ).toEqual({ status: 'pending' })
      expect(
        database.prepare(`
          SELECT total_attempt_count AS totalAttemptCount,
            total_correct_count AS totalCorrectCount, stage
          FROM user_word_states
          WHERE id = 'state-1'
        `).get(),
      ).toEqual({ totalAttemptCount: 0, totalCorrectCount: 0, stage: 'S0' })
      expect(
        database.prepare(`
          SELECT status, completed_task_count AS completedTaskCount,
            correct_count AS correctCount, wrong_count AS wrongCount
          FROM lesson_sessions
          WHERE id = 'lesson-1'
        `).get(),
      ).toEqual({
        status: sessionStatus,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
      })
      expect(
        database.prepare('SELECT current_lesson_no AS currentLessonNo FROM courses WHERE id = ?')
          .get('course-1'),
      ).toEqual({ currentLessonNo: 1 })

      database.close()
    },
  )

  it('persists a reordered queue and makes duplicate answer writes idempotent', async () => {
    const { database, repository } = await createRepositoryFixture()
    const primary = createTask('task-primary', 1)
    const initialState = createWordState()
    await repository.createLesson({
      session: {
        id: 'lesson-1',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        startedAt: NOW,
      },
      tasks: [primary],
      wordStates: [initialState],
    })

    const completedPrimary = createTask('task-primary', 1, { status: 'completed' })
    const bridge = createTask('task-bridge', 2, {
      role: 'bridge',
      required: true,
    })
    const reflux = createTask('task-reflux', 3, {
      role: 'reflux',
      required: true,
      refluxSourceTaskId: primary.id,
    })
    const updatedState = createWordState({
      stage: 'S1',
      totalAttemptCount: 1,
      totalCorrectCount: 1,
      currentStreak: 1,
      masteryScore: 15,
      nextDueLessonNo: 2,
      status: 'learning',
    })
    const input = {
      task: completedPrimary,
      wordState: updatedState,
      reviewLog: {
        id: 'review-1',
        sessionId: 'lesson-1',
        taskId: primary.id,
        courseId: 'course-1',
        wordId: 'word-1',
        stage: 'S0' as const,
        taskType: 'recognize_meaning',
        userAnswer: JSON.stringify({ taskType: 'recognize_meaning', response: 'known' }),
        correctAnswer: 'known',
        score: 2 as const,
        lessonNo: 1,
        createdAt: NOW,
      },
      tasks: [completedPrimary, bridge, reflux],
      advanceWordState: true,
    }

    const [first, retry] = await Promise.all([
      repository.recordAnswer(input),
      repository.recordAnswer(input),
    ])
    const tasks = await repository.getLessonTasks('lesson-1')
    const state = await repository.getWordState('course-1', 'word-1')

    expect(retry).toEqual(first)
    expect(tasks.map((task) => [task.id, task.orderIndex, task.role])).toEqual([
      ['task-primary', 1, 'primary'],
      ['task-bridge', 2, 'bridge'],
      ['task-reflux', 3, 'reflux'],
    ])
    expect(state?.totalAttemptCount).toBe(1)
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM review_logs').get() as { count: number },
    ).toEqual({ count: 1 })

    database.close()
  })

  it.each(['paused', 'completed'] as const)(
    'does not complete a lesson for a %s course',
    async (status) => {
      const { database, repository } = await createRepositoryFixture()
      const tasks = Array.from({ length: 5 }, (_, index) =>
        createTask(`task-${String(index + 1)}`, index + 1, {
          status: index < 4 ? 'completed' : 'pending',
        }),
      )
      await repository.createLesson({
        session: {
          id: 'lesson-1',
          courseId: 'course-1',
          lessonNo: 1,
          status: 'started',
          taskCount: 5,
          completedTaskCount: 4,
          correctCount: 4,
          wrongCount: 0,
          startedAt: NOW,
        },
        tasks,
        wordStates: [createWordState()],
      })
      database.prepare('UPDATE courses SET status = ? WHERE id = ?').run(status, 'course-1')

      await expect(
        repository.completeLesson({
          sessionId: 'lesson-1',
          completedAt: NOW,
          skippablePrimaryTaskIds: ['task-5'],
          nextLessonNo: 2,
        }),
      ).rejects.toMatchObject({ code: 'course_unavailable' })
      expect(
        database.prepare('SELECT status FROM lesson_tasks WHERE id = ?').get('task-5'),
      ).toEqual({ status: 'pending' })
      expect(
        database
          .prepare('SELECT status, completed_at AS completedAt FROM lesson_sessions WHERE id = ?')
          .get('lesson-1'),
      ).toEqual({ status: 'started', completedAt: null })
      expect(
        database
          .prepare('SELECT current_lesson_no AS currentLessonNo, status FROM courses WHERE id = ?')
          .get('course-1'),
      ).toEqual({ currentLessonNo: 1, status })

      database.close()
    },
  )

  it.each(['completed', 'abandoned'] as const)(
    'does not complete a lesson after it becomes %s',
    async (sessionStatus) => {
      const { database, repository } = await createRepositoryFixture()
      const tasks = Array.from({ length: 5 }, (_, index) =>
        createTask(`task-${String(index + 1)}`, index + 1, {
          status: index < 4 ? 'completed' : 'pending',
        }),
      )
      await repository.createLesson({
        session: {
          id: 'lesson-1',
          courseId: 'course-1',
          lessonNo: 1,
          status: 'started',
          taskCount: 5,
          completedTaskCount: 4,
          correctCount: 4,
          wrongCount: 0,
          startedAt: NOW,
        },
        tasks,
        wordStates: [createWordState()],
      })
      database
        .prepare('UPDATE lesson_sessions SET status = ? WHERE id = ?')
        .run(sessionStatus, 'lesson-1')

      await expect(
        repository.completeLesson({
          sessionId: 'lesson-1',
          completedAt: NOW,
          skippablePrimaryTaskIds: ['task-5'],
          nextLessonNo: 2,
        }),
      ).rejects.toMatchObject({ code: 'lesson_not_active' })
      expect(
        database.prepare('SELECT status FROM lesson_tasks WHERE id = ?').get('task-5'),
      ).toEqual({ status: 'pending' })
      expect(
        database
          .prepare('SELECT status, completed_at AS completedAt FROM lesson_sessions WHERE id = ?')
          .get('lesson-1'),
      ).toEqual({ status: sessionStatus, completedAt: null })
      expect(
        database.prepare('SELECT current_lesson_no AS currentLessonNo FROM courses WHERE id = ?')
          .get('course-1'),
      ).toEqual({ currentLessonNo: 1 })

      database.close()
    },
  )

  it('atomically skips the remaining primary and advances a lesson only once', async () => {
    const { database, repository } = await createRepositoryFixture()
    const tasks = Array.from({ length: 5 }, (_, index) =>
      createTask(`task-${String(index + 1)}`, index + 1, {
        status: index < 4 ? 'completed' : 'pending',
      }),
    )
    await repository.createLesson({
      session: {
        id: 'lesson-1',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 5,
        completedTaskCount: 4,
        correctCount: 4,
        wrongCount: 0,
        startedAt: NOW,
      },
      tasks,
      wordStates: [createWordState()],
    })
    const input = {
      sessionId: 'lesson-1',
      completedAt: NOW,
      skippablePrimaryTaskIds: ['task-5'],
      nextLessonNo: 2,
    }
    const [first, second] = await Promise.all([
      repository.completeLesson(input),
      repository.completeLesson(input),
    ])
    const restoredTasks = await repository.getLessonTasks('lesson-1')

    expect(first?.course.currentLessonNo).toBe(2)
    expect(second).toEqual(first)
    expect(restoredTasks[4]?.status).toBe('skipped')
    expect(
      database.prepare('SELECT current_lesson_no FROM courses WHERE id = ?').get('course-1'),
    ).toEqual({ current_lesson_no: 2 })

    database.close()
  })
})
