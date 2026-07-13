import { describe, expect, it } from 'vitest'
import { createD1CourseRepository } from '../../server/repositories/d1CourseRepository'
import { createD1SessionRepository } from '../../server/repositories/d1SessionRepository'
import type { CreateCourseInput } from '../../server/repositories/courseRepository'

type CapturedStatement = {
  sql: string
  bindings: unknown[]
}

const createRecordingD1 = (firstResults: unknown[] = [], runChanges: number[] = []) => {
  const statements: CapturedStatement[] = []
  const batches: unknown[][] = []
  const db = {
    prepare(sql: string) {
      const captured: CapturedStatement = { sql, bindings: [] }
      statements.push(captured)
      const statement = {
        bind(...bindings: unknown[]) {
          captured.bindings = bindings
          return statement
        },
        run() {
          return Promise.resolve({ meta: { changes: runChanges.shift() ?? 1 } })
        },
        first() {
          return Promise.resolve(firstResults.shift() ?? null)
        },
      }

      return statement
    },
    batch(preparedStatements: unknown[]) {
      batches.push(preparedStatements)
      return Promise.resolve(
        preparedStatements.map(() => ({ meta: { changes: runChanges.shift() ?? 1 } })),
      )
    },
  } as unknown as D1Database

  return { db, statements, batches }
}

const createCourseInput = (): CreateCourseInput => ({
  learner: {
    id: 'learner-1',
    name: 'Alice',
    accessCode: 'ABCDEFGH23',
    createdAt: '2026-07-13T00:00:00.000Z',
  },
  course: {
    id: 'course-1',
    learnerId: 'learner-1',
    sourceVersionId: 'version-1',
    currentLessonNo: 1,
    status: 'active',
    createdAt: '2026-07-13T00:00:00.000Z',
  },
})

