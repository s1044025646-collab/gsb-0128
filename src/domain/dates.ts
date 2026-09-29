/**
 * Effective-date rules for prior art.
 *
 * A reference is prior art only when its publication date is strictly before
 * the effective date (the priority date by default). A document published on
 * the same day as the priority date is NOT prior art (same-day rule), and a
 * document published after it is late.
 */
export type EligibilityReason = 'before_effective' | 'same_day' | 'after_effective' | 'out_of_scope';

export function eligibilityReason(publicationDate: string, effectiveDate: string): EligibilityReason {
  if (publicationDate < effectiveDate) return 'before_effective';
  if (publicationDate === effectiveDate) return 'same_day';
  return 'after_effective';
}

export function isPriorArt(publicationDate: string, effectiveDate: string): boolean {
  return publicationDate < effectiveDate;
}
