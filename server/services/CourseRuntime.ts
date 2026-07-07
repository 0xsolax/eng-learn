import type {
  CompletedLesson,
  CreatedCourse,
  ReviewScore,
  StartedLesson,
  SubmittedAnswer,
} from '../../shared/domain/course'
import type {
  CourseRepository,
  LessonTaskRecord,
  UserWordStateRecord,
} from '../repositories/courseRepository'
import type { ContentRepository, SourceVersionSnapshot } from '../repositories/contentRepository'
import { applyAnswerScore } from './StageEngine'

export type CourseRuntime = {
  createCourse(input: {
    learnerName: string
    sourceVersionId: string
  }): Promise<CreatedCourse>
  enterCourseByAccessCode(accessCode: string): Promise<CreatedCourse>
  startLesson(courseId: string): Promise<StartedLesson>
  submitAnswer(input: {
    sessionId: string
    taskId: string
    userAnswer: string
  }): Promise<SubmittedAnswer>
  completeLesson(sessionId: string): Promise<CompletedLesson>
}

export type CreateCourseRuntimeInput = {
  contentRepository: ContentRepository
  courseRepository: CourseRepository
  now: () => Date
}

export const createCourseRuntime = ({
  contentRepository,
  courseRepository,
  now,
}: CreateCourseRuntimeInput): CourseRuntime => {
  const createCourse = async (input: {
    learnerName: string
    sourceVersionId: string
  }): Promise<CreatedCourse> => {
    const sourceVersion = await contentRepository.getSourceVersion(input.sourceVersionId)

    if (!sourceVersion || sourceVersion.version.status !== 'published') {
      throw new Error('Courses can only bind published source versions')
    }

    const createdAt = now().toISOString()
    const learnerId = crypto.randomUUID()

    return courseRepository.createCourse({
      learner: {
        id: learnerId,
        name: input.learnerName,
        accessCode: createAccessCode(),
        createdAt,
      },
      course: {
        id: crypto.randomUUID(),
        learnerId,
        sourceVersionId: input.sourceVersionId,
        currentLessonNo: 1,
        status: 'active',
        createdAt,
      },
    })
  }

  const startLesson = async (courseId: string): Promise<StartedLesson> => {
    const course = await courseRepository.getCourse(courseId)

    if (!course) {
      throw new Error(`Course ${courseId} is missing`)
    }

    const existing = await courseRepository.getStartedLesson(course.id, course.currentLessonNo)

    if (existing) {
      return existing
    }

    const sourceVersion = await contentRepository.getSourceVersion(course.sourceVersionId)

    if (!sourceVersion || sourceVersion.version.status !== 'published') {
      throw new Error('Course source version is not available')
    }

    const existingStates = await courseRepository.getWordStates(course.id)
    const dueStates = existingStates.filter(
      (state) => state.nextDueLessonNo <= course.currentLessonNo,
    )
    const activatedGroupIds = new Set(existingStates.map((state) => state.groupId))
    const nextGroup = sourceVersion.groups.find((group) => !activatedGroupIds.has(group.id))

    if (existingStates.length === 0 && !nextGroup) {
      throw new Error('Course source version has no word groups')
    }

    const createdAt = now().toISOString()
    const sessionId = crypto.randomUUID()
    const nextGroupWords = nextGroup
      ? sourceVersion.words.filter(
          (word) =>
            word.orderIndex >= nextGroup.startOrderIndex &&
            word.orderIndex <= nextGroup.endOrderIndex,
        )
      : []
    const initialStates = nextGroup
      ? nextGroupWords.map<UserWordStateRecord>((word) =>
          createInitialWordState({
            courseId: course.id,
            wordId: word.id,
            groupId: nextGroup.id,
            lessonNo: course.currentLessonNo,
            createdAt,
          }),
        )
      : []
    const dueTasks = dueStates.map((state, index) =>
      createLessonTask({
        sourceVersion,
        state,
        sessionId,
        orderIndex: index + 1,
        createdAt,
      }),
    )
    const newTasks = initialStates.map((state, index) =>
      createLessonTask({
        sourceVersion,
        state,
        sessionId,
        orderIndex: dueTasks.length + index + 1,
        createdAt,
      }),
    )
    const tasks = [...dueTasks, ...newTasks]

    return courseRepository.createLesson({
      session: {
        id: sessionId,
        courseId: course.id,
        lessonNo: course.currentLessonNo,
        status: 'started',
        taskCount: tasks.length,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        startedAt: createdAt,
      },
      tasks,
      wordStates: initialStates,
    })
  }

  const enterCourseByAccessCode = async (accessCode: string): Promise<CreatedCourse> => {
    const course = await courseRepository.getCourseByAccessCode(accessCode)

    if (!course) {
      throw new Error('Course access code is invalid')
    }

    return course
  }

  const createLessonTask = (input: {
    sourceVersion: SourceVersionSnapshot
    state: UserWordStateRecord
    sessionId: string
    orderIndex: number
    createdAt: string
  }): LessonTaskRecord => {
    const word = input.sourceVersion.words.find((candidate) => candidate.id === input.state.wordId)

    if (!word) {
      throw new Error(`Word ${input.state.wordId} is missing`)
    }

    const exerciseItem = input.sourceVersion.exerciseItems.find(
      (item) =>
        item.wordId === input.state.wordId &&
        item.stage === input.state.stage &&
        item.status === 'approved',
    )

    if (!exerciseItem) {
      throw new Error(`Approved ${input.state.stage} exercise item is missing for ${word.word}`)
    }

    return {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      courseId: input.state.courseId,
      wordId: word.id,
      stage: exerciseItem.stage,
      taskType: exerciseItem.taskType,
      prompt: exerciseItem.prompt,
      answer: exerciseItem.answer,
      orderIndex: input.orderIndex,
      status: 'pending',
      createdAt: input.createdAt,
    }
  }

  const submitAnswer = async (input: {
    sessionId: string
    taskId: string
    userAnswer: string
  }): Promise<SubmittedAnswer> => {
    const existing = await courseRepository.getSubmittedAnswer(input.sessionId, input.taskId)

    if (existing) {
      return existing
    }

    const session = await courseRepository.getLessonSession(input.sessionId)

    if (!session) {
      throw new Error(`Lesson session ${input.sessionId} is missing`)
    }

    const task = await courseRepository.getLessonTask(input.sessionId, input.taskId)

    if (!task) {
      throw new Error(`Lesson task ${input.taskId} is missing`)
    }

    const wordState = await courseRepository.getWordState(task.courseId, task.wordId)

    if (!wordState) {
      throw new Error(`Word state is missing for ${task.wordId}`)
    }

    const createdAt = now().toISOString()
    const score = evaluateAnswer(task.answer, input.userAnswer)
    const updatedWordState = applyAnswerScore(wordState, {
      lessonNo: session.lessonNo,
      score,
      updatedAt: createdAt,
    })
    const lessonTasks = await courseRepository.getLessonTasks(input.sessionId)
    const newTasks =
      score === 0
        ? [
            createRefluxTask({
              task,
              orderIndex: lessonTasks.length + 1,
              createdAt,
            }),
          ]
        : []

    return courseRepository.recordAnswer({
      task: {
        ...task,
        status: 'completed',
      },
      wordState: updatedWordState,
      reviewLog: {
        id: crypto.randomUUID(),
        sessionId: session.id,
        taskId: task.id,
        courseId: task.courseId,
        wordId: task.wordId,
        stage: task.stage as UserWordStateRecord['stage'],
        taskType: task.taskType,
        userAnswer: input.userAnswer,
        correctAnswer: getWordAnswer(task.answer),
        score,
        lessonNo: session.lessonNo,
        createdAt,
      },
      ...(newTasks.length > 0 ? { newTasks } : {}),
    })
  }

  const completeLesson = async (sessionId: string): Promise<CompletedLesson> => {
    const session = await courseRepository.getLessonSession(sessionId)

    if (!session) {
      throw new Error(`Lesson session ${sessionId} is missing`)
    }

    if (session.status === 'completed') {
      return courseRepository.completeLesson(sessionId, now().toISOString())
    }

    const tasks = await courseRepository.getLessonTasks(sessionId)
    const completedTaskCount = tasks.filter((task) => task.status === 'completed').length
    const completionRatio = tasks.length === 0 ? 0 : completedTaskCount / tasks.length

    if (completionRatio < 0.8) {
      throw new Error('Lesson completion requires at least eighty percent completed tasks')
    }

    return courseRepository.completeLesson(sessionId, now().toISOString())
  }

  return {
    createCourse,
    enterCourseByAccessCode,
    startLesson,
    submitAnswer,
    completeLesson,
  }
}

