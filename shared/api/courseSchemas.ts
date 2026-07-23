import { z } from 'zod'
import { lessonTaskSchema } from './taskSchemas'
import { learnerLoginAccountSchema } from './schemas'

const nonEmptyText = z.string().trim().min(1)

export const courseStatusSchema = z.enum(['active', 'paused', 'completed'])
export const lessonSessionStatusSchema = z.enum(['started', 'completed', 'abandoned'])

export const courseViewSchema = z
  .object({
    id: nonEmptyText,
    learnerId: nonEmptyText,
    sourceVersionId: nonEmptyText,
    currentLessonNo: z.number().int().positive(),
    status: courseStatusSchema,
  })
  .strict()

export const learnerIdentitySchema = z
  .object({
    id: nonEmptyText,
    name: nonEmptyText,
  })
  .strict()

export const createdCourseSchema = z
  .object({
    learner: learnerIdentitySchema
      .extend({
        loginAccount: learnerLoginAccountSchema,
      })
      .strict(),
    course: courseViewSchema,
  })
  .strict()

export const establishedLearnerSessionSchema = z
  .object({
    learner: learnerIdentitySchema,
    course: courseViewSchema,
  })
  .strict()

export const restoredLearnerSessionSchema = z
  .object({
    learner: z.object({ id: nonEmptyText }).strict(),
    course: courseViewSchema,
  })
  .strict()

export const lessonSessionSchema = z
  .object({
    id: nonEmptyText,
    courseId: nonEmptyText,
    lessonNo: z.number().int().positive(),
    status: lessonSessionStatusSchema,
    taskCount: z.number().int().nonnegative(),
    completedTaskCount: z.number().int().nonnegative(),
  })
  .strict()
  .refine((session) => session.completedTaskCount <= session.taskCount, {
    path: ['completedTaskCount'],
    message: 'Completed task count cannot exceed task count',
  })

export const startedLessonSchema = z
  .object({
    session: lessonSessionSchema,
    tasks: z.array(lessonTaskSchema),
  })
  .strict()

export const completedLessonSchema = z
  .object({
    course: courseViewSchema,
    session: lessonSessionSchema,
  })
  .strict()

export const rotatedAccessCodeSchema = z
  .object({
    accessCode: z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/),
    credentialVersion: z.number().int().positive(),
    revokedSessionCount: z.number().int().nonnegative(),
  })
  .strict()

export const updatedLearnerLoginSchema = z
  .object({
    loginAccount: learnerLoginAccountSchema,
    credentialVersion: z.number().int().positive(),
    revokedSessionCount: z.number().int().nonnegative(),
  })
  .strict()

