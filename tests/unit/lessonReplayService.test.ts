import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createInMemoryLessonReplayRepository } from '../../server/repositories/inMemoryLessonReplayRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import { createLessonReplayService } from '../../server/services/LessonReplayService'
import type { LessonTaskDto, SubmitTaskAnswerRequest } from '../../shared/api/taskSchemas'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const NOW = new Date('2026-07-18T02:00:00.000Z')

describe('lesson replay service', () => {
  it('replays a completed snapshot repeatedly without changing any formal learning state', async () => {
    const fixture = await createFixture()
    const principal = {
      learnerId: fixture.created.learner.id,
      courseId: fixture.created.course.id,
    }
    const before = await readFormalSnapshot(fixture)

    await expect(
      fixture.replays.listCompletedLessons(principal, { limit: 20 }),
    ).resolves.toMatchObject({
      currentLearningRunNo: 1,
      lessons: [
        {
          sourceSessionId: fixture.lesson.session.id,
          learningRunNo: 1,
          lessonNo: 1,
          taskCount: fixture.lesson.tasks.length,
        },
      ],
    })

    const started = await fixture.replays.startReplay(
      principal,
      fixture.lesson.session.id,
    )
    const resumed = await fixture.replays.startReplay(
      principal,
      fixture.lesson.session.id,
    )

    expect(resumed.session.id).toBe(started.session.id)
    expect(started.tasks).toHaveLength(fixture.lesson.tasks.length)
    expect(started.tasks.every((task) => task.status === 'pending')).toBe(true)
    expect(started.tasks.map((task) => task.orderIndex)).toEqual(
      fixture.lesson.tasks.map((task) => task.orderIndex),
    )

    const secondTask = started.tasks[1]
    if (!secondTask) throw new Error('Expected a second replay task')
    await expect(
      fixture.replays.submitAnswer(principal, {
        replaySessionId: started.session.id,
        taskId: secondTask.id,
        submission: answerFor(secondTask),
      }),
    ).rejects.toMatchObject({ code: 'task_not_current' })

    for (;;) {
      const replay = await fixture.replays.getReplay(principal, started.session.id)
      const current = replay.tasks.find((task) => task.status === 'pending')
      if (!current) break
      await fixture.replays.submitAnswer(principal, {
        replaySessionId: replay.session.id,
        taskId: current.id,
        submission: answerFor(current),
      })
    }

    const completed = await fixture.replays.completeReplay(principal, started.session.id)
    expect(completed.session).toMatchObject({
      status: 'completed',
      completedTaskCount: started.tasks.length,
      correctCount: started.tasks.length,
      wrongCount: 0,
    })

    const nextAttempt = await fixture.replays.startReplay(
      principal,
      fixture.lesson.session.id,
    )
    expect(nextAttempt.session.id).not.toBe(started.session.id)
    expect(nextAttempt.session.status).toBe('started')
    await expect(readFormalSnapshot(fixture)).resolves.toEqual(before)
  })

  it('does not leak a reference revealed by the formal S5 task into a new replay', async () => {
    const fixture = await createFixture()
    const principal = {
      learnerId: fixture.created.learner.id,
      courseId: fixture.created.course.id,
    }
    const sourceSessionId = 'formal-s5-session'
    const sourceTaskId = 'formal-s5-task'

    await fixture.courseRepository.createLesson({
      session: {
        id: sourceSessionId,
        courseId: principal.courseId,
        lessonNo: 2,
        status: 'completed',
        taskCount: 1,
        completedTaskCount: 1,
        correctCount: 1,
        wrongCount: 0,
        queuePolicyVersion: 'v2_3_6_cap3',
        flowPolicyVersion: 'v1_due_then_new_unbounded',
        startedAt: NOW.toISOString(),
        completedAt: NOW.toISOString(),
      },
      tasks: [
        {
          id: sourceTaskId,
          sessionId: sourceSessionId,
          courseId: principal.courseId,
          wordId: 'word-s5',
          orderIndex: 1,
          status: 'completed',
          role: 'primary',
          required: true,
          draftAnswer: 'The old formal draft.',
          referenceRevealedAt: '2026-07-18T01:00:00.000Z',
          createdAt: '2026-07-18T00:00:00.000Z',
          stage: 'S5',
          taskType: 'sentence_output',
          prompt: { meaning: '苹果', instruction: 'Write one sentence.' },
          answer: { referenceSentence: 'I eat an apple every day.' },
        },
      ],
      wordStates: [],
    })

    const replay = await fixture.replays.startReplay(principal, sourceSessionId)
    const task = replay.tasks[0]
    if (!task || task.taskType !== 'sentence_output') {
      throw new Error('Expected a replay sentence-output task')
    }

    expect(task.preview).toBeUndefined()
    expect(JSON.stringify(task)).not.toContain('The old formal draft.')
    expect(JSON.stringify(task)).not.toContain('I eat an apple every day.')

    const preview = await fixture.replays.previewSentenceOutput(principal, {
      replaySessionId: replay.session.id,
      taskId: task.id,
      preview: { taskType: 'sentence_output', draft: 'My new replay draft.' },
    })

    expect(preview).toMatchObject({
      taskId: task.id,
      draft: 'My new replay draft.',
      referenceSentence: 'I eat an apple every day.',
    })
    const restored = await fixture.replays.getReplay(principal, replay.session.id)
    expect(restored.tasks[0]).toMatchObject({
      preview: {
        draft: 'My new replay draft.',
        referenceSentence: 'I eat an apple every day.',
      },
    })

    const formalTask = await fixture.courseRepository.getLessonTask(
      sourceSessionId,
      sourceTaskId,
    )
    expect(formalTask).toMatchObject({
      draftAnswer: 'The old formal draft.',
      referenceRevealedAt: '2026-07-18T01:00:00.000Z',
    })
  })
})

