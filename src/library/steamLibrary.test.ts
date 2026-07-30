import { describe, expect, it } from 'vitest';
import { parseSteamAppIds } from './steamLibrary';

describe('Steam library import', () => {
  it('parses newline and comma separated App IDs', () => {
    expect(parseSteamAppIds('730, 570\n1245620')).toEqual([570, 730, 1245620]);
  });

  it('parses GetOwnedGames responses', () => {
    const payload = JSON.stringify({ response: { games: [{ appid: 730 }, { appid: 570 }] } });
    expect(parseSteamAppIds(payload)).toEqual([570, 730]);
  });

  it('parses appids objects and removes duplicates', () => {
    expect(parseSteamAppIds(JSON.stringify({ appids: [730, '730', 570] }))).toEqual([570, 730]);
  });
});
