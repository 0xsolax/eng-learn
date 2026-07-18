import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createD1CourseRepository } from '../../server/repositories/d1CourseRepository'
import { createD1LessonReplayRepository } from '../../server/repositories/d1LessonReplayRepository'
import { createLessonReplayService } from '../../server/services/LessonReplayService'

const NOW = new Date('2026-07-18T03:00:00.000Z')

describe('D1 lesson replay repository', () => {
  it('persists one active replay winner and never mutates formal learning rows', async () => {
    const fixture = createFixture()
    const principal = { learnerId: 'learner-1', courseId: 'course-1' }
    const before = readFormalRows(fixture.database)

    const [left, right] = await Promise.all([
      fixture.service.startReplay(principal, 'session-1'),
      fixture.service.startReplay(principal, 'session-1'),
    ])

    expect(left.session.id).toBe(right.session.id)
    expect(count(fixture.database, 'lesson_replay_sessions')).toBe(1)
    expect(count(fixture.database, 'lesson_replay_task_states')).toBe(1)

    const task = left.tasks[0]
    if (!task || task.taskType !== 'recognize_meaning') {
      throw new Error('Expected one recognition replay task')
    }
    const first = await fixture.service.submitAnswer(principal, {
      replaySessionId: left.session.id,
      taskId: task.id,
      submission: { taskType: 'recognize_meaning', response: 'known' },
    })
    const retried = await fixture.service.submitAnswer(principal, {
      replaySessionId: left.session.id,
      taskId: task.id,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
    })

    expect(retried).toEqual(first)
    expect(count(fixture.database, 'lesson_replay_task_states', "status = 'completed'"))
      .toBe(1)
    const completed = await fixture.service.completeReplay(principal, left.session.id)
    expect(completed.session).toMatchObject({
      status: 'completed',
      completedTaskCount: 1,
      correctCount: 1,
      wrongCount: 0,
    })

    const secondAttempt = await fixture.service.startReplay(principal, 'session-1')
    expect(secondAttempt.session.id).not.toBe(left.session.id)
    expect(count(fixture.database, 'lesson_replay_sessions')).toBe(2)
    expect(readFormalRows(fixture.database)).toEqual(before)

    fixture.control.resetReadCounts()
    await expect(
      fixture.replayRepository.getReplayForCourse({
        replaySessionId: secondAttempt.session.id,
        courseId: 'course-1',
      }),
    ).resolves.toMatchObject({ session: { id: secondAttempt.session.id } })
    expect(fixture.control.readCounts()).toEqual({ first: 0, all: 1 })

    fixture.database.close()
  })

  it('rolls back replay session and task rows when a D1 batch fails midway', async () => {
    const fixture = createFixture()
    fixture.control.failNextBatchAt(1)

    await expect(
      fixture.service.startReplay(
        { learnerId: 'learner-1', courseId: 'course-1' },
        'session-1',
      ),
    ).rejects.toThrow('injected D1 batch failure')

    expect(count(fixture.database, 'lesson_replay_sessions')).toBe(0)
    expect(count(fixture.database, 'lesson_replay_task_states')).toBe(0)
    fixture.database.close()
  })

  it('rejects an incomplete replay instead of returning a started success payload', async () => {
    const fixture = createFixture()
    const principal = { learnerId: 'learner-1', courseId: 'course-1' }
    const replay = await fixture.service.startReplay(principal, 'session-1')

    await expect(
      fixture.service.completeReplay(principal, replay.session.id),
    ).rejects.toMatchObject({ code: 'conflict' })
    fixture.database.close()
  })

  it('lets only one different S5 preview draft win and rejects the loser', async () => {
    const fixture = createFixture('sentence_output')
    const principal = { learnerId: 'learner-1', courseId: 'course-1' }
    const replay = await fixture.service.startReplay(principal, 'session-1')
    const task = replay.tasks[0]
    if (!task || task.taskType !== 'sentence_output') {
      throw new Error('Expected one sentence-output replay task')
    }

    const outcomes = await Promise.allSettled(
      ['First replay draft.', 'Second replay draft.'].map((draft) =>
        fixture.service.previewSentenceOutput(principal, {
          replaySessionId: replay.session.id,
          taskId: task.id,
          preview: { taskType: 'sentence_output', draft },
        }),
      ),
    )

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: { code: 'conflict' },
    })
    fixture.database.close()
  })
})

const createFixture = (
  taskType: 'recognize_meaning' | 'sentence_output' = 'recognize_meaning',
) => {
  const database = new DatabaseSync(':memory:')
  for (const migration of readdirSync('migrations').sort()) {
    database.exec(readFileSync(`migrations/${migration}`, 'utf8'))
  }
  seedFormalLesson(database, taskType)
  const { db, control } = createSqliteD1(database)
  const courseRepository = createD1CourseRepository(db)
  const replayRepository = createD1LessonReplayRepository(db)

  return {
    database,
    control,
    replayRepository,
    service: createLessonReplayService({
      courseRepository,
      replayRepository,
      now: () => NOW,
    }),
  }
}

