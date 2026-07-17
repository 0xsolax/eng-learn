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
  '../../migrations/0009_add_lesson_queue_policy_v2.sql',
  '../../migrations/0010_add_admin_sessions.sql',
  '../../migrations/0011_add_progressive_context_model.sql',
  '../../migrations/0012_add_exercise_review_feedback.sql',
  '../../migrations/0013_add_lesson_flow_policy_v2.sql',
]

type SqliteD1Statement = {
  bind(...values: unknown[]): SqliteD1Statement
  run(): Promise<{ success: true; meta: { changes: number } }>
  first(): Promise<unknown>
  all(): Promise<{ success: true; results: unknown[]; meta: Record<string, never> }>
  reserve(): void
  execute(): { success: true; results: unknown[]; meta: { changes: number } }
}

type D1QueryBudgetProbe = {
  queries: Array<{
    sqlBytes: number
    boundCount: number
    maxStringBytes: number
  }>
  batchSizes: number[]
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
    batchSizes: [],
    reset() {
      this.queries.length = 0
      this.batchSizes.length = 0
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
        if (/^\s*SELECT\b/i.test(sql)) {
          return {
            success: true,
            results: statement.all(...bindings),
            meta: { changes: 0 },
          }
        }

        const result = statement.run(...bindings)

        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes) },
        }
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
      budget.batchSizes.push(sqliteStatements.length)

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

