import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chooseRandomUnlabeled, loadLabelingCatalog, searchLabelingGames } from './data';
import { buildExportPayload, loadStoredLabels, parseLabels, saveStoredLabels, STORAGE_KEY } from './labels';
import { LabelerIcon } from './LabelerIcon';
import type { DifficultyLabel, DifficultyLevel, LabelingCatalog, LabelingGame } from './types';
import './DifficultyLabeler.css';

const LEVEL_OPTIONS: Array<{ level: DifficultyLevel; key: string; label: string; help: string }> = [
  { level: 'easy', key: '1', label: '简单', help: '绝大多数玩家都应该认识' },
  { level: 'normal', key: '2', label: '普通', help: '活跃玩家大概率认识' },
  { level: 'hard', key: '3', label: '困难', help: '需要一定游戏阅历' },
  { level: 'hell', key: '4', label: '地狱', help: '小众，但仍适合作为题目' },
];

const numberFormatter = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

function formatNumber(value: number) {
  return numberFormatter.format(value);
}

function gameImage(game: LabelingGame) {
  return game.headerImage || game.screenshotUrl || `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appId}/header.jpg`;
}

function labelName(label: DifficultyLabel) {
  if (label.excluded) return '不收录';
  return LEVEL_OPTIONS.find(option => option.level === label.level)?.label ?? '未标注';
}