const seedFormalLesson = (
  database: DatabaseSync,
  taskType: 'recognize_meaning' | 'sentence_output',
): void => {
  const taskSnapshot =
    taskType === 'sentence_output'
      ? {
          stage: 'S5',
          prompt: '{"meaning":"苹果","instruction":"Write one sentence."}',
          answer: '{"referenceSentence":"I eat an apple every day."}',
        }
      : {
          stage: 'S0',
          prompt: '{"word":"apple","meaning":"苹果","exampleSentence":"an apple"}',
          answer: '{"word":"apple","expectedResponse":"known"}',
        }
  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-1', 'Source', '2026-07-18T00:00:00.000Z');
    INSERT INTO source_versions (id, source_id, version_no, status, created_at, published_at)
    VALUES (
      'version-1', 'source-1', 1, 'published',
      '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO words (
      id, source_version_id, order_index, word, meaning, example_sentence,
      part_of_speech, example_phrase, example_sentence_extended, created_at
    ) VALUES (
      'word-1', 'version-1', 1, 'apple', '苹果', 'I eat an apple.',
      'noun', 'an apple', 'I eat an apple every day.', '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO word_groups (
      id, source_version_id, group_index, start_order_index, end_order_index, created_at
    ) VALUES (
      'group-1', 'version-1', 1, 1, 1, '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO learners (id, name, access_code, created_at)
    VALUES ('learner-1', 'Alice', 'CODE000001', '2026-07-18T00:00:00.000Z');
    INSERT INTO courses (
      id, learner_id, source_version_id, current_lesson_no, status, created_at
    ) VALUES (
      'course-1', 'learner-1', 'version-1', 2, 'active',
      '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO lesson_sessions (
      id, course_id, lesson_no, learning_run_no, run_lesson_no, status,
      task_count, completed_task_count, correct_count, wrong_count,
      queue_policy_version, flow_policy_version, started_at
    ) VALUES (
      'session-1', 'course-1', 1, 1, 1, 'started', 1, 0, 0, 0,
      'v2_3_6_cap3', 'v1_due_then_new_unbounded', '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO lesson_tasks (
      id, session_id, course_id, word_id, stage, task_type, prompt_json,
      answer_json, order_index, status, role, required, created_at
    ) VALUES (
      'task-1', 'session-1', 'course-1', 'word-1', '${taskSnapshot.stage}', '${taskType}',
      '${taskSnapshot.prompt}', '${taskSnapshot.answer}',
      1, 'completed', 'primary', 1, '2026-07-18T00:00:00.000Z'
    );
    UPDATE lesson_sessions
    SET
      status = 'completed', completed_task_count = 1, correct_count = 1,
      completed_at = '2026-07-18T00:10:00.000Z'
    WHERE id = 'session-1';
  `)
}

const readFormalRows = (database: DatabaseSync) => ({
  courses: database.prepare('SELECT * FROM courses ORDER BY id').all(),
  sessions: database.prepare('SELECT * FROM lesson_sessions ORDER BY id').all(),
  tasks: database.prepare('SELECT * FROM lesson_tasks ORDER BY id').all(),
  logs: database.prepare('SELECT * FROM review_logs ORDER BY id').all(),
  states: database.prepare('SELECT * FROM user_word_states ORDER BY id').all(),
})

const count = (database: DatabaseSync, table: string, where = '1 = 1'): number =>
  (
    database.prepare(`SELECT COUNT(*) AS row_count FROM ${table} WHERE ${where}`).get() as {
      row_count: number
    }
  ).row_count

type SqliteD1Statement = {
  bind(...values: unknown[]): SqliteD1Statement
  run(): Promise<{ success: true; meta: { changes: number } }>
  first(): Promise<unknown>
  all(): Promise<{ success: true; results: unknown[]; meta: { changes: number } }>
  execute(): { success: true; meta: { changes: number } }
}

const createSqliteD1 = (database: DatabaseSync) => {
  let injectedFailureIndex: number | undefined
  let firstReadCount = 0
  let allReadCount = 0
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
        firstReadCount += 1
        return Promise.resolve(statement.get(...bindings) ?? null)
      },
      all() {
        allReadCount += 1
        return Promise.resolve({
          success: true,
          results: statement.all(...bindings),
          meta: { changes: 0 },
        })
      },
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
      database.exec('BEGIN')
      try {
        const results = sqliteStatements.map((statement, index) => {
          if (index === injectedFailureIndex) {
            throw new Error('injected D1 batch failure')
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

  return {
    db,
    control: {
      failNextBatchAt(index: number) {
        injectedFailureIndex = index
      },
      resetReadCounts() {
        firstReadCount = 0
        allReadCount = 0
      },
      readCounts() {
        return { first: firstReadCount, all: allReadCount }
      },
    },
  }
}
