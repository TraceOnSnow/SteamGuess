import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DIFFICULTY_TARGETS, levelForValue } from '../../difficulty/model';
import type { DifficultyLevel } from '../../labeler/types';
import { submitDifficultyFeedback } from '../../api/client';
import './DifficultyFeedback.css';

const LEVELS: DifficultyLevel[] = ['easy', 'normal', 'hard', 'hell'];

interface DifficultyFeedbackProps {
  appId: number;
  initialScore?: number;
  playerId: string;
  sessionId: string;
  onClose: () => void;
}

function levelFromScore(score: number): DifficultyLevel {
  return levelForValue(score / 100 * 3);
}

export function DifficultyFeedback({ appId, initialScore, playerId, sessionId, onClose }: DifficultyFeedbackProps) {
  const { t } = useTranslation();
  const startingScore = Math.round(Math.max(0, Math.min(100, initialScore ?? 50)));
  const [score, setScore] = useState(startingScore);
  const [level, setLevel] = useState<DifficultyLevel>(levelFromScore(startingScore));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const scoreText = useMemo(() => String(Math.round(score)), [score]);

  const changeScore = (next: number) => {
    const normalized = Math.max(0, Math.min(100, Number.isFinite(next) ? next : 0));
    setScore(normalized);
    setLevel(levelFromScore(normalized));
    if (status !== 'idle') setStatus('idle');
  };

  const selectLevel = (next: DifficultyLevel) => {
    setLevel(next);
    setScore(Math.round(DIFFICULTY_TARGETS[next] / 3 * 100));
    if (status !== 'idle') setStatus('idle');
  };

  const submit = async () => {
    setStatus('saving');
    try {
      await submitDifficultyFeedback({ playerId, sessionId, appId, score, level });
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  };

  return (
    <section className="difficulty-feedback" aria-labelledby="difficulty-feedback-title">
      <div className="difficulty-feedback-heading">
        <div>
          <p className="outcome-kicker">{t('feedback.kicker')}</p>
          <h3 id="difficulty-feedback-title">{t('feedback.title')}</h3>
        </div>
        <button className="feedback-close" type="button" onClick={onClose} aria-label={t('feedback.close')}>×</button>
      </div>

      <div className="difficulty-level-options" aria-label={t('feedback.levelLabel')}>
        {LEVELS.map(item => (
          <button
            key={item}
            type="button"
            className={item === level ? 'selected' : ''}
            aria-pressed={item === level}
            onClick={() => selectLevel(item)}
          >
            {t(`feedback.level.${item}`)}
          </button>
        ))}
      </div>

      <div className="difficulty-score-editor">
        <label htmlFor="difficulty-feedback-score">{t('feedback.scoreLabel')}</label>
        <input
          id="difficulty-feedback-score"
          type="range"
          min="0"
          max="100"
          step="1"
          value={score}
          onChange={event => changeScore(Number(event.target.value))}
        />
        <input
          className="difficulty-score-number"
          type="number"
          min="0"
          max="100"
          step="1"
          value={scoreText}
          aria-label={t('feedback.scoreInput')}
          onChange={event => changeScore(Number(event.target.value))}
        />
      </div>

      <div className="difficulty-feedback-actions">
        <span className={`feedback-submit-status status-${status}`} role="status" aria-live="polite">
          {status === 'saved' ? t('feedback.saved') : status === 'error' ? t('feedback.error') : ''}
        </span>
        <button className="btn btn-primary" type="button" disabled={status === 'saving' || status === 'saved'} onClick={() => void submit()}>
          {status === 'saving' ? t('feedback.saving') : status === 'saved' ? t('feedback.savedButton') : t('feedback.submit')}
        </button>
      </div>
    </section>
  );
}
