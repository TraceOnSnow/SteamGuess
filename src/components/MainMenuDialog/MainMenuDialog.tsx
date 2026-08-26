import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './MainMenuDialog.css';

interface MainMenuDialogProps {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function MainMenuDialog({
  open,
  busy = false,
  onCancel,
  onConfirm,
}: MainMenuDialogProps) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div className="main-menu-dialog-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section
        className="main-menu-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="main-menu-dialog-title"
        aria-describedby="main-menu-dialog-description"
      >
        <h2 id="main-menu-dialog-title">{t('navigation.returnToMenuTitle')}</h2>
        <p id="main-menu-dialog-description">{t('navigation.returnToMenuMessage')}</p>
        <div className="main-menu-dialog-actions">
          <button ref={cancelRef} className="btn btn-quiet" type="button" onClick={onCancel} disabled={busy}>
            {t('navigation.cancel')}
          </button>
          <button className="btn btn-danger" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? t('navigation.returning') : t('navigation.confirmReturnToMenu')}
          </button>
        </div>
      </section>
    </div>
  );
}
