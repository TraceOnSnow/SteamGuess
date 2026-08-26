import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { pickRandomHint } from '../../difficulty/startingHints';
import type { StartingHintMode } from '../../difficulty/types';
import './HintPanel.css';

interface HintPanelProps {
  screenshotUrls?: string[];
  reviewTexts?: string[];
  initialHintMode?: StartingHintMode;
  revealOriginal?: boolean;
  onUseHint: () => void;
}

export function HintPanel({
  screenshotUrls = [],
  reviewTexts = [],
  initialHintMode = 'none',
  revealOriginal = false,
  onUseHint,
}: HintPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasScreenshots = screenshotUrls.length > 0;
  const availableReviews = reviewTexts.filter(text => text.trim());
  const [showScreenshot, setShowScreenshot] = useState(initialHintMode === 'screenshot' && hasScreenshots);
  const [usedScreenshot, setUsedScreenshot] = useState(initialHintMode === 'screenshot');
  const [selectedScreenshot, setSelectedScreenshot] = useState<string | undefined>(
    () => pickRandomHint(screenshotUrls),
  );
  const [showReview, setShowReview] = useState(initialHintMode === 'review' && availableReviews.length > 0);
  const [usedReview, setUsedReview] = useState(initialHintMode === 'review');
  const [selectedReview] = useState<string | undefined>(
    () => pickRandomHint(availableReviews),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeMenu);
    return () => document.removeEventListener('mousedown', closeMenu);
  }, []);

  useEffect(() => {
    if (!showScreenshot && !showReview) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowScreenshot(false);
      setShowReview(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [showReview, showScreenshot]);

  const revealScreenshot = () => {
    if (!hasScreenshots) return;
    if (!selectedScreenshot || !screenshotUrls.includes(selectedScreenshot)) {
      setSelectedScreenshot(pickRandomHint(screenshotUrls));
    }
    setShowScreenshot(true);
    setOpen(false);
    if (!usedScreenshot && !revealOriginal) {
      setUsedScreenshot(true);
      onUseHint();
    }
  };

  const closeScreenshot = () => {
    setShowScreenshot(false);
    triggerRef.current?.focus();
  };

  const revealReview = () => {
    if (!selectedReview) return;
    setShowReview(true);
    setOpen(false);
    if (!usedReview && !revealOriginal) {
      setUsedReview(true);
      onUseHint();
    }
  };

  const closeReview = () => {
    setShowReview(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="hint-control" ref={rootRef}>
      <button
        ref={triggerRef}
        className="btn btn-quiet"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {t('hint.button')}
      </button>
      {open && (
        <div className="hint-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={!hasScreenshots}
            onClick={revealScreenshot}
          >
            <strong>{revealOriginal ? t('hint.originalScreenshot') : t('hint.screenshot')}</strong>
            <span>{hasScreenshots ? (revealOriginal ? t('hint.originalHelp') : t('hint.screenshotHelp')) : t('hint.unavailable')}</span>
          </button>
          <button type="button" role="menuitem" disabled={!selectedReview} onClick={revealReview}>
            <strong>{t('hint.review')}</strong>
            <span>{selectedReview ? t('hint.reviewHelp') : t('hint.unavailable')}</span>
          </button>
        </div>
      )}
      {showScreenshot && selectedScreenshot && createPortal(
        <div className="screenshot-dialog-backdrop" onMouseDown={event => {
          if (event.target === event.currentTarget) closeScreenshot();
        }}>
          <section
            className="screenshot-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="screenshot-dialog-title"
          >
            <header className="screenshot-dialog-header">
              <h2 id="screenshot-dialog-title">
                {revealOriginal ? t('hint.originalTitle') : t('hint.screenshot')}
              </h2>
              <button
                ref={closeRef}
                className="screenshot-dialog-close"
                type="button"
                onClick={closeScreenshot}
                aria-label={t('hint.close')}
              >
                ×
              </button>
            </header>
            <figure className="screenshot-hint" aria-live="polite">
              <div className="screenshot-frame">
                <img
                  className={revealOriginal ? 'is-original' : 'is-blurred'}
                  src={selectedScreenshot}
                  alt={revealOriginal ? t('hint.originalAlt') : t('hint.screenshotAlt')}
                />
              </div>
              <figcaption>{revealOriginal ? t('hint.originalCaption') : t('hint.screenshotCaption')}</figcaption>
            </figure>
          </section>
        </div>,
        document.body,
      )}
      {showReview && selectedReview && createPortal(
        <div className="screenshot-dialog-backdrop" onMouseDown={event => {
          if (event.target === event.currentTarget) closeReview();
        }}>
          <section className="screenshot-dialog review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-dialog-title">
            <header className="screenshot-dialog-header">
              <h2 id="review-dialog-title">{t('hint.reviewTitle')}</h2>
              <button ref={closeRef} className="screenshot-dialog-close" type="button" onClick={closeReview} aria-label={t('hint.close')}>×</button>
            </header>
            <blockquote className="review-hint">{selectedReview}</blockquote>
            <p className="review-caption">{t('hint.reviewCaption')}</p>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
