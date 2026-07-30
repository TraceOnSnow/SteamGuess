import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chooseRandomUnlabeled, loadLabelingCatalog, searchLabelingGames } from './data';
import { applyAutomaticSoftwareExclusions, buildExportPayload, isSoftwareApp, loadStoredLabels, parseLabels, saveStoredLabels, STORAGE_KEY } from './labels';
import { LabelerIcon } from './LabelerIcon';
import { DIFFICULTY_TARGETS, levelForValue, saveDifficultyModel, trainDifficultyModel } from '../difficulty/model';
import { localizedTagName } from '../data/localization';
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
  if (label.excludedReason === 'software') return '软件 · 自动排除';
  if (label.excluded) return '不收录';
  return LEVEL_OPTIONS.find(option => option.level === label.level)?.label ?? '未标注';
}

interface ScoreRangeProps {
  value: number;
  onCommit: (value: number) => void;
  ariaLabel: string;
  disabled?: boolean;
}

function ScoreRange({ value, onCommit, ariaLabel, disabled = false }: ScoreRangeProps) {
  const [draft, setDraft] = useState(Math.round(value));
  const committed = useRef(Math.round(value));

  const commit = () => {
    if (draft === committed.current) return;
    committed.current = draft;
    onCommit(draft);
  };

  return (
    <input
      type="range"
      min="0"
      max="100"
      step="1"
      value={draft}
      onChange={event => setDraft(Number(event.target.value))}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  );
}

