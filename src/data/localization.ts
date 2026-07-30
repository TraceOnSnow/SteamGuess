import { STEAM_TAGS_ZH } from './steamTagsZh';

export function localizedTagName(tag: string, language: string): string {
  if (!language.startsWith('zh')) return tag;
  const trimmed = tag.trim();
  const chinese = STEAM_TAGS_ZH[trimmed];
  return chinese || trimmed;
}

export function localizedGameNames(game: { name: string; localizedNames?: { zh?: string } }): string[] {
  return [game.name, game.localizedNames?.zh].filter((name): name is string => Boolean(name));
}
