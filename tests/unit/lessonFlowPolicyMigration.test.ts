import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const baseMigrationPaths = [
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
]
const flowMigrationPath = '../../migrations/0013_add_lesson_flow_policy_v2.sql'

const applyMigration = (database: DatabaseSync, path: string): void => {
  database.exec(readFileSync(new URL(path, import.meta.url), 'utf8'))
}

const createLegacyDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const path of baseMigrationPaths) applyMigration(database, path)

  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-1', 'Source', '2026-07-18T00:00:00.000Z');
    INSERT INTO source_versions (
      id, source_id, version_no, status, created_at, published_at
    ) VALUES (
      'version-1', 'source-1', 1, 'published',
      '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO word_groups (
      id, source_version_id, group_index, start_order_index, end_order_index, created_at
    ) VALUES (
      'group-1', 'version-1', 1, 1, 30, '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO learners (id, name, access_code, created_at)
    VALUES ('learner-1', 'Alice', 'CODE-1', '2026-07-18T00:00:00.000Z');
    INSERT INTO courses (
      id, learner_id, source_version_id, current_lesson_no, status, created_at
    ) VALUES (
      'course-1', 'learner-1', 'version-1', 1, 'active',
      '2026-07-18T00:00:00.000Z'
    );
  `)

  const insertWord = database.prepare(`
    INSERT INTO words (
      id, source_version_id, order_index, word, meaning, example_sentence, created_at
    ) VALUES (?, 'version-1', ?, ?, ?, '', '2026-07-18T00:00:00.000Z')
  `)
  for (let index = 1; index <= 30; index += 1) {
    insertWord.run(
      `word-${String(index)}`,
      index,
      `word${String(index)}`,
      `meaning${String(index)}`,
    )
  }

  database.exec(`
    INSERT INTO lesson_sessions (
      id, course_id, lesson_no, status, task_count, completed_task_count,
      correct_count, wrong_count, started_at, queue_policy_version
    ) VALUES (
      'session-legacy', 'course-1', 1, 'started', 1, 1, 0, 1,
      '2026-07-18T00:00:00.000Z', 'v2_3_6_cap3'
    );
    INSERT INTO lesson_tasks (
      id, session_id, course_id, word_id, stage, task_type, prompt_json,
      answer_json, order_index, status, role, required, created_at
    ) VALUES (
      'task-legacy', 'session-legacy', 'course-1', 'word-1', 'S0',
      'recognize_meaning', '{}', '{}', 1, 'completed', 'primary', 0,
      '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO review_logs (
      id, session_id, task_id, course_id, word_id, stage, task_type,
      correct_answer, score, lesson_no, created_at, queue_disposition
    ) VALUES (
      'review-legacy', 'session-legacy', 'task-legacy', 'course-1', 'word-1',
      'S0', 'recognize_meaning', 'known', 0, 1,
      '2026-07-18T00:00:00.000Z', 'deferred_capacity'
    );
  `)

  return database
}

const applyFlowMigration = (database: DatabaseSync): void => {
  applyMigration(database, flowMigrationPath)
}

type FlowPolicyVersion =
  | 'v1_due_then_new_unbounded'
  | 'v2_rolling_reinforcement_budget24'

const createCurrentDatabase = (): DatabaseSync => {
  const database = createLegacyDatabase()
  applyFlowMigration(database)
  return database
}

const insertSession = (
  database: DatabaseSync,
  input: {
    id: string
    lessonNo: number
    flowPolicy?: FlowPolicyVersion
    queuePolicy?: 'v1_5_8_unbounded' | 'v2_3_6_cap3'
  },
): void => {
  database.prepare(`
    INSERT INTO lesson_sessions (
      id, course_id, lesson_no, status, started_at,
      queue_policy_version, flow_policy_version
    ) VALUES (?, 'course-1', ?, 'started', '2026-07-18T00:00:00.000Z', ?, ?)
  `).run(
    input.id,
    input.lessonNo,
    input.queuePolicy ?? 'v2_3_6_cap3',
    input.flowPolicy ?? 'v2_rolling_reinforcement_budget24',
  )
}

const insertWordState = (
  database: DatabaseSync,
  input: { wordNumber: number; firstLessonNo: number },
): void => {
  database.prepare(`
    INSERT INTO user_word_states (
      id, course_id, word_id, group_id, stage, first_lesson_no,
      next_due_lesson_no, status, created_at, updated_at
    ) VALUES (
      ?, 'course-1', ?, 'group-1', 'S1', ?, ?, 'active',
      '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'
    )
  `).run(
    `state-${String(input.wordNumber)}`,
    `word-${String(input.wordNumber)}`,
    input.firstLessonNo,
    input.firstLessonNo + 1,
  )
}

const insertSourceTask = (
  database: DatabaseSync,
  input: {
    id: string
    sessionId: string
    wordNumber: number
    orderIndex?: number
    stage?: string
    role?: 'primary' | 'bridge' | 'reflux'
    status?: string
    score?: number | null
  },
): void => {
  database.prepare(`
    INSERT INTO lesson_tasks (
      id, session_id, course_id, word_id, stage, task_type, prompt_json,
      answer_json, order_index, status, role, required, created_at
    ) VALUES (
      ?, ?, 'course-1', ?, ?, 'recognize_meaning', '{}', '{}', ?, ?, ?, 0,
      '2026-07-18T00:00:00.000Z'
    )
  `).run(
    input.id,
    input.sessionId,
    `word-${String(input.wordNumber)}`,
    input.stage ?? 'S0',
    input.orderIndex ?? 1,
    input.status ?? 'completed',
    input.role ?? 'primary',
  )

  if (input.score === null) return
  const score = input.score ?? 2
  database.prepare(`
    INSERT INTO review_logs (
      id, session_id, task_id, course_id, word_id, stage, task_type,
      correct_answer, score, lesson_no, created_at, queue_disposition
    ) SELECT
      ?, lesson_sessions.id, ?, lesson_sessions.course_id, ?, ?,
      'recognize_meaning', 'known', ?, lesson_sessions.lesson_no,
      '2026-07-18T00:00:00.000Z', ?
    FROM lesson_sessions
    WHERE lesson_sessions.id = ?
  `).run(
    `review-${input.id}`,
    input.id,
    `word-${String(input.wordNumber)}`,
    input.stage ?? 'S0',
    score,
    score < 2 ? 'scheduled' : null,
    input.sessionId,
  )
}

const insertPlannedChild = (
  database: DatabaseSync,
  input: {
    id: string
    sourceTaskId: string | null
    sessionId: string
    wordNumber: number
    orderIndex?: number
    stage?: string
    role?: 'primary' | 'bridge' | 'reflux'
    required?: number
    refluxSourceTaskId?: string | null
  },
): void => {
  database.prepare(`
    INSERT INTO lesson_tasks (
      id, session_id, course_id, word_id, stage, task_type, prompt_json,
      answer_json, order_index, status, role, required, reflux_source_task_id,
      reinforcement_source_task_id, created_at
    ) VALUES (
      ?, ?, 'course-1', ?, ?, 'recall_word', '{}', '{}', ?, 'pending', ?, ?, ?, ?,
      '2026-07-18T00:00:00.000Z'
    )
  `).run(
    input.id,
    input.sessionId,
    `word-${String(input.wordNumber)}`,
    input.stage ?? 'S1',
    input.orderIndex ?? 2,
    input.role ?? 'bridge',
    input.required ?? 1,
    input.refluxSourceTaskId ?? null,
    input.sourceTaskId,
  )
}

const insertGenericTask = (
  database: DatabaseSync,
  input: { id: string; sessionId: string; wordNumber: number; orderIndex: number },
): void => {
  database.prepare(`
    INSERT INTO lesson_tasks (
      id, session_id, course_id, word_id, stage, task_type, prompt_json,
      answer_json, order_index, status, role, required, created_at
    ) VALUES (
      ?, ?, 'course-1', ?, 'S0', 'recognize_meaning', '{}', '{}', ?,
      'pending', 'primary', 0, '2026-07-18T00:00:00.000Z'
    )
  `).run(
    input.id,
    input.sessionId,
    `word-${String(input.wordNumber)}`,
    input.orderIndex,
  )
}

const insertReviewWithCapacityReason = (
  database: DatabaseSync,
  input: {
    id: string
    sessionId: string
    wordNumber: number
    orderIndex: number
    score: number
    disposition: 'scheduled' | 'deferred_cap' | 'deferred_capacity' | null
    reason: string | null
  },
): void => {
  insertGenericTask(database, {
    id: `reason-task-${input.id}`,
    sessionId: input.sessionId,
    wordNumber: input.wordNumber,
    orderIndex: input.orderIndex,
  })
  database.prepare(`
    INSERT INTO review_logs (
      id, session_id, task_id, course_id, word_id, stage, task_type,
      correct_answer, score, lesson_no, created_at, queue_disposition,
      queue_capacity_reason
    ) SELECT
      ?, lesson_sessions.id, ?, lesson_sessions.course_id, ?, 'S0',
      'recognize_meaning', 'known', ?, lesson_sessions.lesson_no,
      '2026-07-18T00:00:00.000Z', ?, ?
    FROM lesson_sessions
    WHERE lesson_sessions.id = ?
  `).run(
    `reason-review-${input.id}`,
    `reason-task-${input.id}`,
    `word-${String(input.wordNumber)}`,
    input.score,
    input.disposition,
    input.reason,
    input.sessionId,
  )
}

describe('lesson flow policy migration', () => {
  it('additively backfills flow v1 and rejects an invalid flow/queue combination', () => {
    const database = createLegacyDatabase()

    applyFlowMigration(database)

    expect(
      database.prepare(`
        SELECT flow_policy_version AS flowPolicyVersion
        FROM lesson_sessions
        WHERE id = 'session-legacy'
      `).get(),
    ).toEqual({ flowPolicyVersion: 'v1_due_then_new_unbounded' })
    expect(
      database.prepare(`
        SELECT queue_capacity_reason AS queueCapacityReason
        FROM review_logs
        WHERE id = 'review-legacy'
      `).get(),
    ).toEqual({ queueCapacityReason: null })

    expect(() => {
      database.exec(`
        INSERT INTO lesson_sessions (
          id, course_id, lesson_no, status, started_at,
          queue_policy_version, flow_policy_version
        ) VALUES (
          'session-invalid-combination', 'course-1', 2, 'started',
          '2026-07-18T00:00:00.000Z', 'v1_5_8_unbounded',
          'v2_rolling_reinforcement_budget24'
        )
      `)
    }).toThrow(/lesson_session_flow_queue_policy_mismatch/u)

    expect(() => {
      database.exec(`
        INSERT INTO lesson_sessions (
          id, course_id, lesson_no, status, started_at,
          queue_policy_version, flow_policy_version
        ) VALUES (
          'session-v2', 'course-1', 2, 'started',
          '2026-07-18T00:00:00.000Z', 'v2_3_6_cap3',
          'v2_rolling_reinforcement_budget24'
        )
      `)
    }).not.toThrow()

    expect(() => {
      database.exec(`
        UPDATE lesson_sessions
        SET flow_policy_version = 'v2_rolling_reinforcement_budget24'
        WHERE id = 'session-legacy'
      `)
    }).toThrow(/lesson_session_flow_policy_immutable/u)

    expect(() => {
      database.exec(`
        INSERT INTO lesson_sessions (
          id, course_id, lesson_no, status, started_at, flow_policy_version
        ) VALUES (
          'session-invalid-value', 'course-1', 3, 'started',
          '2026-07-18T00:00:00.000Z', 'unknown'
        )
      `)
    }).toThrow()

    database.close()
  })

  it('accepts exactly one immutable planned child for a valid completed S0 source', () => {
    const database = createCurrentDatabase()
    insertSession(database, { id: 'session-planned', lessonNo: 2 })
    insertWordState(database, { wordNumber: 2, firstLessonNo: 2 })
    insertSourceTask(database, {
      id: 'source-task-2',
      sessionId: 'session-planned',
      wordNumber: 2,
    })

    expect(() => {
      insertPlannedChild(database, {
        id: 'planned-task-2',
        sourceTaskId: 'source-task-2',
        sessionId: 'session-planned',
        wordNumber: 2,
      })
    }).not.toThrow()

    expect(() => {
      insertPlannedChild(database, {
        id: 'planned-task-2-duplicate',
        sourceTaskId: 'source-task-2',
        sessionId: 'session-planned',
        wordNumber: 2,
        orderIndex: 3,
      })
    }).toThrow()
    expect(() => {
      database.exec(`
        UPDATE lesson_tasks
        SET reinforcement_source_task_id = NULL
        WHERE id = 'planned-task-2'
      `)
    }).toThrow(/lesson_task_reinforcement_source_immutable/u)

    database.close()
  })

  it('rejects planned children without the required source, state, log, and session invariants', () => {
    const database = createCurrentDatabase()
    insertSession(database, { id: 'session-valid', lessonNo: 2 })
    insertSession(database, { id: 'session-other', lessonNo: 3 })
    insertSession(database, {
      id: 'session-flow-v1',
      lessonNo: 4,
      flowPolicy: 'v1_due_then_new_unbounded',
    })

    insertWordState(database, { wordNumber: 2, firstLessonNo: 2 })
    insertWordState(database, { wordNumber: 3, firstLessonNo: 1 })
    insertWordState(database, { wordNumber: 4, firstLessonNo: 2 })
    insertWordState(database, { wordNumber: 5, firstLessonNo: 2 })
    insertWordState(database, { wordNumber: 6, firstLessonNo: 2 })
    insertWordState(database, { wordNumber: 7, firstLessonNo: 4 })

    insertSourceTask(database, {
      id: 'source-valid',
      sessionId: 'session-valid',
      wordNumber: 2,
    })
    insertSourceTask(database, {
      id: 'source-state-mismatch',
      sessionId: 'session-valid',
      wordNumber: 3,
      orderIndex: 2,
    })
    insertSourceTask(database, {
      id: 'source-no-log',
      sessionId: 'session-valid',
      wordNumber: 4,
      orderIndex: 3,
      score: null,
    })
    insertSourceTask(database, {
      id: 'source-wrong-stage',
      sessionId: 'session-valid',
      wordNumber: 5,
      orderIndex: 4,
      stage: 'S1',
    })
    insertSourceTask(database, {
      id: 'source-failing-log',
      sessionId: 'session-valid',
      wordNumber: 6,
      orderIndex: 5,
      score: 0,
    })
    insertSourceTask(database, {
      id: 'source-flow-v1',
      sessionId: 'session-flow-v1',
      wordNumber: 7,
    })

    const invalidCases = [
      {
        id: 'planned-missing-source',
        sourceTaskId: 'missing-source',
        sessionId: 'session-valid',
        wordNumber: 2,
        orderIndex: 6,
      },
      {
        id: 'planned-wrong-session',
        sourceTaskId: 'source-valid',
        sessionId: 'session-other',
        wordNumber: 2,
        orderIndex: 1,
      },
      {
        id: 'planned-wrong-word',
        sourceTaskId: 'source-valid',
        sessionId: 'session-valid',
        wordNumber: 8,
        orderIndex: 7,
      },
      {
        id: 'planned-state-mismatch',
        sourceTaskId: 'source-state-mismatch',
        sessionId: 'session-valid',
        wordNumber: 3,
        orderIndex: 8,
      },
      {
        id: 'planned-no-log',
        sourceTaskId: 'source-no-log',
        sessionId: 'session-valid',
        wordNumber: 4,
        orderIndex: 9,
      },
      {
        id: 'planned-wrong-source-stage',
        sourceTaskId: 'source-wrong-stage',
        sessionId: 'session-valid',
        wordNumber: 5,
        orderIndex: 10,
      },
      {
        id: 'planned-failing-log',
        sourceTaskId: 'source-failing-log',
        sessionId: 'session-valid',
        wordNumber: 6,
        orderIndex: 11,
      },
      {
        id: 'planned-flow-v1',
        sourceTaskId: 'source-flow-v1',
        sessionId: 'session-flow-v1',
        wordNumber: 7,
        orderIndex: 2,
      },
      {
        id: 'planned-invalid-shape',
        sourceTaskId: 'source-valid',
        sessionId: 'session-valid',
        wordNumber: 2,
        orderIndex: 12,
        role: 'primary' as const,
      },
    ]

    for (const invalidCase of invalidCases) {
      expect(
        () => { insertPlannedChild(database, invalidCase) },
        invalidCase.id,
      ).toThrow(/lesson_task_reinforcement_mismatch/u)
    }

    database.close()
  })

  it('limits a flow v2 session to three planned reinforcement children', () => {
    const database = createCurrentDatabase()
    insertSession(database, { id: 'session-planned-cap', lessonNo: 2 })

    for (let wordNumber = 2; wordNumber <= 5; wordNumber += 1) {
      insertWordState(database, { wordNumber, firstLessonNo: 2 })
      insertSourceTask(database, {
        id: `source-cap-${String(wordNumber)}`,
        sessionId: 'session-planned-cap',
        wordNumber,
        orderIndex: wordNumber - 1,
      })
    }
    for (let wordNumber = 2; wordNumber <= 4; wordNumber += 1) {
      insertPlannedChild(database, {
        id: `planned-cap-${String(wordNumber)}`,
        sourceTaskId: `source-cap-${String(wordNumber)}`,
        sessionId: 'session-planned-cap',
        wordNumber,
        orderIndex: wordNumber + 3,
      })
    }

    expect(() => {
      database.exec(`
        INSERT INTO lesson_tasks (
          id, session_id, course_id, word_id, stage, task_type, prompt_json,
          answer_json, order_index, status, role, required,
          reinforcement_source_task_id, created_at
        ) VALUES (
          'planned-cap-2', 'session-planned-cap', 'course-1', 'word-2', 'S1',
          'recall_word', '{"upserted":true}', '{}', 5, 'pending', 'bridge', 1,
          'source-cap-2', '2026-07-18T00:00:00.000Z'
        )
        ON CONFLICT(id) DO UPDATE SET prompt_json = excluded.prompt_json
      `)
    }).not.toThrow()

    expect(() => {
      insertPlannedChild(database, {
        id: 'planned-cap-fourth',
        sourceTaskId: 'source-cap-5',
        sessionId: 'session-planned-cap',
        wordNumber: 5,
        orderIndex: 8,
      })
    }).toThrow(/lesson_session_planned_reinforcement_limit/u)
    expect(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM lesson_tasks
        WHERE session_id = 'session-planned-cap'
          AND reinforcement_source_task_id IS NOT NULL
      `).get(),
    ).toEqual({ count: 3 })

    database.close()
  })

  it('caps new flow v2 task ids at 24 without blocking updates or id-based upserts', () => {
    const database = createCurrentDatabase()
    insertSession(database, { id: 'session-task-cap', lessonNo: 2 })

    for (let index = 1; index <= 24; index += 1) {
      insertGenericTask(database, {
        id: `cap-task-${String(index)}`,
        sessionId: 'session-task-cap',
        wordNumber: index,
        orderIndex: index,
      })
    }

    expect(() => {
      database.exec(`
        UPDATE lesson_tasks
        SET prompt_json = '{"updated":true}'
        WHERE id = 'cap-task-1'
      `)
    }).not.toThrow()
    expect(() => {
      database.exec(`
        INSERT INTO lesson_tasks (
          id, session_id, course_id, word_id, stage, task_type, prompt_json,
          answer_json, order_index, status, role, required, created_at
        ) VALUES (
          'cap-task-1', 'session-task-cap', 'course-1', 'word-1', 'S0',
          'recognize_meaning', '{"upserted":true}', '{}', 1, 'pending',
          'primary', 0, '2026-07-18T00:00:00.000Z'
        )
        ON CONFLICT(id) DO UPDATE SET prompt_json = excluded.prompt_json
      `)
    }).not.toThrow()
    expect(
      database.prepare(`
        SELECT prompt_json AS promptJson
        FROM lesson_tasks
        WHERE id = 'cap-task-1'
      `).get(),
    ).toEqual({ promptJson: '{"upserted":true}' })

    expect(() => {
      insertGenericTask(database, {
        id: 'cap-task-25',
        sessionId: 'session-task-cap',
        wordNumber: 25,
        orderIndex: 25,
      })
    }).toThrow(/lesson_session_task_limit/u)

    insertSession(database, {
      id: 'session-flow-v1-unbounded',
      lessonNo: 3,
      flowPolicy: 'v1_due_then_new_unbounded',
    })
    for (let index = 1; index <= 25; index += 1) {
      insertGenericTask(database, {
        id: `legacy-unbounded-${String(index)}`,
        sessionId: 'session-flow-v1-unbounded',
        wordNumber: index,
        orderIndex: index,
      })
    }
    expect(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM lesson_tasks
        WHERE session_id = 'session-flow-v1-unbounded'
      `).get(),
    ).toEqual({ count: 25 })

    expect(() => {
      database.exec(`
        UPDATE lesson_tasks
        SET session_id = 'session-task-cap', order_index = 25
        WHERE id = 'legacy-unbounded-1'
      `)
    }).toThrow(/lesson_session_task_limit/u)

    database.close()
  })

  it('requires capacity reasons only for flow v2 deferred-capacity outcomes', () => {
    const database = createCurrentDatabase()
    insertSession(database, { id: 'session-reason-v2', lessonNo: 2 })
    insertSession(database, {
      id: 'session-reason-v1',
      lessonNo: 3,
      flowPolicy: 'v1_due_then_new_unbounded',
    })

    expect(() => {
      insertReviewWithCapacityReason(database, {
        id: 'v1-legacy-capacity',
        sessionId: 'session-reason-v1',
        wordNumber: 2,
        orderIndex: 1,
        score: 0,
        disposition: 'deferred_capacity',
        reason: null,
      })
    }).not.toThrow()
    expect(() => {
      insertReviewWithCapacityReason(database, {
        id: 'v1-reason-forbidden',
        sessionId: 'session-reason-v1',
        wordNumber: 3,
        orderIndex: 2,
        score: 0,
        disposition: 'deferred_capacity',
        reason: 'short_pool',
      })
    }).toThrow(/review_log_queue_capacity_reason_mismatch/u)
    expect(() => {
      insertReviewWithCapacityReason(database, {
        id: 'v2-reason-required',
        sessionId: 'session-reason-v2',
        wordNumber: 4,
        orderIndex: 1,
        score: 0,
        disposition: 'deferred_capacity',
        reason: null,
      })
    }).toThrow(/review_log_queue_capacity_reason_mismatch/u)
    expect(() => {
      insertReviewWithCapacityReason(database, {
        id: 'v2-capacity-valid',
        sessionId: 'session-reason-v2',
        wordNumber: 5,
        orderIndex: 2,
        score: 0,
        disposition: 'deferred_capacity',
        reason: 'lesson_task_budget',
      })
    }).not.toThrow()
    expect(() => {
      insertReviewWithCapacityReason(database, {
        id: 'v2-scheduled-reason-forbidden',
        sessionId: 'session-reason-v2',
        wordNumber: 6,
        orderIndex: 3,
        score: 0,
        disposition: 'scheduled',
        reason: 'short_pool',
      })
    }).toThrow(/review_log_queue_capacity_reason_mismatch/u)
    expect(() => {
      insertReviewWithCapacityReason(database, {
        id: 'v2-invalid-reason',
        sessionId: 'session-reason-v2',
        wordNumber: 7,
        orderIndex: 4,
        score: 0,
        disposition: 'deferred_capacity',
        reason: 'unknown',
      })
    }).toThrow()

    database.close()
  })

  it('keeps a recorded capacity reason immutable', () => {
    const database = createCurrentDatabase()
    insertSession(database, { id: 'session-reason-immutable', lessonNo: 2 })
    insertReviewWithCapacityReason(database, {
      id: 'immutable',
      sessionId: 'session-reason-immutable',
      wordNumber: 2,
      orderIndex: 1,
      score: 0,
      disposition: 'deferred_capacity',
      reason: 'short_pool',
    })

    expect(() => {
      database.exec(`
        UPDATE review_logs
        SET queue_capacity_reason = 'interval_infeasible'
        WHERE id = 'reason-review-immutable'
      `)
    }).toThrow(/review_log_queue_capacity_reason_immutable/u)
    expect(
      database.prepare(`
        SELECT queue_capacity_reason AS queueCapacityReason
        FROM review_logs
        WHERE id = 'reason-review-immutable'
      `).get(),
    ).toEqual({ queueCapacityReason: 'short_pool' })

    database.close()
  })
})
