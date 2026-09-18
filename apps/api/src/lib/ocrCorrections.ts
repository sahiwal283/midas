/**
 * Compare what OCR extracted with what the user actually submitted, so the
 * OCR service can measure first-time-right accuracy. Pure — no DB, no I/O.
 */

export type CorrectableField = 'merchant' | 'amount' | 'date' | 'category' | 'cardLastFour';

export interface OcrFieldLike {
  value: string | null;
}

export interface SubmittedValues {
  merchant: string;
  amount: string;
  date: string;
  categoryName: string | null;
  cardLastFour: string | null;
}

export interface Correction {
  field: CorrectableField;
  original_value: string | null;
  corrected_value: string | null;
}

export function normalizeAmountCents(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const cleaned = String(v).replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function normalizeDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return null;
}

export function normalizeText(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function lastFour(v: string | null | undefined): string | null {
  const digits = (v ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function usable(field: OcrFieldLike | undefined): field is OcrFieldLike {
  return Boolean(field);
}

export function diffOcrCorrections(
  fields: Partial<Record<CorrectableField, OcrFieldLike | undefined>>,
  submitted: SubmittedValues,
): Correction[] {
  const out: Correction[] = [];

  const merchant = fields.merchant;
  if (usable(merchant) && normalizeText(merchant.value) !== normalizeText(submitted.merchant)) {
    out.push({ field: 'merchant', original_value: merchant.value, corrected_value: submitted.merchant });
  }

  const amount = fields.amount;
  if (usable(amount) && normalizeAmountCents(amount.value) !== normalizeAmountCents(submitted.amount)) {
    out.push({ field: 'amount', original_value: amount.value, corrected_value: submitted.amount });
  }

  const date = fields.date;
  if (usable(date) && normalizeDate(date.value) !== normalizeDate(submitted.date)) {
    out.push({ field: 'date', original_value: date.value, corrected_value: submitted.date });
  }

  const category = fields.category;
  if (usable(category) && category.value && submitted.categoryName) {
    const suggestion = normalizeText(category.value);
    const chosen = normalizeText(submitted.categoryName);
    if (!(chosen.includes(suggestion) || suggestion.includes(chosen))) {
      out.push({ field: 'category', original_value: category.value, corrected_value: submitted.categoryName });
    }
  }

  const card = fields.cardLastFour;
  if (usable(card) && card.value && submitted.cardLastFour) {
    if (lastFour(card.value) !== lastFour(submitted.cardLastFour)) {
      out.push({ field: 'cardLastFour', original_value: card.value, corrected_value: submitted.cardLastFour });
    }
  }

  return out;
}
