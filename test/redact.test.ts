import { describe, expect, it } from 'vitest';
import { redact } from '../src/execution/Redact';

describe('Tool output redaction', () => {
  it('masks common secret formats and keeps the surrounding text', () => {
    const text = 'export OPENAI_API_KEY=sk-abcdefghijklmnop1234\nAuthorization: Bearer abcdefghijklmnopqrstuv\npassword: hunter22secret\nghp_abcdefghijklmnopqrstuvwxyz0123 AKIAABCDEFGHIJKLMNOP\nok';
    const masked = redact(text, 10000);
    for (const secret of ['sk-abcdefghijklmnop1234', 'abcdefghijklmnopqrstuv', 'hunter22secret', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'AKIAABCDEFGHIJKLMNOP']) expect(masked).not.toContain(secret);
    expect(masked).toContain('Bearer [已遮罩]'); expect(masked).toContain('password: [已遮罩]'); expect(masked.endsWith('\nok')).toBe(true);
  });
  it('truncates long output and says how much was cut', () => {
    expect(redact('a'.repeat(30), 10)).toBe(`${'a'.repeat(10)}\n…（已截斷 20 字）`);
  });
});
