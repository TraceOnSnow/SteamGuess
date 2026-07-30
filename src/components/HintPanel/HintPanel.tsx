import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import './HintPanel.css';

interface HintPanelProps {
  screenshotUrl?: string;
  revealOriginal?: boolean;
  onUseHint: () => void;
}

export function HintPanel({ screenshotUrl, revealOriginal = false, onUseHint }: HintPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showScreenshot, setShowScreenshot] = useState(false);
  const [usedScreenshot, setUsedScreenshot] = useState(false);
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
    if (!showScreenshot) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowScreenshot(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [showScreenshot]);

  const revealScreenshot = () => {
    if (!screenshotUrl) return;
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
            disabled={!screenshotUrl}
            onClick={revealScreenshot}
          >
            <strong>{revealOriginal ? t('hint.originalScreenshot') : t('hint.screenshot')}</strong>
            <span>{screenshotUrl ? (revealOriginal ? t('hint.originalHelp') : t('hint.screenshotHelp')) : t('hint.unavailable')}</span>
          </button>
        </div>
      )}
      {showScreenshot && screenshotUrl && createPortal(
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
                  src={screenshotUrl}
                  alt={revealOriginal ? t('hint.originalAlt') : t('hint.screenshotAlt')}
                />
              </div>
              <figcaption>{revealOriginal ? t('hint.originalCaption') : t('hint.screenshotCaption')}</figcaption>
            </figure>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
