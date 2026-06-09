import { ZohoClient } from '../../src/integrations/zoho/client';

describe('ZohoClient', () => {
  const fetchMock = jest.fn();
  const client = new ZohoClient({
    clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt',
    fetchImpl: fetchMock as unknown as typeof import('node-fetch'),
  });

  beforeEach(() => {
    fetchMock.mockReset();
    // Clear the cached Zoho access token between tests so the refresh
    // path is exercised every time.
    (client as unknown as { tokenCache: unknown }).tokenCache = null;
  });

  it('refreshes the token then upserts a contact', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ access_token: 'zt', expires_in: 3600 }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: [{ id: 'zc1', email: 'a@b.test' }] }),
        text: async () => '',
      });
    const res = await client.upsertContact({
      firstName: 'A', lastName: 'B', email: 'a@b.test',
    });
    expect(res.id).toBe('zc1');
    const tokenInit = fetchMock.mock.calls[0][1];
    expect(tokenInit.body).toMatch(/grant_type=refresh_token/);
    const upsertInit = fetchMock.mock.calls[1][1];
    expect(upsertInit.headers.Authorization).toBe('Zoho-oauthtoken zt');
    expect(JSON.parse(upsertInit.body).duplicate_check_fields).toEqual(['Email']);
  });

  it('finds a contact by email', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ access_token: 'zt', expires_in: 3600 }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: [{ id: 'z9', email: 'x@y.test' }] }),
        text: async () => '',
      });
    const res = await client.findContactByEmail('x@y.test');
    expect(res?.id).toBe('z9');
  });
});
