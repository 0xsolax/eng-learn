import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { editExerciseItemRequestSchema } from '../../shared/api/contentSchemas'
import {
  exerciseItemContentSchema,
  lessonTaskSchema,
} from '../../shared/api/taskSchemas'
import { createD1ContentRepository } from '../../server/repositories/d1ContentRepository'
import { createD1CourseRepository } from '../../server/repositories/d1CourseRepository'
import { createD1SessionRepository } from '../../server/repositories/d1SessionRepository'
import { createWorkerApp, type WorkerApp } from '../../server/app'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseQueryService } from '../../server/services/CourseQueryService'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import { createLearnerSessionService } from '../../server/services/LearnerSessionService'

const NOW = '2026-07-13T00:00:00.000Z'
const ORIGIN = 'https://eng-learn.test'
const SESSION_TOKEN = 'a'.repeat(64)
const legacyMigrationPaths = [
  '../../migrations/0001_initial.sql',
  '../../migrations/0002_add_review_task_integrity.sql',
]
const currentMigrationPaths = [
  '../../migrations/0003_add_learner_sessions.sql',
  '../../migrations/0004_harden_learner_sessions.sql',
  '../../migrations/0005_content_version_cas.sql',
  '../../migrations/0006_add_lesson_task_queue.sql',
  '../../migrations/0007_backfill_legacy_lesson_runtime.sql',
  '../../migrations/0008_add_admin_operation_ledger.sql',
  '../../migrations/0009_add_lesson_queue_policy_v2.sql',
  '../../migrations/0011_add_progressive_context_model.sql',
  '../../migrations/0012_add_exercise_review_feedback.sql',
  '../../migrations/0013_add_lesson_flow_policy_v2.sql',
]

type SqliteD1Statement = {
  bind(...values: unknown[]): SqliteD1Statement
  run(): Promise<{ success: true; meta: { changes: number } }>
  first(): Promise<unknown>
  all(): Promise<{ success: true; results: unknown[]; meta: Record<string, never> }>
  execute(): { success: true; meta: { changes: number } }
}

const createSqliteD1 = (database: DatabaseSync): D1Database => {
  const prepare = (sql: string): SqliteD1Statement => {
    let bindings: SQLInputValue[] = []
    const statement = database.prepare(sql)
    const adapter: SqliteD1Statement = {
      bind(...values) {
        bindings = values as SQLInputValue[]
        return adapter
      },
      run() {
        return Promise.resolve(adapter.execute())
      },
      first() {
        return Promise.resolve(statement.get(...bindings) ?? null)
      },
      all() {
        return Promise.resolve({
          success: true,
          results: statement.all(...bindings),
          meta: {},
        })
      },
      execute() {
        const result = statement.run(...bindings)

        return { success: true, meta: { changes: Number(result.changes) } }
      },
    }

    return adapter
  }

  return {
    prepare(sql: string) {
      return prepare(sql) as unknown as D1PreparedStatement
    },
    batch(statements: D1PreparedStatement[]) {
      const sqliteStatements = statements as unknown as SqliteD1Statement[]

      database.exec('BEGIN IMMEDIATE')

      try {
        const results = sqliteStatements.map((statement) => statement.execute())
        database.exec('COMMIT')

        return Promise.resolve(results as unknown as D1Result[])
      } catch (error) {
        database.exec('ROLLBACK')

        return Promise.reject(error instanceof Error ? error : new Error('SQLite D1 batch failed'))
      }
    },
  } as unknown as D1Database
}

type VersionStatus = 'draft' | 'published'

