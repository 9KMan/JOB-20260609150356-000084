/**
 * Zoho CRM adapter.
 *
 * Two-step auth: we trade a long-lived refresh token for a short
 * access token. We cache until near expiry. We model the operations
 * needed for patient/lead sync:
 *  - upsertContact
 *  - addNote
 *  - findContact
 */
// node-fetch v2 default export is the fetch function.
import fetch from 'node-fetch';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export interface ZohoContact {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  leadSource?: string;
  externalId?: string;        // our patient id
}

export interface ZohoContactRecord {
  id: string;
  email: string;
}

export interface ZohoClientOptions {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  fetchImpl?: typeof fetch;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class ZohoClient {
  private baseUrl: string;
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private fetchImpl: typeof fetch;
  private tokenCache: TokenCache | null = null;

  constructor(opts: ZohoClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? config.zoho.baseUrl).replace(/\/$/, '');
    this.clientId = opts.clientId ?? config.zoho.clientId;
    this.clientSecret = opts.clientSecret ?? config.zoho.clientSecret;
    this.refreshToken = opts.refreshToken ?? config.zoho.refreshToken;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as typeof fetch);
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }
    // Zoho accounts are region-specific. We default to .com.
    const accountsUrl = 'https://accounts.zoho.com/oauth/v2/token';
    const res = await this.fetchImpl(accountsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
      }).toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zoho token HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.tokenCache = {
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
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      logger.error(
        { status: res.status, path, body: text.slice(0, 500) },
        'zoho http error'
      );
      throw new Error(`Zoho HTTP ${res.status} on ${path}`);
    }
    return (await res.json()) as T;
  }

  async findContactByEmail(email: string): Promise<ZohoContactRecord | null> {
    const q = `(Email:equals:${encodeURIComponent(email)})`;
    const data = await this.request<{ data: ZohoContactRecord[] }>(
      'GET',
      `/Contacts/search?criteria=${q}`
    );
    return data.data?.[0] ?? null;
  }

  async upsertContact(contact: ZohoContact): Promise<ZohoContactRecord> {
    const payload = {
      data: [
        {
          First_Name: contact.firstName,
          Last_Name: contact.lastName,
          Email: contact.email,
          Phone: contact.phone,
          Lead_Source: contact.leadSource,
          External_ID: contact.externalId,
        },
      ],
      duplicate_check_fields: ['Email'],
    };
    const res = await this.request<{ data: ZohoContactRecord[] }>(
      'POST',
      '/Contacts/upsert',
      payload
    );
    const rec = res.data?.[0];
    if (!rec) throw new Error('Zoho upsert returned no record');
    return rec;
  }

  async addNote(contactId: string, title: string, content: string): Promise<{ id: string }> {
    const res = await this.request<{ data: Array<{ id: string }> }>(
      'POST',
      '/Notes',
      {
        data: [
          {
            Parent_Id: contactId,
            Module: 'Contacts',
            Title: title,
            Content: content,
          },
        ],
      }
    );
    const rec = res.data?.[0];
    if (!rec) throw new Error('Zoho note returned no record');
    return rec;
  }
}