const createAccessCode = (): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const values = new Uint8Array(10)
  crypto.getRandomValues(values)

  return Array.from(values, (value) => alphabet.charAt(value % alphabet.length)).join('')
}

const getWordAnswer = (answer: unknown): string => {
  if (!answer || typeof answer !== 'object' || !('word' in answer)) {
    return ''
  }

  const word = (answer as { word?: unknown }).word

  return typeof word === 'string' ? word : ''
}

const evaluateAnswer = (answer: unknown, userAnswer: string): ReviewScore => {
  const normalizedUserAnswer = normalizeAnswer(userAnswer)

  if (!normalizedUserAnswer) {
    return 0
  }

  return getAnswerCandidates(answer).some((candidate) => candidate === normalizedUserAnswer)
    ? 2
    : 0
}

const getAnswerCandidates = (answer: unknown): string[] => {
  if (!answer || typeof answer !== 'object') {
    return []
  }

  const values = Object.values(answer)

  return values.flatMap((value) =>
    typeof value === 'string' ? [normalizeAnswer(value)] : [],
  )
}

const normalizeAnswer = (answer: string): string => answer.trim().toLocaleLowerCase()

const createInitialWordState = (input: {
  courseId: string
  wordId: string
  groupId: string
  lessonNo: number
  createdAt: string
}): UserWordStateRecord => ({
  id: crypto.randomUUID(),
  courseId: input.courseId,
  wordId: input.wordId,
  groupId: input.groupId,
  stage: 'S0',
  totalAttemptCount: 0,
  totalCorrectCount: 0,
  totalWrongCount: 0,
  currentStreak: 0,
  wrongStreak: 0,
  lapseCount: 0,
  easeFactor: 1,
  masteryScore: 0,
  firstLessonNo: input.lessonNo,
  nextDueLessonNo: input.lessonNo,
  status: 'new',
  createdAt: input.createdAt,
  updatedAt: input.createdAt,
})

const createRefluxTask = (input: {
  task: LessonTaskRecord
  orderIndex: number
  createdAt: string
}): LessonTaskRecord => ({
  id: crypto.randomUUID(),
  sessionId: input.task.sessionId,
  courseId: input.task.courseId,
  wordId: input.task.wordId,
  stage: input.task.stage,
  taskType: input.task.taskType,
  prompt: input.task.prompt,
  answer: input.task.answer,
  orderIndex: input.orderIndex,
  status: 'pending',
  createdAt: input.createdAt,
})
