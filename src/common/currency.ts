/**
 * The currencies a workspace can be denominated in.
 *
 * A workspace picks ONE. Switching it re-denominates the whole admin — the
 * stored figures are not converted, because there are no exchange rates in this
 * system and inventing them would be worse than not having them: a rate that is
 * stale, wrong, or silently applied turns every historical price into a number
 * nobody can reconcile against an invoice. A price of 1200 stays 1200; the
 * symbol and code beside it change.
 *
 * `decimals` is per currency for a reason. The rupiah is quoted in whole units —
 * "Rp 16.300,50" is not a price anyone writes — while the taka, yuan, peso and
 * dollar all take two. Formatting every currency to two places would make the
 * IDR figures wrong-looking in exactly the market that uses them.
 *
 * Mirrored in the frontend's src/lib/currency.ts; keep the two in step. The
 * backend copy is the authority: it validates the code and derives the symbol
 * on write, so the stored pair can never disagree with itself.
 */
export interface CurrencyDef {
  code: string;
  symbol: string;
  /** English name, for settings UI and API docs. */
  name: string;
  /** Fraction digits this currency is conventionally quoted to. */
  decimals: number;
}

export const CURRENCIES = {
  BDT: { code: "BDT", symbol: "৳", name: "Bangladeshi Taka", decimals: 2 },
  USD: { code: "USD", symbol: "$", name: "US Dollar", decimals: 2 },
  IDR: { code: "IDR", symbol: "Rp", name: "Indonesian Rupiah", decimals: 0 },
  CNY: { code: "CNY", symbol: "¥", name: "Chinese Yuan", decimals: 2 },
  PHP: { code: "PHP", symbol: "₱", name: "Philippine Peso", decimals: 2 },
} as const satisfies Record<string, CurrencyDef>;

export type CurrencyCode = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

/**
 * The platform default: every new workspace starts on taka, and every fallback
 * path — an unset column, an unrecognised code, a tenant that hasn't loaded
 * yet — resolves here. Listed first in CURRENCIES so it also leads every
 * picker.
 */
export const DEFAULT_CURRENCY: CurrencyCode = "BDT";

export function isCurrencyCode(v: unknown): v is CurrencyCode {
  return typeof v === "string" && v in CURRENCIES;
}

/**
 * The symbol for a code.
 *
 * Always derived, never taken from the client: `currency` and `currency_symbol`
 * are two columns describing one fact, and letting a caller set them
 * independently is how a workspace ends up storing "BDT" with a "$".
 */
export function symbolFor(code: string): string {
  return isCurrencyCode(code) ? CURRENCIES[code].symbol : CURRENCIES[DEFAULT_CURRENCY].symbol;
}

export function decimalsFor(code: string): number {
  return isCurrencyCode(code) ? CURRENCIES[code].decimals : 2;
}
