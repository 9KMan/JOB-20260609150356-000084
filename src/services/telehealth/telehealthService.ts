/**
 * Telehealth service — generates a single-use meeting URL and records
 * a session. The provider is pluggable (Doxy.me by default), but the
 * storage and audit shape is the same.
 */
import { Pool } from 'pg';
import { randomToken } from '../../utils/encryption';
import { getAuditLogger } from '../../db/audit';

export interface CreateSessionInput {
  organisationId: string;
  appointmentId: string;
  patientId: string;
  providerId: string;
  provider: 'doxy' | 'zoom' | 'custom';
  customUrl?: string;
}

export class TelehealthService {
  constructor(private pool: Pool) {}

  async createSession(input: CreateSessionInput): Promise<{ sessionId: string; url: string }> {
    const sessionId = randomToken(24);
    const url = input.customUrl ?? this.defaultUrlFor(input.provider, sessionId);

    await this.pool.query(
      `UPDATE appointments SET telehealth_url = $2, updated_at = now()
       WHERE id = $1`,
      [input.appointmentId, url]
    );

    await getAuditLogger().record({
      action: 'telehealth.session.create',
      userId: input.providerId,
      resourceType: 'appointment',
      resourceId: input.appointmentId,
      outcome: 'success',
      metadata: { provider: input.provider, sessionId },
    });

    return { sessionId, url };
  }

  private defaultUrlFor(provider: string, sessionId: string): string {
    switch (provider) {
      case 'doxy':
        return `https://doxy.me/clinic-room/${sessionId}`;
      case 'zoom':
        return `https://zoom.us/j/${sessionId}`;
      default:
        return `https://telehealth.local/session/${sessionId}`;
    }
  }
}
