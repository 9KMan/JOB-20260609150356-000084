import { AutomationDispatcher } from '../../src/services/automation/automationDispatcher';

describe('AutomationDispatcher', () => {
  const fetchMock = jest.fn();
  const dispatcher = new AutomationDispatcher({
    fetchImpl: fetchMock as unknown as typeof import('node-fetch').default,
  });

  beforeEach(() => fetchMock.mockReset());

  it('posts to n8n webhook and returns upstream id', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200, text: async () => '{"id":"run-1"}',
    });
    const res = await dispatcher.dispatch({
      target: 'n8n',
      workflowId: 'patient-intake',
      event: { type: 'patient.created', organisationId: 'org-1', payload: { id: 'p1' } },
    });
    expect(res.status).toBe('queued');
    expect(res.upstreamId).toBe('run-1');
    expect(fetchMock.mock.calls[0][0]).toMatch(/patient-intake/);
  });

  it('returns error on HTTP failure', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 500, text: async () => 'boom',
    });
    const res = await dispatcher.dispatch({
      target: 'keragon',
      workflowId: 'lab-result',
      event: { type: 'lab.result', organisationId: 'org-1', payload: {} },
    });
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/boom/);
  });
});
