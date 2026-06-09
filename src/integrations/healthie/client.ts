/**
 * Healthie GraphQL API client.
 *
 * Healthie exposes a single GraphQL endpoint. We use the official
 * Authorization header scheme: "Authorization: Basic <api_key>:<api_secret>"
 * (base64). For this PoC we also support API-key-only mode (single
 * secret used for both halves) which is fine for sandbox keys.
 *
 * Reference (publicly documented): https://docs.gethealthie.com/
 */
// node-fetch v2 is a CJS module whose default export is the fetch
// function. Using a default import gives us a callable value that
// also matches the `fetch` global shape on Node 18+.
import fetch from 'node-fetch';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export interface HealthieClientOptions {
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  fetchImpl?: typeof fetch;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

export class HealthieClient {
  private baseUrl: string;
  private authHeader: string;
  private fetchImpl: typeof fetch;

  constructor(opts: HealthieClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? config.healthie.graphqlUrl;
    const key = opts.apiKey ?? config.healthie.apiKey;
    const secret = opts.apiSecret ?? config.healthie.apiSecret ?? key;
    this.authHeader =
      'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as typeof fetch);
  }

  async request<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.error(
        { status: res.status, body: text.slice(0, 500) },
        'healthie http error'
      );
      throw new Error(`Healthie HTTP ${res.status}`);
    }
    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors && json.errors.length > 0) {
      logger.error(
        { errors: json.errors },
        'healthie graphql errors'
      );
      throw new Error(
        `Healthie GraphQL: ${json.errors.map((e) => e.message).join('; ')}`
      );
    }
    if (!json.data) {
      throw new Error('Healthie returned no data');
    }
    return json.data;
  }

  // ---- typed wrappers ---------------------------------------------------

  async createPatient(input: {
    first_name: string;
    last_name: string;
    email: string;
    phone_number?: string;
    date_of_birth?: string;
    gender?: string;
    external_id?: string;
  }): Promise<{ createPatient: { patient: { id: string } } }> {
    const mutation = `
      mutation CreatePatient($input: CreatePatientInput!) {
        createPatient(input: $input) {
          patient { id }
        }
      }
    `;
    return this.request(mutation, { input });
  }

  async getPatient(id: string): Promise<{
    patient: {
      id: string;
      first_name: string;
      last_name: string;
      email: string;
      phone_number: string | null;
      date_of_birth: string | null;
    } | null;
  }> {
    const q = `
      query GetPatient($id: ID!) {
        patient(id: $id) {
          id first_name last_name email phone_number date_of_birth
        }
      }
    `;
    return this.request(q, { id });
  }

  async createAppointment(input: {
    patient_id: string;
    provider_id: string;
    start_at: string;        // ISO 8601
    end_at: string;          // ISO 8601
    notes?: string;
    appointment_type?: string;
  }): Promise<{ createAppointment: { appointment: { id: string } } }> {
    const mutation = `
      mutation CreateAppt($input: CreateAppointmentInput!) {
        createAppointment(input: $input) {
          appointment { id }
        }
      }
    `;
    return this.request(mutation, { input });
  }

  async sendMessage(input: {
    recipient_id: string;
    body: string;
    conversation_id?: string;
  }): Promise<{ sendMessage: { message: { id: string } } }> {
    const mutation = `
      mutation SendMessage($input: SendMessageInput!) {
        sendMessage(input: $input) {
          message { id }
        }
      }
    `;
    return this.request(mutation, { input });
  }
}
