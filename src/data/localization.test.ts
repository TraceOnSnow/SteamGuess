import { describe, expect, it } from 'vitest';
import { localizedTagName } from './localization';

describe('Steam metadata localization', () => {
  it('shows official Chinese and English tag names in Chinese UI', () => {
    expect(localizedTagName('Action', 'zh-CN')).toBe('动作');
    expect(localizedTagName('Action', 'en')).toBe('Action');
  });
});
