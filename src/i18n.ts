import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const resources = {
  en: {
    translation: {
      app: {
        settings: 'Settings',
        openSettings: 'Open settings',
        flipArrowLogic: 'Flip arrow logic',
        language: 'Language',
        english: 'English',
        chinese: '中文',
        title: '🎮 SteamGuess',
        subtitle: 'Guess the Steam game based on the clues!',
        noGameLoaded: 'No game loaded',
        startGame: 'Start Game',
        attemptsLeft: 'Attempts Left:',
        guessesMade: 'Guesses Made:',
        surrender: 'Surrender',
        playAgain: 'Play Again',
        footer: 'SteamGuess © 2025 | MVP v0.1',
        alertCorrect: '🎉 Correct! {{name}} is the answer!\nYou used {{count}} attempts.',
        alertGameOver: '❌ Game Over! The answer was: {{name}}',
        alertSurrender: '🏳️ You surrendered.\nAnswer: {{name}}',
      },
      search: {
        placeholder: 'Search for a game...',
      },
      table: {
        gameName: 'Game Name',
        price: 'Price',
        peakPlayers: 'Peak Players',
        reviews: 'Reviews',
        rate: 'Rate',
        releaseDate: 'Release Date',
        tags: 'Tags',
        answerSuffix: ' (Answer)',
        openSteam: 'Open {{name}} on Steam',
      },
    },
  },
  zh: {
    translation: {
      app: {
        settings: '设置',
        openSettings: '打开设置',
        flipArrowLogic: '翻转箭头逻辑',
        language: '语言',
        english: 'English',
        chinese: '中文',
        title: '🎮 SteamGuess',
        subtitle: '根据线索猜测 Steam 游戏！',
        noGameLoaded: '未加载游戏',
        startGame: '开始游戏',
        attemptsLeft: '剩余次数：',
        guessesMade: '已猜次数：',
        surrender: '投降',
        playAgain: '再来一局',
        footer: 'SteamGuess © 2025 | MVP v0.1',
        alertCorrect: '🎉 猜对了！答案是 {{name}}！\n你用了 {{count}} 次尝试。',
        alertGameOver: '❌ 游戏结束！答案是：{{name}}',
        alertSurrender: '🏳️ 你已投降。\n答案：{{name}}',
      },
      search: {
        placeholder: '搜索游戏...',
      },
      table: {
        gameName: '游戏名',
        price: '价格',
        peakPlayers: '峰值在线',
        reviews: '评测数',
        rate: '好评率',
        releaseDate: '发售日期',
        tags: '标签',
        answerSuffix: '（答案）',
        openSteam: '在 Steam 打开 {{name}}',
      },
    },
  },
} as const;

i18n.use(initReactI18next).init({
  resources,
  lng: 'zh',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
