import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import edition from '../../shared/edition.json';
import { ClueTile } from '../components/GuessCard';
import { TopBar } from '../components/TopBar';
import { readSavedRound, readStats, roundKey } from '../play/progress';
import { DAILY_LEVEL, LEVELS, POOL_SIZES, dateKey } from '../play/rules';
import './home.css';

export default function HomePage() {
  const { t, i18n } = useTranslation();
  const [stats] = useState(readStats);
  const [dailyDone] = useState(() => {
    const saved = readSavedRound(roundKey(dateKey(), DAILY_LEVEL));
    return Boolean(saved && saved.phase !== 'playing');
  });
  const zh = i18n.language.startsWith('zh');

  return <div className="page">
    <TopBar />
    <main className="home">
      <section className="hero">
        <p className="label">{t('home.poolLine', { answers: edition.answerLimit.toLocaleString(), search: edition.searchLimit.toLocaleString() })}</p>
        <h1>{t('home.title')}</h1>
        <p className="hero-lead">{t('home.lead')}</p>
      </section>

      <nav className="modes" aria-label={t('home.title')}>
        <a className="mode mode-primary" href="/singleplayer?daily=1">
          <span className="label">01</span>
          <h2>{t('home.daily')}</h2>
          <p>{dailyDone ? t('home.dailyDone') : t('home.dailyHelp')}</p>
          <span className="mode-go" aria-hidden="true">→</span>
        </a>
        <a className="mode" href="/singleplayer">
          <span className="label">02</span>
          <h2>{t('home.practice')}</h2>
          <p>{t('home.practiceHelp')}</p>
          <span className="mode-go" aria-hidden="true">→</span>
        </a>
        <a className="mode" href="/multiplayer">
          <span className="label">03</span>
          <h2>{t('home.multiplayer')}</h2>
          <p>{t('home.multiplayerHelp')}</p>
          <span className="mode-go" aria-hidden="true">→</span>
        </a>
      </nav>

      <section className="how">
        <div>
          <h2>{t('home.howTitle')}</h2>
          <p>{t('home.howBody')}</p>
          <div className="legend">
            {(['exact', 'partial', 'close', 'wrong'] as const).map(status => <span key={status}><i className={`is-${status}`} />{t(`status.${status}`)}</span>)}
          </div>
        </div>
        <figure className="example">
          <div className="tiles">
            <ClueTile field="price" value={zh ? '¥68' : '$19.99'} result={{ status: 'close', direction: 'higher' }} />
            <ClueTile field="popularity" value={zh ? '1.2万' : '12K'} result={{ status: 'wrong', direction: 'lower' }} />
            <ClueTile field="reviews" value={zh ? '8.4万' : '84K'} result={{ status: 'partial', direction: 'higher' }} />
            <ClueTile field="rating" value="94%" result={{ status: 'exact', direction: 'near' }} />
            <ClueTile field="releaseDate" value={zh ? '2017年3月' : 'Mar 2017'} result={{ status: 'close', direction: 'higher' }} />
          </div>
          <figcaption>{t('home.exampleCaption')}</figcaption>
        </figure>
      </section>

      <section className="facts">
        <dl className="levels">
          {LEVELS.map(level => <div key={level}>
            <dt>{t(`level.${level}`)}</dt>
            <dd className="num">{POOL_SIZES[level]}</dd>
          </div>)}
        </dl>
        <dl className="record" aria-label={t('home.statsTitle')}>
          <div><dt>{t('home.played')}</dt><dd className="num">{stats.played}</dd></div>
          <div><dt>{t('home.won')}</dt><dd className="num">{stats.won}</dd></div>
          <div><dt>{t('home.best')}</dt><dd className="num">{stats.best ?? '—'}</dd></div>
          <div><dt>{t('home.streak')}</dt><dd className="num">{stats.streak}</dd></div>
        </dl>
      </section>
    </main>
    <footer className="home-foot">{t('home.footer')}</footer>
  </div>;
}
