const { sanitizeInput, validateSocketJoinData } = require('../../middleware/validation');
const { VALID_ROOM_ID } = require('../helpers/constants');

describe('sanitizeInput', () => {
  it('removes angle brackets', () => {
    expect(sanitizeInput('<script>alert("xss")</script>')).toBe('scriptalert("xss")/script');
  });

  it('trims whitespace', () => {
    expect(sanitizeInput('  hello  ')).toBe('hello');
  });

  it('limits to 100 characters', () => {
    const long = 'x'.repeat(150);
    expect(sanitizeInput(long).length).toBe(100);
  });

  it('returns non-string input unchanged', () => {
    expect(sanitizeInput(42)).toBe(42);
    expect(sanitizeInput(null)).toBe(null);
  });

  it('handles empty string', () => {
    expect(sanitizeInput('')).toBe('');
  });
});

describe('validateSocketJoinData', () => {
  it('valid data returns isValid=true', () => {
    const result = validateSocketJoinData({ roomId: VALID_ROOM_ID, role: 'baby' });
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('valid data with userName', () => {
    const result = validateSocketJoinData({ roomId: VALID_ROOM_ID, role: 'parent', userName: 'Dad' });
    expect(result.isValid).toBe(true);
  });

  it('missing roomId returns error', () => {
    const result = validateSocketJoinData({ role: 'baby' });
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('room ID'))).toBe(true);
  });

  it('invalid roomId format returns error', () => {
    const result = validateSocketJoinData({ roomId: 'short', role: 'baby' });
    expect(result.isValid).toBe(false);
  });

  it('missing role returns error', () => {
    const result = validateSocketJoinData({ roomId: VALID_ROOM_ID });
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('role'))).toBe(true);
  });

  it('invalid role returns error', () => {
    const result = validateSocketJoinData({ roomId: VALID_ROOM_ID, role: 'watcher' });
    expect(result.isValid).toBe(false);
  });

  it('invalid userName (too long) returns error', () => {
    const result = validateSocketJoinData({
      roomId: VALID_ROOM_ID,
      role: 'baby',
      userName: 'x'.repeat(51),
    });
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('user name'))).toBe(true);
  });

  it('multiple errors collected', () => {
    const result = validateSocketJoinData({});
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
