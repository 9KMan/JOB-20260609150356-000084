/**
 * LabCorp lab integrations adapter.
 *
 * LabCorp exposes a REST API for ordering tests and receiving
 * results. Auth is via OAuth2 client credentials; we cache the
 * access token until expiry. We model the two operations we need:
 *  - placeOrder  (create a lab order)
 *  - fetchResult (pull a single result; results are also pushed via
 *                 webhook which we accept in api/v1/labs/webhook)
 */
// node-fetch v2 default export is the fetch function.
import fetch from 'node-fetch';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export interface LabOrderRequest {
  patient: {
    firstName: string;
    lastName: string;
    dob: string;            // YYYY-MM-DD
    mrn: string;
    gender: 'M' | 'F' | 'O' | 'U';
  };
  provider: { npi: string };
  tests: Array<{ loinc: string; code: string; name: string }>;
  priority: 'routine' | 'urgent' | 'stat';
}

export interface LabOrderResponse {
  labcorpOrderId: string;
  status: 'received' | 'rejected';
  rejectionReason?: string;
  estimatedResultDate?: string;
}

export interface LabResultValue {
  testCode: string;
  testName: string;
  value: string;
  unit?: string;
  referenceRange?: string;
  abnormalFlag?: 'L' | 'H' | 'LL' | 'HH' | 'N' | 'A';
  observedAt: string;
}

export interface LabResult {
  labcorpOrderId: string;
  patientMrn: string;
  resultedAt: string;
  values: LabResultValue[];
}

export interface LabCorpClientOptions {
  baseUrl?: string;
  apiKey?: string;
  accountId?: string;
  fetchImpl?: typeof fetch;
}

interface TokenState {
  token: string;
  expiresAt: number;
}

export class LabCorpClient {
  private baseUrl: string;
  private apiKey: string;
  private accountId: string;
  private fetchImpl: typeof fetch;
  private tokenState: TokenState | null = null;

  constructor(opts: LabCorpClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? config.labcorp.baseUrl).replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? config.labcorp.apiKey;
    this.accountId = opts.accountId ?? config.labcorp.accountId;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as typeof fetch);
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenState && this.tokenState.expiresAt > now + 60_000) {
      return this.tokenState.token;
    }
    const res = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.apiKey,
        client_secret: this.accountId,
        scope: 'orders:write results:read',
      }).toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LabCorp token failed HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.tokenState = {
      token: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    return data.access_token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      logger.error(
        { status: res.status, path, body: text.slice(0, 500) },
        'labcorp http error'
      );
      throw new Error(`LabCorp HTTP ${res.status} on ${path}`);
    }
    return (await res.json()) as T;
  }

  async placeOrder(req: LabOrderRequest): Promise<LabOrderResponse> {
    return this.request<LabOrderResponse>('POST', '/v1/orders', {
      accountId: this.accountId,
      ...req,
    });
  }

  async fetchResult(labcorpOrderId: string): Promise<LabResult> {
    return this.request<LabResult>(
      'GET',
      `/v1/orders/${encodeURIComponent(labcorpOrderId)}/result`
    );
  }
}
