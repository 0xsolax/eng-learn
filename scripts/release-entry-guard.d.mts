import type { ReleaseEntry } from './check-remote-d1-migrations.mjs'

export function assertReleaseWorkerCompatibility(workerArtifact: string): void

export function createReleaseDeployArguments(): string[]

export function executeReleaseEntry(input: {
  entry: ReleaseEntry
  configurationContents: string
  buildRelease: () => Promise<void>
  readArtifactConfiguration: () => Promise<string>
  readWorkerArtifact: () => Promise<string>
  scanArtifacts: () => Promise<void>
  checkRemoteMigrations: (entry: ReleaseEntry) => Promise<unknown>
  readCurrentConfiguration: () => Promise<string>
  deploy: () => Promise<void>
}): Promise<void>
