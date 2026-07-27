import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const resources = {
  en: {
    translation: {
      app: {
        title: 'SteamGuess',
        eyebrow: '{{count}} games in the catalog',
        subtitle: 'Use price, popularity, reviews, release date, and shared tags to find the hidden Steam game.',
        loading: 'Loading the game catalog…',
        loadFailed: 'Could not load the game catalog',
        loadFailedHelp: 'Check your connection and try again.',
        retry: 'Try again',
        skipToGame: 'Skip to game',
        settings: 'Settings',
        language: 'Language',
        attempts: 'Attempts left',
        attemptsLeft: '{{count}} attempts left',
        surrender: 'Reveal answer',
        guessHeading: 'Make a guess',
        guessHelp: 'Search by game title. Each result tells you how close the guess is to the answer.',
        playAgain: 'Play another game',
        footer: 'SteamGuess · A small game built around Steam data',
      },
      search: {
        label: 'Search the Steam catalog',
        placeholder: 'Type a game title…',
        noResults: 'No unguessed games found.',
      },
      table: {
        feedback: 'Your clues',
        title: 'Guess history',
        legend: 'Match legend',
        cover: 'Cover',
        gameName: 'Game',
        price: 'Price',
        peakPlayers: 'Current players',
        reviews: 'Reviews',
        rate: 'Positive',
        releaseDate: 'Release date',
        tags: 'Tags',
        answer: 'Answer',
        sharedTag: 'shared with the answer',
        openSteam: 'Open {{name}} on Steam',
      },
      status: {
        exact: 'Exact',
        partial: 'Close',
        close: 'Near',
        wrong: 'Far',
        unknown: 'Unknown',
      },
      direction: {
        higher: 'The answer is higher',
        lower: 'The answer is lower',
        equal: 'Equal to the answer',
        near: 'Very close to the answer',
      },
      outcome: {
        won: {
          kicker: 'You found it',
          title: '{{name}} is the answer!',
          message: 'Solved in {{count}} guesses.',
        },
        lost: {
          kicker: 'No attempts left',
          title: 'The answer was {{name}}',
          message: 'The answer has been added to the bottom of your guess history.',
        },
        surrendered: {
          kicker: 'Answer revealed',
          title: 'The answer was {{name}}',
          message: 'Use the final row to compare it with your guesses.',
        },
      },
    },
  },
  zh: {
    translation: {
      app: {
        title: 'SteamGuess',
        eyebrow: '当前题库收录 {{count}} 款游戏',
        subtitle: '根据价格、热度、评测、发行日期和共同标签，找出隐藏的 Steam 游戏。',
        loading: '正在加载游戏题库…',
        loadFailed: '游戏题库加载失败',
        loadFailedHelp: '请检查网络或静态文件配置，然后重试。',
        retry: '重新加载',
        skipToGame: '跳到游戏区域',
        settings: '设置',
        language: '语言',
        attempts: '剩余机会',
        attemptsLeft: '还剩 {{count}} 次机会',
        surrender: '揭晓答案',
        guessHeading: '提交一个猜测',
        guessHelp: '按游戏名称搜索。每次提交后，表格会告诉你各项属性离答案有多近。',
        playAgain: '再来一局',
        footer: 'SteamGuess · 一个围绕 Steam 数据构建的小游戏',
      },
      search: {
        label: '搜索 Steam 游戏题库',
        placeholder: '输入游戏名称…',
        noResults: '没有找到尚未猜过的游戏。',
      },
      table: {
        feedback: '线索反馈',
        title: '猜测记录',
        legend: '匹配程度图例',
        cover: '封面',
        gameName: '游戏',
        price: '价格',
        peakPlayers: '当前在线',
        reviews: '评测数',
        rate: '好评率',
        releaseDate: '发行日期',
        tags: '标签',
        answer: '答案',
        sharedTag: '与答案相同',
        openSteam: '在 Steam 打开 {{name}}',
      },
      status: {
        exact: '准确',
        partial: '接近',
        close: '相邻',
        wrong: '较远',
        unknown: '未知',
      },
      direction: {
        higher: '答案更高',
        lower: '答案更低',
        equal: '与答案相同',
        near: '与答案非常接近',
      },
      outcome: {
        won: {
          kicker: '猜对了',
          title: '答案就是 {{name}}！',
          message: '你用了 {{count}} 次猜测。',
        },
        lost: {
          kicker: '机会用完了',
          title: '答案是 {{name}}',
          message: '答案已经添加到猜测记录的最后一行。',
        },
        surrendered: {
          kicker: '答案已揭晓',
          title: '答案是 {{name}}',
          message: '可以在最后一行对照答案和之前的猜测。',
        },
      },
    },
  },
} as const;

const savedLanguage = localStorage.getItem('steamguess-language');
const initialLanguage = savedLanguage === 'en' || savedLanguage === 'zh' ? savedLanguage : 'zh';
document.documentElement.lang = initialLanguage === 'zh' ? 'zh-CN' : 'en';

i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export default i18n;
