import { describe, expect, it } from 'vitest';
import { loadDisplayFields } from './displayFields';

describe('display field settings', () => {
  it('migrates the former CCU and review columns into activity', () => {
    const storage = { getItem: () => JSON.stringify(['price', 'ccu', 'reviews', 'tags']) };
    expect([...loadDisplayFields(storage)]).toEqual(['price', 'activity', 'tags']);
  });
});
