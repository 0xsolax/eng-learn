import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseQueryService } from '../../server/services/CourseQueryService'
import { createCourseRuntime } from '../../server/services/CourseRuntime'

const NOW = new Date('2026-07-13T00:00:00.000Z')

describe('course query service', () => {
  it('lists minimal admin course state without recovering any credential', async () => {
    const fixture = await createFixture()
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })

    const result = await fixture.queries.listAdminCourses()

    expect(result).toEqual({
      courses: [
        {
          learner: { id: created.learner.id, name: 'Alice' },
          course: created.course,
          credentialVersion: 1,
        },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(/accessCode|access_code|sha256:/u)
  })

  it('derives start and continue summaries from server lesson state without dates', async () => {
    const fixture = await createFixture()
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    const principal = {
      learnerId: created.learner.id,
      courseId: created.course.id,
    }

    await expect(fixture.queries.getCourseHome(principal)).resolves.toEqual({
      course: created.course,
      newWordCount: 5,
      reviewWordCount: 0,
      action: 'start',
      lessonPath: [
        { lessonNo: 1, status: 'current' },
        { lessonNo: 2, status: 'locked' },
      ],
    })

    const lesson = await fixture.runtime.startLesson(created.course.id)

    await expect(fixture.queries.getCourseHome(principal)).resolves.toEqual({
      course: created.course,
      newWordCount: 5,
      reviewWordCount: 0,
      action: 'continue',
      startedSessionId: lesson.session.id,
      lessonPath: [
        { lessonNo: 1, status: 'current' },
        { lessonNo: 2, status: 'locked' },
      ],
    })

    for (const task of lesson.tasks.slice(0, 4)) {
      await fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }
    await fixture.runtime.completeLesson(lesson.session.id)

    await expect(fixture.queries.getCourseHome(principal)).resolves.toMatchObject({
      course: { currentLessonNo: 2 },
      newWordCount: 5,
      reviewWordCount: 5,
      action: 'start',
      lessonPath: [
        { lessonNo: 1, status: 'completed' },
        { lessonNo: 2, status: 'current' },
        { lessonNo: 3, status: 'locked' },
      ],
    })
  })

  it('shows the latest completed session instead of inventing a skipped lesson', async () => {
    const fixture = await createFixture(5)
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    const principal = {
      learnerId: created.learner.id,
      courseId: created.course.id,
    }
    const lessonOne = await fixture.runtime.startLesson(created.course.id)

    for (const task of lessonOne.tasks) {
      if (task.taskType !== 'recognize_meaning') {
        throw new Error('Expected lesson one to contain recognition tasks')
      }
      await fixture.runtime.submitAnswer({
        sessionId: lessonOne.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }
    await fixture.runtime.completeLesson(lessonOne.session.id)

    const lessonTwo = await fixture.runtime.startLesson(created.course.id)
    for (const [index, task] of lessonTwo.tasks.entries()) {
      if (task.taskType !== 'multiple_choice') {
        throw new Error('Expected lesson two to contain multiple-choice tasks')
      }
      await fixture.runtime.submitAnswer({
        sessionId: lessonTwo.session.id,
        taskId: task.id,
        submission: {
          taskType: 'multiple_choice',
          answer: `word-${String(index + 1)}`,
        },
      })
    }
    await fixture.runtime.completeLesson(lessonTwo.session.id)

    const home = await fixture.queries.getCourseHome(principal)

    expect(home.course.currentLessonNo).toBe(4)
    expect(home.lessonPath).toEqual([
      { lessonNo: 2, status: 'completed' },
      { lessonNo: 4, status: 'current' },
      { lessonNo: 5, status: 'locked' },
    ])
  })

  it('reports primary-answer correctness while excluding bridge and reflux audit logs', async () => {
    const fixture = await createFixture()
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    const lesson = await fixture.runtime.startLesson(created.course.id)
    const firstTask = requireValue(lesson.tasks[0], 'Expected the first primary task')

    await fixture.runtime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: firstTask.id,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
    })

    let current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
      (task) => task.status === 'pending',
    )
    while (current) {
      await fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: current.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
      current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
        (task) => task.status === 'pending',
      )
    }

    await fixture.runtime.completeLesson(lesson.session.id)
    const principal = {
      learnerId: created.learner.id,
      courseId: created.course.id,
    }
    const firstRead = await fixture.queries.getLessonReport(principal, lesson.session.id)
    const nextVersion = await fixture.builder.importNextVersion({
      sourceId: fixture.sourceId,
      words: Array.from({ length: 10 }, (_, index) => ({
        word: `replacement-${String(index + 1)}`,
        meaning: `replacement meaning ${String(index + 1)}`,
        examplePhrase: `replacement-${String(index + 1)}`,
        exampleSentence: `I use replacement-${String(index + 1)}.`,
        exampleSentenceExtended: `I use replacement-${String(index + 1)} every day.`,
      })),
    })
    await fixture.builder.buildExerciseItems(nextVersion.versionId)
    const nextItems = await fixture.builder.listExerciseItems(nextVersion.versionId)
    await fixture.builder.approveExerciseItems(nextItems.map((item) => item.id))
    await fixture.builder.publishVersion(nextVersion.versionId)
    const secondRead = await fixture.queries.getLessonReport(principal, lesson.session.id)

    expect(firstRead).toMatchObject({
      lessonNo: 1,
      completedTaskCount: 6,
      totalTaskCount: 6,
      correctRate: 0.8,
      needsPracticeWords: [{ id: firstTask.wordId, word: 'word-1' }],
      nextLessonNo: 2,
      courseStatus: 'active',
    })
    expect(firstRead.progressWords).toHaveLength(4)
    expect(secondRead).toEqual(firstRead)
    expect(JSON.stringify(firstRead)).not.toMatch(
      /easeFactor|masteryScore|nextDueLessonNo|wrongStreak/u,
    )
  })

  it('reports a deferred bridge word as needing practice even when its primary passed', async () => {
    const fixture = await createFixture(5)
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    const lesson = await fixture.runtime.startLesson(created.course.id)

    for (const task of lesson.tasks.slice(0, 4)) {
      await fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }

    const lastPrimary = requireValue(lesson.tasks[4], 'Expected the last primary task')
    await fixture.runtime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: lastPrimary.id,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
    })

    const firstBridge = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
      (task) => task.role === 'bridge',
    )

    if (!firstBridge) throw new Error('Expected a bridge task')

    for (;;) {
      const current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
        (task) => task.status === 'pending',
      )

      if (!current) break
      await fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: current.id,
        submission: {
          taskType: 'recognize_meaning',
          response: current.wordId === firstBridge.wordId ? 'learning' : 'known',
        },
      })
    }

    await fixture.runtime.completeLesson(lesson.session.id)
    const report = await fixture.queries.getLessonReport(
      { learnerId: created.learner.id, courseId: created.course.id },
      lesson.session.id,
    )

    expect(report.needsPracticeWords).toEqual([
      { id: firstBridge.wordId, word: 'word-1' },
      { id: lastPrimary.wordId, word: 'word-5' },
    ])
    expect(report.progressWords.map((word) => word.id)).not.toContain(firstBridge.wordId)
  })

  it('rejects a completed v2 report when a non-primary answer audit is missing', async () => {
    const fixture = await createFixture(5)
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    const lesson = await fixture.runtime.startLesson(created.course.id)
    const firstTask = requireValue(lesson.tasks[0], 'Expected the first primary task')

    await fixture.runtime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: firstTask.id,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
    })

    for (;;) {
      const current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
        (task) => task.status === 'pending',
      )

      if (!current) break
      await fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: current.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }

    await fixture.runtime.completeLesson(lesson.session.id)
    const snapshot = await fixture.courseRepository.getLessonReportSnapshot({
      sessionId: lesson.session.id,
      courseId: created.course.id,
    })

    if (!snapshot) throw new Error('Expected the completed lesson report snapshot')
    const nonPrimaryTask = requireValue(
      snapshot.tasks.find((task) => task.role !== 'primary'),
      'Expected a non-primary task',
    )
    const corruptQueries = createCourseQueryService({
      contentRepository: fixture.contentRepository,
      courseRepository: {
        ...fixture.courseRepository,
        getLessonReportSnapshot: () =>
          Promise.resolve({
            ...snapshot,
            reviewLogs: snapshot.reviewLogs.filter(
              (log) => log.taskId !== nonPrimaryTask.id,
            ),
          }),
      },
    })

    await expect(
      corruptQueries.getLessonReport(
        { learnerId: created.learner.id, courseId: created.course.id },
        lesson.session.id,
      ),
    ).rejects.toMatchObject({ code: 'dependency_failure' })
  })

  it('rejects cross-course reports and reports from an unfinished lesson', async () => {
    const fixture = await createFixture()
    const first = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    const second = await fixture.runtime.createCourse({
      learnerName: 'Bob',
      sourceVersionId: fixture.versionId,
    })
    const lesson = await fixture.runtime.startLesson(first.course.id)

    await expect(
      fixture.queries.getLessonReport(
        { learnerId: second.learner.id, courseId: second.course.id },
        lesson.session.id,
      ),
    ).rejects.toMatchObject({ code: 'forbidden_resource' })
    await expect(
      fixture.queries.getLessonReport(
        { learnerId: first.learner.id, courseId: first.course.id },
        lesson.session.id,
      ),
    ).rejects.toMatchObject({ code: 'report_unavailable' })
  })
})

const createFixture = async (wordCount = 10) => {
  const contentRepository = createInMemoryContentRepository()
  const courseRepository = createInMemoryCourseRepository()
  const builder = createContentBuilder({ repository: contentRepository, now: () => NOW })
  const imported = await builder.importWords({
    sourceName: 'Query source',
    words: Array.from({ length: wordCount }, (_, index) => ({
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

  return {
    builder,
    contentRepository,
    courseRepository,
    sourceId: imported.sourceId,
    versionId: imported.versionId,
    runtime: createCourseRuntime({
      contentRepository,
      courseRepository,
      now: () => NOW,
      queueWriteMode: 'v2',
    }),
    queries: createCourseQueryService({ contentRepository, courseRepository }),
  }
}

const requireValue = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new Error(message)

  return value
}
