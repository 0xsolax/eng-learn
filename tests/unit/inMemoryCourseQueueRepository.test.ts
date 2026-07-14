import { describe, expect, it } from 'vitest'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import type {
  LessonTaskRecord,
  RecordAnswerInput,
  UserWordStateRecord,
} from '../../server/repositories/courseRepository'

const NOW = '2026-07-14T00:00:00.000Z'

const createTask = (): LessonTaskRecord => ({
  id: 'task-1',
  sessionId: 'lesson-1',
  courseId: 'course-1',
  wordId: 'word-1',
  stage: 'S0',
  taskType: 'recognize_meaning',
  prompt: { word: 'hello', meaning: '你好', exampleSentence: '' },
  answer: { word: 'hello', expectedResponse: 'known' },
  orderIndex: 1,
  status: 'pending',
  role: 'primary',
  required: false,
  createdAt: NOW,
})

const createWordState = (): UserWordStateRecord => ({
  id: 'state-1',
  courseId: 'course-1',
  wordId: 'word-1',
  groupId: 'group-1',
  stage: 'S0',
  totalAttemptCount: 0,
  totalCorrectCount: 0,
  totalWrongCount: 0,
  currentStreak: 0,
  wrongStreak: 0,
  lapseCount: 0,
  easeFactor: 1,
  masteryScore: 0,
  firstLessonNo: 1,
  nextDueLessonNo: 1,
  status: 'new',
  createdAt: NOW,
  updatedAt: NOW,
})

describe('in-memory course queue repository', () => {
  it('persists a v2 session policy and restores it in the authoritative queue snapshot', async () => {
    const repository = createInMemoryCourseRepository()
    await repository.createCourse({
      learner: { id: 'learner-1', name: 'Alice', accessCode: 'ABCDEFGH23', createdAt: NOW },
      course: {
        id: 'course-1',
        learnerId: 'learner-1',
        sourceVersionId: 'version-1',
        currentLessonNo: 1,
        status: 'active',
        createdAt: NOW,
      },
    })
    await repository.createLesson({
      session: {
        id: 'lesson-1',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        queuePolicyVersion: 'v2_3_6_cap3',
        startedAt: NOW,
      },
      tasks: [createTask()],
      wordStates: [createWordState()],
    })

    await expect(repository.getLessonSession('lesson-1')).resolves.toMatchObject({
      queuePolicyVersion: 'v2_3_6_cap3',
    })
    await expect(
      repository.getLessonQueueSnapshot({ sessionId: 'lesson-1', courseId: 'course-1' }),
    ).resolves.toMatchObject({
      session: { queuePolicyVersion: 'v2_3_6_cap3' },
      tasks: [{ id: 'task-1' }],
      reviewLogs: [],
    })

    const completedTask = { ...createTask(), status: 'completed' as const }
    const recordInput: RecordAnswerInput = {
      task: completedTask,
      wordState: {
        ...createWordState(),
        totalAttemptCount: 1,
        totalWrongCount: 1,
        wrongStreak: 1,
        lastSeenLessonNo: 1,
        nextDueLessonNo: 2,
        status: 'learning' as const,
      },
      reviewLog: {
        id: 'review-1',
        sessionId: 'lesson-1',
        taskId: 'task-1',
        courseId: 'course-1',
        wordId: 'word-1',
        stage: 'S0' as const,
        taskType: 'recognize_meaning',
        correctAnswer: 'known',
        score: 0 as const,
        queueDisposition: 'deferred_capacity' as const,
        lessonNo: 1,
        createdAt: NOW,
      },
      taskMutations: [completedTask],
      reorderedExistingTaskIds: [],
      taskCount: 1,
      completedTaskCount: 1,
      persistWordState: true,
      expectedQueuePolicyVersion: 'v2_3_6_cap3' as const,
    }

    await expect(repository.recordAnswer(recordInput)).resolves.toMatchObject({
      queueDisposition: 'deferred_capacity',
      submittedAnswer: { reviewLog: { id: 'review-1', score: 0 } },
    })
    recordInput.reviewLog.queueDisposition = 'scheduled'
    await expect(repository.getSubmittedAnswer('lesson-1', 'task-1')).resolves.toMatchObject({
      queueDisposition: 'deferred_capacity',
      submittedAnswer: { reviewLog: { id: 'review-1', score: 0 } },
    })
  })
})