const createLegacyDatabase = (status: VersionStatus): DatabaseSync => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')

  for (const migrationPath of legacyMigrationPaths) {
    database.exec(readFileSync(new URL(migrationPath, import.meta.url), 'utf8'))
  }

  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-legacy', 'Legacy source', '${NOW}');
    INSERT INTO source_versions (
      id, source_id, version_no, status, created_at, published_at
    ) VALUES (
      'version-legacy', 'source-legacy', 1, '${status}', '${NOW}',
      ${status === 'published' ? `'${NOW}'` : 'NULL'}
    );
    INSERT INTO words (
      id, source_version_id, order_index, word, meaning, example_sentence, created_at
    ) VALUES (
      'word-legacy', 'version-legacy', 1, 'apple', '苹果',
      'I ate an apple.', '${NOW}'
    );
    INSERT INTO word_groups (
      id, source_version_id, group_index, start_order_index, end_order_index, created_at
    ) VALUES ('group-legacy', 'version-legacy', 1, 1, 1, '${NOW}');
  `)

  insertLegacyExerciseItems(database, status === 'draft' ? 'draft' : 'approved')

  return database
}

const legacyContents = [
  {
    id: 'legacy-s0',
    stage: 'S0',
    taskType: 'recognize_meaning',
    prompt: { word: 'apple', meaning: '苹果', exampleSentence: 'I ate an apple.' },
  },
  {
    id: 'legacy-s1',
    stage: 'S1',
    taskType: 'recall_word',
    prompt: { meaning: '苹果' },
  },
  {
    id: 'legacy-s2',
    stage: 'S2',
    taskType: 'multiple_choice',
    prompt: { meaning: '苹果', options: ['apple', 'apple-option-a', 'apple-option-b'] },
  },
  {
    id: 'legacy-s3',
    stage: 'S3',
    taskType: 'fill_blank',
    prompt: { sentence: 'I ate an ____.' },
  },
  {
    id: 'legacy-s4',
    stage: 'S4',
    taskType: 'sentence_build',
    prompt: { pieces: ['I', 'ate', 'an', 'apple.'] },
  },
  {
    id: 'legacy-s5',
    stage: 'S5',
    taskType: 'sentence_output',
    prompt: { meaning: '苹果' },
  },
] as const

const insertLegacyExerciseItems = (
  database: DatabaseSync,
  status: 'draft' | 'approved',
): void => {
  const insert = database.prepare(`
    INSERT INTO exercise_items (
      id, source_version_id, word_id, stage, task_type,
      prompt_json, answer_json, status, created_at
    ) VALUES (?, 'version-legacy', 'word-legacy', ?, ?, ?, ?, ?, ?)
  `)

  for (const content of legacyContents) {
    insert.run(
      content.id,
      content.stage,
      content.taskType,
      JSON.stringify(content.prompt),
      JSON.stringify({ word: 'apple', meaning: '苹果' }),
      status,
      NOW,
    )
  }
}

const applyCurrentMigrations = (database: DatabaseSync): void => {
  for (const migrationPath of currentMigrationPaths) {
    database.exec(readFileSync(new URL(migrationPath, import.meta.url), 'utf8'))
  }
}

const readPersistedJson = (database: DatabaseSync, table: 'exercise_items' | 'lesson_tasks') =>
  database
    .prepare(`SELECT id, prompt_json, answer_json FROM ${table} ORDER BY id ASC`)
    .all() as Array<{ id: string; prompt_json: string; answer_json: string }>

const seedLegacyCourse = (database: DatabaseSync): void => {
  database.exec(`
    INSERT INTO learners (id, name, access_code, created_at)
    VALUES ('learner-legacy', 'Alice', 'ABCDEFGH23', '${NOW}');
    INSERT INTO courses (
      id, learner_id, source_version_id, current_lesson_no, status, created_at
    ) VALUES (
      'course-legacy', 'learner-legacy', 'version-legacy', 1, 'active', '${NOW}'
    );
  `)
}

const seedLegacyWordState = (database: DatabaseSync, stage: 'S1' | 'S2' | 'S5'): void => {
  database.exec(`
    INSERT INTO user_word_states (
      id, course_id, word_id, group_id, stage,
      first_lesson_no, last_seen_lesson_no, next_due_lesson_no,
      status, created_at, updated_at
    ) VALUES (
      'state-legacy', 'course-legacy', 'word-legacy', 'group-legacy', '${stage}',
      1, 1, 1, 'learning', '${NOW}', '${NOW}'
    );
  `)
}

const setLegacyMeaningLeak = (database: DatabaseSync): void => {
  database
    .prepare("UPDATE words SET meaning = ? WHERE id = 'word-legacy'")
    .run('apple 苹果')
  database
    .prepare("UPDATE exercise_items SET prompt_json = ? WHERE id IN ('legacy-s1', 'legacy-s2')")
    .run(JSON.stringify({ meaning: 'apple 苹果' }))
  database
    .prepare("UPDATE exercise_items SET prompt_json = ? WHERE id = 'legacy-s2'")
    .run(
      JSON.stringify({
        meaning: 'apple 苹果',
        options: ['apple', 'apple-option-a', 'apple-option-b'],
      }),
    )
}

const seedLegacyStartedLesson = (database: DatabaseSync): void => {
  seedLegacyCourse(database)
  database.exec(`
    INSERT INTO lesson_sessions (
      id, course_id, lesson_no, status, task_count, started_at
    ) VALUES ('session-legacy', 'course-legacy', 1, 'started', 2, '${NOW}');
  `)
  const insert = database.prepare(`
    INSERT INTO lesson_tasks (
      id, session_id, course_id, word_id, stage, task_type,
      prompt_json, answer_json, order_index, status, created_at
    ) VALUES (
      ?, 'session-legacy', 'course-legacy', 'word-legacy', ?, ?, ?, ?, ?, 'pending', '${NOW}'
    )
  `)

  for (const [index, content] of legacyContents.slice(4).entries()) {
    insert.run(
      `task-${content.id}`,
      content.stage,
      content.taskType,
      JSON.stringify(content.prompt),
      JSON.stringify({ word: 'apple', meaning: '苹果' }),
      index + 1,
    )
  }
}

const createLegacyLearnerApp = (db: D1Database): WorkerApp => {
  const contentRepository = createD1ContentRepository(db)
  const courseRepository = createD1CourseRepository(db)
  const now = () => new Date(NOW)

  return createWorkerApp({
    contentBuilder: createContentBuilder({ repository: contentRepository, now }),
    courseRuntime: createCourseRuntime({
      contentRepository,
      courseRepository,
      now,
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    }),
    courseQueryService: createCourseQueryService({
      contentRepository,
      courseRepository,
      flowWriteMode: 'legacy_v1',
    }),
    courseRepository,
    learnerSessionService: createLearnerSessionService({
      courseRepository,
      sessionRepository: createD1SessionRepository(db),
      now,
      generateToken: () => SESSION_TOKEN,
    }),
    adminAuthentication: { allowedOrigin: ORIGIN },
  })
}

const exchangeLegacyAccessCode = async (app: WorkerApp): Promise<string> => {
  const response = await app.fetch(
    new Request(`${ORIGIN}/api/app/session/by-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ accessCode: 'ABCDEFGH23' }),
    }),
  )
  const cookie = response.headers.get('set-cookie')?.split(';')[0]

  if (response.status !== 200 || !cookie) {
    throw new Error('Expected the legacy learner access code to establish a session')
  }

  return cookie
}

