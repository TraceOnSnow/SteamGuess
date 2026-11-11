/**
 * Share links carry the answer so a friend gets the same game.  The AppID is
 * lightly scrambled only so the link does not spoil the answer at a glance.
 */
const SCRAMBLE = 0x5f3a9;

export function encodeChallenge(appId: number): string {
  return ((appId ^ SCRAMBLE) >>> 0).toString(36);
}

export function decodeChallenge(code: string | null | undefined): number | null {
  if (!code || !/^[0-9a-z]{1,10}$/.test(code)) return null;
  const value = (parseInt(code, 36) ^ SCRAMBLE) >>> 0;
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function challengeUrl(origin: string, appId: number): string {
  return `${origin}/singleplayer?g=${encodeChallenge(appId)}`;
}
