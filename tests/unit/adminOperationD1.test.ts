import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createD1AdminOperationLedger } from '../../server/repositories/adminOperationLedger'
import { createD1ContentRepository } from '../../server/repositories/d1ContentRepository'
import { createD1CourseRepository } from '../../server/repositories/d1CourseRepository'
import { createD1SessionRepository } from '../../server/repositories/d1SessionRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import { createLearnerSessionService } from '../../server/services/LearnerSessionService'

const NOW = new Date('2026-07-13T00:00:00.000Z')
const SOURCE_TOKEN = '1'.repeat(64)
const COURSE_TOKEN = '2'.repeat(64)
const ROTATE_TOKEN_A = '3'.repeat(64)
const ROTATE_TOKEN_B = '4'.repeat(64)
const ROTATE_TOKEN_C = '5'.repeat(64)
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

describe('D1 admin operation transactions', () => {
  it('rolls back and then safely replays create-source, create-course, and rotation batches', async () => {
    const fixture = createFixture()

    fixture.control.failNextBatchAt(2)
    await expect(
      fixture.contentBuilder.importNewSourceIdempotently({
        operationToken: SOURCE_TOKEN,
        sourceName: 'Imported',
        words: createWords(),
      }),
    ).rejects.toThrow('Injected D1 batch failure')
    expect(count(fixture.database, 'word_sources', "id <> 'source-published'")).toBe(0)
    expect(count(fixture.database, 'admin_operations')).toBe(0)

    const imported = await fixture.contentBuilder.importNewSourceIdempotently({
      operationToken: SOURCE_TOKEN,
      sourceName: 'Imported',
      words: createWords(),
    })
    await expect(
      fixture.contentBuilder.importNewSourceIdempotently({
        operationToken: SOURCE_TOKEN,
        sourceName: 'Imported',
        words: createWords(),
      }),
    ).resolves.toEqual(imported)
    expect(count(fixture.database, 'word_sources', "id <> 'source-published'")).toBe(1)
    expect(count(fixture.database, 'admin_operations')).toBe(1)

    fixture.control.failNextBatchAt(2)
    await expect(
      fixture.courseRuntime.createCourseIdempotently({
        operationToken: COURSE_TOKEN,
        learnerName: 'Alice',
        sourceVersionId: 'version-published',
      }),
    ).rejects.toThrow('Injected D1 batch failure')
    expect(count(fixture.database, 'learners')).toBe(0)
    expect(count(fixture.database, 'courses')).toBe(0)
    expect(count(fixture.database, 'admin_operations')).toBe(1)

    const created = await fixture.courseRuntime.createCourseIdempotently({
      operationToken: COURSE_TOKEN,
      learnerName: 'Alice',
      sourceVersionId: 'version-published',
    })
    await expect(
      fixture.courseRuntime.createCourseIdempotently({
        operationToken: COURSE_TOKEN,
        learnerName: 'Alice',
        sourceVersionId: 'version-published',
      }),
    ).resolves.toEqual(created)
    expect(count(fixture.database, 'learners')).toBe(1)
    expect(count(fixture.database, 'courses')).toBe(1)
    expect(count(fixture.database, 'admin_operations')).toBe(2)

    const established = await fixture.sessionService.exchangeAccessCode(
      created.learner.accessCode,
    )
    expect(established).toBeDefined()

    fixture.control.failNextBatchAt(2)
    await expect(
      fixture.sessionService.rotateAccessCodeIdempotently(created.learner.id, {
        operationToken: ROTATE_TOKEN_A,
        expectedCredentialVersion: 1,
      }),
    ).rejects.toThrow('Injected D1 batch failure')
    expect(readCredentialVersion(fixture.database, created.learner.id)).toBe(1)
    expect(readRevokedAt(fixture.database)).toBeNull()
    expect(count(fixture.database, 'admin_operations')).toBe(2)

    const rotated = await fixture.sessionService.rotateAccessCodeIdempotently(
      created.learner.id,
      {
        operationToken: ROTATE_TOKEN_A,
        expectedCredentialVersion: 1,
      },
    )
    const replay = await fixture.sessionService.rotateAccessCodeIdempotently(
      created.learner.id,
      {
        operationToken: ROTATE_TOKEN_A,
        expectedCredentialVersion: 1,
      },
    )
    expect(rotated).toMatchObject({ credentialVersion: 2, revokedSessionCount: 1 })
    expect(replay).toEqual(rotated)
    expect(readCredentialVersion(fixture.database, created.learner.id)).toBe(2)
    expect(readRevokedAt(fixture.database)).toBe(NOW.toISOString())
    expect(count(fixture.database, 'admin_operations')).toBe(3)

    const persisted = JSON.stringify(
      fixture.database.prepare('SELECT * FROM admin_operations').all(),
    )
    expect(persisted).not.toContain(SOURCE_TOKEN)
    expect(persisted).not.toContain(COURSE_TOKEN)
    expect(persisted).not.toContain(ROTATE_TOKEN_A)
    expect(persisted).not.toContain(created.learner.accessCode)
    expect(persisted).not.toContain(rotated?.accessCode ?? 'missing')

    fixture.database.close()
  })

  it('commits only one different token for a credential version and leaves stale attempts ledger-free', async () => {
    const fixture = createFixture()
    const created = await fixture.courseRuntime.createCourseIdempotently({
      operationToken: COURSE_TOKEN,
      learnerName: 'Alice',
      sourceVersionId: 'version-published',
    })
    await fixture.sessionService.exchangeAccessCode(created.learner.accessCode)

    const candidates = [
      {
        operationToken: ROTATE_TOKEN_A,
        expectedCredentialVersion: 1,
      },
      {
        operationToken: ROTATE_TOKEN_B,
        expectedCredentialVersion: 1,
      },
    ]
    const results = await Promise.allSettled(
      candidates.map((command) =>
        fixture.sessionService.rotateAccessCodeIdempotently(
          created.learner.id,
          command,
        ),
      ),
    )

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'credential_conflict' } })
    expect(readCredentialVersion(fixture.database, created.learner.id)).toBe(2)
    expect(count(fixture.database, 'admin_operations', "kind = 'rotate_access_code'")).toBe(1)

    await expect(
      fixture.sessionService.rotateAccessCodeIdempotently(created.learner.id, {
        operationToken: ROTATE_TOKEN_C,
        expectedCredentialVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'credential_conflict' })
    expect(readCredentialVersion(fixture.database, created.learner.id)).toBe(2)
    expect(count(fixture.database, 'admin_operations', "kind = 'rotate_access_code'")).toBe(1)

    const winningIndex = results.findIndex((result) => result.status === 'fulfilled')
    const winningCommand = candidates[winningIndex]
    const winningResult = results[winningIndex]

    if (!winningCommand || winningResult?.status !== 'fulfilled') {
      throw new Error('Expected one successful rotation command')
    }

    await expect(
      fixture.sessionService.rotateAccessCodeIdempotently(
        created.learner.id,
        winningCommand,
      ),
    ).resolves.toEqual(winningResult.value)

    await fixture.sessionService.rotateAccessCodeIdempotently(created.learner.id, {
      operationToken: ROTATE_TOKEN_C,
      expectedCredentialVersion: 2,
    })
    await expect(
      fixture.sessionService.rotateAccessCodeIdempotently(
        created.learner.id,
        winningCommand,
      ),
    ).rejects.toMatchObject({ code: 'operation_superseded' })

    fixture.database.close()
  })
})

