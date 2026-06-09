/**
 * Charm Health REST adapter — the SOURCE side of the EHR migration.
 *
 * Charm Health exposes a FHIR-style REST API plus a proprietary JSON
 * API. We model the proprietary surface because that's the documented
 * canonical export. All endpoints require an API key in the
 * `apikey` query parameter and an `Authorization: Basic` header
 * with the practice credentials.
 *
 * This client is intentionally read-only: it only ever pulls data
 * out of Charm, never writes back. Migration runs are forward-only.
 */
// node-fetch v2 default export is the fetch function.
import fetch from 'node-fetch';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export interface CharmPatient {
  patient_id: string;
  first_name: string;
  last_name: string;
  dob: string;
  gender: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  insurance: {
    payer: string;
    member_id: string;
  } | null;
}

export interface CharmAppointment {
  appointment_id: string;
  patient_id: string;
  provider_id: string;
  start_time: string;
  end_time: string;
  reason: string;
  status: string;
}

export interface CharmClientOptions {
  baseUrl?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
}

export class CharmClient {
  private baseUrl: string;
  private apiKey: string;
  private authHeader: string;
  private fetchImpl: typeof fetch;

  constructor(opts: CharmClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? config.charm.baseUrl).replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? config.charm.apiKey;
    this.authHeader =
      'Basic ' +
      Buffer.from(
        `${opts.username ?? config.charm.username}:${
          opts.password ?? config.charm.password
        }`
      ).toString('base64');
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as typeof fetch);
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    url.searchParams.set('apikey', this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    const res = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      logger.error(
        { status: res.status, path, body: text.slice(0, 500) },
        'charm http error'
      );
      throw new Error(`Charm HTTP ${res.status} on ${path}`);
    }
    return (await res.json()) as T;
  }

  async listPatients(opts: { since?: string; page?: number; pageSize?: number } = {}): Promise<CharmPatient[]> {
    const params: Record<string, string> = {
      page: String(opts.page ?? 1),
      pageSize: String(opts.pageSize ?? 100),
    };
    if (opts.since) params.since = opts.since;
    const data = await this.get<{ patients: CharmPatient[] }>(
      '/ehr/v1/patients',
      params
    );
    return data.patients ?? [];
  }

  async getPatient(charmId: string): Promise<CharmPatient | null> {
    const data = await this.get<{ patient: CharmPatient | null }>(
      `/ehr/v1/patients/${encodeURIComponent(charmId)}`
    );
    return data.patient;
  }

  async listAppointments(opts: { from: string; to: string; page?: number; pageSize?: number }): Promise<CharmAppointment[]> {
    const params: Record<string, string> = {
      from: opts.from,
      to: opts.to,
      page: String(opts.page ?? 1),
      pageSize: String(opts.pageSize ?? 200),
    };
    const data = await this.get<{ appointments: CharmAppointment[] }>(
      '/ehr/v1/appointments',
      params
    );
    return data.appointments ?? [];
  }
}
