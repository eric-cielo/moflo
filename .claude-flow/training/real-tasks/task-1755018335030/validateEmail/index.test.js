
const { validateEmail } = require('./index');

describe('validateEmail', () => {
  test('validates correct email', () => {
    expect(validateEmail('test@example.com')).toBe(true);
  });
  
  test('rejects invalid email', () => {
    expect(validateEmail('invalid')).toBe(false);
  });
});
