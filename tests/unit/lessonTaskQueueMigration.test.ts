import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

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

const createMigratedDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')

  for (const migrationPath of migrationPaths) {
    database.exec(readFileSync(new URL(migrationPath, import.meta.url), 'utf8'))
  }

  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-1', 'Source', '2026-07-13T00:00:00.000Z');
    INSERT INTO source_versions (
      id, source_id, version_no, status, created_at, published_at
    ) VALUES (
      'version-1', 'source-1', 1, 'published',
      '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z'
    );
    INSERT INTO words (
      id, source_version_id, order_index, word, meaning, example_sentence, created_at
    ) VALUES (
      'word-1', 'version-1', 1, 'hello', '你好', '', '2026-07-13T00:00:00.000Z'
    );
    INSERT INTO learners (id, name, access_code, created_at)
    VALUES ('learner-1', 'Alice', 'CODE-1', '2026-07-13T00:00:00.000Z');
    INSERT INTO courses (
      id, learner_id, source_version_id, current_lesson_no, status, created_at
    ) VALUES (
      'course-1', 'learner-1', 'version-1', 1, 'active', '2026-07-13T00:00:00.000Z'
    );
    INSERT INTO lesson_sessions (
      id, course_id, lesson_no, status, started_at
    ) VALUES (
      'session-1', 'course-1', 1, 'started', '2026-07-13T00:00:00.000Z'
    );
  `)

  return database
}

const insertTask = (
  database: DatabaseSync,
  input: {
    id: string
    sessionId?: string
    courseId?: string
    role: 'primary' | 'bridge' | 'reflux'
    refluxSourceTaskId?: string
    orderIndex: number
  },
) =>
  database
    .prepare(`
      INSERT INTO lesson_tasks (
        id, session_id, course_id, word_id, stage, task_type, prompt_json,
        answer_json, order_index, status, role, required, reflux_source_task_id,
        created_at
      ) VALUES (?, ?, ?, 'word-1', 'S0', 'recognize_meaning', ?, ?, ?, 'pending', ?, ?, ?, ?)
    `)
    .run(
      input.id,
      input.sessionId ?? 'session-1',
      input.courseId ?? 'course-1',
      JSON.stringify({ word: 'hello', meaning: '你好', exampleSentence: '' }),
      JSON.stringify({ word: 'hello', expectedResponse: 'known' }),
      input.orderIndex,
      input.role,
      input.role === 'primary' ? 0 : 1,
      input.refluxSourceTaskId ?? null,
      '2026-07-13T00:00:00.000Z',
    )

describe('lesson task queue migration integrity', () => {
  it('reconstructs legacy reflux chains and unambiguous pre-integrity review links', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    database.exec(readFileSync(new URL(migrationPaths[0] ?? '', import.meta.url), 'utf8'))
    database.exec(`
      INSERT INTO word_sources (id, name, created_at)
      VALUES ('source-legacy', 'Legacy source', '2026-07-01T00:00:00.000Z');
      INSERT INTO source_versions (
        id, source_id, version_no, status, created_at, published_at
      ) VALUES (
        'version-legacy', 'source-legacy', 1, 'published',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
      );
      INSERT INTO words (
        id, source_version_id, order_index, word, meaning, example_sentence, created_at
      ) VALUES
        ('word-legacy', 'version-legacy', 1, 'hello', '你好',
          'I said hello.', '2026-07-01T00:00:00.000Z'),
        ('word-ambiguous', 'version-legacy', 2, 'world', '世界',
          'Hello world.', '2026-07-01T00:00:00.000Z');
      INSERT INTO word_groups (
        id, source_version_id, group_index, start_order_index, end_order_index, created_at
      ) VALUES (
        'group-legacy', 'version-legacy', 1, 1, 1, '2026-07-01T00:00:00.000Z'
      );
      INSERT INTO learners (id, name, access_code, created_at)
      VALUES ('learner-legacy', 'Alice', 'LEGACYCODE', '2026-07-01T00:00:00.000Z');
      INSERT INTO courses (
        id, learner_id, source_version_id, current_lesson_no, status, created_at
      ) VALUES (
        'course-legacy', 'learner-legacy', 'version-legacy', 2, 'active',
        '2026-07-01T00:00:00.000Z'
      );
      INSERT INTO lesson_sessions (
        id, course_id, lesson_no, status, task_count, completed_task_count,
        correct_count, wrong_count, started_at, completed_at
      ) VALUES (
        'session-legacy', 'course-legacy', 1, 'completed', 3, 3, 2, 1,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:10:00.000Z'
      );
      INSERT INTO lesson_tasks (
        id, session_id, course_id, word_id, stage, task_type, prompt_json,
        answer_json, order_index, status, created_at
      ) VALUES
        ('task-primary', 'session-legacy', 'course-legacy', 'word-legacy', 'S0',
          'recognize_meaning', '{"word":"hello","meaning":"你好","exampleSentence":"I said hello."}',
          '{"word":"hello","meaning":"你好"}', 1, 'completed', '2026-07-01T00:00:00.000Z'),
        ('task-reflux-1', 'session-legacy', 'course-legacy', 'word-legacy', 'S0',
          'recognize_meaning', '{"word":"hello","meaning":"你好","exampleSentence":"I said hello."}',
          '{"word":"hello","meaning":"你好"}', 2, 'completed', '2026-07-01T00:01:00.000Z'),
        ('task-reflux-2', 'session-legacy', 'course-legacy', 'word-legacy', 'S0',
          'recognize_meaning', '{"word":"hello","meaning":"你好","exampleSentence":"I said hello."}',
          '{"word":"hello","meaning":"你好"}', 3, 'completed', '2026-07-01T00:02:00.000Z'),
        ('task-ambiguous-primary', 'session-legacy', 'course-legacy', 'word-ambiguous', 'S0',
          'recognize_meaning', '{"word":"world","meaning":"世界","exampleSentence":"Hello world."}',
          '{"word":"world","meaning":"世界"}', 4, 'completed', '2026-07-01T00:03:00.000Z'),
        ('task-ambiguous-reflux', 'session-legacy', 'course-legacy', 'word-ambiguous', 'S0',
          'recognize_meaning', '{"word":"world","meaning":"世界","exampleSentence":"Hello world."}',
          '{"word":"world","meaning":"世界"}', 5, 'pending', '2026-07-01T00:04:00.000Z');
      INSERT INTO review_logs (
        id, session_id, course_id, word_id, stage, task_type, user_answer,
        correct_answer, score, lesson_no, created_at
      ) VALUES
        ('review-primary', 'session-legacy', 'course-legacy', 'word-legacy', 'S0',
          'recognize_meaning', 'learning', 'hello', 0, 1, '2026-07-01T00:01:00.000Z'),
        ('review-reflux-1', 'session-legacy', 'course-legacy', 'word-legacy', 'S0',
          'recognize_meaning', 'known', 'hello', 2, 1, '2026-07-01T00:02:00.000Z'),
        ('review-reflux-2', 'session-legacy', 'course-legacy', 'word-legacy', 'S0',
          'recognize_meaning', 'known', 'hello', 2, 1, '2026-07-01T00:03:00.000Z'),
        ('review-ambiguous-1', 'session-legacy', 'course-legacy', 'word-ambiguous', 'S0',
          'recognize_meaning', 'learning', 'world', 0, 1, '2026-07-01T00:04:00.000Z'),
        ('review-ambiguous-2', 'session-legacy', 'course-legacy', 'word-ambiguous', 'S0',
          'recognize_meaning', 'learning', 'world', 0, 1, '2026-07-01T00:05:00.000Z');
    `)

    for (const migrationPath of migrationPaths.slice(1)) {
      database.exec(readFileSync(new URL(migrationPath, import.meta.url), 'utf8'))
    }

    expect(
      database.prepare(`
        SELECT id, role, required, reflux_source_task_id AS refluxSourceTaskId
        FROM lesson_tasks
        WHERE word_id = 'word-legacy'
        ORDER BY order_index
      `).all(),
    ).toEqual([
      { id: 'task-primary', role: 'primary', required: 0, refluxSourceTaskId: null },
      { id: 'task-reflux-1', role: 'reflux', required: 1, refluxSourceTaskId: 'task-primary' },
      { id: 'task-reflux-2', role: 'reflux', required: 1, refluxSourceTaskId: 'task-reflux-1' },
    ])
    expect(
      database.prepare(`
        SELECT id, task_id AS taskId
        FROM review_logs
        WHERE word_id = 'word-legacy'
        ORDER BY created_at
      `).all(),
    ).toEqual([
      { id: 'review-primary', taskId: 'task-primary' },
      { id: 'review-reflux-1', taskId: 'task-reflux-1' },
      { id: 'review-reflux-2', taskId: 'task-reflux-2' },
    ])
    expect(
      database.prepare(`
        SELECT id, task_id AS taskId
        FROM review_logs
        WHERE word_id = 'word-ambiguous'
        ORDER BY created_at
      `).all(),
    ).toEqual([
      { id: 'review-ambiguous-1', taskId: null },
      { id: 'review-ambiguous-2', taskId: null },
    ])

    database.close()
  })

  it('rejects task rows whose session and course do not form one resource chain', () => {
    const database = createMigratedDatabase()

    expect(() =>
      insertTask(database, {
        id: 'task-cross-course',
        courseId: 'course-other',
        role: 'primary',
        orderIndex: 1,
      }),
    ).toThrow('lesson_task_scope_mismatch')

    database.close()
  })

  it('requires a same-session source and only one reflux per source task', () => {
    const database = createMigratedDatabase()
    insertTask(database, { id: 'task-primary', role: 'primary', orderIndex: 1 })

    expect(() =>
      insertTask(database, {
        id: 'task-reflux-missing',
        role: 'reflux',
        refluxSourceTaskId: 'task-missing',
        orderIndex: 2,
      }),
    ).toThrow('lesson_task_reflux_source_mismatch')

    insertTask(database, {
      id: 'task-reflux',
      role: 'reflux',
      refluxSourceTaskId: 'task-primary',
      orderIndex: 2,
    })
    expect(() =>
      insertTask(database, {
        id: 'task-reflux-duplicate',
        role: 'reflux',
        refluxSourceTaskId: 'task-primary',
        orderIndex: 3,
      }),
    ).toThrow()

    database.close()
  })

  it('does not reinterpret a queue that already carries explicit metadata', () => {
    const database = createMigratedDatabase()
    insertTask(database, { id: 'task-primary', role: 'primary', orderIndex: 1 })
    insertTask(database, { id: 'task-bridge', role: 'bridge', orderIndex: 2 })
    insertTask(database, {
      id: 'task-reflux',
      role: 'reflux',
      refluxSourceTaskId: 'task-primary',
      orderIndex: 3,
    })
    const before = database.prepare(`
      SELECT id, role, required, reflux_source_task_id AS refluxSourceTaskId
      FROM lesson_tasks
      ORDER BY order_index
    `).all()

    database.exec(
      readFileSync(
        new URL('../../migrations/0007_backfill_legacy_lesson_runtime.sql', import.meta.url),
        'utf8',
      ),
    )

    expect(
      database.prepare(`
        SELECT id, role, required, reflux_source_task_id AS refluxSourceTaskId
        FROM lesson_tasks
        ORDER BY order_index
      `).all(),
    ).toEqual(before)

    database.close()
  })
})