function DifficultyLabeler() {
  const [catalog, setCatalog] = useState<LabelingCatalog | null>(null);
  const [labels, setLabels] = useState<Map<number, DifficultyLabel>>(() => loadStoredLabels());
  const [currentAppId, setCurrentAppId] = useState<number | null>(null);
  const [history, setHistory] = useState<Array<{ appId: number; previous?: DifficultyLabel }>>([]);
  const [query, setQuery] = useState('');
  const [showReference, setShowReference] = useState(false);
  const [message, setMessage] = useState('');
  const [showReview, setShowReview] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<DifficultyLevel | 'excluded' | 'all'>('all');
  const [reviewQuery, setReviewQuery] = useState('');
  const [loadError, setLoadError] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadLabelingCatalog(controller.signal)
      .then(result => {
        setCatalog(result);
        const storedLabels = loadStoredLabels();
        const validLabels = new Map([...storedLabels].filter(([appId]) => result.games.some(game => game.appId === appId)));
        const automatic = applyAutomaticSoftwareExclusions(validLabels, result.games);
        setLabels(automatic.labels);
        if (automatic.changed > 0 || validLabels.size !== storedLabels.size) saveStoredLabels(automatic.labels);
        if (automatic.changed > 0) setMessage(`已自动排除 ${automatic.changed} 个 Steam Application 软件`);
        setCurrentAppId(chooseRandomUnlabeled(result.games, new Set(automatic.labels.keys()))?.appId ?? result.games[0]?.appId ?? null);
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
  const difficultyModel = useMemo(
    () => catalog ? trainDifficultyModel(catalog.games, labels) : null,
    [catalog, labels],
  );

  const reviewItems = useMemo(() => {
    const normalized = reviewQuery.trim().toLocaleLowerCase();
    const games = reviewFilter === 'all'
      ? catalog?.games ?? []
      : [...labels.values()]
        .filter(label => reviewFilter === 'excluded' ? label.excluded : !label.excluded && label.level === reviewFilter)
        .map(label => gamesById.get(label.appId))
        .filter((game): game is LabelingGame => Boolean(game));

    return games
      .filter(game => !normalized || game.name.toLocaleLowerCase().includes(normalized) || game.localizedNames?.zh?.includes(reviewQuery.trim()) || String(game.appId) === normalized)
      .map(game => ({
        game,
        label: labels.get(game.appId),
        score: difficultyModel?.predictions[String(game.appId)]?.score ?? Math.round((100 - game.recognitionScore) * 10) / 10,
      }))
      .sort((left, right) => right.score - left.score || left.game.name.localeCompare(right.game.name));
  }, [catalog, difficultyModel, gamesById, labels, reviewFilter, reviewQuery]);

  useEffect(() => {
    if (difficultyModel) saveDifficultyModel(difficultyModel);
  }, [difficultyModel]);

  const counts = useMemo(() => {
    const result = { easy: 0, normal: 0, hard: 0, hell: 0, excluded: 0, automatic: 0 };

    for (const label of labels.values()) {
      if (label.automatic) result.automatic += 1;
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
    if (isSoftwareApp(currentGame.appType) && !excluded) {
      setMessage('Steam Application 软件必须统一排除');
      return;
    }
    const previous = labels.get(currentGame.appId);
    const nextLabel: DifficultyLabel = {
      appId: currentGame.appId,
      level,
      score: level ? Math.round(DIFFICULTY_TARGETS[level] / 3 * 1000) / 10 : undefined,
      excluded,
      reviewedAt: new Date().toISOString(),
      automatic: false,
      excludedReason: excluded ? 'manual' : undefined,
    };
    const nextLabels = new Map(labels).set(currentGame.appId, nextLabel);
    setHistory(items => [...items.slice(-49), { appId: currentGame.appId, previous }]);
    setLabels(nextLabels);
    saveStoredLabels(nextLabels);
    setMessage(`${currentGame.name} → ${labelName(nextLabel)}`);
    selectNext(nextLabels, currentGame.appId);
  }, [currentGame, labels, selectNext]);

  const updateReviewedLabel = (game: LabelingGame, value: string) => {
    if (isSoftwareApp(game.appType)) {
      setMessage('Steam Application 软件必须统一排除');
      return;
    }
    const previous = labels.get(game.appId);
    const nextLabels = new Map(labels);
    if (value === 'unlabeled') {
      nextLabels.delete(game.appId);
    } else {
      const excluded = value === 'excluded';
      nextLabels.set(game.appId, {
        appId: game.appId,
        level: excluded ? null : value as DifficultyLevel,
        score: excluded ? undefined : Math.round(DIFFICULTY_TARGETS[value as DifficultyLevel] / 3 * 1000) / 10,
        excluded,
        reviewedAt: new Date().toISOString(),
        automatic: false,
        excludedReason: excluded ? 'manual' : undefined,
      });
    }
    setHistory(items => [...items.slice(-49), { appId: game.appId, previous }]);
    setLabels(nextLabels);
    saveStoredLabels(nextLabels);
    setMessage(`${game.name} → ${value === 'unlabeled' ? '取消标注' : labelName(nextLabels.get(game.appId)!)}`);
  };

  const updateScore = useCallback((game: LabelingGame, score: number) => {
    if (isSoftwareApp(game.appType)) {
      setMessage('Steam Application 软件必须统一排除');
      return;
    }
    const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));
    const previous = labels.get(game.appId);
    const nextLabel: DifficultyLabel = {
      appId: game.appId,
      level: levelForValue(normalizedScore / 100 * 3),
      score: normalizedScore,
      excluded: false,
      reviewedAt: new Date().toISOString(),
      automatic: false,
    };
    const nextLabels = new Map(labels).set(game.appId, nextLabel);
    setHistory(items => [...items.slice(-49), { appId: game.appId, previous }]);
    setLabels(nextLabels);
    saveStoredLabels(nextLabels);
    setMessage(`${game.name} → 难度分 ${normalizedScore}`);
  }, [labels]);

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
      const automatic = applyAutomaticSoftwareExclusions(nextLabels, catalog?.games ?? []);
      setLabels(automatic.labels);
      saveStoredLabels(automatic.labels);
      setMessage(`已导入 ${imported.size} 条；当前 ${automatic.labels.size} 条，软件已统一排除`);
      selectNext(automatic.labels);
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

  const manualCount = labels.size - counts.automatic;
  const progress = Math.round(labels.size / catalog.games.length * 100);
  const positiveRatio = currentGame.metrics.reviewsTotal
    ? Math.round(currentGame.metrics.positive / currentGame.metrics.reviewsTotal * 100)
    : 0;
  const currentLabel = labels.get(currentGame.appId);
  const currentScore = currentLabel?.score
    ?? difficultyModel?.predictions[String(currentGame.appId)]?.score
    ?? Math.round((100 - currentGame.recognitionScore) * 10) / 10;

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
          <button type="button" className="labeler-button" onClick={() => setShowReview(true)}>
            <LabelerIcon name="list" />查看分类 <span className="button-count">{labels.size}</span>
          </button>
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
            <p>人工标注 {manualCount} 条 · 自动排除软件 {counts.automatic} 条</p>
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

          <section className="model-panel" aria-live="polite">
            <div className="section-heading"><h2>难度模型</h2><span>{difficultyModel ? '已试装' : '等待数据'}</span></div>
            {difficultyModel ? (
              <>
                <p><strong>{difficultyModel.trainingLabels}</strong> 条人工样本已实时训练</p>
                <div className="model-metrics">
                  <span>拟合准确率 {(difficultyModel.trainAccuracy * 100).toFixed(0)}%</span>
                  <span>平均误差 {difficultyModel.trainMae.toFixed(2)}</span>
                </div>
                <div className="model-pools">
                  {LEVEL_OPTIONS.map(option => <span key={option.level}>{option.label}题库 {difficultyModel.poolCounts[option.level]}</span>)}
                </div>
              </>
            ) : <p>至少需要 20 条非排除标注，达到后自动训练并供主游戏使用。</p>}
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
                    <span>{game.localizedNames?.zh || game.name}</span>
                    <small>{game.localizedNames?.zh ? `${game.name} · ` : ''}#${game.appId}{labels.has(game.appId) ? ' · 已标注' : ''}</small>
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
                  <div className="game-maker">
                    <span><strong>开发商</strong>{currentGame.developers.join(' / ') || '暂缺'}</span>
                    <span><strong>发行商</strong>{currentGame.publishers.join(' / ') || '暂缺'}</span>
                  </div>
                </div>
                <a className="store-link" href={`https://store.steampowered.com/app/${currentGame.appId}`} target="_blank" rel="noreferrer">
                  商店页 <LabelerIcon name="external" />
                </a>
              </div>

              <dl className="metric-grid">
                <div>
                  <dt>{currentGame.metrics.peak7d !== undefined ? '近 7 日峰值' : '昨日峰值'}</dt>
                  <dd>{formatNumber(currentGame.metrics.peak7d ?? currentGame.metrics.peakYesterday ?? currentGame.metrics.ccu)}</dd>
                </div>
                <div><dt>预计拥有者</dt><dd>{formatNumber(currentGame.metrics.ownersMin)}–{formatNumber(currentGame.metrics.ownersMax)}</dd></div>
                <div><dt>评价数量</dt><dd>{formatNumber(currentGame.metrics.reviewsTotal)}</dd></div>
                <div><dt>好评比例</dt><dd>{positiveRatio}%</dd></div>
              </dl>

              <div className="app-type-row">
                <span>Steam 类型</span><strong>{currentGame.appType || '未知'}</strong>
                {isSoftwareApp(currentGame.appType) && <em>软件将自动排除</em>}
              </div>

              <div className="tag-list" aria-label="开发商、发行商和 Steam 用户标签">
                {currentGame.developers.slice(0, 2).map(name => <span className="maker-tag developer" key={`developer-${name}`}>开发商 · {name}</span>)}
                {currentGame.publishers.slice(0, 2).map(name => <span className="maker-tag publisher" key={`publisher-${name}`}>发行商 · {name}</span>)}
                {currentGame.userTags.slice(0, 20).map(tag => <span key={tag} title={tag}>{localizedTagName(tag, 'zh')}</span>)}
              </div>

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
            <p className="nesting-note">难度库互相包含：简单 ⊂ 普通 ⊂ 困难 ⊂ 地狱。可以点固定档位，也可以直接拖动分数。</p>
            <div className="score-editor">
              <div><span>难度分</span><strong>{Math.round(currentScore)}</strong></div>
              <ScoreRange
                key={`${currentGame.appId}-${Math.round(currentScore)}`}
                value={currentScore}
                onCommit={score => updateScore(currentGame, score)}
                disabled={isSoftwareApp(currentGame.appType)}
                ariaLabel={`${currentGame.name} 的难度分`}
              />
              <div className="score-scale"><span>简单 0</span><span>普通 33</span><span>困难 67</span><span>地狱 100</span></div>
            </div>
            <div className="decision-grid">
              {LEVEL_OPTIONS.map(option => (
                <button key={option.level} type="button" className={`difficulty-button ${option.level}`} onClick={() => applyLabel(option.level)} disabled={isSoftwareApp(currentGame.appType)}>
                  <kbd>{option.key}</kbd><strong>{option.label}</strong><span>{Math.round(DIFFICULTY_TARGETS[option.level] / 3 * 100)} 分 · {option.help}</span>
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

      {showReview && (
        <div className="review-overlay" role="dialog" aria-modal="true" aria-labelledby="review-title">
          <section className="review-dialog">
            <header className="review-header">
              <div><p>题库评分总览</p><h2 id="review-title">查看和修改难度分</h2></div>
              <button type="button" className="review-close" onClick={() => setShowReview(false)} aria-label="关闭分类总览"><LabelerIcon name="close" /></button>
            </header>
            <div className="review-tabs" role="tablist" aria-label="难度分类">
              <button type="button" role="tab" aria-selected={reviewFilter === 'all'} onClick={() => setReviewFilter('all')}>
                全部评分<span>{catalog.games.length}</span>
              </button>
              {LEVEL_OPTIONS.map(option => (
                <button key={option.level} type="button" role="tab" aria-selected={reviewFilter === option.level} onClick={() => setReviewFilter(option.level)}>
                  {option.label}<span>{counts[option.level]}</span>
                </button>
              ))}
              <button type="button" role="tab" aria-selected={reviewFilter === 'excluded'} onClick={() => setReviewFilter('excluded')}>
                不收录<span>{counts.excluded}</span>
              </button>
            </div>
            <div className="review-toolbar">
              <div><LabelerIcon name="search" /><input value={reviewQuery} onChange={event => setReviewQuery(event.target.value)} placeholder="搜索游戏或 AppID…" aria-label="搜索评分列表" /></div>
              <span>当前显示 {reviewItems.length} 款 · 高分在前</span>
            </div>
            <div className="review-list">
              {reviewItems.length === 0 ? <p className="review-empty">这个分类下还没有符合条件的游戏。</p> : reviewItems.map(({ label, game, score }) => (
                <article className="review-game" key={game.appId}>
                  <button className="review-game-main" type="button" onClick={() => { setCurrentAppId(game.appId); setShowReview(false); }}>
                    <img src={gameImage(game)} alt="" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} />
                    <span><strong>{game.localizedNames?.zh || game.name}</strong><small>{game.localizedNames?.zh ? `${game.name} · ` : ''}APP {game.appId}</small></span>
                  </button>
                  <div className="review-game-tags" aria-label={`${game.name} 的开发商、发行商和 Steam 标签`}>
                    {game.developers.slice(0, 1).map(name => <span className="maker-tag developer" key={`developer-${name}`}>开发商 · {name}</span>)}
                    {game.publishers.slice(0, 1).map(name => <span className="maker-tag publisher" key={`publisher-${name}`}>发行商 · {name}</span>)}
                    {game.userTags.slice(0, 8).map(tag => <span key={tag} title={tag}>{localizedTagName(tag, 'zh')}</span>)}
                    {game.developers.length + game.publishers.length + game.userTags.length === 0 && <span>暂无标签信息</span>}
                  </div>
                  <div className="review-game-edit">
                    {label?.excludedReason === 'software' ? (
                      <span className="auto-excluded">Application · 自动排除</span>
                    ) : (
                      <>
                        <div className="review-score"><strong>{Math.round(score)}</strong><span>{label && !label.excluded ? '人工' : '拟合'}</span></div>
                        <ScoreRange key={`${game.appId}-${Math.round(label?.score ?? score)}`} value={label?.score ?? score} onCommit={value => updateScore(game, value)} ariaLabel={`修改 ${game.name} 的难度分`} />
                        <label><span className="visually-hidden">修改 {game.name} 的难度</span>
                          <select value={label?.excluded ? 'excluded' : label?.level ?? 'unlabeled'} onChange={event => updateReviewedLabel(game, event.target.value)}>
                            {LEVEL_OPTIONS.map(option => <option key={option.level} value={option.level}>{option.label}</option>)}
                            <option value="excluded">不收录</option>
                            <option value="unlabeled">取消标注</option>
                          </select>
                        </label>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default DifficultyLabeler;