const createFixture = async () => {
  const contentRepository = createInMemoryContentRepository()
  const courseRepository = createInMemoryCourseRepository()
  const builder = createContentBuilder({ repository: contentRepository, now: () => NOW })
  const imported = await builder.importNewSourceIdempotently({
    operationToken: generateAdminOperationToken(),
    sourceName: 'Replay source',
    words: Array.from({ length: 5 }, (_, index) => ({
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
    now: () => NOW,
    queueWriteMode: 'v2',
    flowWriteMode: 'legacy_v1',
  })
  const created = await runtime.createCourse({
    learnerName: 'Alice',
    sourceVersionId: imported.versionId,
  })
  const lesson = await runtime.startLesson(created.course.id)

  for (const task of lesson.tasks) {
    await runtime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: task.id,
      submission: answerFor(task),
    })
  }
  await runtime.completeLesson(lesson.session.id)

  return {
    contentRepository,
    courseRepository,
    runtime,
    created,
    lesson,
    replays: createLessonReplayService({
      courseRepository,
      replayRepository: createInMemoryLessonReplayRepository(),
      now: () => NOW,
    }),
  }
}

const readFormalSnapshot = async (fixture: Awaited<ReturnType<typeof createFixture>>) => ({
  course: await fixture.courseRepository.getCourse(fixture.created.course.id),
  wordStates: await fixture.courseRepository.getWordStates(fixture.created.course.id),
  lesson: await fixture.courseRepository.getLessonReportSnapshot({
    courseId: fixture.created.course.id,
    sessionId: fixture.lesson.session.id,
  }),
})

const answerFor = (task: LessonTaskDto): SubmitTaskAnswerRequest => {
  switch (task.taskType) {
    case 'recognize_meaning':
      return { taskType: 'recognize_meaning', response: 'known' }
    case 'recall_word':
    case 'multiple_choice':
      return { taskType: task.taskType, answer: `word-${task.wordId.split('-').at(-1) ?? ''}` }
    case 'fill_blank':
      return { taskType: 'fill_blank', answer: `word-${task.wordId.split('-').at(-1) ?? ''}` }
    case 'sentence_build':
      return { taskType: 'sentence_build', pieceIds: task.prompt.pieces.map((piece) => piece.id) }
    case 'sentence_output':
      return { taskType: 'sentence_output', draft: 'Replay draft.', selfScore: 3 }
  }
}
