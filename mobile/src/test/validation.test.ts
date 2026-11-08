import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidHhmm,
  scheduleDraftHasErrors,
  validateBaseUrl,
  validateCoordinate,
  validateHhmmField,
  validateJourneyChronology,
  validateManualLocation,
  validateNonnegativeInteger,
  validatePin,
  validateScheduleDraft,
  type ScheduleDraft,
} from '../validation/validate';

function draft(patch: Partial<ScheduleDraft> = {}): ScheduleDraft {
  return {
    windowStart: '08:00',
    windowEnd: '09:15',
    preferredDeparture: '08:30',
    arrivalDeadline: '09:45',
    safetyBufferMinutes: '10',
    days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
    ...patch,
  };
}

test('HH:mm validation accepts canonical times and rejects malformed ones', () => {
  for (const good of ['08:30', '00:00', '23:59', ' 09:15 ']) {
    assert.ok(isValidHhmm(good), good);
  }
  for (const bad of ['8:30', '24:00', '08:60', '0830', 'abc', '12:5', '']) {
    assert.equal(isValidHhmm(bad), false, bad);
  }
  assert.match(validateHhmmField('25:00', 'Window end') ?? '', /valid 24-hour time/);
});

test('schedule validation: window order and preferred-inside-window rules', () => {
  assert.equal(scheduleDraftHasErrors(validateScheduleDraft(draft())), false, 'clean draft passes');

  const reversed = validateScheduleDraft(draft({ windowStart: '09:15', windowEnd: '08:00' }));
  assert.match(reversed.windowEnd ?? '', /after window start/);

  const prefOutside = validateScheduleDraft(draft({ preferredDeparture: '10:00' }));
  assert.match(prefOutside.preferredDeparture ?? '', /inside the window/);

  const equalWindow = validateScheduleDraft(draft({ windowStart: '09:00', windowEnd: '09:00' }));
  assert.match(equalWindow.windowEnd ?? '', /after window start/);

  const midnightWindow = validateScheduleDraft(draft({ windowStart: '23:45', windowEnd: '23:50', preferredDeparture: '23:48' }));
  assert.equal(scheduleDraftHasErrors(midnightWindow), false);
});

test('schedule validation: deadline optional but must be valid; buffer must be a bounded nonnegative integer; days nonempty', () => {
  const noDeadline = validateScheduleDraft(draft({ arrivalDeadline: '' }));
  assert.equal(noDeadline.arrivalDeadline, undefined, 'empty deadline allowed');

  const badDeadline = validateScheduleDraft(draft({ arrivalDeadline: '9:45' }));
  assert.match(badDeadline.arrivalDeadline ?? '', /valid 24-hour time/);

  for (const bad of ['-5', 'abc', '', '3.5']) {
    assert.match(validateNonnegativeInteger(bad, 'Safety buffer') ?? '', /whole number/, bad);
  }
  assert.match(validateNonnegativeInteger('200', 'Safety buffer') ?? '', /at most 120/);
  assert.equal(validateNonnegativeInteger('0', 'Safety buffer'), null);
  assert.equal(validateNonnegativeInteger('120', 'Safety buffer'), null);

  const noDays = validateScheduleDraft(draft({ days: [] }));
  assert.match(noDays.days ?? '', /at least one workday/);

  const bufferError = validateScheduleDraft(draft({ safetyBufferMinutes: '-1' }));
  assert.match(bufferError.safetyBufferMinutes ?? '', /whole number/);
});

test('manual location coordinates respect global bounds without inventing geocodes', () => {
  assert.equal(validateCoordinate('12.9116', 'lat'), null);
  assert.equal(validateCoordinate('77.6474', 'lng'), null);
  assert.match(validateCoordinate('91', 'lat') ?? '', /between -90 and 90/);
  assert.match(validateCoordinate('-200.5', 'lng') ?? '', /between -180 and 180/);
  assert.match(validateCoordinate('abc', 'lat') ?? '', /decimal number/);

  const manual = validateManualLocation({ label: '  ', lat: '12.9', lng: '77.6' });
  assert.match(manual.label ?? '', /label/i);
  const ok = validateManualLocation({ label: 'Home – HSR', lat: '12.9116', lng: '77.6474' });
  assert.deepEqual(ok, {});
});

test('journey chronology rejects arrival at/before departure instead of clamping', () => {
  assert.equal(validateJourneyChronology('08:30', '09:05'), null);
  assert.equal(validateJourneyChronology('08:30', null), null);
  assert.equal(validateJourneyChronology('08:30', ''), null);
  assert.match(validateJourneyChronology('08:30', '08:30') ?? '', /later than departure/);
  assert.match(validateJourneyChronology('08:30', '07:00') ?? '', /later than departure/);
  // Malformed inputs are left to the format validators; chronology stays silent.
  assert.equal(validateJourneyChronology('8:30', 'banana'), null);
});

test('pilot PIN must be exactly 4 digits', () => {
  assert.equal(validatePin('1001'), null);
  for (const bad of ['100', '10001', 'abcd', '']) {
    assert.match(validatePin(bad) ?? '', /4-digit/, bad);
  }
});

test('base URL must be a bare origin; plain http limited to loopback/private LAN', () => {
  for (const good of [
    'http://10.0.2.2:3000',
    'http://localhost:3000',
    'http://127.0.0.1:8787',
    'http://192.168.1.20:3000',
    'http://172.16.0.5:3000',
    'https://orr-pilot.example.com',
    'https://orr-pilot.example.com:8443',
  ]) {
    assert.equal(validateBaseUrl(good), null, good);
  }
  for (const bad of [
    '', 'not a url', 'ftp://10.0.2.2:3000',
    'http://user:pass@10.0.2.2:3000',
    'http://10.0.2.2:3000/api',
    'http://10.0.2.2:3000/?x=1',
    'http://10.0.2.2:3000/#frag',
    // Plain http to non-private hosts is rejected
    'http://8.8.8.8:3000',
    'http://orr-pilot.example.com',
  ] as string[]) {
    assert.notEqual(validateBaseUrl(bad), null, `expected rejection: ${bad}`);
  }
  assert.match(validateBaseUrl('http://8.8.8.8:3000') ?? '', /localhost or a private LAN/i);
  assert.match(validateBaseUrl('http://10.0.2.2:3000/api') ?? '', /without a path/i);
});
