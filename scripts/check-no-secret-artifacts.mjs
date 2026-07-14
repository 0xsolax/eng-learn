import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import process from 'node:process'

const defaultRoots = ['dist/client', 'dist/eng_learn', 'test-results', 'playwright-report']
const textExtensions = /\.(?:css|html|js|json|log|map|md|mjs|txt)$/i
const secretFileName = /^(?:\.dev\.vars(?:\..+)?|\.env(?:\..+)?)$/i
const sensitiveTestArtifact = /^(?:trace\.zip|.+\.har|storage[-_.]?state(?:\..+)?\.json)$/i
const sensitiveAssignments = [
  /\b(?:ADMIN_API_TOKEN|CF_ACCESS_CLIENT_SECRET|CLOUDFLARE_ACCESS_CLIENT_SECRET)\s*[:=]\s*(?:["'`][^"'`\r\n]{8,}["'`]|[^\s"'`]{8,})/i,
  /["']?authorization["']?\s*[:=]\s*["'`]?(?:Bearer|Basic)\s+[^\s"'`]{8,}/i,
  /["']?x-admin-token["']?\s*[:=]\s*["'`]?[^\s"'`]{8,}/i,
  /["']?cf-access-jwt-assertion["']?\s*[:=]\s*["'`]?eyJ[^\s"'`]{8,}/i,
  /["']?access(?:_|-)?code["']?\s*[:=]\s*["'`]?[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}(?=["'`\s,}]|$)/i,
  /["']?operation(?:_|-)?token["']?\s*[:=]\s*["'`]?[0-9a-f]{64}(?=["'`\s,}]|$)/i,
  /__Host-eng_learn_session=[0-9a-f]{64}/i,
]
const hostPathMetadata = [
  /\/\/#region[^\r\n]*(?:\/(?:Users|home|root|private\/var|tmp|workspace|builds)\/|[A-Za-z]:[\\/])/i,
  /["'](?:configPath|userConfigPath)["']\s*:\s*["'](?:\/|[A-Za-z]:[\\/]|~[\\/])/i,
]

const findings = []

const addFinding = (rule, path) => {
  findings.push({ rule, path })
}

const scanFile = async (path) => {
  const name = basename(path)
  if (secretFileName.test(name)) {
    addFinding('forbidden-secret-file', path)
    return
  }
  if (sensitiveTestArtifact.test(name)) {
    addFinding('sensitive-test-artifact', path)
    return
  }
  if (!textExtensions.test(name)) {
    return
  }

  const content = await readFile(path, 'utf8')
  if (sensitiveAssignments.some((pattern) => pattern.test(content))) {
    addFinding('sensitive-assignment', path)
  }
  if (hostPathMetadata.some((pattern) => pattern.test(content))) {
    addFinding('host-path-metadata', path)
  }
}

const scanPath = async (path) => {
  let entry
  try {
    entry = await lstat(path)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw error
  }

  if (entry.isSymbolicLink()) {
    addFinding('symlink-artifact', path)
    return
  }
  if (entry.isFile()) {
    await scanFile(path)
    return
  }
  if (!entry.isDirectory()) {
    return
  }

  const children = await readdir(path)
  for (const child of children) {
    await scanPath(resolve(path, child))
  }
}

const roots = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultRoots).map(
  (path) => resolve(path),
)

try {
  for (const root of roots) {
    await scanPath(root)
  }

  if (findings.length === 0) {
    process.stdout.write('Secret artifact scan passed\n')
  } else {
    process.stdout.write('Secret artifact scan failed\n')
    for (const finding of findings.sort((left, right) => left.path.localeCompare(right.path))) {
      process.stdout.write(`- [${finding.rule}] ${relative(process.cwd(), finding.path)}\n`)
    }
    process.exitCode = 1
  }
} catch {
  process.stderr.write('Secret artifact scan could not inspect every requested path\n')
  process.exitCode = 2
}
