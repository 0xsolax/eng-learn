import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  assertLessonFlowMigrationPresent,
  assertProductionLessonQueueWriteMode,
  assertProductionLessonWriteModes,
  assertRemoteMigrationGateConfiguration,
  assertRemoteD1MigrationParity,
  createRemoteD1ReadCommands,
  parseRemoteD1Info,
  parseRemoteD1Migrations,
  parseWranglerJsonc,
  resolveRemoteD1MigrationTarget,
} from '../../scripts/check-remote-d1-migrations.mjs'

const CONFIG = `{
  // Production account and database are intentionally explicit.
  "account_id": "c7ca52deb3d8d683f242d58b95c928b9",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "eng-learn-prod",
      "database_id": "851f7eb3-e88e-40dc-bc83-37f327774067",
      "migrations_dir": "./migrations",
    },
  ],
}`

const LOCAL_MIGRATIONS = [
  '0001_initial.sql',
  '0002_add_review_task_integrity.sql',
]

describe('remote D1 migration release gate', () => {
  it('allows production release only when the lesson queue write mode is explicitly v2', () => {
    const invalidConfigurations = [
      ['missing vars', '{}'],
      ['missing mode', '{ "vars": {} }'],
      ['legacy mode', '{ "vars": { "LESSON_QUEUE_WRITE_MODE": "legacy_v1" } }'],
      ['disabled mode', '{ "vars": { "LESSON_QUEUE_WRITE_MODE": "disabled" } }'],
      ['empty mode', '{ "vars": { "LESSON_QUEUE_WRITE_MODE": "" } }'],
      ['unknown mode', '{ "vars": { "LESSON_QUEUE_WRITE_MODE": "future" } }'],
    ] as const

    for (const [label, contents] of invalidConfigurations) {
      expect(
        () => {
          assertProductionLessonQueueWriteMode(parseWranglerJsonc(contents))
        },
        label,
      ).toThrow(/LESSON_QUEUE_WRITE_MODE.*v2/u)
    }

    expect(() => {
      assertProductionLessonQueueWriteMode(
        parseWranglerJsonc('{ "vars": { "LESSON_QUEUE_WRITE_MODE": "v2" } }'),
      )
    }).not.toThrow()
  })

  it.each([
    ['normal', 'rolling_v2'],
    ['flow-compat', 'legacy_v1'],
    ['flow-freeze', 'disabled'],
  ] as const)('requires the exact queue/flow pair for %s', (entry, flowMode) => {
    const accepted = parseWranglerJsonc(`{
      "vars": {
        "LESSON_QUEUE_WRITE_MODE": "v2",
        "LESSON_FLOW_WRITE_MODE": "${flowMode}"
      }
    }`)

    expect(() => {
      assertProductionLessonWriteModes(accepted, entry)
    }).not.toThrow()

    expect(() => {
      assertProductionLessonWriteModes(
        parseWranglerJsonc(`{
          "vars": {
            "LESSON_QUEUE_WRITE_MODE": "legacy_v1",
            "LESSON_FLOW_WRITE_MODE": "${flowMode}"
          }
        }`),
        entry,
      )
    }).toThrow(/LESSON_QUEUE_WRITE_MODE.*v2/u)

    for (const rejectedFlowMode of ['rolling_v2', 'legacy_v1', 'disabled']) {
      if (rejectedFlowMode === flowMode) continue

      expect(() => {
        assertProductionLessonWriteModes(
          parseWranglerJsonc(`{
            "vars": {
              "LESSON_QUEUE_WRITE_MODE": "v2",
              "LESSON_FLOW_WRITE_MODE": "${rejectedFlowMode}"
            }
          }`),
          entry,
        )
      }).toThrow(new RegExp(`LESSON_FLOW_WRITE_MODE.*${flowMode}`, 'u'))
    }
  })

  it('rejects missing, misplaced, and duplicate flow configuration', () => {
    const rejectedConfigurations = [
      '{}',
      '{ "LESSON_FLOW_WRITE_MODE": "rolling_v2", "vars": { "LESSON_QUEUE_WRITE_MODE": "v2" } }',
      '{ "vars": { "LESSON_QUEUE_WRITE_MODE": "v2" } }',
      '{ "vars": { "LESSON_QUEUE_WRITE_MODE": "v2", "LESSON_FLOW_WRITE_MODE": "rolling_v2", "LESSON_FLOW_WRITE_MODE": "legacy_v1" } }',
    ]

    for (const contents of rejectedConfigurations) {
      expect(() => {
        assertProductionLessonWriteModes(parseWranglerJsonc(contents), 'normal')
      }).toThrow()
    }
  })

  it('keeps standalone parity reads available while the committed release profile stays compat', async () => {
    const contents = await readFile(
      new URL('../../wrangler.jsonc', import.meta.url),
      'utf8',
    )
    const config = parseWranglerJsonc(contents)

    expect(() => {
      assertRemoteMigrationGateConfiguration(config)
    }).not.toThrow()
    expect(() => {
      assertRemoteMigrationGateConfiguration(config, 'flow-compat')
    }).not.toThrow()
    expect(() => {
      assertRemoteMigrationGateConfiguration(config, 'normal')
    }).toThrow(/LESSON_FLOW_WRITE_MODE.*rolling_v2/u)
  })

  it('requires the lesson-flow and learning-run migrations before release', () => {
    expect(() => {
      assertLessonFlowMigrationPresent(['0011_previous.sql', '0012_previous.sql'])
    }).toThrow(/0013_add_lesson_flow_policy_v2\.sql/u)

    expect(() => {
      assertLessonFlowMigrationPresent([
        '0011_previous.sql',
        '0012_previous.sql',
        '0013_add_lesson_flow_policy_v2.sql',
      ])
    }).toThrow(/0014_add_lesson_replay_and_learning_runs\.sql/u)

    expect(() => {
      assertLessonFlowMigrationPresent([
        '0011_previous.sql',
        '0012_previous.sql',
        '0013_add_lesson_flow_policy_v2.sql',
        '0014_add_lesson_replay_and_learning_runs.sql',
      ])
    }).not.toThrow()
  })

  it('parses the production target from JSONC and accepts exact migration parity', () => {
    const target = resolveRemoteD1MigrationTarget(parseWranglerJsonc(CONFIG))
    const info = parseRemoteD1Info(JSON.stringify({
      uuid: target.databaseId,
      name: target.databaseName,
    }))
    const migrations = parseRemoteD1Migrations(JSON.stringify([
      {
        success: true,
        results: LOCAL_MIGRATIONS.map((name, index) => ({ id: index + 1, name })),
        meta: { changed_db: false, rows_written: 0 },
      },
    ]))

    expect(target).toEqual({
      accountId: 'c7ca52deb3d8d683f242d58b95c928b9',
      binding: 'DB',
      databaseName: 'eng-learn-prod',
      databaseId: '851f7eb3-e88e-40dc-bc83-37f327774067',
      migrationsDirectory: './migrations',
    })
    expect(() => {
      assertRemoteD1MigrationParity({
        target,
        info,
        localMigrationNames: LOCAL_MIGRATIONS,
        remoteMigrations: migrations,
      })
    }).not.toThrow()
  })

  it('fails closed when local migrations are missing remotely or ordered differently', () => {
    const target = resolveRemoteD1MigrationTarget(parseWranglerJsonc(CONFIG))
    const info = { name: target.databaseName, uuid: target.databaseId }

    expect(() => {
      assertRemoteD1MigrationParity({
        target,
        info,
        localMigrationNames: [...LOCAL_MIGRATIONS, '0003_pending.sql'],
        remoteMigrations: LOCAL_MIGRATIONS.map((name, index) => ({
          id: index + 1,
          name,
        })),
      })
    }).toThrow(/0003_pending\.sql/u)
    expect(() => {
      assertRemoteD1MigrationParity({
        target,
        info,
        localMigrationNames: LOCAL_MIGRATIONS,
        remoteMigrations: [
          { id: 1, name: LOCAL_MIGRATIONS[1] },
          { id: 2, name: LOCAL_MIGRATIONS[0] },
        ],
      })
    }).toThrow(/order|mismatch/iu)
  })

  it('rejects the wrong database identity and malformed Wrangler output', () => {
    const target = resolveRemoteD1MigrationTarget(parseWranglerJsonc(CONFIG))

    expect(() => {
      assertRemoteD1MigrationParity({
        target,
        info: { name: 'another-db', uuid: target.databaseId },
        localMigrationNames: LOCAL_MIGRATIONS,
        remoteMigrations: LOCAL_MIGRATIONS.map((name, index) => ({
          id: index + 1,
          name,
        })),
      })
    }).toThrow(/identity/iu)
    expect(() => parseRemoteD1Info('not-json')).toThrow(/parse/iu)
    expect(() => parseRemoteD1Migrations('{"success":true}')).toThrow(/parse/iu)
  })

  it('constructs only read-only Wrangler commands', () => {
    const target = resolveRemoteD1MigrationTarget(parseWranglerJsonc(CONFIG))
    const commands = createRemoteD1ReadCommands(target, '/repo/wrangler.jsonc')
    const serialized = JSON.stringify(commands)

    expect(commands).toHaveLength(2)
    expect(commands[0]).toContain('info')
    expect(commands[1]).toContain('execute')
    expect(commands[1]).toContain('SELECT id, name FROM d1_migrations ORDER BY id')
    expect(serialized).not.toMatch(/\b(?:apply|migrate|insert|update|delete)\b/iu)
  })
})
