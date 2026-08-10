import './HomePage.css';

export default function HomePage() {
  return (
    <main className="home-shell">
      <section className="home-card" aria-labelledby="home-title">
        <div className="home-mark" aria-hidden="true">SG</div>
        <p className="home-eyebrow">SteamGuess</p>
        <h1 id="home-title">你想怎么玩？</h1>
        <p className="home-intro">猜猜这是哪款 Steam 游戏。</p>
        <div className="home-modes">
          <a className="home-mode home-mode-primary" href="/singleplayer">
            <span className="home-mode-icon" aria-hidden="true">◉</span>
            <span><strong>单人模式</strong><small>自己挑战今日游戏</small></span>
            <span className="home-arrow" aria-hidden="true">→</span>
          </a>
          <a className="home-mode" href="/multiplayer">
            <span className="home-mode-icon" aria-hidden="true">♟</span>
            <span><strong>多人模式</strong><small>创建房间，和朋友同题竞速</small></span>
            <span className="home-arrow" aria-hidden="true">→</span>
          </a>
        </div>
      </section>
    </main>
  );
}
