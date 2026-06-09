import { CharmClient } from '../../src/integrations/charm/client';

describe('CharmClient', () => {
  const fetchMock = jest.fn();
  const client = new CharmClient({
    apiKey: 'akey',
    username: 'u',
    password: 'p',
    fetchImpl: fetchMock as unknown as typeof import('node-fetch'),
  });

  beforeEach(() => fetchMock.mockReset());

  it('listPatients hits the patients endpoint with apikey', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ patients: [] }),
      text: async () => '',
    });
    const list = await client.listPatients({ pageSize: 10 });
    expect(list).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/ehr\/v1\/patients\?/);
    expect(url).toMatch(/apikey=akey/);
    expect(url).toMatch(/pageSize=10/);
    expect(init.method).toBe('GET');
  });

  it('listAppointments sends from/to params', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ appointments: [] }),
      text: async () => '',
    });
    const list = await client.listAppointments({
      from: '2025-01-01T00:00:00Z',
      to: '2025-01-31T23:59:59Z',
    });
    expect(list).toEqual([]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toMatch(/from=2025-01-01/);
    expect(url).toMatch(/to=2025-01-31/);
  });

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
      json: async () => ({}),
    });
    await expect(client.listPatients()).rejects.toThrow(/HTTP 401/);
  });
});
