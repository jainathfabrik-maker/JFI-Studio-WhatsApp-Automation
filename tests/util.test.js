import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKeyInTz, dateLabelInTz, dayOfYearInTz, chunkText, maskPhone, normalizePhone, timingSafeEqualString, isValidTimezone } from '../src/util.js';

const TZ = 'Asia/Kolkata';

test('the day boundary follows IST, not UTC', () => {
  // 18:29:59 UTC on 2 Nov 2026 is 23:59:59 IST on 2 Nov.
  const beforeMidnight = Date.UTC(2026, 10, 2, 18, 29, 59);
  // 18:30:00 UTC on 2 Nov 2026 is 00:00:00 IST on 3 Nov.
  const afterMidnight = Date.UTC(2026, 10, 2, 18, 30, 0);

  assert.equal(dateKeyInTz(TZ, beforeMidnight), '2026-11-02');
  assert.equal(dateKeyInTz(TZ, afterMidnight), '2026-11-03');

  // At 18:31 UTC the two zones genuinely disagree: IST has rolled to the 3rd,
  // UTC is still on the 2nd. This is why the run guard must not use UTC.
  assert.equal(dateKeyInTz('UTC', afterMidnight), '2026-11-02');
  assert.notEqual(dateKeyInTz(TZ, afterMidnight), dateKeyInTz('UTC', afterMidnight));
});

test('the daily run date rolls over exactly at IST midnight', () => {
  const justBefore = Date.UTC(2026, 10, 2, 18, 29, 0);
  const justAfter = Date.UTC(2026, 10, 2, 18, 31, 0);
  assert.equal(dateKeyInTz(TZ, justBefore), '2026-11-02');
  assert.equal(dateKeyInTz(TZ, justAfter), '2026-11-03');
});

test('the date label is a single line with no comma', () => {
  const label = dateLabelInTz(TZ, Date.UTC(2026, 10, 3, 6, 30));
  assert.equal(label, 'Tue 3 Nov 2026');
  assert.ok(!label.includes(','), 'a comma would still be legal but reads badly as a template parameter');
  assert.ok(!/[\n\r\t]/.test(label), 'a template parameter must be one line');
});

test('day of year is computed in IST', () => {
  assert.equal(dayOfYearInTz(TZ, Date.UTC(2026, 0, 1, 6, 30)), 1);
  assert.equal(dayOfYearInTz(TZ, Date.UTC(2026, 11, 31, 6, 30)), 365);
  // 18:31 UTC on 31 Dec is already 1 Jan in IST.
  assert.equal(dayOfYearInTz(TZ, Date.UTC(2026, 11, 31, 18, 31)), 1);
});

test('timezone validation accepts real zones and rejects invented ones', () => {
  assert.equal(isValidTimezone('Asia/Kolkata'), true);
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Asia/Bengaluru'), false);
  assert.equal(isValidTimezone(''), false);
});

test('chunkText never exceeds the limit and prefers a line break', () => {
  const text = Array.from({ length: 60 }, (_, i) => `line ${i} of the pack`).join('\n');
  const chunks = chunkText(text, 200);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 200, `chunk of ${chunk.length} exceeds 200`);
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});

test('chunkText returns one chunk when the text fits, and none when empty', () => {
  assert.deepEqual(chunkText('short', 100), ['short']);
  assert.deepEqual(chunkText('', 100), []);
});

test('phone numbers normalise to digits and mask in logs', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '919876543210');
  assert.equal(normalizePhone('(91)-98765-43210'), '919876543210');
  assert.equal(maskPhone('919876543210'), '919***210');
  assert.ok(!maskPhone('919876543210').includes('876543'));
  assert.equal(maskPhone('123'), '***');
});

test('constant-time comparison handles equal, different and empty values', () => {
  assert.equal(timingSafeEqualString('abc', 'abc'), true);
  assert.equal(timingSafeEqualString('abc', 'abd'), false);
  assert.equal(timingSafeEqualString('abc', 'abcd'), false);
  assert.equal(timingSafeEqualString('', ''), true);
  assert.equal(timingSafeEqualString(undefined, ''), true);
});
