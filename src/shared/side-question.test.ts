import { describe, expect, it } from 'vitest';
import { getSideQuestionText } from './side-question';

describe('getSideQuestionText', () => {
  it.each([
    ['/btw', ''],
    ['/btw ', ''],
    [' /BTW How is it going? ', 'How is it going?'],
    ['/btw\nFirst line\nSecond line', 'First line\nSecond line'],
    ['/btw First line\nSecond line', 'First line\nSecond line'],
  ])('recognizes %j as a side question', (text, question) => {
    expect(getSideQuestionText(text)).toBe(question);
  });

  it.each(['', 'btw Why?', 'Please /btw explain', '/btwhatever', '/btw-more Why?', '/review'])(
    'does not match ordinary input %j',
    (text) => {
      expect(getSideQuestionText(text)).toBeNull();
    }
  );
});
