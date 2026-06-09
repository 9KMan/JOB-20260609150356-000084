import { signToken, verifyToken, hashPassword, verifyPassword } from '../../src/auth/jwt';

describe('JWT auth', () => {
  const payload = {
    sub: '00000000-0000-0000-0000-000000000001',
    email: 'doc@nrg.test',
    role: 'provider' as const,
    orgId: '00000000-0000-0000-0000-000000000002',
  };

  it('signs and verifies a token with a sessionId', () => {
    const token = signToken(payload);
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe(payload.sub);
    expect(decoded.role).toBe(payload.role);
    expect(decoded.orgId).toBe(payload.orgId);
    expect(typeof decoded.sessionId).toBe('string');
    expect(decoded.sessionId.length).toBeGreaterThan(0);
  });

  it('rejects a tampered token', () => {
    const token = signToken(payload);
    const tampered = token.slice(0, -2) + 'AA';
    expect(() => verifyToken(tampered)).toThrow();
  });
});

describe('Password hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).not.toBe('correct-horse-battery-staple');
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('produces a different hash each time (salt)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });
});
