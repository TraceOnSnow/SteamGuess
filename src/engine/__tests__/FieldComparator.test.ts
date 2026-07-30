import { describe, expect, it } from 'vitest';
import { FieldComparator } from '../FieldComparator';

const percentRule = { mode: 'percent' as const, exact: 5, partial: 50, close: 100 };

describe('FieldComparator', () => {
  const comparator = new FieldComparator();

  it('treats equal non-zero percentages as an exact match', () => {
    const result = comparator.compareNumeric({
      fieldName: 'Popularity',
      userValue: 100,
      correctValue: 100,
      rule: percentRule,
    });

    expect(result.status).toBe('exact');
    expect(result.direction).toBe('equal');
  });

  it('calculates percentage distance relative to the answer', () => {
    const result = comparator.compareNumeric({
      fieldName: 'Popularity',
      userValue: 50,
      correctValue: 100,
      rule: percentRule,
    });

    expect(result.status).toBe('partial');
    expect(result.direction).toBe('higher');
  });

  it('handles a zero answer without dividing by zero', () => {
    expect(comparator.compareNumeric({
      fieldName: 'Popularity',
      userValue: 0,
      correctValue: 0,
      rule: percentRule,
    }).status).toBe('exact');

    expect(comparator.compareNumeric({
      fieldName: 'Popularity',
      userValue: 10,
      correctValue: 0,
      rule: percentRule,
    }).status).toBe('close');
  });

  it('returns unknown when the answer value is missing', () => {
    const result = comparator.compareNumeric({
      fieldName: 'Price',
      userValue: 68,
      correctValue: undefined,
      rule: percentRule,
    });
    expect(result.status).toBe('unknown');
    expect(result.correctValue).toBeNull();
  });

  it('compares full release dates and exposes the answer direction', () => {
    const result = comparator.compareDate(
      'Release Date',
      '2020-01-01',
      '2022-01-01',
      { exactYears: 0.2, partialYears: 1, closeYears: 3 },
    );

    expect(result.status).toBe('close');
    expect(result.direction).toBe('higher');
  });

  it('returns unknown for invalid dates', () => {
    expect(comparator.compareDate(
      'Release Date',
      'not-a-date',
      '2022-01-01',
      { exactYears: 0.2, partialYears: 1, closeYears: 3 },
    ).status).toBe('unknown');
  });
});