const installLessonTaskWriteAudit = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE lesson_task_write_audit (
      operation TEXT NOT NULL
    );
    CREATE TRIGGER lesson_task_write_audit_insert
    AFTER INSERT ON lesson_tasks
    BEGIN
      INSERT INTO lesson_task_write_audit (operation) VALUES ('insert');
    END;
    CREATE TRIGGER lesson_task_write_audit_update
    AFTER UPDATE ON lesson_tasks
    BEGIN
      INSERT INTO lesson_task_write_audit (operation) VALUES ('update');
    END;
  `)
}

const readLessonTaskWriteCounts = (
  database: DatabaseSync,
): { inserts: number; updates: number } => {
  const rows = database
    .prepare(
      'SELECT operation, COUNT(*) AS count FROM lesson_task_write_audit GROUP BY operation',
    )
    .all() as Array<{ operation: string; count: number }>
  const counts = new Map(rows.map((row) => [row.operation, row.count]))

  return {
    inserts: counts.get('insert') ?? 0,
    updates: counts.get('update') ?? 0,
  }
}

const resetLessonTaskWriteAudit = (database: DatabaseSync): void => {
  database.prepare('DELETE FROM lesson_task_write_audit').run()
}

const seedAdditionalWords = (database: DatabaseSync, wordCount: number): void => {
  const insertWord = database.prepare(
    'INSERT INTO words (id, source_version_id, order_index, word, meaning, example_sentence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )

  for (let index = 2; index <= wordCount; index += 1) {
    insertWord.run(
      `word-${String(index)}`,
      'version-1',
      index,
      `word-${String(index)}`,
      `meaning-${String(index)}`,
      '',
      NOW,
    )
  }

  database
    .prepare('UPDATE word_groups SET end_order_index = ? WHERE id = ?')
    .run(wordCount, 'group-1')
}

const createD1RuntimeLessonFixture = async (
  refluxGaps: number[] = [5],
  queuePolicyVersion: 'v1_5_8_unbounded' | 'v2_3_6_cap3' = 'v1_5_8_unbounded',
) => {
  const fixture = await createRepositoryFixture()
  seedAdditionalWords(fixture.database, 5)
  const tasks = Array.from({ length: 5 }, (_, index) =>
    createTask(`task-runtime-${String(index + 1)}`, index + 1, {
      wordId: `word-${String(index + 1)}`,
    }),
  )
  const wordStates = Array.from({ length: 5 }, (_, index) =>
    createWordState({
      id: `state-${String(index + 1)}`,
      wordId: `word-${String(index + 1)}`,
    }),
  )

  await fixture.repository.createLesson({
    session: {
      id: 'lesson-1',
      courseId: 'course-1',
      lessonNo: 1,
      status: 'started',
      taskCount: tasks.length,
      completedTaskCount: 0,
      correctCount: 0,
      wrongCount: 0,
      queuePolicyVersion,
      startedAt: NOW,
    },
    tasks,
    wordStates,
  })
  const gaps = [...refluxGaps]
  const runtime = createCourseRuntime({
    contentRepository: createD1ContentRepository(fixture.db),
    courseRepository: fixture.repository,
    now: () => new Date(NOW),
    selectRefluxGap: () => gaps.shift() ?? 5,
    queueWriteMode:
      queuePolicyVersion === 'v2_3_6_cap3' ? 'v2' : 'legacy_v1',
    flowWriteMode: 'legacy_v1',
  })

  fixture.budget.reset()
  return { ...fixture, runtime, tasks }
}

describe('D1 course queue repository', () => {
  it('persists one rolling S1 reinforcement through split update and insert writes', async () => {
    const { database, db, repository, budget } = await createRepositoryFixture()
    database.exec(`
      INSERT INTO word_sources (id, name, created_at)
      VALUES ('source-flow', 'Rolling source', '${NOW}');
      INSERT INTO source_versions (
        id, source_id, version_no, content_model, status, created_at, published_at
      ) VALUES (
        'version-flow', 'source-flow', 1, 'v2_progressive_context',
        'published', '${NOW}', '${NOW}'
      );
      INSERT INTO word_groups (
        id, source_version_id, group_index, start_order_index, end_order_index, created_at
      ) VALUES ('group-flow', 'version-flow', 1, 1, 5, '${NOW}');
      UPDATE courses SET source_version_id = 'version-flow' WHERE id = 'course-1';
    `)
    const insertWord = database.prepare(`
      INSERT INTO words (
        id, source_version_id, order_index, word, meaning, example_phrase,
        example_sentence, example_sentence_extended, created_at
      ) VALUES (?, 'version-flow', ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertItem = database.prepare(`
      INSERT INTO exercise_items (
        id, source_version_id, word_id, stage, task_type,
        prompt_json, answer_json, status, created_at
      ) VALUES (?, 'version-flow', ?, ?, ?, ?, ?, 'approved', ?)
    `)

    for (let index = 1; index <= 5; index += 1) {
      const wordId = `flow-word-${String(index)}`
      const word = `flowword${String(index)}`
      insertWord.run(
        wordId,
        index,
        word,
        `meaning-${String(index)}`,
        word,
        `I use ${word} here.`,
        `I can use ${word} here every day.`,
        NOW,
      )
      insertItem.run(
        `flow-s0-${String(index)}`,
        wordId,
        'S0',
        'recognize_meaning',
        JSON.stringify({
          word,
          meaning: `meaning-${String(index)}`,
          exampleSentence: `I use ${word} here.`,
        }),
        JSON.stringify({ word, expectedResponse: 'known' }),
        NOW,
      )
      insertItem.run(
        `flow-s1-${String(index)}`,
        wordId,
        'S1',
        'multiple_choice',
        JSON.stringify({
          meaning: `meaning-${String(index)}`,
          options: [word, `distractor-a-${String(index)}`, `distractor-b-${String(index)}`],
        }),
        JSON.stringify({ word }),
        NOW,
      )
    }

    const runtime = createCourseRuntime({
      contentRepository: createD1ContentRepository(db),
      courseRepository: repository,
      now: () => new Date(NOW),
      queueWriteMode: 'v2',
      flowWriteMode: 'rolling_v2',
    })
    budget.reset()
    const lesson = await runtime.startLesson('course-1')

    for (const task of lesson.tasks.slice(0, 2)) {
      budget.reset()
      await runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }

    const thirdTask = lesson.tasks[2]

    if (!thirdTask) throw new Error('Expected the third rolling task')

    budget.reset()
    const [winner, retry] = await Promise.all([
      runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: thirdTask.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      }),
      runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: thirdTask.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      }),
    ])

    expect(retry.reviewLog.id).toBe(winner.reviewLog.id)

    budget.reset()
    const snapshot = await repository.getLessonQueueSnapshot({
      sessionId: lesson.session.id,
      courseId: 'course-1',
    })
    const reinforcement = snapshot?.tasks.find(
      (task) => task.reinforcementSourceTaskId === lesson.tasks[0]?.id,
    )

    expect(snapshot?.session.flowPolicyVersion).toBe(
      'v2_rolling_reinforcement_budget24',
    )
    expect(snapshot?.tasks).toHaveLength(6)
    expect(reinforcement).toMatchObject({
      stage: 'S1',
      taskType: 'multiple_choice',
      role: 'bridge',
      required: true,
      orderIndex: 4,
    })
    expect(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM lesson_tasks
        WHERE reinforcement_source_task_id IS NOT NULL
      `).get(),
    ).toEqual({ count: 1 })

    database.close()
  })

  it('persists a v2 session policy and restores it in the authoritative queue snapshot', async () => {
    const { database, budget, repository } = await createRepositoryFixture()
    const task = createTask('task-policy-v2', 1)

    await repository.createLesson({
      session: {
        id: 'lesson-policy-v2',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        queuePolicyVersion: 'v2_3_6_cap3',
        startedAt: NOW,
      },
      tasks: [{ ...task, sessionId: 'lesson-policy-v2' }],
      wordStates: [createWordState()],
    })

    await expect(repository.getLessonSession('lesson-policy-v2')).resolves.toMatchObject({
      queuePolicyVersion: 'v2_3_6_cap3',
    })
    budget.reset()
    await expect(
      repository.getLessonQueueSnapshot({
        sessionId: 'lesson-policy-v2',
        courseId: 'course-1',
      }),
    ).resolves.toMatchObject({
      session: { queuePolicyVersion: 'v2_3_6_cap3' },
      tasks: [{ id: 'task-policy-v2' }],
      reviewLogs: [],
    })
    expect(budget.batchSizes).toEqual([3])
    expectD1FreeInvocation(budget, 3)

    database.close()
  })

  it('commits and restores the winning v2 queue disposition with its answer', async () => {
    const { database, repository } = await createRepositoryFixture()
    const pendingTask = createTask('task-v2-disposition', 1, {
      sessionId: 'lesson-v2-disposition',
    })
    await repository.createLesson({
      session: {
        id: 'lesson-v2-disposition',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        queuePolicyVersion: 'v2_3_6_cap3',
        startedAt: NOW,
      },
      tasks: [pendingTask],
      wordStates: [createWordState()],
    })
    const completedTask = { ...pendingTask, status: 'completed' as const }
    const input = {
      task: completedTask,
      wordState: createWordState({
        totalAttemptCount: 1,
        totalWrongCount: 1,
        wrongStreak: 1,
        lastSeenLessonNo: 1,
        nextDueLessonNo: 2,
        status: 'learning',
      }),
      reviewLog: {
        id: 'review-v2-disposition',
        sessionId: 'lesson-v2-disposition',
        taskId: pendingTask.id,
        courseId: 'course-1',
        wordId: 'word-1',
        stage: 'S0' as const,
        taskType: 'recognize_meaning',
        userAnswer: JSON.stringify({ taskType: 'recognize_meaning', response: 'learning' }),
        correctAnswer: 'known',
        score: 0 as const,
        lessonNo: 1,
        createdAt: NOW,
        queueDisposition: 'deferred_cap' as const,
      },
      taskMutations: [completedTask],
      reorderedExistingTaskIds: [],
      taskCount: 1,
      completedTaskCount: 1,
      persistWordState: true,
      expectedQueuePolicyVersion: 'v2_3_6_cap3' as const,
    }

    await expect(repository.recordAnswer(input)).resolves.toMatchObject({
      queueDisposition: 'deferred_cap',
      submittedAnswer: {
        reviewLog: { id: 'review-v2-disposition', score: 0 },
      },
    })
    await expect(
      repository.getSubmittedAnswer('lesson-v2-disposition', pendingTask.id),
    ).resolves.toMatchObject({
      queueDisposition: 'deferred_cap',
      submittedAnswer: {
        reviewLog: { id: 'review-v2-disposition', score: 0 },
      },
    })
    await expect(
      repository.getLessonQueueSnapshot({
        sessionId: 'lesson-v2-disposition',
        courseId: 'course-1',
      }),
    ).resolves.toMatchObject({
      reviewLogs: [
        { id: 'review-v2-disposition', queueDisposition: 'deferred_cap' },
      ],
    })

    database.close()
  })

  it('writes nothing when the answer policy does not match the persisted session policy', async () => {
    const { database, repository } = await createRepositoryFixture()
    const pendingTask = createTask('task-policy-mismatch', 1, {
      sessionId: 'lesson-policy-mismatch',
    })
    await repository.createLesson({
      session: {
        id: 'lesson-policy-mismatch',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        queuePolicyVersion: 'v2_3_6_cap3',
        startedAt: NOW,
      },
      tasks: [pendingTask],
      wordStates: [createWordState()],
    })

    await expect(
      repository.recordAnswer({
        task: { ...pendingTask, status: 'completed' },
        wordState: createWordState({ totalAttemptCount: 1, totalWrongCount: 1 }),
        reviewLog: {
          id: 'review-policy-mismatch',
          sessionId: 'lesson-policy-mismatch',
          taskId: pendingTask.id,
          courseId: 'course-1',
          wordId: 'word-1',
          stage: 'S0',
          taskType: 'recognize_meaning',
          correctAnswer: 'known',
          score: 0,
          queueDisposition: 'deferred_cap',
          lessonNo: 1,
          createdAt: NOW,
        },
        taskMutations: [{ ...pendingTask, status: 'completed' }],
        reorderedExistingTaskIds: [],
        taskCount: 1,
        completedTaskCount: 1,
        persistWordState: true,
        expectedQueuePolicyVersion: 'v1_5_8_unbounded',
      }),
    ).rejects.toThrow()

    expect(database.prepare('SELECT COUNT(*) AS count FROM review_logs').get()).toEqual({
      count: 0,
    })
    expect(
      database
        .prepare('SELECT status FROM lesson_tasks WHERE id = ?')
        .get(pendingTask.id),
    ).toEqual({ status: 'pending' })
    expect(
      database
        .prepare(`
          SELECT completed_task_count AS completedTaskCount,
            correct_count AS correctCount,
            wrong_count AS wrongCount
          FROM lesson_sessions
          WHERE id = 'lesson-policy-mismatch'
        `)
        .get(),
    ).toEqual({ completedTaskCount: 0, correctCount: 0, wrongCount: 0 })

    database.close()
  })

  it('writes nothing when the proposed winner is not the first pending task', async () => {
    const { database, repository } = await createRepositoryFixture()
    const firstTask = createTask('task-current-first', 1, {
      sessionId: 'lesson-current-guard',
    })
    const laterTask = createTask('task-current-later', 2, {
      sessionId: 'lesson-current-guard',
    })
    await repository.createLesson({
      session: {
        id: 'lesson-current-guard',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 2,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        queuePolicyVersion: 'v1_5_8_unbounded',
        startedAt: NOW,
      },
      tasks: [firstTask, laterTask],
      wordStates: [createWordState()],
    })

    await expect(
      repository.recordAnswer({
        task: { ...laterTask, status: 'completed' },
        wordState: createWordState({ totalAttemptCount: 1, totalCorrectCount: 1 }),
        reviewLog: {
          id: 'review-current-later',
          sessionId: 'lesson-current-guard',
          taskId: laterTask.id,
          courseId: 'course-1',
          wordId: 'word-1',
          stage: 'S0',
          taskType: 'recognize_meaning',
          correctAnswer: 'known',
          score: 2,
          lessonNo: 1,
          createdAt: NOW,
        },
        taskMutations: [{ ...laterTask, status: 'completed' }],
        reorderedExistingTaskIds: [],
        taskCount: 2,
        completedTaskCount: 1,
        persistWordState: true,
        expectedQueuePolicyVersion: 'v1_5_8_unbounded',
      }),
    ).rejects.toThrow()

    expect(database.prepare('SELECT COUNT(*) AS count FROM review_logs').get()).toEqual({
      count: 0,
    })
    expect(
      database
        .prepare(`
          SELECT id, status
          FROM lesson_tasks
          WHERE session_id = 'lesson-current-guard'
          ORDER BY order_index
        `)
        .all(),
    ).toEqual([
      { id: firstTask.id, status: 'pending' },
      { id: laterTask.id, status: 'pending' },
    ])

    database.close()
  })

  it('returns one persisted disposition when concurrent v2 answers propose different outcomes', async () => {
    const { database, repository } = await createRepositoryFixture()
    const sourceTask = createTask('task-v2-race', 1, { sessionId: 'lesson-v2-race' })
    await repository.createLesson({
      session: {
        id: 'lesson-v2-race',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        queuePolicyVersion: 'v2_3_6_cap3',
        startedAt: NOW,
      },
      tasks: [sourceTask],
      wordStates: [createWordState()],
    })
    const completedTask = { ...sourceTask, status: 'completed' as const }
    const wordState = createWordState({
      totalAttemptCount: 1,
      totalWrongCount: 1,
      wrongStreak: 1,
      lastSeenLessonNo: 1,
      nextDueLessonNo: 2,
      status: 'learning',
    })
    const deferredInput = {
      task: completedTask,
      wordState,
      reviewLog: {
        id: 'review-v2-race-deferred',
        sessionId: 'lesson-v2-race',
        taskId: sourceTask.id,
        courseId: 'course-1',
        wordId: 'word-1',
        stage: 'S0' as const,
        taskType: 'recognize_meaning',
        correctAnswer: 'known',
        score: 0 as const,
        queueDisposition: 'deferred_cap' as const,
        lessonNo: 1,
        createdAt: NOW,
      },
      taskMutations: [completedTask],
      reorderedExistingTaskIds: [],
      taskCount: 1,
      completedTaskCount: 1,
      persistWordState: true,
      expectedQueuePolicyVersion: 'v2_3_6_cap3' as const,
    }
    const refluxTask = createTask('task-v2-race-reflux', 2, {
      sessionId: 'lesson-v2-race',
      role: 'reflux',
      required: true,
      refluxSourceTaskId: sourceTask.id,
    })
    const scheduledInput = {
      ...deferredInput,
      reviewLog: {
        ...deferredInput.reviewLog,
        id: 'review-v2-race-scheduled',
        queueDisposition: 'scheduled' as const,
      },
      taskMutations: [completedTask, refluxTask],
      taskCount: 2,
    }

    const [first, second] = await Promise.all([
      repository.recordAnswer(deferredInput),
      repository.recordAnswer(scheduledInput),
    ])
    const tasks = await repository.getLessonTasks('lesson-v2-race')
    const snapshot = await repository.getLessonQueueSnapshot({
      sessionId: 'lesson-v2-race',
      courseId: 'course-1',
    })

    expect(second).toEqual(first)
    expect(snapshot?.reviewLogs).toHaveLength(1)
    expect(snapshot?.reviewLogs[0]?.queueDisposition).toBe(first.queueDisposition)
    expect(tasks.filter((task) => task.role === 'reflux')).toHaveLength(
      first.queueDisposition === 'scheduled' ? 1 : 0,
    )
    expect(database.prepare('SELECT COUNT(*) AS count FROM review_logs').get()).toEqual({
      count: 1,
    })

    database.close()
  })

  it('rolls back the v2 disposition, child task, state, and counters as one batch', async () => {
    const { database, budget, repository } = await createRepositoryFixture()
    const sourceTask = createTask('task-v2-rollback', 1, {
      sessionId: 'lesson-v2-rollback',
    })
    await repository.createLesson({
      session: {
        id: 'lesson-v2-rollback',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        queuePolicyVersion: 'v2_3_6_cap3',
        startedAt: NOW,
      },
      tasks: [sourceTask],
      wordStates: [createWordState()],
    })
    const completedTask = { ...sourceTask, status: 'completed' as const }
    const refluxTask = createTask('task-v2-rollback-reflux', 2, {
      sessionId: 'lesson-v2-rollback',
      role: 'reflux',
      required: true,
      refluxSourceTaskId: sourceTask.id,
    })
    budget.failNextBatchAt(2)

    await expect(
      repository.recordAnswer({
        task: completedTask,
        wordState: createWordState({
          totalAttemptCount: 1,
          totalWrongCount: 1,
          wrongStreak: 1,
          lastSeenLessonNo: 1,
          nextDueLessonNo: 2,
          status: 'learning',
        }),
        reviewLog: {
          id: 'review-v2-rollback',
          sessionId: 'lesson-v2-rollback',
          taskId: sourceTask.id,
          courseId: 'course-1',
          wordId: 'word-1',
          stage: 'S0',
          taskType: 'recognize_meaning',
          correctAnswer: 'known',
          score: 0,
          queueDisposition: 'scheduled',
          lessonNo: 1,
          createdAt: NOW,
        },
        taskMutations: [completedTask, refluxTask],
        reorderedExistingTaskIds: [],
        taskCount: 2,
        completedTaskCount: 1,
        persistWordState: true,
        expectedQueuePolicyVersion: 'v2_3_6_cap3',
      }),
    ).rejects.toThrow('Injected D1 batch failure')

    expect(database.prepare('SELECT COUNT(*) AS count FROM review_logs').get()).toEqual({
      count: 0,
    })
    expect(
      database
        .prepare('SELECT id, status FROM lesson_tasks WHERE session_id = ? ORDER BY order_index')
        .all('lesson-v2-rollback'),
    ).toEqual([{ id: sourceTask.id, status: 'pending' }])
    expect(
      database
        .prepare(`
          SELECT total_attempt_count AS totalAttemptCount,
            total_wrong_count AS totalWrongCount
          FROM user_word_states
          WHERE id = 'state-1'
        `)
        .get(),
    ).toEqual({ totalAttemptCount: 0, totalWrongCount: 0 })
    expect(
      database
        .prepare(`
          SELECT task_count AS taskCount,
            completed_task_count AS completedTaskCount,
            wrong_count AS wrongCount
          FROM lesson_sessions
          WHERE id = 'lesson-v2-rollback'
        `)
        .get(),
    ).toEqual({ taskCount: 1, completedTaskCount: 0, wrongCount: 0 })

    database.close()
  })

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
        queuePolicyVersion: 'v1_5_8_unbounded',
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
            queuePolicyVersion: 'v1_5_8_unbounded',
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
          queuePolicyVersion: 'v1_5_8_unbounded',
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
        queuePolicyVersion: 'v1_5_8_unbounded',
        startedAt: NOW,
      },
      tasks,
      wordStates: [createWordState()],
    })
    const completedTask = createTask(tasks[0]?.id ?? '', 1, { status: 'completed' })
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
      taskMutations: [completedTask],
      reorderedExistingTaskIds: [],
      taskCount: tasks.length,
      completedTaskCount: 1,
      persistWordState: true,
      expectedQueuePolicyVersion: 'v1_5_8_unbounded' as const,
    }

    installLessonTaskWriteAudit(database)

    budget.reset()
    const first = await repository.recordAnswer(input)

    expect(first.submittedAnswer.reviewLog.id).toBe('review-budget-500')
    expect(readLessonTaskWriteCounts(database)).toEqual({ inserts: 0, updates: 1 })
    expectD1FreeInvocation(budget, 7)

    budget.reset()
    const retry = await repository.recordAnswer(input)

    expect(retry).toEqual(first)
    expectD1FreeInvocation(budget, 3)
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM review_logs').get(),
    ).toEqual({ count: 1 })

    database.close()
  })

  it('bulk-updates a reordered 65-task legacy flow within the D1 query budget', async () => {
    const { database, db, budget, repository } = await createRepositoryFixture()
    seedAdditionalWords(database, 65)
    const tasks = Array.from({ length: 65 }, (_, index) =>
      createTask(`task-reorder-${String(index + 1)}`, index + 1, {
        wordId: `word-${String(index + 1)}`,
      }),
    )
    const wordStates = Array.from({ length: 65 }, (_, index) =>
      createWordState({
        id: `state-reorder-${String(index + 1)}`,
        wordId: `word-${String(index + 1)}`,
      }),
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
        queuePolicyVersion: 'v2_3_6_cap3',
        startedAt: NOW,
      },
      tasks,
      wordStates,
    })
    const runtime = createCourseRuntime({
      contentRepository: createD1ContentRepository(db),
      courseRepository: repository,
      now: () => new Date(NOW),
      selectRefluxGap: () => 5,
      queueWriteMode: 'v2',
      flowWriteMode: 'legacy_v1',
    })

    budget.reset()
    await runtime.submitAnswer({
      sessionId: 'lesson-1',
      taskId: 'task-reorder-1',
      submission: { taskType: 'recognize_meaning', response: 'learning' },
    })
    expectD1FreeInvocation(budget)

    budget.reset()
    const snapshot = await repository.getLessonQueueSnapshot({
      sessionId: 'lesson-1',
      courseId: 'course-1',
    })

    expect(snapshot?.tasks).toHaveLength(66)
    const reflux = snapshot?.tasks.find(
      (task) => task.refluxSourceTaskId === 'task-reorder-1',
    )

    expect(reflux).toMatchObject({ role: 'reflux' })
    expect((reflux?.orderIndex ?? 0) - 2).toBeGreaterThanOrEqual(3)
    expect((reflux?.orderIndex ?? 0) - 2).toBeLessThanOrEqual(6)

    database.close()
  })

  it('writes only the current task and newly scheduled rows for an early wrong answer', async () => {
    const { database, runtime, tasks } = await createD1RuntimeLessonFixture([5])
    const source = tasks[0]

    if (!source) throw new Error('Expected the first runtime task')
    installLessonTaskWriteAudit(database)

    await runtime.submitAnswer({
      sessionId: 'lesson-1',
      taskId: source.id,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
    })

    const restored = await runtime.getLesson('lesson-1')
    expect(readLessonTaskWriteCounts(database)).toEqual({ inserts: 2, updates: 1 })
    expect(restored.tasks.slice(0, 5).map((task) => task.id)).toEqual(
      tasks.map((task) => task.id),
    )
    expect(
      restored.tasks
        .filter((task) => task.role === 'bridge')
        .every((task) => task.wordId !== source.wordId),
    ).toBe(true)

    database.close()
  })

  it('restores v2 wrong-answer dispositions after a runtime restart and completes at the five-word cap', async () => {
    const { database, db, budget, repository, runtime, tasks } =
      await createD1RuntimeLessonFixture([], 'v2_3_6_cap3')
    const firstTask = tasks[0]

    if (!firstTask) throw new Error('Expected the first v2 runtime task')

    budget.reset()
    await runtime.submitAnswer({
      sessionId: 'lesson-1',
      taskId: firstTask.id,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
    })

    budget.reset()
    const beforeRestart = await repository.getLessonQueueSnapshot({
      sessionId: 'lesson-1',
      courseId: 'course-1',
    })
    const resumedRepository = createD1CourseRepository(db)
    const resumedRuntime = createCourseRuntime({
      contentRepository: createD1ContentRepository(db),
      courseRepository: resumedRepository,
      now: () => new Date(NOW),
      queueWriteMode: 'v2',
    })
    budget.reset()
    const afterRestart = await resumedRepository.getLessonQueueSnapshot({
      sessionId: 'lesson-1',
      courseId: 'course-1',
    })
    budget.reset()
    const resumedLesson = await resumedRuntime.getLesson('lesson-1')

    expect(afterRestart).toEqual(beforeRestart)
    expect(afterRestart?.reviewLogs).toEqual([
      expect.objectContaining({
        taskId: firstTask.id,
        queueDisposition: 'scheduled',
      }),
    ])
    expect(
      resumedLesson.tasks.map((task) => ({
        id: task.id,
        orderIndex: task.orderIndex,
        status: task.status,
        role: task.role,
        refluxSourceTaskId: task.refluxSourceTaskId,
      })),
    ).toEqual(
      afterRestart?.tasks.map((task) => ({
        id: task.id,
        orderIndex: task.orderIndex,
        status: task.status,
        role: task.role,
        refluxSourceTaskId: task.refluxSourceTaskId,
      })),
    )

    let answeredCount = 1

    for (;;) {
      budget.reset()
      const current = (await resumedRuntime.getLesson('lesson-1')).tasks.find(
        (task) => task.status === 'pending',
      )

      if (!current) break
      if (answeredCount >= 15) {
        throw new Error('Restarted v2 D1 runtime exceeded the fifteen-task bound')
      }

      budget.reset()
      await resumedRuntime.submitAnswer({
        sessionId: 'lesson-1',
        taskId: current.id,
        submission: { taskType: 'recognize_meaning', response: 'learning' },
      })
      answeredCount += 1
    }

    budget.reset()
    const completedSnapshot = await resumedRepository.getLessonQueueSnapshot({
      sessionId: 'lesson-1',
      courseId: 'course-1',
    })

    expect(answeredCount).toBe(15)
    expect(completedSnapshot?.tasks).toHaveLength(15)
    expect(
      Array.from(
        (completedSnapshot?.tasks ?? []).reduce<Map<string, number>>(
          (counts, task) =>
            counts.set(task.wordId, (counts.get(task.wordId) ?? 0) + 1),
          new Map(),
        ).values(),
      ).sort((left, right) => left - right),
    ).toEqual([3, 3, 3, 3, 3])
    expect(
      completedSnapshot?.reviewLogs.filter(
        (log) => log.queueDisposition === 'scheduled',
      ),
    ).toHaveLength(10)
    expect(
      completedSnapshot?.reviewLogs.filter(
        (log) => log.queueDisposition === 'deferred_cap',
      ),
    ).toHaveLength(5)
    expect(
      completedSnapshot?.reviewLogs.filter(
        (log) => log.queueDisposition === 'deferred_capacity',
      ),
    ).toHaveLength(0)
    budget.reset()
    await expect(resumedRuntime.completeLesson('lesson-1')).resolves.toMatchObject({
      session: { status: 'completed', taskCount: 15, completedTaskCount: 15 },
      course: { currentLessonNo: 2 },
    })

    database.close()
  })

  it('temporarily reorders only existing task ids whose order actually changes', async () => {
    const { database, runtime, tasks } = await createD1RuntimeLessonFixture([8, 5])
    const first = tasks[0]
    const second = tasks[1]

    if (!first || !second) throw new Error('Expected two runtime tasks')
    installLessonTaskWriteAudit(database)
    await runtime.submitAnswer({
      sessionId: 'lesson-1',
      taskId: first.id,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
    })
    resetLessonTaskWriteAudit(database)

    await runtime.submitAnswer({
      sessionId: 'lesson-1',
      taskId: second.id,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
    })

    expect(readLessonTaskWriteCounts(database)).toEqual({ inserts: 1, updates: 5 })

    database.close()
  })

  it('keeps multi-round reflux task writes constant as the queue grows', async () => {
    const { database, budget, runtime, tasks } = await createD1RuntimeLessonFixture([5, 5, 5])

    for (const task of tasks.slice(0, 4)) {
      budget.reset()
      await runtime.submitAnswer({
        sessionId: 'lesson-1',
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }

    installLessonTaskWriteAudit(database)
    let source = tasks[4]
    const wrongWriteCounts: Array<{ inserts: number; updates: number }> = []

    if (!source) throw new Error('Expected the last runtime task')

    for (let round = 0; round < 3; round += 1) {
      resetLessonTaskWriteAudit(database)
      budget.reset()
      await runtime.submitAnswer({
        sessionId: 'lesson-1',
        taskId: source.id,
        submission: { taskType: 'recognize_meaning', response: 'learning' },
      })
      wrongWriteCounts.push(readLessonTaskWriteCounts(database))

      if (round === 2) break

      budget.reset()
      let current = (await runtime.getLesson('lesson-1')).tasks.find(
        (task) => task.status === 'pending',
      )
      while (current?.role === 'bridge') {
        resetLessonTaskWriteAudit(database)
        budget.reset()
        await runtime.submitAnswer({
          sessionId: 'lesson-1',
          taskId: current.id,
          submission: { taskType: 'recognize_meaning', response: 'known' },
        })
        expect(readLessonTaskWriteCounts(database)).toEqual({ inserts: 0, updates: 1 })
        budget.reset()
        current = (await runtime.getLesson('lesson-1')).tasks.find(
          (task) => task.status === 'pending',
        )
      }

      if (!current || current.role !== 'reflux') {
        throw new Error('Expected the next reflux task')
      }
      source = current
    }

    expect(wrongWriteCounts).toEqual([
      { inserts: 6, updates: 1 },
      { inserts: 6, updates: 1 },
      { inserts: 6, updates: 1 },
    ])
    budget.reset()
    await expect(runtime.getLesson('lesson-1')).resolves.toMatchObject({
      session: { taskCount: 23 },
    })

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
        queuePolicyVersion: 'v1_5_8_unbounded',
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
      queuePolicyVersion: 'v1_5_8_unbounded',
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
    budget.failNextBatchAt(3)
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
        taskMutations: [completedTask],
        reorderedExistingTaskIds: [],
        taskCount: 1,
        completedTaskCount: 1,
        persistWordState: true,
        expectedQueuePolicyVersion: 'v1_5_8_unbounded',
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
    expectD1FreeInvocation(budget, 6)

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
        queuePolicyVersion: 'v1_5_8_unbounded',
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
        queuePolicyVersion: 'v1_5_8_unbounded',
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
        queuePolicyVersion: 'v1_5_8_unbounded',
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
      taskMutations: [completedTask],
      reorderedExistingTaskIds: [],
      taskCount: 1,
      completedTaskCount: 1,
      persistWordState: true,
      expectedQueuePolicyVersion: 'v1_5_8_unbounded' as const,
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
      flowWriteMode: 'legacy_v1',
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
        queuePolicyVersion: 'v1_5_8_unbounded',
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

    installLessonTaskWriteAudit(database)
    const first = await repository.saveSentenceOutputPreview(input)
    expect(readLessonTaskWriteCounts(database)).toEqual({ inserts: 0, updates: 1 })
    const retry = await repository.saveSentenceOutputPreview(input)
    const restored = await repository.getLessonTask('lesson-1', task.id)

    expect(retry).toEqual(first)
    expect(readLessonTaskWriteCounts(database)).toEqual({ inserts: 0, updates: 1 })
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
          queuePolicyVersion: 'v1_5_8_unbounded',
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
          queuePolicyVersion: 'v1_5_8_unbounded',
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
          queuePolicyVersion: 'v1_5_8_unbounded',
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
        queueWriteMode: 'legacy_v1',
        flowWriteMode: 'legacy_v1',
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
          queuePolicyVersion: 'v1_5_8_unbounded',
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
          taskMutations: [completedTask],
          reorderedExistingTaskIds: [],
          taskCount: 1,
          completedTaskCount: 1,
          persistWordState: true,
          expectedQueuePolicyVersion: 'v1_5_8_unbounded',
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
          queuePolicyVersion: 'v1_5_8_unbounded',
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
          taskMutations: [completedTask],
          reorderedExistingTaskIds: [],
          taskCount: 1,
          completedTaskCount: 1,
          persistWordState: true,
          expectedQueuePolicyVersion: 'v1_5_8_unbounded',
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
          queuePolicyVersion: 'v1_5_8_unbounded',
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
        queueWriteMode: 'legacy_v1',
        flowWriteMode: 'legacy_v1',
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
        queuePolicyVersion: 'v1_5_8_unbounded',
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
      taskMutations: [completedPrimary, bridge, reflux],
      newTaskIds: [bridge.id, reflux.id],
      reorderedExistingTaskIds: [],
      taskCount: 3,
      completedTaskCount: 1,
      persistWordState: true,
      expectedQueuePolicyVersion: 'v1_5_8_unbounded' as const,
      expectedFlowPolicyVersion: 'v1_due_then_new_unbounded' as const,
    }
    const concurrentLoserInput = {
      ...input,
      reviewLog: { ...input.reviewLog, id: 'review-concurrent-loser' },
    }

    installLessonTaskWriteAudit(database)

    const [first, retry] = await Promise.all([
      repository.recordAnswer(input),
      repository.recordAnswer(concurrentLoserInput),
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
    expect(readLessonTaskWriteCounts(database)).toEqual({ inserts: 2, updates: 1 })
    await expect(repository.recordAnswer(input)).resolves.toEqual(first)
    expect(readLessonTaskWriteCounts(database)).toEqual({ inserts: 2, updates: 1 })
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
          queuePolicyVersion: 'v1_5_8_unbounded',
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
          queuePolicyVersion: 'v1_5_8_unbounded',
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
        queuePolicyVersion: 'v1_5_8_unbounded',
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
