import { encryptPHI, decryptPHI, blindIndex } from '../../src/utils/encryption';

describe('PHI encryption', () => {
  it('round-trips a plaintext through encrypt/decrypt', () => {
    const envelope = encryptPHI('John Doe');
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(decryptPHI(envelope)).toBe('John Doe');
  });

  it('produces a different envelope each time (random IV)', () => {
    const a = encryptPHI('same value');
    const b = encryptPHI('same value');
    expect(a).not.toBe(b);
    expect(decryptPHI(a)).toBe('same value');
    expect(decryptPHI(b)).toBe('same value');
  });

  it('returns null on a tampered envelope (auth tag failure)', () => {
    const good = encryptPHI('secret');
    const parts = good.split(':');
    // Flip a byte in the ciphertext
    const ctBuf = Buffer.from(parts[3], 'base64');
    ctBuf[0] = ctBuf[0] ^ 0xff;
    parts[3] = ctBuf.toString('base64');
    const bad = parts.join(':');
    expect(decryptPHI(bad)).toBeNull();
  });

  it('returns null on a malformed envelope', () => {
    expect(decryptPHI(null)).toBeNull();
    expect(decryptPHI('')).toBeNull();
    expect(decryptPHI('v0:aaa:bbb:ccc')).toBeNull();
    expect(decryptPHI('garbage')).toBeNull();
  });

  it('blind index is deterministic and case-insensitive', () => {
    expect(blindIndex('MRN-001')).toBe(blindIndex('mrn-001'));
    expect(blindIndex('MRN-001')).toBe(blindIndex('  mrn-001  '));
    expect(blindIndex('MRN-001')).not.toBe(blindIndex('MRN-002'));
  });
});
