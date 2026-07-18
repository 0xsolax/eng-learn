import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createInMemoryAdminOperationLedger } from '../../server/repositories/adminOperationLedger'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import { createLearningProgressService } from '../../server/services/LearningProgressService'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const NOW = new Date('2026-07-18T04:00:00.000Z')

describe('learning progress service', () => {
  it('starts a new formal learning run at logical lesson one while preserving identity and history', async () => {
    const fixture = await createFixture()
    const beforeCourse = await fixture.courseRepository.getCourse(fixture.created.course.id)
    const beforeStates = await fixture.courseRepository.getWordStates(fixture.created.course.id)
    const startedLessonTwo = await fixture.runtime.startLesson(fixture.created.course.id)
    const operationToken = generateAdminOperationToken()
    const command = {
      operationToken,
      expectedLearningRunNo: 1,
      expectedCurrentLessonNo: 2,
    }

    const reset = await fixture.progress.resetCourseProgress(
      fixture.created.course.id,
      command,
      { source: 'service_token', subject: 'admin-1' },
    )
    const retried = await fixture.progress.resetCourseProgress(
      fixture.created.course.id,
      command,
      { source: 'service_token', subject: 'admin-1' },
    )

    expect(retried).toEqual(reset)
    expect(reset).toMatchObject({
      course: {
        id: fixture.created.course.id,
        learnerId: fixture.created.learner.id,
        sourceVersionId: fixture.created.course.sourceVersionId,
        currentLessonNo: 1,
      },
      learningRunNo: 2,
      abandonedSessionCount: 1,
      historyPreserved: true,
    })

    const internalCourse = await fixture.courseRepository.getCourse(fixture.created.course.id)
    expect(internalCourse).toMatchObject({
      currentLearningRunNo: 2,
      currentRunStartLessonNo: 3,
      currentLessonNo: 3,
    })
    expect(internalCourse?.currentLessonNo).toBeGreaterThan(beforeCourse?.currentLessonNo ?? 0)
    await expect(
      fixture.courseRepository.getLessonSession(startedLessonTwo.session.id),
    ).resolves.toMatchObject({ status: 'abandoned', learningRunNo: 1, runLessonNo: 2 })
    await expect(
      fixture.courseRepository.getWordStates(fixture.created.course.id),
    ).resolves.toEqual([])
    const expectedStateMatchers: unknown[] = []
    for (const state of beforeStates) {
      expectedStateMatchers.push(expect.objectContaining({ ...state, learningRunNo: 1 }))
    }
    await expect(
      fixture.courseRepository.getLearningRunWordStateSnapshots({
        courseId: fixture.created.course.id,
        learningRunNo: 1,
      }),
    ).resolves.toEqual(
      expect.arrayContaining(expectedStateMatchers),
    )

    const restoredIdentity = await fixture.courseRepository.getCourseByAccessCode(
      fixture.created.learner.accessCode,
    )
    expect(restoredIdentity).toMatchObject({
      learner: { id: fixture.created.learner.id },
      course: { id: fixture.created.course.id, currentLessonNo: 1 },
    })

    await expect(
      fixture.runtime.submitAnswer({
        sessionId: startedLessonTwo.session.id,
        taskId: startedLessonTwo.tasks[0]?.id ?? 'missing',
        submission: { taskType: 'multiple_choice', answer: 'word-1' },
      }),
    ).rejects.toMatchObject({ code: 'lesson_not_active' })

    const restarted = await fixture.runtime.startLesson(fixture.created.course.id)
    expect(restarted.session).toMatchObject({ lessonNo: 1, status: 'started' })
    const restartedInternal = await fixture.courseRepository.getLessonSession(
      restarted.session.id,
    )
    expect(restartedInternal).toMatchObject({
      lessonNo: 3,
      learningRunNo: 2,
      runLessonNo: 1,
    })
    await expect(
      fixture.progress.resetCourseProgress(
        fixture.created.course.id,
        command,
        { source: 'service_token', subject: 'admin-1' },
      ),
    ).resolves.toEqual(reset)
  })

  it('rejects token reuse with changed parameters and a stale different-token CAS', async () => {
    const fixture = await createFixture()
    const token = generateAdminOperationToken()
    await fixture.progress.resetCourseProgress(
      fixture.created.course.id,
      {
        operationToken: token,
        expectedLearningRunNo: 1,
        expectedCurrentLessonNo: 2,
      },
      { source: 'service_token', subject: 'admin-1' },
    )

    await expect(
      fixture.progress.resetCourseProgress(
        fixture.created.course.id,
        {
          operationToken: token,
          expectedLearningRunNo: 1,
          expectedCurrentLessonNo: 1,
        },
        { source: 'service_token', subject: 'admin-1' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(
      fixture.progress.resetCourseProgress(
        fixture.created.course.id,
        {
          operationToken: generateAdminOperationToken(),
          expectedLearningRunNo: 1,
          expectedCurrentLessonNo: 2,
        },
        { source: 'service_token', subject: 'admin-2' },
      ),
    ).rejects.toMatchObject({ code: 'progress_conflict' })
  })

  it('rejects operation-token reuse in either direction across the admin ledgers', async () => {
    const fixture = await createFixture()

    await expect(
      fixture.progress.resetCourseProgress(
        fixture.created.course.id,
        {
          operationToken: fixture.importOperationToken,
          expectedLearningRunNo: 1,
          expectedCurrentLessonNo: 2,
        },
        { source: 'service_token', subject: 'admin-1' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })

    const resetToken = generateAdminOperationToken()
    await fixture.progress.resetCourseProgress(
      fixture.created.course.id,
      {
        operationToken: resetToken,
        expectedLearningRunNo: 1,
        expectedCurrentLessonNo: 2,
      },
      { source: 'service_token', subject: 'admin-1' },
    )

    await expect(
      fixture.builder.importNewSourceIdempotently({
        operationToken: resetToken,
        sourceName: 'Conflicting source',
        words: [{
          word: 'pear',
          meaning: '梨',
          examplePhrase: 'a pear',
          exampleSentence: 'I eat a pear.',
          exampleSentenceExtended: 'I eat a pear after lunch.',
        }],
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
})

const createFixture = async () => {
  const operationLedger = createInMemoryAdminOperationLedger()
  const contentRepository = createInMemoryContentRepository({ ledger: operationLedger })
  const courseRepository = createInMemoryCourseRepository({ ledger: operationLedger })
  const builder = createContentBuilder({
    repository: contentRepository,
    operationLedger,
    now: () => NOW,
  })
  const importOperationToken = generateAdminOperationToken()
  const imported = await builder.importNewSourceIdempotently({
    operationToken: importOperationToken,
    sourceName: 'Reset source',
    words: Array.from({ length: 10 }, (_, index) => ({
      word: `word-${String(index + 1)}`,
      meaning: `meaning-${String(index + 1)}`,
      examplePhrase: `word-${String(index + 1)}`,
      exampleSentence: `I use word-${String(index + 1)}.`,
      exampleSentenceExtended: `I can use word-${String(index + 1)} every day.`,
    })),
  })
  await builder.buildExerciseItems(imported.versionId)
  const items = await builder.listExerciseItems(imported.versionId)
  await builder.approveExerciseItems(items.map((item) => item.id))
  await builder.publishVersion(imported.versionId)
  const runtime = createCourseRuntime({
    contentRepository,
    courseRepository,
    operationLedger,
    now: () => NOW,
    queueWriteMode: 'v2',
    flowWriteMode: 'legacy_v1',
  })
  const created = await runtime.createCourse({
    learnerName: 'Alice',
    sourceVersionId: imported.versionId,
  })
  const lessonOne = await runtime.startLesson(created.course.id)
  for (const task of lessonOne.tasks) {
    await runtime.submitAnswer({
      sessionId: lessonOne.session.id,
      taskId: task.id,
      submission: { taskType: 'recognize_meaning', response: 'known' },
    })
  }
  await runtime.completeLesson(lessonOne.session.id)

  return {
    courseRepository,
    builder,
    importOperationToken,
    runtime,
    created,
    progress: createLearningProgressService({
      courseRepository,
      operationLedger,
      now: () => NOW,
    }),
  }
}
