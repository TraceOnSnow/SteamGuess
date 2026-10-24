import { useState } from 'react';
import { loadGames, searchGames } from '../data/games';
import type { Game } from '../types/game';
import { CHALLENGES, type Challenge } from '../play/rules';
import { readStats } from '../play/progress';
import edition from '../../shared/edition.json';
import './HomePage.css';

export default function HomePage() {
  const [stats] = useState(readStats);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<Game[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const results = query.trim() ? searchGames(catalog, query, new Set(), 20) : [];
  return <div className="home-shell">
    <header className="home-top"><a className="home-logo" href="/">SG <span>SteamGuess</span></a></header>
    <main className="home-content">
      <section className="home-title"><h1>猜游戏</h1><p>{edition.answerLimit} 款题库 · {edition.searchLimit.toLocaleString()} 款可搜索</p></section>
      <nav className="home-modes" aria-label="开始游戏">
        <a className="home-mode home-primary" href="/singleplayer?daily=1"><h2>每日挑战 <span>↗</span></h2><p>每日一题</p></a>
        <a className="home-mode" href="/singleplayer"><h2>自由练习 <span>↗</span></h2><p>10 次猜测</p></a>
        <a className="home-mode" href="/multiplayer"><h2>多人房间 <span>↗</span></h2><p>2–8 人</p></a>
      </nav>
      <section className="home-difficulties" aria-label="五档题库">{(Object.keys(CHALLENGES) as Challenge[]).map(level => <div key={level}><span>{CHALLENGES[level].label}</span><strong>{CHALLENGES[level].poolSize}<small> 款</small></strong></div>)}</section>
      <section className="home-stats" aria-label="本机战绩"><span>已玩 <strong>{stats.played}</strong> 局</span><span>猜中 <strong>{stats.won}</strong> 局</span><span>最佳 <strong>{stats.best ?? '—'}</strong> 次</span></section>
      <details className="home-library" onToggle={event => {
        if (event.currentTarget.open && !catalog.length && !catalogLoading) {
          setCatalogLoading(true); setCatalogError(false);
          void loadGames().then(setCatalog).catch(() => setCatalogError(true)).finally(() => setCatalogLoading(false));
        }
      }}><summary>搜索游戏库</summary><div className="library-content"><label htmlFor="collection-query">中文、英文或别名</label><input id="collection-query" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索游戏…" /><div className="collection-list">{results.map(game => <span key={game.appId}>{game.localizedNames?.zh || game.name}</span>)}</div><p>{catalogLoading ? '加载中…' : catalogError ? '加载失败，重新展开可重试。' : query.trim() && !results.length ? '未找到游戏' : `共 ${catalog.length.toLocaleString()} 款`}</p></div></details>
    </main><footer className="home-footer">游戏图片归各自权利人所有</footer>
  </div>;
}
