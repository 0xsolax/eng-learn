import { readFile, writeFile } from 'node:fs/promises'
import ts from 'typescript'

const sourceRegionCommentPattern = /^\/\/#(?:end)?region(?:[ \t].*)?$/

const collectSourceCommentRanges = (source) => {
  const sourceFile = ts.createSourceFile(
    'generated-worker.js',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  )
  const commentsByPosition = new Map()
  const nodes = [sourceFile]

  const collect = (ranges) => {
    for (const range of ranges ?? []) {
      if (
        range.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
        sourceRegionCommentPattern.test(source.slice(range.pos, range.end))
      ) {
        commentsByPosition.set(range.pos, range)
      }
    }
  }

  while (nodes.length > 0) {
    const node = nodes.pop()
    collect(ts.getLeadingCommentRanges(source, node.getFullStart()))
    collect(ts.getTrailingCommentRanges(source, node.end))
    nodes.push(...node.getChildren(sourceFile))
  }

  return [...commentsByPosition.values()]
}

const toRemovalRange = (source, comment) => {
  const lineStart = source.lastIndexOf('\n', comment.pos - 1) + 1
  if (!/^[ \t]*$/.test(source.slice(lineStart, comment.pos))) {
    return { start: comment.pos, end: comment.end }
  }

  let lineEnd = comment.end
  if (source.startsWith('\r\n', lineEnd)) lineEnd += 2
  else if (source[lineEnd] === '\n' || source[lineEnd] === '\r') lineEnd += 1

  return { start: lineStart, end: lineEnd }
}

export const stripGeneratedSourceRegionComments = (source) => {
  const removals = collectSourceCommentRanges(source)
    .map((comment) => toRemovalRange(source, comment))
    .sort((left, right) => right.start - left.start)

  return removals.reduce(
    (sanitized, removal) =>
      `${sanitized.slice(0, removal.start)}${sanitized.slice(removal.end)}`,
    source,
  )
}

export const sanitizeGeneratedReleaseMetadata = async ({
  outputConfigPath,
  workerPath,
}) => {
  const workerBundle = await readFile(workerPath, 'utf8')
  await writeFile(workerPath, stripGeneratedSourceRegionComments(workerBundle))

  const outputConfig = JSON.parse(await readFile(outputConfigPath, 'utf8'))
  delete outputConfig.configPath
  delete outputConfig.userConfigPath
  await writeFile(outputConfigPath, JSON.stringify(outputConfig))
}
