export type RemoteD1MigrationTarget = {
  accountId: string
  binding: 'DB'
  databaseName: string
  databaseId: string
  migrationsDirectory: string
}

export type RemoteD1Info = {
  name: string
  uuid: string
}

export type RemoteD1Migration = {
  id: number
  name: string
}

export type ReleaseEntry = 'normal' | 'flow-compat' | 'flow-freeze'

export const RELEASE_ENTRY_WRITE_MODES: Readonly<Record<ReleaseEntry, Readonly<{
  queue: 'v2'
  flow: 'rolling_v2' | 'legacy_v1' | 'disabled'
}>>>

export function parseWranglerJsonc(contents: string): unknown

export function assertProductionLessonQueueWriteMode(config: unknown): void

export function assertProductionLessonWriteModes(
  config: unknown,
  entry: ReleaseEntry,
): void

export function assertRemoteMigrationGateConfiguration(
  config: unknown,
  entry?: ReleaseEntry,
): void

export function assertLessonFlowMigrationPresent(
  localMigrationNames: string[],
): void

export function resolveRemoteD1MigrationTarget(
  config: unknown,
): RemoteD1MigrationTarget

export function parseRemoteD1Info(stdout: string): RemoteD1Info

export function parseRemoteD1Migrations(stdout: string): RemoteD1Migration[]

export function assertRemoteD1MigrationParity(input: {
  target: RemoteD1MigrationTarget
  info: RemoteD1Info
  localMigrationNames: string[]
  remoteMigrations: RemoteD1Migration[]
}): void

export function createRemoteD1ReadCommands(
  target: RemoteD1MigrationTarget,
  configPath: string,
): string[][]

export function checkRemoteD1Migrations(entry?: ReleaseEntry): Promise<{
  databaseName: string
  databaseId: string
  migrationCount: number
}>
