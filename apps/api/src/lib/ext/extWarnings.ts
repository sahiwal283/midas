import { isLikelyDuplicate } from '../duplicates';

export interface DuplicateMatch {
  id: string;
  merchant: string;
  amount: number;
  date: string;
}

export interface ExtWarning {
  code: string;
  message: string;
  matches?: DuplicateMatch[];
}

/**
 * Pure duplicate scan over already-fetched candidate rows. Reuses the same
 * matcher the Midas-native create path uses, so a consumer never has to
 * reimplement it or fetch candidates itself.
 */
export function findDuplicateMatches(
  candidate: { merchant: string; amount: number; date: string },
  existing: { id: string; merchant: string; amount: number | string; date: string }[],
): DuplicateMatch[] {
  return existing
    .filter((e) => isLikelyDuplicate(candidate, { merchant: e.merchant, amount: e.amount, date: e.date }))
    .map((e) => ({ id: e.id, merchant: e.merchant, amount: Number(e.amount), date: e.date }));
}
