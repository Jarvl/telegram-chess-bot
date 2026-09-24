import { GrammyError } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tips } from '../../src/db/schema';
import { refundTip, type RefundableTip } from '../../src/domain/tipRefunds';
import { createTelegramApi } from '../../src/telegram/client';
import { testConfig } from '../helpers/config';
import { openTestDb, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
let fake: FakeTelegram;
let api: ReturnType<typeof createTelegramApi>;

beforeAll(async () => {
  fake = await FakeTelegram.start();
  api = createTelegramApi(testConfig(), { apiRoot: fake.url, throttle: false });
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

const yes = async () => true;

const insertTip = async (fields: Partial<typeof tips.$inferInsert> = {}) => {
  const payer = await insertUser(db, { telegramUserId: 11, firstName: 'Alice', username: 'alice' });
  const [tip] = await db
    .insert(tips)
    .values({
      userId: payer.id,
      telegramUserId: 11,
      stars: 100,
      telegramPaymentChargeId: 'stxb-charge-1',
      ...fields,
    })
    .returning();
  return tip!;
};

describe('refundTip', () => {
  it('shows the tip and its payer, and refunds once confirmed', async () => {
    const tip = await insertTip();
    const shown: RefundableTip[] = [];
    const result = await refundTip(db, api, 'stxb-charge-1', async (candidate) => {
      shown.push(candidate);
      expect(fake.callsTo('refundStarPayment')).toHaveLength(0);
      return true;
    });
    expect(shown).toEqual([{ tip, payer: { firstName: 'Alice', username: 'alice' } }]);
    expect(result).toEqual({ outcome: 'refunded', tip });
    expect(fake.callsTo('refundStarPayment').map((call) => call.body)).toEqual([
      { user_id: 11, telegram_payment_charge_id: 'stxb-charge-1' },
    ]);
  });

  it('leaves refunded_at to the refunded_payment update Telegram sends', async () => {
    await insertTip();
    await refundTip(db, api, 'stxb-charge-1', yes);
    const [row] = await db.select().from(tips);
    expect(row?.refundedAt).toBeNull();
  });

  it('refuses an unknown transaction id without calling Telegram', async () => {
    await insertTip();
    const confirm = vi.fn(yes);
    expect(await refundTip(db, api, 'stxb-unknown', confirm)).toEqual({ outcome: 'not_found' });
    expect(confirm).not.toHaveBeenCalled();
    expect(fake.callsTo('refundStarPayment')).toHaveLength(0);
  });

  it('does not refund a tip twice', async () => {
    const tip = await insertTip({ refundedAt: new Date('2026-09-24T12:00:00Z') });
    const confirm = vi.fn(yes);
    expect(await refundTip(db, api, 'stxb-charge-1', confirm)).toEqual({
      outcome: 'already_refunded',
      tip,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(fake.callsTo('refundStarPayment')).toHaveLength(0);
  });

  it('refunds nothing when the operator declines', async () => {
    const tip = await insertTip();
    expect(await refundTip(db, api, 'stxb-charge-1', async () => false)).toEqual({
      outcome: 'cancelled',
      tip,
    });
    expect(fake.callsTo('refundStarPayment')).toHaveLength(0);
  });

  it('still shows a tip that has no user row', async () => {
    await insertTip({ userId: null });
    const shown: RefundableTip[] = [];
    await refundTip(db, api, 'stxb-charge-1', async (candidate) => {
      shown.push(candidate);
      return false;
    });
    expect(shown[0]?.payer).toBeNull();
  });

  it('passes on what Telegram says when it refuses', async () => {
    await insertTip();
    fake.failNext('refundStarPayment', {
      error_code: 400,
      description: 'Bad Request: CHARGE_ALREADY_REFUNDED',
    });
    await expect(refundTip(db, api, 'stxb-charge-1', yes)).rejects.toSatisfy(
      (error) => error instanceof GrammyError && /CHARGE_ALREADY_REFUNDED/.test(error.description),
    );
  });
});
