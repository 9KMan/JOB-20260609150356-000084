import { HealthieClient } from '../../src/integrations/healthie/client';

describe('HealthieClient', () => {
  const fetchMock = jest.fn();
  const client = new HealthieClient({
    apiKey: 'key',
    apiSecret: 'secret',
    fetchImpl: fetchMock as unknown as typeof import('node-fetch'),
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('sends a POST with Basic auth and JSON body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { createPatient: { patient: { id: 'p1' } } } }),
      text: async () => '',
    });
    const res = await client.createPatient({
      first_name: 'A',
      last_name: 'B',
      email: 'a@b.test',
    });
    expect(res.createPatient.patient.id).toBe('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.gethealthie.com/graphql');
    expect(init.method).toBe('POST');
    const expected = 'Basic ' + Buffer.from('key:secret').toString('base64');
    expect(init.headers.Authorization).toBe(expected);
    const body = JSON.parse(init.body);
    expect(body.query).toMatch(/mutation CreatePatient/);
    expect(body.variables.input).toEqual({ first_name: 'A', last_name: 'B', email: 'a@b.test' });
  });

  it('throws on GraphQL errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: 'bad' }] }),
      text: async () => '',
    });
    await expect(client.getPatient('p1')).rejects.toThrow(/bad/);
  });

  it('throws on HTTP non-2xx', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'server boom',
      json: async () => ({}),
    });
    await expect(client.getPatient('p1')).rejects.toThrow(/HTTP 500/);
  });
});
