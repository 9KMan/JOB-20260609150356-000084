/**
 * Automation dispatcher — fires a workflow trigger into n8n or
 * Keragon and waits for the result. Used by appointment lifecycle
 * events, new patient events, prescription refills, lab results, etc.
 */
// node-fetch v2 default export is the fetch function.
import fetch, { RequestInit, Response } from 'node-fetch';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { getAuditLogger } from '../../db/audit';

export type AutomationTarget = 'n8n' | 'keragon';

export interface AutomationEvent {
  type: string;                // e.g. 'patient.created'
  organisationId: string;
  payload: Record<string, unknown>;
}

export interface DispatchOptions {
  target: AutomationTarget;
  workflowId: string;
  event: AutomationEvent;
}

export interface DispatchResult {
  status: 'queued' | 'rejected' | 'error';
  upstreamId?: string;
  message?: string;
}

export type FetchLike = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

export interface AutomationDispatcherOptions {
  fetchImpl?: FetchLike;
}

export class AutomationDispatcher {
  private fetchImpl: FetchLike;

  constructor(opts: AutomationDispatcherOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  async dispatch(opts: DispatchOptions): Promise<DispatchResult> {
    const url = this.urlFor(opts.target, opts.workflowId);
    const headers = this.headersFor(opts.target);

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(opts.event),
      });
      const text = await res.text();
      if (!res.ok) {
        logger.error(
          { status: res.status, target: opts.target, workflow: opts.workflowId, body: text.slice(0, 500) },
          'automation: dispatch failed'
        );
        await getAuditLogger().record({
          action: 'automation.workflow.trigger',
          outcome: 'failure',
          metadata: { target: opts.target, workflow: opts.workflowId, status: res.status },
        });
        return { status: 'error', message: text.slice(0, 200) };
      }
      const body = text ? JSON.parse(text) : {};
      await getAuditLogger().record({
        action: 'automation.workflow.trigger',
        outcome: 'success',
        metadata: { target: opts.target, workflow: opts.workflowId, event: opts.event.type },
      });
      return { status: 'queued', upstreamId: body.id ?? body.runId };
    } catch (err) {
      logger.error({ err }, 'automation: dispatch threw');
      return { status: 'error', message: (err as Error).message };
    }
  }

  private urlFor(target: AutomationTarget, workflowId: string): string {
    if (target === 'n8n') {
      return `${config.n8n.webhookUrl || `${config.n8n.baseUrl}/webhook`}/${workflowId}`;
    }
    return `${config.keragon.webhookUrl || `${config.keragon.baseUrl}/v1/workflows/${workflowId}/trigger`}`;
  }

  private headersFor(target: AutomationTarget): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (target === 'n8n' && config.n8n.apiKey) {
      h['X-N8n-API-Key'] = config.n8n.apiKey;
    }
    if (target === 'keragon' && config.keragon.apiKey) {
      h['Authorization'] = `Bearer ${config.keragon.apiKey}`;
    }
    return h;
  }
}
