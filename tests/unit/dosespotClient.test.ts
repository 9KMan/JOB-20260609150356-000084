import { DoseSpotClient } from '../../src/integrations/dosespot/client';

describe('DoseSpotClient', () => {
  const fetchMock = jest.fn();
  const client = new DoseSpotClient({
    apiKey: 'k',
    apiSecret: 's',
    clinicId: 'c1',
    fetchImpl: fetchMock as unknown as typeof import('node-fetch'),
  });

  beforeEach(() => {
    fetchMock.mockReset();
    // Clear the in-memory session cache between tests so the auth flow
    // is exercised on every test rather than inherited from the prior.
    (client as unknown as { session: unknown }).session = null;
  });

  it('creates a session then posts a prescription with bearer token', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: 'sess-1', expiresInSeconds: 3600 }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          prescriptionId: 'rx-1',
          status: 'pending',
          pharmacy: { ncpdpId: '123', name: 'Pharm' },
          warnings: [],
        }),
        text: async () => '',
      });

    const res = await client.createPrescription({
      patientId: 'p1',
      providerId: 'doc1',
      drug: {
        name: 'amoxicillin',
        dose: '500mg',
        route: 'oral',
        frequency: 'tid',
        durationDays: 7,
        refills: 0,
        genericAllowed: true,
      },
      pharmacy: { ncpdpId: '123' },
    });
    expect(res.prescriptionId).toBe('rx-1');
    expect(res.status).toBe('pending');
    expect(fetchMock.mock.calls[0][0]).toMatch(/sessions$/);
    expect(fetchMock.mock.calls[1][0]).toMatch(/prescriptions$/);
    const sessionInit = fetchMock.mock.calls[0][1];
    expect(sessionInit.method).toBe('POST');
    expect(JSON.parse(sessionInit.body)).toEqual({
      apiKey: 'k', apiSecret: 's', clinicId: 'c1',
    });
    const rxInit = fetchMock.mock.calls[1][1];
    expect(rxInit.headers.Authorization).toBe('Bearer sess-1');
    expect(rxInit.headers.clinicId).toBe('c1');
  });

  it('caches the session across calls', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: 'sess-2', expiresInSeconds: 3600 }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          prescriptionId: 'rx-2', status: 'pending',
          pharmacy: { ncpdpId: '1', name: 'p' }, warnings: [],
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          prescriptionId: 'rx-3', status: 'pending',
          pharmacy: { ncpdpId: '1', name: 'p' }, warnings: [],
        }),
        text: async () => '',
      });
    await client.createPrescription({
      patientId: 'p1', providerId: 'doc1',
      drug: { name: 'x', dose: '1', route: 'oral', frequency: 'qd',
              durationDays: 1, refills: 0, genericAllowed: true },
      pharmacy: { ncpdpId: '1' },
    });
    await client.createPrescription({
      patientId: 'p1', providerId: 'doc1',
      drug: { name: 'x', dose: '1', route: 'oral', frequency: 'qd',
              durationDays: 1, refills: 0, genericAllowed: true },
      pharmacy: { ncpdpId: '1' },
    });
    expect(fetchMock.mock.calls).toHaveLength(3); // 1 session + 2 rx
  });
});