describe('D1 course repository credential storage', () => {
  it('stores only the access-code hash while returning the one-time raw code to admin creation', async () => {
    const { db, statements } = createRecordingD1()
    const repository = createD1CourseRepository(db)
    const created = await repository.createCourse(createCourseInput())
    const learnerInsert = statements.find((statement) =>
      statement.sql.startsWith('INSERT INTO learners'),
    )

    expect(learnerInsert?.bindings).toEqual([
      'learner-1',
      'Alice',
      'sha256:17190666e16f8d07ca35531be8ac05a695b08ec80bc1ef7303ebf76bba91be49',
      '2026-07-13T00:00:00.000Z',
    ])
    expect(created.learner.accessCode).toBe('ABCDEFGH23')
  })

  it('inserts only the session-token hash using bound D1 parameters', async () => {
    const { db, statements } = createRecordingD1()
    const repository = createD1SessionRepository(db)

    await repository.create({
      id: 'session-1',
      tokenHash: 'sha256:stored-only',
      learnerId: 'learner-1',
      courseId: 'course-1',
      createdAt: '2026-07-13T00:00:00.000Z',
      expiresAt: '2026-08-12T00:00:00.000Z',
      credentialVersion: 1,
    })

    const insert = statements.find((statement) =>
      statement.sql.startsWith('INSERT INTO learner_sessions'),
    )
    expect(insert?.sql).not.toContain('sha256:stored-only')
    expect(insert?.bindings).toEqual([
      'session-1',
      'sha256:stored-only',
      'learner-1',
      'course-1',
      '2026-07-13T00:00:00.000Z',
      '2026-08-12T00:00:00.000Z',
      null,
      1,
      'course-1',
      'learner-1',
      1,
    ])
  })

  it('lazily replaces a legacy plaintext access code after a successful bound lookup', async () => {
    const { db, statements } = createRecordingD1([
      null,
      {
        learner_id: 'learner-1',
        learner_name: 'Alice',
        course_id: 'course-1',
        source_version_id: 'version-1',
        current_lesson_no: 1,
        status: 'active',
        credential_version: 1,
      },
    ])
    const repository = createD1CourseRepository(db)

    const identity = await repository.getCourseIdentityByAccessCode('abcdefgh23')

    expect(identity?.course.id).toBe('course-1')
    expect(statements[0]?.bindings).toEqual([
      'sha256:17190666e16f8d07ca35531be8ac05a695b08ec80bc1ef7303ebf76bba91be49',
    ])
    expect(statements[1]?.bindings).toEqual(['ABCDEFGH23'])
    expect(statements[2]?.sql).toBe(
      'UPDATE learners SET access_code = ? WHERE id = ? AND access_code = ?',
    )
    expect(statements[2]?.bindings).toEqual([
      'sha256:17190666e16f8d07ca35531be8ac05a695b08ec80bc1ef7303ebf76bba91be49',
      'learner-1',
      'ABCDEFGH23',
    ])
  })

  it('rejects a legacy credential when its conditional migration loses a rotation race', async () => {
    const { db } = createRecordingD1(
      [
        null,
        {
          learner_id: 'learner-1',
          learner_name: 'Alice',
          course_id: 'course-1',
          source_version_id: 'version-1',
          current_lesson_no: 1,
          status: 'active',
          credential_version: 1,
        },
        null,
      ],
      [0],
    )
    const repository = createD1CourseRepository(db)

    await expect(repository.getCourseCredentialByAccessCode('abcdefgh23')).resolves.toBeUndefined()
  })

  it('binds an untrusted session hash instead of interpolating it into SQL', async () => {
    const maliciousHash = "sha256:x' OR 1=1 --"
    const { db, statements } = createRecordingD1()
    const repository = createD1SessionRepository(db)

    await expect(repository.getByTokenHash(maliciousHash)).resolves.toBeUndefined()

    expect(statements[0]?.sql).toContain('WHERE learner_sessions.token_hash = ?')
    expect(statements[0]?.sql).not.toContain(maliciousHash)
    expect(statements[0]?.bindings).toEqual([maliciousHash])
  })

  it('binds every learner resource scope in D1 ownership queries', async () => {
    const { db, statements } = createRecordingD1()
    const repository = createD1CourseRepository(db)
    const maliciousId = "resource' OR 1=1 --"

    await repository.getCourseForLearner({ courseId: maliciousId, learnerId: 'learner-1' })
    await repository.getLessonSessionForCourse({
      sessionId: maliciousId,
      courseId: 'course-1',
    })
    await repository.getLessonTaskForResource({
      taskId: maliciousId,
      sessionId: 'session-1',
      courseId: 'course-1',
    })

    expect(statements.map((statement) => statement.bindings)).toEqual([
      [maliciousId, 'learner-1'],
      [maliciousId, 'course-1'],
      [maliciousId, 'session-1', 'course-1'],
    ])
    expect(statements.every((statement) => !statement.sql.includes(maliciousId))).toBe(true)
  })

  it('binds access-code rotation and learner-wide session revocation writes', async () => {
    const { db, statements, batches } = createRecordingD1([], [1, 2])
    const sessionRepository = createD1SessionRepository(db)
    const accessCodeHash = "sha256:x' --"

    await expect(
      sessionRepository.rotateLearnerCredential({
        learnerId: 'learner-1',
        accessCodeHash,
        revokedAt: '2026-07-13T00:00:00.000Z',
      }),
    ).resolves.toBe(2)

    expect(statements[0]).toEqual({
      sql: 'UPDATE learners SET access_code = ?, credential_version = credential_version + 1 WHERE id = ?',
      bindings: [accessCodeHash, 'learner-1'],
    })
    expect(statements[1]).toEqual({
      sql: 'UPDATE learner_sessions SET revoked_at = ? WHERE learner_id = ? AND revoked_at IS NULL',
      bindings: ['2026-07-13T00:00:00.000Z', 'learner-1'],
    })
    expect(batches).toHaveLength(1)
  })
})
