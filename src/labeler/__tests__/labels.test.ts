import { describe, expect, it } from 'vitest';
import { buildExportPayload, loadStoredLabels, parseLabels, saveStoredLabels, STORAGE_KEY } from '../labels';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('difficulty label persistence', () => {
  it('parses regression-compatible label files', () => {
    const labels = parseLabels({ labels: [{ appId: 730, level: 'easy', excluded: false }] });
    expect(labels.get(730)?.level).toBe('easy');
  });

  it('round-trips labels through storage', () => {
    const storage = new MemoryStorage();
    const labels = parseLabels([{ appId: 10, level: null, excluded: true }]);
    saveStoredLabels(labels, storage);
    expect(storage.values.has(STORAGE_KEY)).toBe(true);
    expect(loadStoredLabels(storage).get(10)?.excluded).toBe(true);
  });

  it('exports labels sorted by app id', () => {
    const labels = parseLabels([
      { appId: 20, level: 'hard', excluded: false },
      { appId: 10, level: 'easy', excluded: false },
    ]);
    expect(buildExportPayload(labels, 'catalog.json').labels.map(item => item.appId)).toEqual([10, 20]);
  });
});
