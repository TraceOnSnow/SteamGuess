# SteamGuess - MVP v0.1

A web game where players guess Steam games based on dynamic clues and feedback.

## Project Structure

```
src/
├── types/
│   ├── game.ts              # Core game data types
│   └── comparison.ts        # Comparison result types
├── engine/
│   └── ComparisonEngine.ts  # Core comparison logic
├── config/
│   └── comparison.ts        # Thresholds and color config
├── data/
│   └── games.ts             # Sample games and search functions
├── components/
│   ├── SearchBox/
│   │   ├── SearchBox.tsx    # Game search input
│   │   └── SearchBox.css    # Search box styles
│   └── GameTable/
│       ├── GameTable.tsx    # Comparison results table
│       └── GameTable.css    # Table styles
├── App.tsx                  # Main application component
├── App.css                  # Main styles
└── index.css               # Global styles
```

## Game Flow

1. **Initialization**: A random game is selected from the sample games
2. **Search**: User searches for a game using the search box
3. **Guess**: User selects a game
4. **Comparison**: `ComparisonEngine` compares the guess against the correct answer
5. **Feedback**: Results displayed in the game table with color-coded matches
6. **Loop**: Continue until correct (or attempts run out)

## Key Components

### ComparisonEngine (`src/engine/ComparisonEngine.ts`)

Core comparison logic that evaluates:
- **Name**: Exact string match
- **Players**: Support for Single/Multi/Online modes
- **Price**: Current price vs. historical low
- **Popularity**: Current weekly player count vs. peak
- **Reviews**: Review count and positive percentage
- **Release Date**: Year comparison
- **Tags**: User tags, genres, developer, publisher

Each comparison returns a `FieldComparison` with:
- `status`: 'exact' | 'partial' | 'close' | 'wrong' | 'unknown'
- `userValue`: What user guessed
- `correctValue`: Correct answer
- `display`: Arrow indicators (↑ ↓ ≈)

### Configuration (`src/config/comparison.ts`)

Threshold configuration (all modifiable):
- `priceThreshold`: ±$10 for "exact" match
- `popularityThresholdPercent`: ±50% for "exact"
- `ratingThresholdPercent`: ±5% for "exact"
- `yearThreshold`: ±1 year for "exact"
- `tagOverlapPercent`: 50% for "exact" match

Color mapping:
- 🟢 Green (#4CAF50): Exact match
- 🟡 Yellow (#FFC107): Partial match
- 🟠 Orange (#FF9800): Close match
- 🔴 Red (#F44336): Wrong
- ⚪ Gray (#9E9E9E): Unknown

## Getting Started

### Prerequisites
- Node.js 16+
- npm or yarn

### Installation

```bash
cd SteamGuess
npm install
```

### Development Server

```bash
npm run dev
```

Starts dev server at `http://localhost:5173/`

### Build

```bash
npm run build
```

## MVP Feature Set

✅ **Implemented**:
- Core comparison engine with 7 comparison fields
- React UI with search box and results table
- Color-coded feedback system
- 3 sample games for testing
- Attempt counter and game status display
- Responsive design

⏳ **Next Phase**:
- Data aggregation (batch import Steam games)
- Daily challenge mode
- User statistics and leaderboard
- Multiplayer support (Socket.IO)
- Persistent data (MongoDB)

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite
- **Styling**: CSS3 with responsive design
- **Build Tool**: Vite
- **Package Manager**: npm

## Configuration

### Modifying Comparison Thresholds

Edit `src/config/comparison.ts`:

```typescript
export const comparisonConfig: ComparisonConfig = {
  priceThreshold: 10,              // ±$10
  popularityThresholdPercent: 50,  // ±50%
  ratingThresholdPercent: 5,       // ±5%
  yearThreshold: 1,                // ±1 year
  tagOverlapPercent: 50,           // 50% overlap
};
```

### Adding Sample Games

Edit `src/data/games.ts` and add to `sampleGames` array:

```typescript
{
  appId: 12345,
  name: "Game Title",
  releaseDate: "2023-01-01",
  price: { current: 19.99, historicalLow: 9.99 },
  // ... other fields
}
```

## Component Architecture

The app is designed for extensibility:

- **SearchBox**: Reusable search component (can be used in future multiplayer mode)
- **GameTable**: Display component (can show different data layouts)
- **ComparisonEngine**: Business logic (can be used by backend for multiplayer)

This separation allows easy addition of multiplayer features later.

## Design Principles

1. **Modularity**: Each comparison field has its own method
2. **Low Coupling**: Components don't depend on each other
3. **Configurable Thresholds**: All magic numbers in config file
4. **Type Safety**: Full TypeScript coverage
5. **Extensibility**: Easy to add new comparison fields or game properties

## License

MIT

---

**Version**: 0.1 (MVP)  
**Last Updated**: January 30, 2025

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
