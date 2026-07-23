import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createD1AdminOperationLedger } from '../../server/repositories/adminOperationLedger'
import { createD1CourseRepository } from '../../server/repositories/d1CourseRepository'
import { createD1LearnerLoginAttemptRepository } from '../../server/repositories/d1LearnerLoginAttemptRepository'
import { createD1SessionRepository } from '../../server/repositories/d1SessionRepository'
import { createLearnerSessionService } from '../../server/services/LearnerSessionService'

const NOW = new Date('2026-07-21T00:00:00.000Z')
const RAW_ACCESS_CODE = 'ABCDEFGH23'

describe('D1 learner account login', () => {
  it('atomically migrates a legacy learner, revokes sessions, and replays the result', async () => {
    const fixture = createFixture()
    const tokens = ['a'.repeat(64), 'b'.repeat(64)]
    const service = createLearnerSessionService({
      courseRepository: fixture.courseRepository,
      sessionRepository: fixture.sessionRepository,
      loginAttemptRepository: fixture.loginAttemptRepository,
      operationLedger: fixture.ledger,
      now: () => NOW,
      generateToken: () => tokens.shift() ?? 'unexpected-token',
      generateAccessCode: () => 'JKLMNPQR45',
    })
    const legacySession = await service.exchangeAccessCode(RAW_ACCESS_CODE)
    const command = {
      operationToken: '1'.repeat(64),
      expectedCredentialVersion: 1,
      loginAccount: 'alice01',
      pin: '123456',
    }

    await expect(
      service.updateLoginCredentialIdempotently('learner-1', command),
    ).resolves.toEqual({
      loginAccount: 'alice01',
      credentialVersion: 2,
      revokedSessionCount: 1,
    })
    await expect(service.resolve(legacySession?.token ?? '')).resolves.toEqual({
      status: 'revoked',
    })
    await expect(service.exchangeAccessCode(RAW_ACCESS_CODE)).resolves.toBeUndefined()
    await expect(service.exchangeAccountLogin('alice01', '123456')).resolves.toBeDefined()
    await expect(
      service.updateLoginCredentialIdempotently('learner-1', command),
    ).resolves.toEqual({
      loginAccount: 'alice01',
      credentialVersion: 2,
      revokedSessionCount: 1,
    })
    expect(
      fixture.database.prepare(
        'SELECT id, learner_id, current_lesson_no FROM courses WHERE id = ?',
      ).get('course-1'),
    ).toEqual({ id: 'course-1', learner_id: 'learner-1', current_lesson_no: 1 })
    expect(
      fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM learner_login_credential_operations',
      ).get(),
    ).toEqual({ count: 1 })
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await expect(
        service.exchangeAccountLogin('alice01', '999999'),
      ).resolves.toBeUndefined()
    }
    await expect(service.exchangeAccountLogin('alice01', '999999')).rejects.toMatchObject({
      code: 'learner_login_rate_limited',
      details: { retryAfterSeconds: 900 },
    })

    fixture.database.close()
  })

  it('rolls back the operation, session revocation, and credential when any batch write fails', async () => {
    const fixture = createFixture()
    const service = createLearnerSessionService({
      courseRepository: fixture.courseRepository,
      sessionRepository: fixture.sessionRepository,
      loginAttemptRepository: fixture.loginAttemptRepository,
      operationLedger: fixture.ledger,
      now: () => NOW,
      generateToken: () => 'a'.repeat(64),
      generateAccessCode: () => 'JKLMNPQR45',
    })
    const legacySession = await service.exchangeAccessCode(RAW_ACCESS_CODE)
    fixture.control.failNextBatchAt(1)

    await expect(
      service.updateLoginCredentialIdempotently('learner-1', {
        operationToken: '2'.repeat(64),
        expectedCredentialVersion: 1,
        loginAccount: 'alice01',
        pin: '123456',
      }),
    ).rejects.toThrow('Injected D1 batch failure')
    expect(
      fixture.database.prepare(
        'SELECT login_account, login_pin_hash, legacy_access_enabled, credential_version FROM learners WHERE id = ?',
      ).get('learner-1'),
    ).toEqual({
      login_account: null,
      login_pin_hash: null,
      legacy_access_enabled: 1,
      credential_version: 1,
    })
    expect(
      fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM learner_login_credential_operations',
      ).get(),
    ).toEqual({ count: 0 })
    await expect(service.resolve(legacySession?.token ?? '')).resolves.toMatchObject({
      status: 'active',
    })

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
          if (index === injectedFailureIndex) throw new Error('Injected D1 batch failure')
          return statement.execute()
        })
        database.exec('COMMIT')
        injectedFailureIndex = undefined
        return Promise.resolve(results as unknown as D1Result[])
      } catch (error) {
        database.exec('ROLLBACK')
        injectedFailureIndex = undefined
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
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

const createFixture = () => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const migration of readdirSync('migrations').sort()) {
    database.exec(readFileSync(`migrations/${migration}`, 'utf8'))
  }
  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-1', 'Source', '${NOW.toISOString()}');
    INSERT INTO source_versions (id, source_id, version_no, status, created_at, published_at)
    VALUES ('version-1', 'source-1', 1, 'published', '${NOW.toISOString()}', '${NOW.toISOString()}');
    INSERT INTO learners (id, name, access_code, created_at)
    VALUES ('learner-1', 'Alice', '${RAW_ACCESS_CODE}', '${NOW.toISOString()}');
    INSERT INTO courses (id, learner_id, source_version_id, current_lesson_no, status, created_at)
    VALUES ('course-1', 'learner-1', 'version-1', 1, 'active', '${NOW.toISOString()}');
  `)
  const { db, control } = createSqliteD1(database)

  return {
    database,
    control,
    courseRepository: createD1CourseRepository(db),
    sessionRepository: createD1SessionRepository(db),
    loginAttemptRepository: createD1LearnerLoginAttemptRepository(db),
    ledger: createD1AdminOperationLedger(db, { includeLearnerLoginUpdates: true }),
  }
}
