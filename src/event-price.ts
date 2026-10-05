/** Explicit source currency only; never derive from country or display locale. */
export function explicitCurrency(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
}
export function eventPriceLabel(price: unknown, currency: unknown): string {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return 'Pris ukendt';
  if (price === 0) return 'Gratis';
  return `${price} ${explicitCurrency(currency) ?? '(valuta ukendt)'}`;
}