function DifficultyLabeler() {
  const [catalog, setCatalog] = useState<LabelingCatalog | null>(null);
  const [labels, setLabels] = useState<Map<number, DifficultyLabel>>(() => loadStoredLabels());
  const [currentAppId, setCurrentAppId] = useState<number | null>(null);
  const [history, setHistory] = useState<Array<{ appId: number; previous?: DifficultyLabel }>>([]);
  const [query, setQuery] = useState('');
  const [showReference, setShowReference] = useState(false);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadLabelingCatalog(controller.signal)
      .then(result => {
        setCatalog(result);
        const storedLabels = loadStoredLabels();
        const validLabels = new Map([...storedLabels].filter(([appId]) => result.games.some(game => game.appId === appId)));
        setLabels(validLabels);
        if (validLabels.size !== storedLabels.size) saveStoredLabels(validLabels);
        setCurrentAppId(chooseRandomUnlabeled(result.games, new Set(validLabels.keys()))?.appId ?? result.games[0]?.appId ?? null);
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(error instanceof Error ? error.message : '标注目录加载失败');
      });
    return () => controller.abort();
  }, []);

  const gamesById = useMemo(
    () => new Map(catalog?.games.map(game => [game.appId, game]) ?? []),
    [catalog],
  );
  const currentGame = currentAppId ? gamesById.get(currentAppId) ?? null : null;
  const searchResults = useMemo(
    () => catalog ? searchLabelingGames(catalog.games, query) : [],
    [catalog, query],
  );
  const recentLabels = useMemo(
    () => [...labels.values()]
      .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt))
      .slice(0, 8)
      .map(label => ({ label, game: gamesById.get(label.appId) }))
      .filter(item => item.game),
    [gamesById, labels],
  );
  const counts = useMemo(() => {
    const result = { easy: 0, normal: 0, hard: 0, hell: 0, excluded: 0 };
    for (const label of labels.values()) {
      if (label.excluded) result.excluded += 1;
      else if (label.level) result[label.level] += 1;
    }
    return result;
  }, [labels]);

  const selectNext = useCallback((nextLabels = labels, previousAppId = currentAppId ?? undefined) => {
    if (!catalog) return;
    const next = chooseRandomUnlabeled(catalog.games, new Set(nextLabels.keys()), previousAppId);
    setCurrentAppId(next?.appId ?? previousAppId ?? catalog.games[0]?.appId ?? null);
    setQuery('');
  }, [catalog, currentAppId, labels]);

  const applyLabel = useCallback((level: DifficultyLevel | null, excluded = false) => {
    if (!currentGame) return;
    const previous = labels.get(currentGame.appId);
    const nextLabel: DifficultyLabel = {
      appId: currentGame.appId,
      level,
      excluded,
      reviewedAt: new Date().toISOString(),
    };
    const nextLabels = new Map(labels).set(currentGame.appId, nextLabel);
    setHistory(items => [...items.slice(-49), { appId: currentGame.appId, previous }]);
    setLabels(nextLabels);
    saveStoredLabels(nextLabels);
    setMessage(`${currentGame.name} → ${labelName(nextLabel)}`);
    selectNext(nextLabels, currentGame.appId);
  }, [currentGame, labels, selectNext]);

  const undo = useCallback(() => {
    const last = history.at(-1);
    if (!last) return;
    const nextLabels = new Map(labels);
    if (last.previous) nextLabels.set(last.appId, last.previous);
    else nextLabels.delete(last.appId);
    setLabels(nextLabels);
    saveStoredLabels(nextLabels);
    setCurrentAppId(last.appId);
    setHistory(items => items.slice(0, -1));
    setMessage('已撤销上一次标注');
  }, [history, labels]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key >= '1' && event.key <= '4') {
        event.preventDefault();
        applyLabel(LEVEL_OPTIONS[Number(event.key) - 1].level);
      } else if (event.key === '5') {
        event.preventDefault();
        applyLabel(null, true);
      } else if (event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        selectNext();
      } else if (event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyLabel, selectNext, undo]);

  const exportLabels = () => {
    if (!catalog) return;
    const payload = buildExportPayload(labels, catalog.sourceCatalog);
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `difficulty_labels_${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage(`已导出 ${labels.size} 条标注`);
  };

  const importLabels = async (file: File) => {
    try {
      const imported = parseLabels(JSON.parse(await file.text()));
      const validAppIds = new Set(catalog?.games.map(game => game.appId) ?? []);
      const nextLabels = new Map(labels);
      for (const [appId, label] of imported) {
        if (validAppIds.has(appId)) nextLabels.set(appId, label);
      }
      setLabels(nextLabels);
      saveStoredLabels(nextLabels);
      setMessage(`已导入 ${imported.size} 条，当前共 ${nextLabels.size} 条标注`);
      selectNext(nextLabels);
    } catch (error) {
      setMessage(error instanceof Error ? `导入失败：${error.message}` : '导入失败');
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  const clearLabels = () => {
    if (!window.confirm(`确定清空本机保存的 ${labels.size} 条标注吗？请先导出备份。`)) return;
    localStorage.removeItem(STORAGE_KEY);
    setLabels(new Map());
    setHistory([]);
    setMessage('本地标注已清空');
    if (catalog) setCurrentAppId(chooseRandomUnlabeled(catalog.games, new Set())?.appId ?? null);
  };

  if (loadError) {
    return (
      <main className="labeler-state">
        <div className="labeler-state-mark">!</div>
        <h1>无法打开标注工具</h1>
        <p>{loadError}</p>
        <button type="button" className="labeler-button primary" onClick={() => window.location.reload()}>重新加载</button>
      </main>
    );
  }

  if (!catalog || !currentGame) {
    return (
      <main className="labeler-state" aria-live="polite">
        <div className="labeler-spinner" />
        <h1>正在准备标注目录</h1>
        <p>读取候选游戏和本地进度…</p>
      </main>
    );
  }

  const progress = Math.round(labels.size / catalog.games.length * 100);
  const positiveRatio = currentGame.metrics.reviewsTotal
    ? Math.round(currentGame.metrics.positive / currentGame.metrics.reviewsTotal * 100)
    : 0;
  const currentLabel = labels.get(currentGame.appId);

  return (
    <div className="labeler-shell">
      <a className="labeler-skip-link" href="#labeling-card">跳到当前游戏</a>
      <header className="labeler-header">
        <div className="labeler-brand">
          <span className="labeler-logo" aria-hidden="true">SG</span>
          <div>
            <p>SteamGuess / Internal</p>
            <h1>难度标注台</h1>
          </div>
        </div>
        <div className="labeler-header-actions">
          <button type="button" className="labeler-button" onClick={undo} disabled={history.length === 0}>
            <LabelerIcon name="undo" />撤销 <kbd>Z</kbd>
          </button>
          <button type="button" className="labeler-button" onClick={() => importRef.current?.click()}>
            <LabelerIcon name="upload" />导入
          </button>
          <input
            ref={importRef}
            className="visually-hidden"
            type="file"
            accept="application/json,.json"
            onChange={event => event.target.files?.[0] && void importLabels(event.target.files[0])}
          />
          <button type="button" className="labeler-button primary" onClick={exportLabels} disabled={labels.size === 0}>
            <LabelerIcon name="download" />导出 JSON
          </button>
        </div>
      </header>

      <main className="labeler-layout">
        <aside className="labeler-sidebar" aria-label="标注进度">
          <section className="progress-panel">
            <div className="progress-heading">
              <div><strong>{labels.size}</strong><span>/ {catalog.games.length}</span></div>
              <span>{progress}%</span>
            </div>
            <div className="progress-track" aria-label={`已完成 ${progress}%`}>
              <span style={{ transform: `scaleX(${progress / 100})` }} />
            </div>
            <p>所有数据只保存在当前浏览器，请定期导出。</p>
          </section>

          <section className="count-grid" aria-label="各难度数量">
            {LEVEL_OPTIONS.map(option => (
              <div className={`count-item ${option.level}`} key={option.level}>
                <span>{option.label}</span><strong>{counts[option.level]}</strong>
              </div>
            ))}
            <div className="count-item excluded"><span>不收录</span><strong>{counts.excluded}</strong></div>
          </section>

          <section className="recent-panel">
            <div className="section-heading"><h2>最近标注</h2><span>{recentLabels.length}</span></div>
            {recentLabels.length === 0 ? (
              <p className="empty-copy">完成第一条标注后会显示在这里。</p>
            ) : (
              <ul>
                {recentLabels.map(({ label, game }) => game && (
                  <li key={label.appId}>
                    <button type="button" onClick={() => setCurrentAppId(label.appId)}>
                      <span>{game.name}</span><small className={label.excluded ? 'excluded' : label.level ?? ''}>{labelName(label)}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <button type="button" className="clear-button" onClick={clearLabels} disabled={labels.size === 0}>
            <LabelerIcon name="trash" />清空本地标注
          </button>
        </aside>

        <section className="labeler-workspace">
          <div className="labeler-search-wrap">
            <LabelerIcon name="search" />
            <label className="visually-hidden" htmlFor="labeler-search">搜索游戏或 App ID</label>
            <input
              id="labeler-search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索游戏或 App ID…"
              autoComplete="off"
            />
            {searchResults.length > 0 && (
              <div className="labeler-search-results">
                {searchResults.map(game => (
                  <button key={game.appId} type="button" onClick={() => { setCurrentAppId(game.appId); setQuery(''); }}>
                    <span>{game.name}</span>
                    <small>#{game.appId}{labels.has(game.appId) ? ' · 已标注' : ''}</small>
                  </button>
                ))}
              </div>
            )}
          </div>

          <article className="labeling-card" id="labeling-card">
            <div className="game-visual">
              <img
                key={currentGame.appId}
                src={gameImage(currentGame)}
                alt={`${currentGame.name} 的 Steam 商店图片`}
                onError={event => { event.currentTarget.style.visibility = 'hidden'; }}
              />
              <span className="image-appid">APP {currentGame.appId}</span>
              {currentLabel && <span className={`existing-label ${currentLabel.excluded ? 'excluded' : currentLabel.level ?? ''}`}>当前：{labelName(currentLabel)}</span>}
            </div>

            <div className="game-content">
              <div className="game-title-row">
                <div>
                  <p className="game-kicker">当前候选</p>
                  <h2>{currentGame.name}</h2>
                  <p className="game-maker">
                    {[...currentGame.developers, ...currentGame.publishers].filter(Boolean).slice(0, 2).join(' · ') || '开发商信息暂缺'}
                  </p>
                </div>
                <a className="store-link" href={`https://store.steampowered.com/app/${currentGame.appId}`} target="_blank" rel="noreferrer">
                  商店页 <LabelerIcon name="external" />
                </a>
              </div>

              <dl className="metric-grid">
                <div><dt>当前在线</dt><dd>{formatNumber(currentGame.metrics.ccu)}</dd></div>
                <div><dt>预计拥有者</dt><dd>{formatNumber(currentGame.metrics.ownersMin)}–{formatNumber(currentGame.metrics.ownersMax)}</dd></div>
                <div><dt>评价数量</dt><dd>{formatNumber(currentGame.metrics.reviewsTotal)}</dd></div>
                <div><dt>好评比例</dt><dd>{positiveRatio}%</dd></div>
              </dl>

              {currentGame.userTags.length > 0 && (
                <div className="tag-list" aria-label="Steam 用户标签">
                  {currentGame.userTags.slice(0, 8).map(tag => <span key={tag}>{tag}</span>)}
                </div>
              )}

              <button type="button" className="reference-toggle" onClick={() => setShowReference(value => !value)} aria-expanded={showReference}>
                {showReference ? '隐藏现有参考' : '显示现有参考（避免标注偏差，默认隐藏）'}
              </button>
              {showReference && (
                <div className="reference-panel">
                  <span>识别度 <strong>{currentGame.recognitionScore.toFixed(1)}</strong></span>
                  <span>启发式建议 <strong>{LEVEL_OPTIONS.find(option => option.level === currentGame.suggestedLevel)?.label}</strong></span>
                </div>
              )}
            </div>
          </article>

          <section className="decision-panel" aria-labelledby="decision-title">
            <div className="decision-heading">
              <div><p>你的判断</p><h2 id="decision-title">它应该最早出现在哪个难度？</h2></div>
              <button type="button" className="skip-button" onClick={() => selectNext()}><LabelerIcon name="skip" />跳过 <kbd>S</kbd></button>
            </div>
            <p className="nesting-note">难度库互相包含：简单 ⊂ 普通 ⊂ 困难 ⊂ 地狱。</p>
            <div className="decision-grid">
              {LEVEL_OPTIONS.map(option => (
                <button key={option.level} type="button" className={`difficulty-button ${option.level}`} onClick={() => applyLabel(option.level)}>
                  <kbd>{option.key}</kbd><strong>{option.label}</strong><span>{option.help}</span>
                </button>
              ))}
              <button type="button" className="difficulty-button exclude" onClick={() => applyLabel(null, true)}>
                <kbd>5</kbd><strong>不收录</strong><span>不是游戏、素材不合适或不值得出题</span>
              </button>
            </div>
          </section>

          {message && <div className="labeler-message" role="status" aria-live="polite">{message}</div>}
        </section>
      </main>
    </div>
  );
}

export default DifficultyLabeler;
