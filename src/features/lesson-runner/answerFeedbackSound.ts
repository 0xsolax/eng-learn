const correctSoundSource = '/sounds/answer-feedback-correct.wav'
const wrongSoundSource = '/sounds/answer-feedback-wrong.wav'

export const playAnswerFeedbackSound = (correct: boolean): void => {
  try {
    const audio = new Audio(correct ? correctSoundSource : wrongSoundSource)
    audio.volume = 0.65
    void audio.play().catch(() => undefined)
  } catch {
    // Visible feedback and answer progression remain authoritative when audio is unavailable.
  }
}
