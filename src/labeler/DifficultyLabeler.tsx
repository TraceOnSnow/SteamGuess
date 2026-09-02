import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DifficultyLevel } from '../difficulty/types';
import './DifficultyLabeler.css';

interface DifficultyRow {
  appId: number;
  name: string;
  localizedName: string | null;
  manualScore: number | null;
  locked: boolean;
  feedbackScore: number | null;
  feedbackCount: number;
  feedbackMean: number | null;
  feedbackStddev: number | null;
  feedbackUpdatedAt: string | null;
  effectiveScore: number | null;
  effectiveLevel: DifficultyLevel | null;
  updatedAt: string | null;
  active: boolean;
  searchOnly: boolean;
  excluded: boolean;
  exclusionReason: 'software' | 'test_app' | 'manual_exclusion' | 'duplicate' | 'too_obscure' | null;
  exclusionUpdatedAt: string | null;
}

interface DifficultyList {
  rows: DifficultyRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

type Filter = 'all' | 'feedback' | 'review' | 'locked' | 'unlocked' | 'edited' | 'excluded';
type Sort = 'effective' | 'manual' | 'feedback' | 'difference' | 'name';
type Direction = 'asc' | 'desc';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const TOKEN_KEY = 'steamguess-admin-token';
const LEVEL_NAMES: Record<DifficultyLevel, string> = {
  beginner: '入门',
  easy: '简单',
  normal: '普通',
  hard: '困难',
  hell: '地狱',
};
const EXCLUSION_NAMES = {
  software: '软件',
  test_app: '测试应用',
  manual_exclusion: '不适合',
  duplicate: '重复项',
  too_obscure: '太冷门（仅搜索）',
} as const;

function requestHeaders(token: string, json = false): HeadersInit {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function apiJson<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...requestHeaders(token, Boolean(init?.body)), ...init?.headers }, cache: 'no-store' });
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败（${response.status}）`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return payload as T;
}

function displayScore(score: number | null) {
  return score == null ? '—' : String(Math.round(score));
}

function levelName(level: DifficultyLevel | null) {
  return level ? LEVEL_NAMES[level] : '未定';
}

interface ScoreEditorProps {
  row: DifficultyRow;
  state: SaveState;
  onSave: (manualScore: number | null) => void;
}

function ScoreEditor({ row, state, onSave }: ScoreEditorProps) {
  const [draft, setDraft] = useState(row.manualScore ?? row.feedbackScore ?? row.effectiveScore ?? 50);
  const previousAppId = useRef(row.appId);

  useEffect(() => {
    if (previousAppId.current !== row.appId || state === 'saved') {
      previousAppId.current = row.appId;
      setDraft(row.manualScore ?? row.feedbackScore ?? row.effectiveScore ?? 50);
    }
  }, [row.appId, row.effectiveScore, row.feedbackScore, row.manualScore, state]);

  const commit = () => {
    const normalized = Math.max(0, Math.min(100, Math.round(Number(draft))));
    setDraft(normalized);
    if (normalized !== row.manualScore) onSave(normalized);
  };

  return (
    <div className="difficulty-score-editor">
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={draft}
        onChange={event => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) commit(); }}
        aria-label={`${row.name} 人工难度分`}
      />
      <input
        className="score-number"
        type="number"
        min="0"
        max="100"
        step="1"
        value={draft}
        onChange={event => setDraft(Number(event.target.value))}
        onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        aria-label={`${row.name} 人工难度数字`}
      />
      {row.manualScore != null && (
        <button className="score-reset" type="button" onClick={() => onSave(null)} title="清除人工分，恢复使用玩家反馈分">重置</button>
      )}
      <span className={`save-state ${state}`}>{state === 'saving' ? '保存中' : state === 'saved' ? '已保存' : state === 'error' ? '失败' : ''}</span>
    </div>
  );
}

export default function DifficultyLabeler() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [tokenDraft, setTokenDraft] = useState(token);
  const [result, setResult] = useState<DifficultyList | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('effective');
  const [direction, setDirection] = useState<Direction>('asc');
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);
  const [saveStates, setSaveStates] = useState<Record<number, SaveState>>({});

  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedQuery(query); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    const parameters = new URLSearchParams({ q: debouncedQuery, filter, sort, direction, scope, page: String(page), pageSize: '100' });
    try {
      const data = await apiJson<DifficultyList>(`/api/admin/difficulties?${parameters}`, token, { signal });
      setResult(data);
      setUnauthorized(false);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      const status = typeof caught === 'object' && caught && 'status' in caught ? Number(caught.status) : 0;
      setUnauthorized(status === 401 || status === 503);
      setError(caught instanceof Error ? caught.message : '难度数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery, direction, filter, page, scope, sort, token]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  const save = useCallback(async (appId: number, patch: {
    manualScore?: number | null;
    locked?: boolean;
    excluded?: boolean;
    exclusionReason?: keyof typeof EXCLUSION_NAMES;
  }) => {
    setSaveStates(states => ({ ...states, [appId]: 'saving' }));
    try {
      const updated = await apiJson<DifficultyRow>(`/api/admin/difficulties/${appId}`, token, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      setResult(current => {
        if (!current) return current;
        if (scope === 'active' && !updated.active) {
          return {
            ...current,
            total: Math.max(0, current.total - 1),
            rows: current.rows.filter(row => row.appId !== appId),
          };
        }
        return { ...current, rows: current.rows.map(row => row.appId === appId ? updated : row) };
      });
      setSaveStates(states => ({ ...states, [appId]: 'saved' }));
      window.setTimeout(() => setSaveStates(states => ({ ...states, [appId]: states[appId] === 'saved' ? 'idle' : states[appId] })), 1400);
    } catch (caught) {
      setSaveStates(states => ({ ...states, [appId]: 'error' }));
      setError(caught instanceof Error ? caught.message : '保存失败');
    }
  }, [scope, token]);

  const stats = useMemo(() => {
    const rows = result?.rows ?? [];
    return {
      locked: rows.filter(row => row.locked).length,
      edited: rows.filter(row => row.manualScore != null).length,
      excluded: rows.filter(row => row.excluded).length,
    };
  }, [result]);

  const applyToken = () => {
    const next = tokenDraft.trim();
    if (next) sessionStorage.setItem(TOKEN_KEY, next); else sessionStorage.removeItem(TOKEN_KEY);
    setToken(next);
  };

  return (
    <main className="difficulty-console">
      <header className="difficulty-header">
        <div>
          <a className="home-link" href="/">← 返回主页</a>
          <h1>难度管理</h1>
          <p>人工分用于编辑初始难度；未锁定的游戏可以由玩家反馈更新，锁定后不会自动修改。</p>
        </div>
        <div className="difficulty-header-actions">
          <div className="header-summary">
            <strong>{result?.total ?? 0}</strong><span>款游戏</span>
            <strong>{stats.locked}</strong><span>本页锁定</span>
            <strong>{stats.edited}</strong><span>本页已编辑</span>
            <strong>{stats.excluded}</strong><span>本页已移出</span>
          </div>
        </div>
      </header>

      {unauthorized && (
        <section className="token-panel">
          <label htmlFor="admin-token">管理令牌</label>
          <input id="admin-token" type="password" value={tokenDraft} onChange={event => setTokenDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') applyToken(); }} />
          <button type="button" onClick={applyToken}>连接</button>
          <span>{error}</span>
        </section>
      )}

      <section className="difficulty-toolbar" aria-label="难度列表筛选">
        <input className="difficulty-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索中文名、英文名或 AppID" />
        <select value={filter} onChange={event => {
          const next = event.target.value as Filter;
          setFilter(next);
          if (next === 'excluded') setScope('all');
          setPage(1);
        }} aria-label="编辑状态">
          <option value="all">全部状态</option><option value="feedback">有玩家反馈</option><option value="review">反馈待审核</option><option value="locked">已锁定</option><option value="unlocked">未锁定</option><option value="edited">有人工分</option><option value="excluded">已移出 Active</option>
        </select>
        <select value={sort} onChange={event => { setSort(event.target.value as Sort); setPage(1); }} aria-label="排序字段">
          <option value="effective">有效分</option><option value="feedback">玩家反馈分</option><option value="manual">人工分</option><option value="difference">与玩家反馈偏差</option><option value="name">名称</option>
        </select>
        <button type="button" className="direction-button" onClick={() => setDirection(value => value === 'asc' ? 'desc' : 'asc')}>{direction === 'asc' ? '升序 ↑' : '降序 ↓'}</button>
        <label className="scope-toggle"><input type="checkbox" checked={scope === 'all'} onChange={event => { setScope(event.target.checked ? 'all' : 'active'); setPage(1); }} /> 包含备用库</label>
        <button type="button" onClick={() => void load()}>刷新</button>
      </section>

      {error && !unauthorized && <div className="difficulty-error">{error}</div>}

      <section className="difficulty-table-wrap" aria-busy={loading}>
        <table className="difficulty-table">
          <thead><tr><th>游戏</th><th>玩家反馈</th><th>人工分</th><th>有效分 / 等级</th><th>编辑人工分</th><th>锁定</th><th>题库状态</th></tr></thead>
          <tbody>
            {result?.rows.map(row => (
              <tr key={row.appId} className={row.locked ? 'is-locked' : ''}>
                <td className="game-cell">
                  <a href={`https://store.steampowered.com/app/${row.appId}`} target="_blank" rel="noreferrer">{row.localizedName || row.name}</a>
                  {row.localizedName && <small>{row.name}</small>}
                  <code>{row.appId}</code>
                </td>
                <td className="feedback-score-cell">
                  <strong>{displayScore(row.feedbackScore)}</strong>
                  <small>
                    {row.feedbackCount
                      ? `${row.feedbackCount} 人 · 均值 ${displayScore(row.feedbackMean)} · σ ${row.feedbackStddev == null ? '—' : row.feedbackStddev.toFixed(1)}`
                      : '暂无反馈'}
                  </small>
                </td>
                <td><strong>{displayScore(row.manualScore)}</strong><small>{row.manualScore == null ? '未编辑' : row.locked ? '已采用' : '未锁定'}</small></td>
                <td><strong className={`level-score ${row.effectiveLevel || ''}`}>{displayScore(row.effectiveScore)}</strong><small>{levelName(row.effectiveLevel)}</small></td>
                <td className="editor-cell"><ScoreEditor row={row} state={saveStates[row.appId] || 'idle'} onSave={manualScore => void save(row.appId, { manualScore })} /></td>
                <td>
                  <button type="button" className={`lock-button ${row.locked ? 'locked' : ''}`} onClick={() => void save(row.appId, { locked: !row.locked })} disabled={saveStates[row.appId] === 'saving'} aria-pressed={row.locked}>
                    {row.locked ? '已锁定' : '锁定'}
                  </button>
                </td>
                <td className="catalog-state-cell">
                  {row.excluded || row.searchOnly ? (
                    <>
                      <small>{row.exclusionReason ? EXCLUSION_NAMES[row.exclusionReason] : row.excluded ? '已移出' : '仅搜索'}</small>
                      <button type="button" className="restore-button" onClick={() => void save(row.appId, { excluded: false })} disabled={saveStates[row.appId] === 'saving'}>恢复候选</button>
                    </>
                  ) : (
                    <div className="exclude-actions">
                      <button type="button" onClick={() => void save(row.appId, { excluded: true, exclusionReason: 'software' })} disabled={saveStates[row.appId] === 'saving'}>软件</button>
                      <button type="button" onClick={() => void save(row.appId, { excluded: true, exclusionReason: 'manual_exclusion' })} disabled={saveStates[row.appId] === 'saving'}>不适合</button>
                      <button type="button" onClick={() => void save(row.appId, { excluded: true, exclusionReason: 'too_obscure' })} disabled={saveStates[row.appId] === 'saving'}>太冷门</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!loading && result?.rows.length === 0 && <tr><td colSpan={7} className="empty-row">没有符合条件的游戏</td></tr>}
          </tbody>
        </table>
        {loading && <div className="table-loading">正在读取数据库…</div>}
      </section>

      <footer className="difficulty-pagination">
        <button type="button" disabled={!result || result.page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>上一页</button>
        <span>第 {result?.page ?? page} / {result?.pages ?? 1} 页</span>
        <button type="button" disabled={!result || result.page >= result.pages} onClick={() => setPage(value => value + 1)}>下一页</button>
      </footer>
    </main>
  );
}
