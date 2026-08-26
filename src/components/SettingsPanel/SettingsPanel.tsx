import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DIFFICULTY_LEVELS } from '../../difficulty/pools';
import type { DifficultyLevel, StartingHintMode } from '../../difficulty/types';
import {
  DISPLAY_FIELDS,
  type DisplayField,
} from '../../settings/displayFields';
import {
  PROFILE_IMPORT_AVAILABLE,
  createLocalLibrary,
  importSteamProfile,
  parseSteamAppIds,
  type SteamLibrary,
} from '../../library/steamLibrary';
import './SettingsPanel.css';

const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
  beginner: '入门',
  easy: '简单',
  normal: '普通',
  hard: '困难',
  hell: '地狱',
};

type PoolMode = 'difficulty' | 'library';

interface SettingsPanelProps {
  difficulty: DifficultyLevel;
  startingHintMode: StartingHintMode;
  answerPoolSize: number;
  visibleFields: ReadonlySet<DisplayField>;
  library: SteamLibrary | null;
  matchedLibraryGames: number;
  poolMode: PoolMode;
  onDifficultyChange: (level: DifficultyLevel) => void;
  onStartingHintModeChange: (mode: StartingHintMode) => void;
  onVisibleFieldChange: (field: DisplayField, visible: boolean) => void;
  onLibraryChange: (library: SteamLibrary | null) => void;
  onPoolModeChange: (mode: PoolMode) => void;
  onClose: () => void;
}

export function SettingsPanel({
  difficulty,
  startingHintMode,
  answerPoolSize,
  visibleFields,
  library,
  matchedLibraryGames,
  poolMode,
  onDifficultyChange,
  onStartingHintModeChange,
  onVisibleFieldChange,
  onLibraryChange,
  onPoolModeChange,
  onClose,
}: SettingsPanelProps) {
  const { t, i18n } = useTranslation();
  const [profile, setProfile] = useState('');
  const [appIdsText, setAppIdsText] = useState('');
  const [importError, setImportError] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  const applyLocalImport = (source: 'file' | 'text', content: string) => {
    const appIds = parseSteamAppIds(content);
    if (appIds.length === 0) {
      setImportError(t('library.noAppIds'));
      return;
    }
    setImportError('');
    onLibraryChange(createLocalLibrary(appIds, source));
  };

  const handleProfileImport = async () => {
    if (!profile.trim()) return;
    setIsImporting(true);
    setImportError('');
    try {
      onLibraryChange(await importSteamProfile(profile));
    } catch (error) {
      setImportError(error instanceof Error ? error.message : t('library.importFailed'));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="settings-panel" id="settings-panel">
      <div className="settings-panel-heading">
        <strong>{t('app.settings')}</strong>
        <button className="text-button close-settings" type="button" onClick={onClose}>{t('app.closeSettings')}</button>
      </div>
      <section className="settings-section">
        <h2>{t('app.questionPool')}</h2>
        <div className="segmented-control pool-control" aria-label={t('app.questionPool')}>
          <button type="button" onClick={() => onPoolModeChange('difficulty')} aria-pressed={poolMode === 'difficulty'}>{t('app.presetPool')}</button>
          <button type="button" onClick={() => onPoolModeChange('library')} aria-pressed={poolMode === 'library'} disabled={!library || matchedLibraryGames === 0}>{t('app.libraryPool')}</button>
        </div>
        {poolMode === 'difficulty' && (
          <div className="segmented-control difficulty-control" aria-label={t('app.difficulty')}>
            {DIFFICULTY_LEVELS.map(level => (
              <button type="button" key={level} onClick={() => onDifficultyChange(level)} aria-pressed={difficulty === level}>
                {i18n.language.startsWith('zh') ? DIFFICULTY_LABELS[level] : level[0].toUpperCase() + level.slice(1)}
              </button>
            ))}
          </div>
        )}
        <small className="model-status">
          {poolMode === 'library'
            ? t('app.libraryPoolStatus', { count: answerPoolSize })
            : t('app.modelPublished', { pool: answerPoolSize })}
        </small>
        {poolMode === 'difficulty' && (difficulty === 'beginner' || difficulty === 'easy') && (
          <div className="starting-hint-settings">
            <h3>{t('hint.startingHeading')}</h3>
            <div className="segmented-control" aria-label={t('hint.startingHeading')}>
              {(['screenshot', 'review', 'none'] as StartingHintMode[]).map(mode => (
                <button
                  type="button"
                  key={mode}
                  onClick={() => onStartingHintModeChange(mode)}
                  aria-pressed={startingHintMode === mode}
                >
                  {t(`hint.startingMode.${mode}`)}
                </button>
              ))}
            </div>
            <small>{t('hint.startingHelp')}</small>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>{t('fields.heading')}</h2>
        <div className="field-options">
          {DISPLAY_FIELDS.map(field => (
            <label key={field} className="check-option">
              <input type="checkbox" checked={visibleFields.has(field)} onChange={event => onVisibleFieldChange(field, event.target.checked)} />
              <span>{t(`fields.${field}`)}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section library-settings">
        <div className="section-heading-row">
          <h2>{t('library.heading')}</h2>
          {library && <button className="text-button" type="button" onClick={() => onLibraryChange(null)}>{t('library.clear')}</button>}
        </div>
        {library && (
          <p className="library-summary">
            {t('library.summary', { imported: library.appIds.length, matched: matchedLibraryGames })}
            {library.profileName ? ` · ${library.profileName}` : ''}
          </p>
        )}

        <label className="input-label" htmlFor="steam-profile">{t('library.profileLabel')}</label>
        <div className="import-row">
          <input id="steam-profile" value={profile} onChange={event => setProfile(event.target.value)} placeholder={t('library.profilePlaceholder')} />
          <button className="btn btn-quiet" type="button" onClick={handleProfileImport} disabled={!PROFILE_IMPORT_AVAILABLE || !profile.trim() || isImporting}>
            {isImporting ? t('library.importing') : t('library.importProfile')}
          </button>
        </div>
        <small>{PROFILE_IMPORT_AVAILABLE ? t('library.profileHelp') : t('library.profileUnavailable')}</small>

        <div className="settings-divider"><span>{t('library.or')}</span></div>
        <label className="input-label" htmlFor="steam-appids">{t('library.appIdsLabel')}</label>
        <textarea id="steam-appids" value={appIdsText} onChange={event => setAppIdsText(event.target.value)} placeholder={t('library.appIdsPlaceholder')} rows={3} />
        <div className="local-import-actions">
          <button className="btn btn-quiet" type="button" onClick={() => applyLocalImport('text', appIdsText)}>{t('library.importText')}</button>
          <label className="btn btn-quiet file-button">
            {t('library.importFile')}
            <input type="file" accept=".json,.txt,text/plain,application/json" onChange={async event => {
              const file = event.target.files?.[0];
              if (file) applyLocalImport('file', await file.text());
              event.target.value = '';
            }} />
          </label>
        </div>
        {importError && <p className="form-error" role="alert">{importError}</p>}
      </section>
    </div>
  );
}
