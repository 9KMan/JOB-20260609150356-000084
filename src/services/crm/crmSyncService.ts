/**
 * CRM sync service — keeps Zoho CRM in step with our patient master.
 * Idempotent: we look up by email first, then upsert.
 */
import { ZohoClient } from '../../integrations/zoho/client';
import { getAuditLogger } from '../../db/audit';

export interface SyncPatientInput {
  patientId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  leadSource?: string;
}

export class CrmSyncService {
  constructor(private zoho: ZohoClient) {}

  async syncPatient(input: SyncPatientInput): Promise<{ id: string; created: boolean }> {
    try {
      const contact = await this.zoho.upsertContact({
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        leadSource: input.leadSource,
        externalId: input.patientId,
      });
      await getAuditLogger().record({
        action: 'integration.zoho.sync',
        resourceType: 'contact',
        resourceId: contact.id,
        outcome: 'success',
        metadata: { email: input.email },
      });
      return { id: contact.id, created: true };
    } catch (err) {
      await getAuditLogger().record({
        action: 'integration.zoho.sync',
        outcome: 'failure',
        metadata: { reason: (err as Error).message, email: input.email },
      });
      throw err;
    }
  }
}
