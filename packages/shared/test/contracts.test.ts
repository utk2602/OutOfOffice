import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_NAME, factInputSchema, meetingInputSchema, parseMeetUrl } from '../src/index.ts';

test('facts are private and unapproved unless explicitly shared', () => {
  const fact = factInputSchema.parse({ title: 'Build', topic: 'status', text: 'Validation is pending.' });
  assert.equal(fact.approved, false);
  assert.equal(fact.sensitivity, 'PRIVATE');
  assert.equal(AGENT_NAME, 'OutOfOffice');
});
test('dispatch requires explicit authorization and rejects extra provider controls', () => {
  assert.equal(meetingInputSchema.safeParse({ ownerAuthorized: false }).success, false);
  assert.equal(factInputSchema.safeParse({ title: 'Build', topic: 'status', text: 'x', ownerId: 'other' }).success, false);
});
test('meeting URL validation rejects arbitrary hosts, credentials and redirects', () => {
  assert.equal(parseMeetUrl('https://meet.google.com/abc-defg-hij?authuser=1'), 'https://meet.google.com/abc-defg-hij');
  for (const value of ['http://meet.google.com/abc-defg-hij', 'https://meet.google.com.evil.org/abc-defg-hij', 'https://user@meet.google.com/abc-defg-hij', 'https://meet.google.com/redirect']) {
    assert.throws(() => parseMeetUrl(value));
  }
});
