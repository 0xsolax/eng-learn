import { z } from 'zod'
import { lessonTaskSchema } from './taskSchemas'

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
        accessCode: z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/),
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

export const adminSessionSchema = z
  .object({
    id: nonEmptyText,
    source: z.enum(['cloudflare_access', 'service_token']),
    email: z.email().optional(),
  })
  .strict()

export const rotatedAccessCodeSchema = z
  .object({
    accessCode: z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/),
    credentialVersion: z.number().int().positive(),
    revokedSessionCount: z.number().int().nonnegative(),
  })
  .strict()

export const adminCourseListSchema = z
  .object({
    courses: z.array(
      z
        .object({
          learner: learnerIdentitySchema,
          course: courseViewSchema,
          credentialVersion: z.number().int().positive(),
        })
        .strict(),
    ),
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
