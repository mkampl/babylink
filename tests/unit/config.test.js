const config = require('../../config');

describe('config.validation.isValidRoomId', () => {
  it('accepts valid 32-char hex (lowercase)', () => {
    expect(config.validation.isValidRoomId('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(true);
  });

  it('accepts valid 32-char hex (uppercase)', () => {
    expect(config.validation.isValidRoomId('A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4')).toBe(true);
  });

  it('accepts valid 32-char hex (mixed case)', () => {
    expect(config.validation.isValidRoomId('aAbBcCdDeEfF0123456789aAbBcCdDeE')).toBe(true);
  });

  it('accepts all zeros', () => {
    expect(config.validation.isValidRoomId('0'.repeat(32))).toBe(true);
  });

  it('rejects 31-char string', () => {
    expect(config.validation.isValidRoomId('a'.repeat(31))).toBe(false);
  });

  it('rejects 33-char string', () => {
    expect(config.validation.isValidRoomId('a'.repeat(33))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(config.validation.isValidRoomId('g'.repeat(32))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(config.validation.isValidRoomId('')).toBe(false);
  });

  it('rejects number input', () => {
    expect(config.validation.isValidRoomId(12345)).toBe(false);
  });

  it('rejects null', () => {
    expect(config.validation.isValidRoomId(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(config.validation.isValidRoomId(undefined)).toBe(false);
  });
});

describe('config.validation.isValidRole', () => {
  it('accepts baby', () => {
    expect(config.validation.isValidRole('baby')).toBe(true);
  });

  it('accepts parent', () => {
    expect(config.validation.isValidRole('parent')).toBe(true);
  });

  it('rejects observer', () => {
    expect(config.validation.isValidRole('observer')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(config.validation.isValidRole('')).toBe(false);
  });

  it('rejects null', () => {
    expect(config.validation.isValidRole(null)).toBe(false);
  });
});

describe('config.validation.isValidUserName', () => {
  it('accepts 1-char name', () => {
    expect(config.validation.isValidUserName('A')).toBe(true);
  });

  it('accepts 50-char name', () => {
    expect(config.validation.isValidUserName('x'.repeat(50))).toBe(true);
  });

  it('rejects empty string', () => {
    expect(config.validation.isValidUserName('')).toBe(false);
  });

  it('rejects 51-char name', () => {
    expect(config.validation.isValidUserName('x'.repeat(51))).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(config.validation.isValidUserName(42)).toBe(false);
  });
});
