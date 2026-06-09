import { StripeClient } from '../../src/integrations/stripe/client';

describe('StripeClient', () => {
  const createMock = jest.fn();
  const retrieveMock = jest.fn();
  const constructEventMock = jest.fn();
  const client = new StripeClient({
    apiKey: 'sk_test_x',
    webhookSecret: 'whsec_x',
    sdkOverride: {
      paymentIntents: {
        create: createMock,
        retrieve: retrieveMock,
      },
      webhooks: { constructEvent: constructEventMock },
    },
  });

  beforeEach(() => {
    createMock.mockReset();
    retrieveMock.mockReset();
    constructEventMock.mockReset();
  });

  it('creates a payment intent and maps the response', async () => {
    createMock.mockResolvedValueOnce({
      id: 'pi_1', status: 'requires_payment_method',
      amount: 1000, currency: 'usd',
      latest_charge: { receipt_url: 'https://stripe/r/1' },
    });
    const out = await client.createPaymentIntent({
      amountCents: 1000, currency: 'usd', patientId: 'p1',
    });
    expect(out.id).toBe('pi_1');
    expect(out.amount).toBe(1000);
    expect(out.receiptUrl).toBe('https://stripe/r/1');
  });

  it('forwards the idempotency key', async () => {
    createMock.mockResolvedValueOnce({
      id: 'pi_2', status: 'succeeded', amount: 500, currency: 'usd',
    });
    await client.createPaymentIntent({
      amountCents: 500, currency: 'usd', patientId: 'p1',
      idempotencyKey: 'idem-1',
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500, currency: 'usd' }),
      { idempotencyKey: 'idem-1' }
    );
  });

  it('verifies a webhook signature', () => {
    constructEventMock.mockReturnValue({ id: 'evt_1', type: 'charge.succeeded' });
    const ev = client.verifyWebhook('payload', 'sig');
    expect(constructEventMock).toHaveBeenCalledWith('payload', 'sig', 'whsec_x');
    expect(ev).toEqual({ id: 'evt_1', type: 'charge.succeeded' });
  });

  it('handles missing latest_charge on retrieve', async () => {
    retrieveMock.mockResolvedValueOnce({
      id: 'pi_3', status: 'succeeded', amount: 200, currency: 'usd',
    });
    const out = await client.getPaymentIntent('pi_3');
    expect(out.receiptUrl).toBeNull();
  });
});