const readLearnerRuntimeState = (database: DatabaseSync) => ({
  course: database
    .prepare(
      'SELECT id, current_lesson_no, status FROM courses WHERE id = ? ORDER BY id ASC',
    )
    .get('course-legacy'),
  sessions: database
    .prepare(
      'SELECT id, status, task_count, completed_task_count, correct_count, wrong_count, completed_at FROM lesson_sessions WHERE course_id = ? ORDER BY id ASC',
    )
    .all('course-legacy'),
  tasks: database
    .prepare(
      'SELECT id, status, order_index, prompt_json, answer_json, draft_answer, reference_revealed_at FROM lesson_tasks WHERE course_id = ? ORDER BY id ASC',
    )
    .all('course-legacy'),
  wordStates: database
    .prepare(
      'SELECT id, stage, total_attempt_count, total_correct_count, total_wrong_count, next_due_lesson_no, status FROM user_word_states WHERE course_id = ? ORDER BY id ASC',
    )
    .all('course-legacy'),
  reviewLogs: database
    .prepare(
      'SELECT id, task_id, stage, score, lesson_no FROM review_logs WHERE course_id = ? ORDER BY id ASC',
    )
    .all('course-legacy'),
})

const expectSafeLegacyCompatibilityResponse = async (response: Response): Promise<void> => {
  expect(response.status).toBe(409)
  const payload = await response.json()

  expect(payload).toEqual({
    ok: false,
    error: {
      code: 'legacy_content_incompatible',
      message: 'Course content is temporarily unavailable',
    },
  })
  const serialized = JSON.stringify(payload)
  expect(serialized).not.toContain('meaning_reveals_answer')
  expect(serialized).not.toContain('prompt_reveals_reference')
  expect(serialized).not.toContain('apple')
  expect(serialized).not.toContain('answer')
  expect(serialized).not.toContain('reason')
}

