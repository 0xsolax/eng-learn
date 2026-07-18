import { describe, expect, it } from 'vitest'
import {
  adminCourseListSchema,
  completedLessonSchema,
  courseHomeSchema,
  createdCourseSchema,
  establishedLearnerSessionSchema,
  lessonReportSchema,
  restoredLearnerSessionSchema,
  startedLessonSchema,
} from '../../shared/api/courseSchemas'

const course = {
  id: 'course-1',
  learnerId: 'learner-1',
  sourceVersionId: 'version-1',
  currentLessonNo: 1,
  status: 'active',
} as const

describe('course API schemas', () => {
  it('separates the one-time admin learning code from learner session restoration', () => {
    expect(
      createdCourseSchema.parse({
        learner: { id: 'learner-1', name: 'Alice', accessCode: 'ABCDEFGH23' },
        course,
      }),
    ).toBeTruthy()
    expect(
      establishedLearnerSessionSchema.parse({
        learner: { id: 'learner-1', name: 'Alice' },
        course,
      }),
    ).toBeTruthy()
    expect(
      restoredLearnerSessionSchema.parse({ learner: { id: 'learner-1' }, course }),
    ).toBeTruthy()
    expect(() =>
      restoredLearnerSessionSchema.parse({
        learner: { id: 'learner-1' },
        course,
        accessCode: 'ABCDEFGH23',
      }),
    ).toThrow()
  })

  it('validates lesson snapshots without an answer field', () => {
    const lesson = {
      session: {
        id: 'lesson-session-1',
        courseId: course.id,
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
      },
      tasks: [
        {
          id: 'task-1',
          sessionId: 'lesson-session-1',
          courseId: course.id,
          wordId: 'word-1',
          stage: 'S0',
          taskType: 'recognize_meaning',
          prompt: { word: 'apple', meaning: '苹果', exampleSentence: '' },
          orderIndex: 1,
          status: 'pending',
          role: 'primary',
          required: false,
        },
      ],
    }

    expect(startedLessonSchema.parse(lesson)).toEqual(lesson)
    expect(() =>
      startedLessonSchema.parse({
        ...lesson,
        tasks: [{ ...lesson.tasks[0], answer: { word: 'apple' } }],
      }),
    ).toThrow()
  })

  it('validates an idempotent completed lesson snapshot', () => {
    expect(
      completedLessonSchema.parse({
        course: { ...course, currentLessonNo: 2 },
        session: {
          id: 'lesson-session-1',
          courseId: course.id,
          lessonNo: 1,
          status: 'completed',
          taskCount: 5,
          completedTaskCount: 4,
        },
      }),
    ).toBeTruthy()
  })

  it('rejects credentials and internal learning state from course read DTOs', () => {
    const adminList = {
      courses: [
        {
          learner: { id: 'learner-1', name: 'Alice' },
          course,
          credentialVersion: 1,
          learningRunNo: 1,
        },
      ],
    }
    const home = {
      course,
      newWordCount: 5,
      reviewWordCount: 0,
      action: 'start',
      lessonPath: [
        { lessonNo: 1, status: 'current' },
        { lessonNo: 2, status: 'locked' },
      ],
    }
    const report = {
      lessonNo: 1,
      completedTaskCount: 5,
      totalTaskCount: 6,
      correctRate: 0.8,
      needsPracticeWords: [{ id: 'word-1', word: 'apple' }],
      progressWords: [{ id: 'word-2', word: 'pear' }],
      nextLessonNo: 2,
      courseStatus: 'active',
    }

    expect(adminCourseListSchema.parse(adminList)).toEqual(adminList)
    expect(courseHomeSchema.parse(home)).toEqual(home)
    expect(lessonReportSchema.parse(report)).toEqual(report)
    expect(() =>
      adminCourseListSchema.parse({
        courses: [
          {
            ...adminList.courses[0],
            learner: { ...adminList.courses[0]?.learner, accessCode: 'ABCDEFGH23' },
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      courseHomeSchema.parse({ ...home, easeFactor: 1.2, masteryScore: 50 }),
    ).toThrow()
    expect(() =>
      lessonReportSchema.parse({ ...report, nextDueLessonNo: 8 }),
    ).toThrow()
  })
})
