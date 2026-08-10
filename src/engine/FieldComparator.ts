import { compareDateValues, compareNumericValues } from '../../shared/game-rules.js';
import type {
  FieldComparison,
  MatchStatus,
  NumericRuleConfig,
} from '../types/comparison';

export interface NumericCompareParams {
  fieldName: string;
  userValue: number | undefined;
  correctValue: number | undefined;
  rule: NumericRuleConfig;
  formatter?: (value: number) => string;
}

export class FieldComparator {
  compareExactText(fieldName: string, userValue: string | undefined, correctValue: string): FieldComparison {
    if (!userValue) {
      return { fieldName, userValue: null, correctValue, status: 'unknown' };
    }

    const status: MatchStatus = userValue.localeCompare(correctValue, undefined, { sensitivity: 'accent' }) === 0
      ? 'exact'
      : 'wrong';

    return { fieldName, userValue, correctValue, status };
  }

  compareNumeric({ fieldName, userValue, correctValue, rule, formatter }: NumericCompareParams): FieldComparison {
    const print = formatter ?? String;

    if (
      userValue === undefined
      || correctValue === undefined
      || !Number.isFinite(userValue)
      || !Number.isFinite(correctValue)
    ) {
      return {
        fieldName,
        userValue: userValue === undefined || !Number.isFinite(userValue) ? null : print(userValue),
        correctValue: correctValue === undefined || !Number.isFinite(correctValue) ? null : print(correctValue),
        status: 'unknown',
      };
    }

    const comparison = compareNumericValues(userValue, correctValue, rule);
    return { fieldName, userValue: print(userValue), correctValue: print(correctValue), ...comparison };
  }

  compareDate(
    fieldName: string,
    userDate: string | undefined,
    correctDate: string,
    thresholds: { exactYears: number; partialYears: number; closeYears: number },
  ): FieldComparison {
    if (!userDate) {
      return { fieldName, userValue: null, correctValue: correctDate, status: 'unknown' };
    }

    const comparison = compareDateValues(userDate, correctDate, thresholds);
    return { fieldName, userValue: userDate, correctValue: correctDate, ...comparison };
  }

}