describe('legacy exercise content compatibility after migrations 0003-0009', () => {
  it('keeps current write/edit schemas strict instead of accepting legacy content', () => {
    const legacy = {
      stage: 'S0',
      taskType: 'recognize_meaning',
      prompt: { word: 'apple', meaning: '苹果', exampleSentence: 'I ate an apple.' },
      answer: { word: 'apple', meaning: '苹果' },
    }

    expect(exerciseItemContentSchema.safeParse(legacy).success).toBe(false)
    expect(editExerciseItemRequestSchema.safeParse({ content: legacy }).success).toBe(false)
  })

  it('reads every legacy exercise shape without rewriting published JSON', async () => {
    const database = createLegacyDatabase('published')
    const before = readPersistedJson(database, 'exercise_items')
    applyCurrentMigrations(database)
    const repository = createD1ContentRepository(createSqliteD1(database))

    const snapshot = await repository.getSourceVersion('version-legacy')

    expect(snapshot?.exerciseItems).toHaveLength(6)
    for (const item of snapshot?.exerciseItems ?? []) {
      expect(
        exerciseItemContentSchema.safeParse({
          stage: item.stage,
          taskType: item.taskType,
          prompt: item.prompt,
          answer: item.answer,
        }).success,
      ).toBe(true)
    }
    expect(readPersistedJson(database, 'exercise_items')).toEqual(before)

    database.close()
  })

  it('keeps a legacy draft readable for management while approval remains strict', async () => {
    const database = createLegacyDatabase('draft')
    const before = readPersistedJson(database, 'exercise_items')
    applyCurrentMigrations(database)
    const repository = createD1ContentRepository(createSqliteD1(database))
    const builder = createContentBuilder({ repository, now: () => new Date(NOW) })

    const items = await builder.listExerciseItems('version-legacy')
    const s5 = await builder.getExerciseItem('legacy-s5')

    expect(items).toHaveLength(6)
    expect(s5).toMatchObject({
      id: 'legacy-s5',
      prompt: {
        meaning: '苹果',
        instruction: 'Write one complete English sentence.',
      },
      answer: { referenceSentence: 'I ate an apple.' },
      status: 'draft',
    })
    await expect(builder.approveExerciseItem('legacy-s2')).rejects.toMatchObject({
      code: 'validation_error',
    })
    expect(readPersistedJson(database, 'exercise_items')).toEqual(before)

    database.close()
  })

  it('keeps an answer-revealing legacy draft visible to admin for repair without rewriting it', async () => {
    const database = createLegacyDatabase('draft')
    setLegacyMeaningLeak(database)
    const before = readPersistedJson(database, 'exercise_items')
    applyCurrentMigrations(database)
    const builder = createContentBuilder({
      repository: createD1ContentRepository(createSqliteD1(database)),
      now: () => new Date(NOW),
    })

    const items = await builder.listExerciseItems('version-legacy')

    expect(items).toContainEqual(
      expect.objectContaining({
        id: 'legacy-s1',
        prompt: { meaning: 'apple 苹果' },
        status: 'draft',
      }),
    )
    expect(readPersistedJson(database, 'exercise_items')).toEqual(before)

    database.close()
  })

  it('restores legacy started S4/S5 tasks through the current lesson DTO without rewriting snapshots', async () => {
    const database = createLegacyDatabase('published')
    seedLegacyStartedLesson(database)
    const before = readPersistedJson(database, 'lesson_tasks')
    applyCurrentMigrations(database)
    const db = createSqliteD1(database)
    const repository = createD1CourseRepository(db)
    const runtime = createCourseRuntime({
      contentRepository: createD1ContentRepository(db),
      courseRepository: repository,
      now: () => new Date(NOW),
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })

    const restored = await runtime.getLesson('session-legacy')

    expect(restored.tasks).toHaveLength(2)
    for (const task of restored.tasks) {
      expect(lessonTaskSchema.safeParse(task).success).toBe(true)
    }
    const sentenceBuildTask = restored.tasks[0]

    if (sentenceBuildTask?.taskType !== 'sentence_build') {
      throw new Error('Expected a restored sentence-build task')
    }

    expect(
      sentenceBuildTask.prompt.pieces.some(
        (piece) => typeof piece.id === 'string' && piece.text === 'apple.',
      ),
    ).toBe(true)
    expect(restored.tasks[1]).toMatchObject({
      taskType: 'sentence_output',
      prompt: {
        meaning: '苹果',
        instruction: 'Write one complete English sentence.',
      },
    })
    expect(readPersistedJson(database, 'lesson_tasks')).toEqual(before)

    database.close()
  })

  it('starts a new lesson for a course bound to a legacy published version without rewriting source JSON', async () => {
    const database = createLegacyDatabase('published')
    seedLegacyCourse(database)
    const before = readPersistedJson(database, 'exercise_items')
    applyCurrentMigrations(database)
    const db = createSqliteD1(database)
    const runtime = createCourseRuntime({
      contentRepository: createD1ContentRepository(db),
      courseRepository: createD1CourseRepository(db),
      now: () => new Date(NOW),
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })

    const started = await runtime.startLesson('course-legacy')

    expect(started.session).toMatchObject({ courseId: 'course-legacy', status: 'started' })
    expect(started.tasks).toHaveLength(1)
    expect(started.tasks[0]).toMatchObject({
      stage: 'S0',
      taskType: 'recognize_meaning',
      prompt: { word: 'apple', meaning: '苹果' },
    })
    expect(readPersistedJson(database, 'exercise_items')).toEqual(before)

    database.close()
  })

  it.each(['S1', 'S2'] as const)(
    'fails closed before starting a legacy published %s task whose meaning reveals the answer',
    async (stage) => {
      const database = createLegacyDatabase('published')
      setLegacyMeaningLeak(database)
      seedLegacyCourse(database)
      seedLegacyWordState(database, stage)
      const before = readPersistedJson(database, 'exercise_items')
      applyCurrentMigrations(database)
      const db = createSqliteD1(database)
      const runtime = createCourseRuntime({
        contentRepository: createD1ContentRepository(db),
        courseRepository: createD1CourseRepository(db),
        now: () => new Date(NOW),
        queueWriteMode: 'legacy_v1',
        flowWriteMode: 'legacy_v1',
      })

      await expect(runtime.startLesson('course-legacy')).rejects.toMatchObject({
        code: 'legacy_content_incompatible',
        reason: 'meaning_reveals_answer',
      })
      expect(readPersistedJson(database, 'exercise_items')).toEqual(before)

      database.close()
    },
  )

  it('maps incompatible legacy source content to a safe learner start response without advancing state', async () => {
    const database = createLegacyDatabase('published')
    setLegacyMeaningLeak(database)
    seedLegacyCourse(database)
    seedLegacyWordState(database, 'S1')
    applyCurrentMigrations(database)
    const db = createSqliteD1(database)
    const app = createLegacyLearnerApp(db)
    const cookie = await exchangeLegacyAccessCode(app)
    const before = readLearnerRuntimeState(database)

    const response = await app.fetch(
      new Request(`${ORIGIN}/api/app/courses/course-legacy/lessons/start`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN },
      }),
    )

    await expectSafeLegacyCompatibilityResponse(response)
    expect(readLearnerRuntimeState(database)).toEqual(before)

    database.close()
  })

  it('fails closed before starting a legacy S5 task whose prompt reveals the reference sentence', async () => {
    const database = createLegacyDatabase('published')
    database
      .prepare("UPDATE exercise_items SET prompt_json = ? WHERE id = 'legacy-s5'")
      .run(JSON.stringify({ meaning: 'I   ATE an apple.' }))
    seedLegacyCourse(database)
    seedLegacyWordState(database, 'S5')
    const before = readPersistedJson(database, 'exercise_items')
    applyCurrentMigrations(database)
    const db = createSqliteD1(database)
    const runtime = createCourseRuntime({
      contentRepository: createD1ContentRepository(db),
      courseRepository: createD1CourseRepository(db),
      now: () => new Date(NOW),
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })

    await expect(runtime.startLesson('course-legacy')).rejects.toMatchObject({
      code: 'legacy_content_incompatible',
      reason: 'prompt_reveals_reference',
    })
    expect(readPersistedJson(database, 'exercise_items')).toEqual(before)

    database.close()
  })

  it('maps a visually equivalent legacy S5 owning-word leak to a safe learner response without advancing state', async () => {
    const database = createLegacyDatabase('published')
    database
      .prepare("UPDATE exercise_items SET prompt_json = ? WHERE id = 'legacy-s5'")
      .run(JSON.stringify({ meaning: '请使用 ａｐｐｌｅ 完成句子' }))
    seedLegacyCourse(database)
    seedLegacyWordState(database, 'S5')
    applyCurrentMigrations(database)
    const db = createSqliteD1(database)
    const app = createLegacyLearnerApp(db)
    const cookie = await exchangeLegacyAccessCode(app)
    const before = readLearnerRuntimeState(database)

    const response = await app.fetch(
      new Request(`${ORIGIN}/api/app/courses/course-legacy/lessons/start`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN },
      }),
    )

    await expectSafeLegacyCompatibilityResponse(response)
    expect(readLearnerRuntimeState(database)).toEqual(before)

    database.close()
  })

  it('fails closed before restoring a legacy started lesson whose meaning reveals the answer', async () => {
    const database = createLegacyDatabase('published')
    setLegacyMeaningLeak(database)
    seedLegacyStartedLesson(database)
    database
      .prepare(`
        UPDATE lesson_tasks
        SET stage = 'S1', task_type = 'recall_word', prompt_json = ?
        WHERE id = 'task-legacy-s4'
      `)
      .run(JSON.stringify({ meaning: 'apple 苹果' }))
    const before = readPersistedJson(database, 'lesson_tasks')
    applyCurrentMigrations(database)
    const db = createSqliteD1(database)
    const runtime = createCourseRuntime({
      contentRepository: createD1ContentRepository(db),
      courseRepository: createD1CourseRepository(db),
      now: () => new Date(NOW),
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })

    await expect(runtime.getLesson('session-legacy')).rejects.toMatchObject({
      code: 'legacy_content_incompatible',
      reason: 'meaning_reveals_answer',
    })
    expect(readPersistedJson(database, 'lesson_tasks')).toEqual(before)

    database.close()
  })

  it('maps an incompatible persisted task to a safe learner lesson response without mutating state', async () => {
    const database = createLegacyDatabase('published')
    setLegacyMeaningLeak(database)
    seedLegacyStartedLesson(database)
    database
      .prepare(`
        UPDATE lesson_tasks
        SET stage = 'S1', task_type = 'recall_word', prompt_json = ?
        WHERE id = 'task-legacy-s4'
      `)
      .run(JSON.stringify({ meaning: 'apple 苹果' }))
    applyCurrentMigrations(database)
    const db = createSqliteD1(database)
    const app = createLegacyLearnerApp(db)
    const cookie = await exchangeLegacyAccessCode(app)
    const before = readLearnerRuntimeState(database)

    const response = await app.fetch(
      new Request(`${ORIGIN}/api/app/lessons/session-legacy`, {
        headers: { cookie },
      }),
    )

    await expectSafeLegacyCompatibilityResponse(response)
    expect(readLearnerRuntimeState(database)).toEqual(before)

    database.close()
  })

  it('fails closed with an auditable reason when a legacy S3 snapshot has no recoverable blank', async () => {
    const database = createLegacyDatabase('published')
    database
      .prepare("UPDATE exercise_items SET prompt_json = ? WHERE id = 'legacy-s3'")
      .run(JSON.stringify({ sentence: 'This sentence omits the target token.' }))
    database
      .prepare("UPDATE words SET example_sentence = ? WHERE id = 'word-legacy'")
      .run('This sentence omits the target token.')
    const before = readPersistedJson(database, 'exercise_items')
    applyCurrentMigrations(database)
    const repository = createD1ContentRepository(createSqliteD1(database))

    await expect(repository.getExerciseItem('legacy-s3')).rejects.toMatchObject({
      code: 'legacy_content_incompatible',
      reason: 'fill_blank_not_recoverable',
    })
    expect(readPersistedJson(database, 'exercise_items')).toEqual(before)

    database.close()
  })

  it.each([
    { label: 'one piece', pieces: ['apple'], reason: 'sentence_build_not_shufflable' },
    { label: 'visually repeated pieces', pieces: ['go', 'go'], reason: 'sentence_build_not_shufflable' },
    { label: 'empty split piece', pieces: ['I', '', 'apple.'], reason: 'sentence_build_empty_piece' },
  ])('fails closed for a legacy S4 $label with an auditable reason', async ({ pieces, reason }) => {
    const database = createLegacyDatabase('published')
    database
      .prepare("UPDATE exercise_items SET prompt_json = ? WHERE id = 'legacy-s4'")
      .run(JSON.stringify({ pieces }))
    const before = readPersistedJson(database, 'exercise_items')
    applyCurrentMigrations(database)
    const repository = createD1ContentRepository(createSqliteD1(database))

    await expect(repository.getExerciseItem('legacy-s4')).rejects.toMatchObject({
      code: 'legacy_content_incompatible',
      reason,
    })
    expect(readPersistedJson(database, 'exercise_items')).toEqual(before)

    database.close()
  })
})
