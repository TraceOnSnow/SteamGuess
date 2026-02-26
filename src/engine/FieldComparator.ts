import type { FieldComparison, MatchStatus, NumericCompareMode } from '../types/comparison';
import { differenceInCalendarDays, isValid, parseISO } from 'date-fns';

export interface NumericRule {
  mode: NumericCompareMode;
  exact: number;
  partial: number;
  close: number;
}

export interface NumericCompareParams {
  fieldName: string;
  userValue: number | undefined;
  correctValue: number;
  rule: NumericRule;
  formatter?: (value: number) => string;
}

export class FieldComparator {
  compareExactText(fieldName: string, userValue: string | undefined, correctValue: string): FieldComparison {
    if (!userValue) {
      return { fieldName, userValue: null, correctValue, status: 'unknown' };
    }

    const status: MatchStatus = userValue.toLowerCase() === correctValue.toLowerCase() ? 'exact' : 'wrong';
    return { fieldName, userValue, correctValue, status };
  }

  compareNumeric(params: NumericCompareParams): FieldComparison {
    const { fieldName, userValue, correctValue, rule, formatter } = params;

    const print = formatter ?? ((value: number) => String(value));
    if (userValue === undefined) {
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
      display: this.getArrow(userValue, correctValue, distance, rule.exact),
    };
  }

  compareYear(fieldName: string, userDate: string | undefined, correctDate: string, thresholds: { exact: number; partial: number; close: number }): FieldComparison {
    if (!userDate) {
      return {
        fieldName,
        userValue: null,
        correctValue: correctDate,
        status: 'unknown',
      };
    }

    const userParsed = this.parseDate(userDate);
    const correctParsed = this.parseDate(correctDate);

    if (!userParsed || !correctParsed) {
      return {
        fieldName,
        userValue: userDate,
        correctValue: correctDate,
        status: 'unknown',
      };
    }

    const diffDays = Math.abs(differenceInCalendarDays(userParsed, correctParsed));
    const exactDays = this.yearsToDays(thresholds.exact);
    const partialDays = this.yearsToDays(thresholds.partial);
    const closeDays = this.yearsToDays(thresholds.close);

    let status: MatchStatus;
    if (diffDays <= exactDays) status = 'exact';
    else if (diffDays <= partialDays) status = 'partial';
    else if (diffDays <= closeDays) status = 'close';
    else status = 'wrong';

    return {
      fieldName,
      userValue: userDate,
      correctValue: correctDate,
      status,
      display: this.getArrow(userParsed.getTime(), correctParsed.getTime(), diffDays, exactDays),
    };
  }

  private getDistance(user: number, correct: number, mode: NumericCompareMode): number {
    if (mode === 'absolute') {
      return Math.abs(user - correct);
    }

    if (correct === 0) {
      return user === 0 ? 0 : 100;
    }
    return Math.abs(Math.max(user, correct) / Math.min(user, correct)) * 100;
  }

  private getStatusByDistance(distance: number, rule: NumericRule): MatchStatus {
    if (distance <= rule.exact) return 'exact';
    if (distance <= rule.partial) return 'partial';
    if (distance <= rule.close) return 'close';
    return 'wrong';
  }

  private getArrow(user: number, correct: number, distance: number, exactThreshold: number): string {
    if (distance <= 0.01) return '=';
    if (distance <= exactThreshold) return '≈';
    return user > correct ? '↑' : '↓';
  }

  private parseDate(date: string): Date | undefined {
    const parsed = parseISO(date);
    return isValid(parsed) ? parsed : undefined;
  }

  private yearsToDays(years: number): number {
    return years * 365;
  }
}
