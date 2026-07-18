import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createD1CourseRepository } from '../../server/repositories/d1CourseRepository'
import { createD1AdminOperationLedger } from '../../server/repositories/adminOperationLedger'
import { createLearningProgressService } from '../../server/services/LearningProgressService'
import { hashAdminOperationToken } from '../../server/security/adminOperationCrypto'
import {
  generateAdminOperationToken,
  parseAdminOperationToken,
} from '../../shared/security/adminOperationToken'

const NOW = new Date('2026-07-18T04:00:00.000Z')

describe('D1 learning progress reset', () => {
  it('atomically starts logical lesson one in a new run and preserves prior history', async () => {
    const fixture = createFixture()
    const command = {
      operationToken: generateAdminOperationToken(),
      expectedLearningRunNo: 1,
      expectedCurrentLessonNo: 2,
    }

    const reset = await fixture.service.resetCourseProgress(
      'course-1',
      command,
      { source: 'service_token', subject: 'admin-1' },
    )
    const retried = await fixture.service.resetCourseProgress(
      'course-1',
      command,
      { source: 'service_token', subject: 'admin-1' },
    )

    expect(retried).toEqual(reset)
    expect(reset).toMatchObject({
      course: {
        id: 'course-1',
        learnerId: 'learner-1',
        sourceVersionId: 'version-1',
        currentLessonNo: 1,
      },
      learningRunNo: 2,
      abandonedSessionCount: 1,
      historyPreserved: true,
    })
    expect(
      fixture.database.prepare(
        'SELECT current_lesson_no, current_learning_run_no, current_run_start_lesson_no FROM courses WHERE id = ?',
      ).get('course-1'),
    ).toEqual({
      current_lesson_no: 3,
      current_learning_run_no: 2,
      current_run_start_lesson_no: 3,
    })
    expect(
      fixture.database.prepare(
        'SELECT run_no, start_lesson_no, status FROM course_learning_runs WHERE course_id = ? ORDER BY run_no',
      ).all('course-1'),
    ).toEqual([
      { run_no: 1, start_lesson_no: 1, status: 'completed' },
      { run_no: 2, start_lesson_no: 3, status: 'active' },
    ])
    expect(
      fixture.database.prepare(
        'SELECT status, learning_run_no, run_lesson_no FROM lesson_sessions WHERE id = ?',
      ).get('session-2'),
    ).toEqual({ status: 'abandoned', learning_run_no: 1, run_lesson_no: 2 })
    expect(
      fixture.database.prepare(
        'SELECT word_id, learning_run_no, reset_operation_hash FROM course_learning_run_word_state_snapshots',
      ).all(),
    ).toEqual([
      expect.objectContaining({ word_id: 'word-1', learning_run_no: 1 }),
    ])
    await expect(fixture.repository.getWordStates('course-1')).resolves.toEqual([])
    await expect(
      fixture.repository.getLearningRunWordStateSnapshots({
        courseId: 'course-1',
        learningRunNo: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'state-1',
        courseId: 'course-1',
        wordId: 'word-1',
        learningRunNo: 1,
      }),
    ])
    expect(count(fixture.database, 'course_progress_reset_operations')).toBe(1)
    expect(count(fixture.database, 'lesson_sessions')).toBe(2)
    expect(count(fixture.database, 'lesson_tasks')).toBe(2)
    const parsedToken = parseAdminOperationToken(command.operationToken)
    if (!parsedToken) throw new Error('Expected a valid reset operation token')
    await expect(
      fixture.operationLedger.get(await hashAdminOperationToken(parsedToken)),
    ).resolves.toMatchObject({
      kind: 'reset_course_progress',
      targetId: 'course-1',
      outcomeLearningRunNo: 2,
      outcomePhysicalLessonNo: 3,
    })

    const restored = await fixture.repository.getCourseByAccessCode('ABCDEFGHJK')
    expect(restored).toMatchObject({
      learner: { id: 'learner-1' },
      course: { id: 'course-1', currentLessonNo: 1 },
    })

    fixture.database.prepare(
      'UPDATE courses SET current_lesson_no = ? WHERE id = ?',
    ).run(4, 'course-1')
    await expect(
      fixture.service.resetCourseProgress(
        'course-1',
        command,
        { source: 'service_token', subject: 'admin-1' },
      ),
    ).resolves.toEqual(reset)
    fixture.database.close()
  })

  it('lets only one stale concurrent reset win', async () => {
    const fixture = createFixture()
    const command = () => ({
      operationToken: generateAdminOperationToken(),
      expectedLearningRunNo: 1,
      expectedCurrentLessonNo: 2,
    })

    const outcomes = await Promise.allSettled([
      fixture.service.resetCourseProgress('course-1', command(), {
        source: 'service_token',
        subject: 'admin-1',
      }),
      fixture.service.resetCourseProgress('course-1', command(), {
        source: 'service_token',
        subject: 'admin-2',
      }),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'progress_conflict' },
    })
    expect(count(fixture.database, 'course_progress_reset_operations')).toBe(1)
    expect(count(fixture.database, 'course_learning_runs')).toBe(2)
    fixture.database.close()
  })

  it('rejects concurrent reuse of one token across different courses', async () => {
    const fixture = createFixture()
    fixture.database.exec(`
      INSERT INTO learners (id, name, access_code, created_at)
      VALUES ('learner-2', 'Bob', 'BCDEFGHJKM', '2026-07-18T00:00:00.000Z');
      INSERT INTO courses (
        id, learner_id, source_version_id, current_lesson_no, status, created_at
      ) VALUES (
        'course-2', 'learner-2', 'version-1', 2, 'active',
        '2026-07-18T00:00:00.000Z'
      );
    `)
    const operationToken = generateAdminOperationToken()
    const command = {
      operationToken,
      expectedLearningRunNo: 1,
      expectedCurrentLessonNo: 2,
    }

    const outcomes = await Promise.allSettled([
      fixture.service.resetCourseProgress('course-1', command, {
        source: 'service_token',
        subject: 'admin-1',
      }),
      fixture.service.resetCourseProgress('course-2', command, {
        source: 'service_token',
        subject: 'admin-1',
      }),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: { code: 'idempotency_conflict' },
    })
    expect(count(fixture.database, 'course_progress_reset_operations')).toBe(1)
    const resetCourses = fixture.database.prepare(
      'SELECT id FROM courses WHERE current_learning_run_no = 2 ORDER BY id',
    ).all()
    expect(resetCourses).toHaveLength(1)
    fixture.database.close()
  })

  it('maps an operation token already used by another admin action to a stable conflict', async () => {
    const fixture = createFixture()
    const operationToken = generateAdminOperationToken()
    const parsedToken = parseAdminOperationToken(operationToken)
    if (!parsedToken) throw new Error('Expected a valid admin operation token')
    const operationHash = await hashAdminOperationToken(parsedToken)
    fixture.database.prepare(
      `INSERT INTO admin_operations (
        operation_hash, kind, target_id, request_fingerprint,
        outcome_learner_id, outcome_credential_version,
        revoked_session_count, created_at
      ) VALUES (?, 'rotate_access_code', 'learner-1', ?, 'learner-1', 2, 0, ?)`,
    ).run(operationHash, `sha256:${'0'.repeat(64)}`, NOW.toISOString())

    await expect(
      fixture.service.resetCourseProgress(
        'course-1',
        {
          operationToken,
          expectedLearningRunNo: 1,
          expectedCurrentLessonNo: 2,
        },
        { source: 'service_token', subject: 'admin-1' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(count(fixture.database, 'course_progress_reset_operations')).toBe(0)
    fixture.database.close()
  })

  it('rolls back every reset ledger and runtime mutation when a D1 batch fails', async () => {
    const fixture = createFixture()
    const before = readResetRows(fixture.database)
    fixture.control.failNextBatchAt(3)

    await expect(
      fixture.service.resetCourseProgress(
        'course-1',
        {
          operationToken: generateAdminOperationToken(),
          expectedLearningRunNo: 1,
          expectedCurrentLessonNo: 2,
        },
        { source: 'service_token', subject: 'admin-1' },
      ),
    ).rejects.toThrow('injected D1 batch failure')

    expect(readResetRows(fixture.database)).toEqual(before)
    fixture.database.close()
  })
})

const createFixture = () => {
  const database = new DatabaseSync(':memory:')
  for (const migration of readdirSync('migrations').sort()) {
    database.exec(readFileSync(`migrations/${migration}`, 'utf8'))
  }
  seedCourse(database)
  const { db, control } = createSqliteD1(database)
  const repository = createD1CourseRepository(db)
  const operationLedger = createD1AdminOperationLedger(db, {
    includeProgressResets: true,
  })

  return {
    database,
    control,
    repository,
    operationLedger,
    service: createLearningProgressService({
      courseRepository: repository,
      operationLedger,
      now: () => NOW,
    }),
  }
}

const seedCourse = (database: DatabaseSync): void => {
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
    VALUES ('learner-1', 'Alice', 'ABCDEFGHJK', '2026-07-18T00:00:00.000Z');
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
    ) VALUES
      (
        'session-1', 'course-1', 1, 1, 1, 'started', 1, 0, 0, 0,
        'v2_3_6_cap3', 'v1_due_then_new_unbounded', '2026-07-18T00:00:00.000Z'
      ),
      (
        'session-2', 'course-1', 2, 1, 2, 'started', 1, 0, 0, 0,
        'v2_3_6_cap3', 'v1_due_then_new_unbounded', '2026-07-18T00:20:00.000Z'
      );
    INSERT INTO lesson_tasks (
      id, session_id, course_id, word_id, stage, task_type, prompt_json,
      answer_json, order_index, status, role, required, created_at
    ) VALUES
      (
        'task-1', 'session-1', 'course-1', 'word-1', 'S0', 'recognize_meaning',
        '{"word":"apple","meaning":"苹果","exampleSentence":"an apple"}',
        '{"word":"apple","expectedResponse":"known"}',
        1, 'completed', 'primary', 1, '2026-07-18T00:00:00.000Z'
      ),
      (
        'task-2', 'session-2', 'course-1', 'word-1', 'S1', 'multiple_choice',
        '{"meaning":"苹果","options":[{"wordId":"word-1","word":"apple"},{"wordId":"word-2","word":"pear"}]}',
        '{"wordId":"word-1","word":"apple"}',
        1, 'pending', 'primary', 1, '2026-07-18T00:20:00.000Z'
      );
    UPDATE lesson_sessions
    SET
      status = 'completed', completed_task_count = 1, correct_count = 1,
      completed_at = '2026-07-18T00:10:00.000Z'
    WHERE id = 'session-1';
    INSERT INTO user_word_states (
      id, course_id, learning_run_no, word_id, group_id, stage,
      stage_attempt_count, stage_correct_count, total_attempt_count,
      total_correct_count, total_wrong_count, current_streak, wrong_streak,
      lapse_count, ease_factor, mastery_score, first_lesson_no,
      last_seen_lesson_no, next_due_lesson_no, status, created_at, updated_at
    ) VALUES (
      'state-1', 'course-1', 1, 'word-1', 'group-1', 'S1', 1, 1, 1, 1, 0,
      1, 0, 0, 1.0, 10, 1, 1, 2, 'learning',
      '2026-07-18T00:00:00.000Z', '2026-07-18T00:10:00.000Z'
    );
  `)
}

const readResetRows = (database: DatabaseSync) => ({
  course: database.prepare('SELECT * FROM courses WHERE id = ?').get('course-1'),
  runs: database.prepare('SELECT * FROM course_learning_runs ORDER BY run_no').all(),
  operations: database.prepare('SELECT * FROM course_progress_reset_operations').all(),
  snapshots: database.prepare('SELECT * FROM course_learning_run_word_state_snapshots').all(),
  sessions: database.prepare('SELECT * FROM lesson_sessions ORDER BY id').all(),
  states: database.prepare('SELECT * FROM user_word_states ORDER BY id').all(),
})

const count = (database: DatabaseSync, table: string): number =>
  (
    database.prepare(`SELECT COUNT(*) AS row_count FROM ${table}`).get() as {
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
    },
  }
}