type SqliteD1Statement = {
  bind(...values: unknown[]): SqliteD1Statement
  run(): Promise<{ success: true; meta: { changes: number } }>
  first(): Promise<unknown>
  all(): Promise<{ success: true; results: unknown[]; meta: Record<string, never> }>
  execute(): { success: true; meta: { changes: number } }
}

type D1Control = {
  failNextBatchAt(statementIndex: number): void
}

const createSqliteD1 = (
  database: DatabaseSync,
): { db: D1Database; control: D1Control } => {
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
  const db = {
    prepare(sql: string) {
      return prepare(sql) as unknown as D1PreparedStatement
    },
    batch(statements: D1PreparedStatement[]) {
      const sqliteStatements = statements as unknown as SqliteD1Statement[]
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

  return {
    db,
    control: {
      failNextBatchAt(statementIndex) {
        injectedFailureIndex = statementIndex
      },
    },
  }
}

const createFixture = () => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const path of migrationPaths) {
    database.exec(readFileSync(new URL(path, import.meta.url), 'utf8'))
  }
  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-published', 'Published', '${NOW.toISOString()}');
    INSERT INTO source_versions (
      id, source_id, version_no, status, created_at, published_at
    ) VALUES (
      'version-published', 'source-published', 1, 'published',
      '${NOW.toISOString()}', '${NOW.toISOString()}'
    );
  `)
  const { db, control } = createSqliteD1(database)
  const ledger = createD1AdminOperationLedger(db)
  const contentRepository = createD1ContentRepository(db)
  const courseRepository = createD1CourseRepository(db)
  const sessionRepository = createD1SessionRepository(db)

  return {
    database,
    control,
    contentBuilder: createContentBuilder({
      repository: contentRepository,
      operationLedger: ledger,
      now: () => NOW,
    }),
    courseRuntime: createCourseRuntime({
      contentRepository,
      courseRepository,
      operationLedger: ledger,
      now: () => NOW,
    }),
    sessionService: createLearnerSessionService({
      courseRepository,
      sessionRepository,
      operationLedger: ledger,
      now: () => NOW,
      generateToken: () => 'f'.repeat(64),
    }),
  }
}

const createWords = () => [
  {
    word: 'apple',
    meaning: '苹果',
    exampleSentence: 'I eat an apple.',
  },
]

const count = (
  database: DatabaseSync,
  table: 'word_sources' | 'learners' | 'courses' | 'admin_operations',
  condition?: string,
): number =>
  (
    database
      .prepare(`SELECT COUNT(*) AS count FROM ${table}${condition ? ` WHERE ${condition}` : ''}`)
      .get() as { count: number }
  ).count

const readCredentialVersion = (database: DatabaseSync, learnerId: string): number =>
  (
    database
      .prepare('SELECT credential_version FROM learners WHERE id = ?')
      .get(learnerId) as { credential_version: number }
  ).credential_version

const readRevokedAt = (database: DatabaseSync): string | null =>
  (
    database
      .prepare('SELECT revoked_at FROM learner_sessions LIMIT 1')
      .get() as { revoked_at: string | null }
  ).revoked_at
