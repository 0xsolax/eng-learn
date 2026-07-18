import { DomainError } from '../errors/DomainError'
import type {
  LessonReplayRepository,
  LessonReplaySessionRecord,
  LessonReplaySnapshot,
  LessonReplayTaskRecord,
} from './lessonReplayRepository'

export const createInMemoryLessonReplayRepository = (): LessonReplayRepository => {
  const sessions = new Map<string, LessonReplaySessionRecord>()
  const tasksBySession = new Map<string, LessonReplayTaskRecord[]>()

  const snapshot = (session: LessonReplaySessionRecord): LessonReplaySnapshot => ({
    session: { ...session },
    tasks: [...(tasksBySession.get(session.id) ?? [])]
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((task) => ({ ...task, sourceTask: { ...task.sourceTask } })),
  })

  const getTask = (replaySessionId: string, taskId: string) =>
    (tasksBySession.get(replaySessionId) ?? []).find((task) => task.id === taskId)

  const getCurrentTask = (replaySessionId: string) =>
    [...(tasksBySession.get(replaySessionId) ?? [])]
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .find((task) => task.status === 'pending')

  return {
    async getStartedReplay(input) {
      const session = Array.from(sessions.values()).find(
        (candidate) =>
          candidate.courseId === input.courseId &&
          candidate.sourceSessionId === input.sourceSessionId &&
          candidate.status === 'started',
      )

      return session ? snapshot(session) : undefined
    },

    async getReplayForCourse(input) {
      const session = sessions.get(input.replaySessionId)

      return session?.courseId === input.courseId ? snapshot(session) : undefined
    },

    async createReplay(input) {
      const existing = Array.from(sessions.values()).find(
        (candidate) =>
          candidate.courseId === input.session.courseId &&
          candidate.sourceSessionId === input.session.sourceSessionId &&
          candidate.status === 'started',
      )

      if (existing) return snapshot(existing)

      sessions.set(input.session.id, { ...input.session })
      tasksBySession.set(
        input.session.id,
        input.tasks.map((task) => ({ ...task, sourceTask: { ...task.sourceTask } })),
      )

      return snapshot(input.session)
    },

    async saveSentenceOutputPreview(input) {
      const session = sessions.get(input.replaySessionId)
      const task = getTask(input.replaySessionId, input.taskId)

      if (!session || session.status !== 'started' || !task || task.status !== 'pending') {
        return undefined
      }

      if (task.draftAnswer !== undefined || task.referenceRevealedAt !== undefined) {
        if (
          task.draftAnswer !== input.draft ||
          task.referenceRevealedAt === undefined
        ) {
          throw new DomainError('conflict', 'Replay sentence preview is already fixed')
        }
        return { ...task, sourceTask: { ...task.sourceTask } }
      }

      if (getCurrentTask(input.replaySessionId)?.id !== task.id) {
        throw new DomainError('task_not_current', 'Only the first pending replay task can be used')
      }

      task.draftAnswer = input.draft
      task.referenceRevealedAt = input.revealedAt
      return { ...task, sourceTask: { ...task.sourceTask } }
    },

    async recordAnswer(input) {
      const session = sessions.get(input.replaySessionId)
      const task = getTask(input.replaySessionId, input.taskId)

      if (!session || !task) return undefined
      if (task.status === 'completed') {
        return { ...task, sourceTask: { ...task.sourceTask } }
      }
      if (session.status !== 'started') return undefined
      if (getCurrentTask(input.replaySessionId)?.id !== task.id) {
        throw new DomainError('task_not_current', 'Only the first pending replay task can be answered')
      }

      task.status = 'completed'
      task.submissionJson = input.submissionJson
      task.score = input.score
      task.answeredAt = input.answeredAt
      session.completedTaskCount += 1
      if (input.score >= 2) session.correctCount += 1
      else session.wrongCount += 1

      return { ...task, sourceTask: { ...task.sourceTask } }
    },

    async completeReplay(input) {
      const session = sessions.get(input.replaySessionId)

      if (!session) return undefined
      if (session.status === 'completed') return snapshot(session)
      if ((tasksBySession.get(session.id) ?? []).some((task) => task.status !== 'completed')) {
        return undefined
      }

      session.status = 'completed'
      session.completedAt = input.completedAt
      return snapshot(session)
    },
  }
}
