import type {
  CourseRecord,
  CourseRepository,
  CreateLessonInput,
  CreateCourseInput,
  LearnerRecord,
  LessonSessionRecord,
  LessonTaskRecord,
  RecordAnswerInput,
  ReviewLogRecord,
  UserWordStateRecord,
} from './courseRepository'

export const createInMemoryCourseRepository = (): CourseRepository => {
  const learners = new Map<string, LearnerRecord>()
  const courses = new Map<string, CourseRecord>()
  const sessions = new Map<string, LessonSessionRecord>()
  const tasksBySession = new Map<string, LessonTaskRecord[]>()
  const wordStates = new Map<string, UserWordStateRecord>()
  const reviewLogs = new Map<string, ReviewLogRecord>()
  const reviewLogByTask = new Map<string, string>()

  const toStartedLesson = (session: LessonSessionRecord) => ({
    session: {
      id: session.id,
      courseId: session.courseId,
      lessonNo: session.lessonNo,
      status: session.status,
      taskCount: session.taskCount,
      completedTaskCount: session.completedTaskCount,
    },
    tasks: (tasksBySession.get(session.id) ?? []).map(toLessonTaskView),
  })

  const toSubmittedAnswer = (reviewLog: ReviewLogRecord, wordState: UserWordStateRecord) => ({
    wordState: toWordStateView(wordState),
    reviewLog: {
      id: reviewLog.id,
      sessionId: reviewLog.sessionId,
      courseId: reviewLog.courseId,
      wordId: reviewLog.wordId,
      stage: reviewLog.stage,
      taskType: reviewLog.taskType,
      ...(reviewLog.userAnswer ? { userAnswer: reviewLog.userAnswer } : {}),
      correctAnswer: reviewLog.correctAnswer,
      score: reviewLog.score,
      lessonNo: reviewLog.lessonNo,
      createdAt: reviewLog.createdAt,
    },
  })

  const wordStateKey = (courseId: string, wordId: string) => `${courseId}:${wordId}`
  const taskKey = (sessionId: string, taskId: string) => `${sessionId}:${taskId}`

  const findTask = (sessionId: string, taskId: string) =>
    (tasksBySession.get(sessionId) ?? []).find((task) => task.id === taskId)

  const toLessonTaskView = (task: LessonTaskRecord) => ({
    id: task.id,
    sessionId: task.sessionId,
    courseId: task.courseId,
    wordId: task.wordId,
    stage: task.stage,
    taskType: task.taskType,
    prompt: task.prompt,
    orderIndex: task.orderIndex,
    status: task.status,
  })

  const toWordStateView = (state: UserWordStateRecord) => ({
    id: state.id,
    courseId: state.courseId,
    wordId: state.wordId,
    groupId: state.groupId,
    stage: state.stage,
    totalAttemptCount: state.totalAttemptCount,
    totalCorrectCount: state.totalCorrectCount,
    totalWrongCount: state.totalWrongCount,
    currentStreak: state.currentStreak,
    wrongStreak: state.wrongStreak,
    lapseCount: state.lapseCount,
    easeFactor: state.easeFactor,
    masteryScore: state.masteryScore,
    firstLessonNo: state.firstLessonNo,
    ...(state.lastSeenLessonNo === undefined ? {} : { lastSeenLessonNo: state.lastSeenLessonNo }),
    nextDueLessonNo: state.nextDueLessonNo,
    status: state.status,
  })

  return {
    async createCourse(input: CreateCourseInput) {
      learners.set(input.learner.id, input.learner)
      courses.set(input.course.id, input.course)

      return {
        learner: {
          id: input.learner.id,
          name: input.learner.name,
          accessCode: input.learner.accessCode,
        },
        course: {
          id: input.course.id,
          learnerId: input.course.learnerId,
          sourceVersionId: input.course.sourceVersionId,
          currentLessonNo: input.course.currentLessonNo,
          status: input.course.status,
        },
      }
    },

    async getCourse(courseId: string) {
      return courses.get(courseId)
    },

    async getCourseByAccessCode(accessCode: string) {
      const learner = Array.from(learners.values()).find(
        (candidate) => candidate.accessCode === accessCode,
      )

      if (!learner) {
        return undefined
      }

      const course = Array.from(courses.values()).find(
        (candidate) => candidate.learnerId === learner.id,
      )

      if (!course) {
        return undefined
      }

      return {
        learner: {
          id: learner.id,
          name: learner.name,
          accessCode: learner.accessCode,
        },
        course: {
          id: course.id,
          learnerId: course.learnerId,
          sourceVersionId: course.sourceVersionId,
          currentLessonNo: course.currentLessonNo,
          status: course.status,
        },
      }
    },

    async getStartedLesson(courseId: string, lessonNo: number) {
      const session = Array.from(sessions.values()).find(
        (candidate) =>
          candidate.courseId === courseId &&
          candidate.lessonNo === lessonNo &&
          candidate.status === 'started',
      )

      return session ? toStartedLesson(session) : undefined
    },

    async createLesson(input: CreateLessonInput) {
      sessions.set(input.session.id, input.session)
      tasksBySession.set(input.session.id, input.tasks)
      for (const state of input.wordStates) {
        wordStates.set(wordStateKey(state.courseId, state.wordId), state)
      }

      return toStartedLesson(input.session)
    },

    async getLessonTask(sessionId: string, taskId: string) {
      return findTask(sessionId, taskId)
    },

    async getLessonTasks(sessionId: string) {
      return tasksBySession.get(sessionId) ?? []
    },

    async getLessonSession(sessionId: string) {
      return sessions.get(sessionId)
    },

    async getWordStates(courseId: string) {
      return Array.from(wordStates.values()).filter((state) => state.courseId === courseId)
    },

    async getWordState(courseId: string, wordId: string) {
      return wordStates.get(wordStateKey(courseId, wordId))
    },

    async getSubmittedAnswer(sessionId: string, taskId: string) {
      const reviewLogId = reviewLogByTask.get(taskKey(sessionId, taskId))

      if (!reviewLogId) {
        return undefined
      }

      const reviewLog = reviewLogs.get(reviewLogId)

      if (!reviewLog) {
        return undefined
      }

      const state = wordStates.get(wordStateKey(reviewLog.courseId, reviewLog.wordId))

      if (!state) {
        throw new Error(`Word state is missing for ${reviewLog.wordId}`)
      }

      return toSubmittedAnswer(reviewLog, state)
    },

    async recordAnswer(input: RecordAnswerInput) {
      const tasks = tasksBySession.get(input.task.sessionId) ?? []
      const nextTasks = [
        ...tasks.map((task) => (task.id === input.task.id ? input.task : task)),
        ...(input.newTasks ?? []),
      ]
      const session = sessions.get(input.task.sessionId)

      tasksBySession.set(input.task.sessionId, nextTasks)

      if (session) {
        sessions.set(input.task.sessionId, {
          ...session,
          taskCount: nextTasks.length,
        })
      }

      wordStates.set(wordStateKey(input.wordState.courseId, input.wordState.wordId), input.wordState)
      reviewLogs.set(input.reviewLog.id, input.reviewLog)
      reviewLogByTask.set(taskKey(input.reviewLog.sessionId, input.reviewLog.taskId), input.reviewLog.id)

      return toSubmittedAnswer(input.reviewLog, input.wordState)
    },

    async completeLesson(sessionId: string, completedAt: string) {
      const session = sessions.get(sessionId)

      if (!session) {
        throw new Error(`Lesson session ${sessionId} is missing`)
      }

      const course = courses.get(session.courseId)

      if (!course) {
        throw new Error(`Course ${session.courseId} is missing`)
      }

      if (session.status === 'completed') {
        return {
          course: {
            id: course.id,
            learnerId: course.learnerId,
            sourceVersionId: course.sourceVersionId,
            currentLessonNo: course.currentLessonNo,
            status: course.status,
          },
          session: {
            id: session.id,
            courseId: session.courseId,
            lessonNo: session.lessonNo,
            status: session.status,
            taskCount: session.taskCount,
            completedTaskCount: session.completedTaskCount,
          },
        }
      }

      const completedTaskCount = (tasksBySession.get(session.id) ?? []).filter(
        (task) => task.status === 'completed',
      ).length
      const completedSession: LessonSessionRecord = {
        ...session,
        status: 'completed',
        completedTaskCount,
        completedAt,
      }
      const advancedCourse: CourseRecord = {
        ...course,
        currentLessonNo: course.currentLessonNo + 1,
      }

      sessions.set(session.id, completedSession)
      courses.set(course.id, advancedCourse)

      return {
        course: {
          id: advancedCourse.id,
          learnerId: advancedCourse.learnerId,
          sourceVersionId: advancedCourse.sourceVersionId,
          currentLessonNo: advancedCourse.currentLessonNo,
          status: advancedCourse.status,
        },
        session: {
          id: completedSession.id,
          courseId: completedSession.courseId,
          lessonNo: completedSession.lessonNo,
          status: completedSession.status,
          taskCount: completedSession.taskCount,
          completedTaskCount: completedSession.completedTaskCount,
        },
      }
    },
  }
}
