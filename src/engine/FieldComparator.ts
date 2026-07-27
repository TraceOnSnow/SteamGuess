import { differenceInCalendarDays, isValid, parseISO } from 'date-fns';
import type {
  ComparisonDirection,
  FieldComparison,
  MatchStatus,
  NumericRuleConfig,
} from '../types/comparison';

export interface NumericCompareParams {
  fieldName: string;
  userValue: number | undefined;
  correctValue: number;
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

    if (userValue === undefined || !Number.isFinite(userValue)) {
      return {
        fieldName,
        userValue: null,
        correctValue: print(correctValue),
        status: 'unknown',
      };
    }

    const distance = this.getDistance(userValue, correctValue, rule.mode);
    const status = this.getStatusByDistance(distance, rule);

    return {
      fieldName,
      userValue: print(userValue),
      correctValue: print(correctValue),
      status,
      direction: this.getDirection(userValue, correctValue, status),
    };
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

    const userParsed = this.parseDate(userDate);
    const correctParsed = this.parseDate(correctDate);

    if (!userParsed || !correctParsed) {
      return { fieldName, userValue: userDate, correctValue: correctDate, status: 'unknown' };
    }

    const diffDays = Math.abs(differenceInCalendarDays(userParsed, correctParsed));
    const exactDays = this.yearsToDays(thresholds.exactYears);
    const partialDays = this.yearsToDays(thresholds.partialYears);
    const closeDays = this.yearsToDays(thresholds.closeYears);

    let status: MatchStatus = 'wrong';
    if (diffDays <= exactDays) status = 'exact';
    else if (diffDays <= partialDays) status = 'partial';
    else if (diffDays <= closeDays) status = 'close';

    return {
      fieldName,
      userValue: userDate,
      correctValue: correctDate,
      status,
      direction: this.getDirection(userParsed.getTime(), correctParsed.getTime(), status),
    };
  }

  private getDistance(user: number, correct: number, mode: NumericRuleConfig['mode']): number {
    if (mode === 'absolute') return Math.abs(user - correct);
    if (correct === 0) return user === 0 ? 0 : 100;
    return (Math.abs(user - correct) / Math.abs(correct)) * 100;
  }

  private getStatusByDistance(distance: number, rule: NumericRuleConfig): MatchStatus {
    if (distance <= rule.exact) return 'exact';
    if (distance <= rule.partial) return 'partial';
    if (distance <= rule.close) return 'close';
    return 'wrong';
  }

  private getDirection(user: number, correct: number, status: MatchStatus): ComparisonDirection {
    if (user === correct) return 'equal';
    if (status === 'exact') return 'near';
    return correct > user ? 'higher' : 'lower';
  }

  private parseDate(date: string): Date | undefined {
    const parsed = parseISO(date);
    return isValid(parsed) ? parsed : undefined;
  }

  private yearsToDays(years: number): number {
    return years * 365.2425;
  }
}
