/**
 * Stripe billing integration.
 *
 * Wraps the parts of the Stripe API we actually need: create a
 * PaymentIntent for a patient balance, look up a payment, and verify
 * webhook signatures. We do not import the `stripe` SDK in tests
 * (we inject a stub), so the SDK is loaded lazily.
 */
import { config } from '../../config';

export interface CreatePaymentIntentInput {
  amountCents: number;
  currency: string;             // 'usd', etc.
  patientId: string;
  description?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface PaymentIntentRecord {
  id: string;
  status: string;
  amount: number;
  currency: string;
  receiptUrl: string | null;
}

export interface StripeClientOptions {
  apiKey?: string;
  webhookSecret?: string;
  // Inject for tests
  sdkOverride?: {
    paymentIntents: {
      create: (params: Record<string, unknown>, opts?: { idempotencyKey?: string }) => Promise<unknown>;
      retrieve: (id: string) => Promise<unknown>;
    };
    webhooks: {
      constructEvent: (payload: string | Buffer, sig: string, secret: string) => unknown;
    };
  };
}

export class StripeClient {
  private apiKey: string;
  private webhookSecret: string;
  private sdk: NonNullable<StripeClientOptions['sdkOverride']>;
  private ownedSdk: boolean;

  constructor(opts: StripeClientOptions = {}) {
    this.apiKey = opts.apiKey ?? config.stripe.apiKey;
    this.webhookSecret = opts.webhookSecret ?? config.stripe.webhookSecret;
    if (opts.sdkOverride) {
      this.sdk = opts.sdkOverride;
      this.ownedSdk = false;
    } else {
      // Lazy require so tests that override the SDK don't pay the cost.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Stripe = require('stripe');
      const real = new Stripe(this.apiKey, { apiVersion: '2024-06-20' as const });
      this.sdk = {
        paymentIntents: {
          create: (params, options) =>
            real.paymentIntents.create(params, options),
          retrieve: (id) => real.paymentIntents.retrieve(id),
        },
        webhooks: {
          constructEvent: (payload, sig, secret) =>
            real.webhooks.constructEvent(payload, sig, secret),
        },
      };
      this.ownedSdk = true;
    }
  }

  async createPaymentIntent(
    input: CreatePaymentIntentInput
  ): Promise<PaymentIntentRecord> {
    const params: Record<string, unknown> = {
      amount: input.amountCents,
      currency: input.currency,
      description: input.description,
      automatic_payment_methods: { enabled: true },
      metadata: { patient_id: input.patientId, ...(input.metadata ?? {}) },
    };
    const opts = input.idempotencyKey
      ? { idempotencyKey: input.idempotencyKey }
      : undefined;
    const pi = (await this.sdk.paymentIntents.create(params, opts)) as {
      id: string;
      status: string;
      amount: number;
      currency: string;
      latest_charge?: { receipt_url?: string } | string | null;
    };
    let receiptUrl: string | null = null;
    if (typeof pi.latest_charge === 'object' && pi.latest_charge?.receipt_url) {
      receiptUrl = pi.latest_charge.receipt_url;
    }
    return {
      id: pi.id,
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
      receiptUrl,
    };
  }

  async getPaymentIntent(id: string): Promise<PaymentIntentRecord> {
    const pi = (await this.sdk.paymentIntents.retrieve(id)) as {
      id: string;
      status: string;
      amount: number;
      currency: string;
      latest_charge?: { receipt_url?: string } | string | null;
    };
    let receiptUrl: string | null = null;
    if (typeof pi.latest_charge === 'object' && pi.latest_charge?.receipt_url) {
      receiptUrl = pi.latest_charge.receipt_url;
    }
    return {
      id: pi.id,
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
      receiptUrl,
    };
  }

  verifyWebhook(payload: string | Buffer, signature: string): unknown {
    return this.sdk.webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret
    );
  }
}
