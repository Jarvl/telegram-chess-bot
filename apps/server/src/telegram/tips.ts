import { t, TIP_MAX_STARS, TIP_MIN_STARS } from '@group-chess/shared';
import type { Api } from 'grammy';

/** Tip jar spec §2.1: the invoice payload names the amount, so pre-checkout can check it. */
const PAYLOAD = /^tip:v1:([1-9]\d{0,4})$/;

export function tipPayload(stars: number): string {
  return `tip:v1:${stars}`;
}

export function parseTipPayload(payload: string): number | null {
  const match = PAYLOAD.exec(payload);
  if (!match) return null;
  const stars = Number(match[1]);
  return stars >= TIP_MIN_STARS && stars <= TIP_MAX_STARS ? stars : null;
}

/** Tip jar spec §2.2: approve only a well-formed payload whose amount and currency match. */
export function tipCheckoutAccepted(query: {
  invoice_payload: string;
  total_amount: number;
  currency: string;
}): boolean {
  const stars = parseTipPayload(query.invoice_payload);
  return stars !== null && stars === query.total_amount && query.currency === 'XTR';
}

/** A fresh link per tap (tip jar spec §2.1); an empty provider token means Telegram Stars. */
export function createTipInvoiceLink(api: Api, stars: number): Promise<string> {
  return api.createInvoiceLink(
    t('invoice.tip.title'),
    t('invoice.tip.description'),
    tipPayload(stars),
    '',
    'XTR',
    [{ label: t('invoice.tip.label'), amount: stars }],
  );
}
