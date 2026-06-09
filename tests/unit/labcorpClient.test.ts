import { LabCorpClient } from '../../src/integrations/labcorp/client';

describe('LabCorpClient', () => {
  const fetchMock = jest.fn();
  const client = new LabCorpClient({
    apiKey: 'cid',
    accountId: 'csec',
    fetchImpl: fetchMock as unknown as typeof import('node-fetch'),
  });

  beforeEach(() => {
    fetchMock.mockReset();
    (client as unknown as { tokenState: unknown }).tokenState = null;
  });

  it('gets an OAuth token then places an order', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok-1', expires_in: 3600 }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          labcorpOrderId: 'L-1',
          status: 'received',
          estimatedResultDate: '2025-01-10',
        }),
        text: async () => '',
      });

    const res = await client.placeOrder({
      patient: {
        firstName: 'Jane',
        lastName: 'Doe',
        dob: '1980-01-01',
        mrn: 'MRN-1',
        gender: 'F',
      },
      provider: { npi: '1234567890' },
      tests: [{ loinc: '4548-4', code: 'HBA1C', name: 'Hemoglobin A1c' }],
      priority: 'routine',
    });
    expect(res.labcorpOrderId).toBe('L-1');
    const tokenInit = fetchMock.mock.calls[0][1];
    expect(tokenInit.body).toMatch(/grant_type=client_credentials/);
    const orderInit = fetchMock.mock.calls[1][1];
    expect(orderInit.headers.Authorization).toBe('Bearer tok-1');
    const orderBody = JSON.parse(orderInit.body);
    expect(orderBody.tests[0].loinc).toBe('4548-4');
  });
});
