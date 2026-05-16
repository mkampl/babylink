// Shared test constants

const VALID_ROOM_ID = 'a'.repeat(32);
const VALID_ROOM_ID_2 = 'b'.repeat(32);
const VALID_ROOM_ID_3 = 'c'.repeat(32);

const INVALID_ROOM_IDS = [
  'short',
  'x'.repeat(31),
  'g'.repeat(32),       // non-hex
  '123',
  '',
  null,
  undefined,
  12345,
];

const VALID_ROLES = ['baby', 'parent'];
const INVALID_ROLES = ['observer', 'admin', '', null, 123];

module.exports = {
  VALID_ROOM_ID,
  VALID_ROOM_ID_2,
  VALID_ROOM_ID_3,
  INVALID_ROOM_IDS,
  VALID_ROLES,
  INVALID_ROLES,
};
