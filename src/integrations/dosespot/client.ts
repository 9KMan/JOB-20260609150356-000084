/**
 * DoseSpot e-prescribing adapter.
 *
 * DoseSpot is a third-party EPCS / e-prescribing service. We model
 * the REST surface used to: (a) create a prescription draft tied to
 * a patient, (b) submit it to a pharmacy, and (c) pull refill status.
 *
 * Auth: DoseSpot issues a session token via POST /v14/sessions, then
 * we send `Authorization: Bearer <token>` and `clinicId` header.
 */
// node-fetch v2 default export is the fetch function.
import fetch from 'node-fetch';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export interface DoseSpotPrescriptionRequest {
  patientId: string;
  providerId: string;
  drug: {
    name: string;
    ndc?: string;
    dose: string;
    route: string;
    frequency: string;
    durationDays: number;
    refills: number;
    genericAllowed: boolean;
  };
  pharmacy: { ncpdpId: string };
  notes?: string;
}

export interface DoseSpotPrescriptionResponse {
  prescriptionId: string;
  status: 'pending' | 'sent' | 'error';
  pharmacy: { ncpdpId: string; name: string };
  warnings: string[];
}

export interface DoseSpotClientOptions {
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  clinicId?: string;
  fetchImpl?: typeof fetch;
}

interface Session {
  token: string;
  expiresAt: number;
}

export class DoseSpotClient {
  private baseUrl: string;
  private apiKey: string;
  private apiSecret: string;
  private clinicId: string;
  private fetchImpl: typeof fetch;
  private session: Session | null = null;

  constructor(opts: DoseSpotClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? config.dosespot.baseUrl).replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? config.dosespot.apiKey;
    this.apiSecret = opts.apiSecret ?? config.dosespot.apiSecret;
    this.clinicId = opts.clinicId ?? config.dosespot.clinicId;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as typeof fetch);
  }

  private async ensureSession(): Promise<string> {
    const now = Date.now();
    if (this.session && this.session.expiresAt > now + 60_000) {
      return this.session.token;
    }
    const url = `${this.baseUrl}/sessions`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        apiKey: this.apiKey,
        apiSecret: this.apiSecret,
        clinicId: this.clinicId,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DoseSpot session failed HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { token: string; expiresInSeconds: number };
    this.session = {
      token: data.token,
      expiresAt: now + data.expiresInSeconds * 1000,
    };
    return data.token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.ensureSession();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        clinicId: this.clinicId,
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      logger.error(
        { status: res.status, path, body: text.slice(0, 500) },
        'dosespot http error'
      );
      throw new Error(`DoseSpot HTTP ${res.status} on ${path}`);
    }
    return (await res.json()) as T;
  }

  async createPrescription(
    req: DoseSpotPrescriptionRequest
  ): Promise<DoseSpotPrescriptionResponse> {
    return this.request<DoseSpotPrescriptionResponse>(
      'POST',
      '/prescriptions',
      req
    );
  }

  async getPrescriptionStatus(prescriptionId: string): Promise<{
    prescriptionId: string;
    status: 'pending' | 'sent' | 'filled' | 'cancelled' | 'error';
  }> {
    return this.request('GET', `/prescriptions/${encodeURIComponent(prescriptionId)}`);
  }
}