export const adminCourseListSchema = z
  .object({
    courses: z.array(
      z
        .object({
          learner: learnerIdentitySchema
            .extend({ loginAccount: learnerLoginAccountSchema.optional() })
            .strict(),
          course: courseViewSchema,
          credentialVersion: z.number().int().positive(),
          learningRunNo: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict()

export const completedLessonSummarySchema = z
  .object({
    sourceSessionId: nonEmptyText,
    learningRunNo: z.number().int().positive(),
    lessonNo: z.number().int().positive(),
    taskCount: z.number().int().positive(),
    completedAt: z.iso.datetime(),
  })
  .strict()

export const completedLessonPageSchema = z
  .object({
    currentLearningRunNo: z.number().int().positive(),
    lessons: z.array(completedLessonSummarySchema),
    nextCursor: nonEmptyText.optional(),
  })
  .strict()

export const lessonReplaySessionSchema = z
  .object({
    id: nonEmptyText,
    courseId: nonEmptyText,
    sourceSessionId: nonEmptyText,
    learningRunNo: z.number().int().positive(),
    lessonNo: z.number().int().positive(),
    status: z.enum(['started', 'completed']),
    taskCount: z.number().int().positive(),
    completedTaskCount: z.number().int().nonnegative(),
    correctCount: z.number().int().nonnegative(),
    wrongCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.completedTaskCount > session.taskCount) {
      context.addIssue({
        code: 'custom',
        path: ['completedTaskCount'],
        message: 'Completed replay task count cannot exceed task count',
      })
    }
    if (session.correctCount + session.wrongCount !== session.completedTaskCount) {
      context.addIssue({
        code: 'custom',
        path: ['correctCount'],
        message: 'Replay score counts must equal completed task count',
      })
    }
  })

export const lessonReplaySchema = z
  .object({
    session: lessonReplaySessionSchema,
    tasks: z.array(lessonTaskSchema),
  })
  .strict()
  .superRefine((replay, context) => {
    if (replay.tasks.length !== replay.session.taskCount) {
      context.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: 'Replay tasks must match the persisted replay task count',
      })
    }
    if (
      replay.tasks.some(
        (task) =>
          task.sessionId !== replay.session.id ||
          task.courseId !== replay.session.courseId,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: 'Replay tasks must belong to the replay session and course',
      })
    }
  })

export const courseProgressResetResultSchema = z
  .object({
    course: courseViewSchema,
    learningRunNo: z.number().int().positive(),
    abandonedSessionCount: z.number().int().nonnegative(),
    historyPreserved: z.literal(true),
  })
  .strict()

export const lessonPathNodeSchema = z
  .object({
    lessonNo: z.number().int().positive(),
    status: z.enum(['completed', 'current', 'locked']),
  })
  .strict()

export const courseHomeSchema = z
  .object({
    course: courseViewSchema,
    newWordCount: z.number().int().nonnegative(),
    reviewWordCount: z.number().int().nonnegative(),
    action: z.enum(['start', 'continue']),
    startedSessionId: nonEmptyText.optional(),
    lessonPath: z.array(lessonPathNodeSchema).min(2).max(3),
  })
  .strict()
  .superRefine((home, context) => {
    if (home.action === 'continue' && !home.startedSessionId) {
      context.addIssue({
        code: 'custom',
        path: ['startedSessionId'],
        message: 'A continuing course requires its started session id',
      })
    }

    if (home.action === 'start' && home.startedSessionId) {
      context.addIssue({
        code: 'custom',
        path: ['startedSessionId'],
        message: 'A course without a started lesson cannot expose a session id',
      })
    }

    const currentNodes = home.lessonPath.filter((node) => node.status === 'current')

    if (
      currentNodes.length !== 1 ||
      currentNodes[0]?.lessonNo !== home.course.currentLessonNo
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lessonPath'],
        message: 'Lesson path must identify the server current lesson exactly once',
      })
    }
  })

export const reportWordSchema = z
  .object({
    id: nonEmptyText,
    word: nonEmptyText,
  })
  .strict()

export const lessonReportSchema = z
  .object({
    lessonNo: z.number().int().positive(),
    completedTaskCount: z.number().int().nonnegative(),
    totalTaskCount: z.number().int().nonnegative(),
    correctRate: z.number().min(0).max(1),
    needsPracticeWords: z.array(reportWordSchema),
    progressWords: z.array(reportWordSchema),
    nextLessonNo: z.number().int().positive(),
    courseStatus: courseStatusSchema,
  })
  .strict()
  .refine((report) => report.completedTaskCount <= report.totalTaskCount, {
    path: ['completedTaskCount'],
    message: 'Completed task count cannot exceed total task count',
  })

export type CourseViewDto = z.infer<typeof courseViewSchema>
export type CreatedCourseDto = z.infer<typeof createdCourseSchema>
export type StartedLessonDto = z.infer<typeof startedLessonSchema>
export type CompletedLessonDto = z.infer<typeof completedLessonSchema>
export type AdminCourseListDto = z.infer<typeof adminCourseListSchema>
export type CourseHomeDto = z.infer<typeof courseHomeSchema>
export type LessonReportDto = z.infer<typeof lessonReportSchema>
export type CompletedLessonPageDto = z.infer<typeof completedLessonPageSchema>
export type LessonReplayDto = z.infer<typeof lessonReplaySchema>
export type CourseProgressResetResultDto = z.infer<
  typeof courseProgressResetResultSchema
>
