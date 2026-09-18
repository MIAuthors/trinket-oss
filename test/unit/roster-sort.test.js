'use strict';

// Sorting a course roster by surname.
//
// Every roster list sorts on `displayName`, which is a single free-text field
// ("Alexandra Brantley"), so the order is by GIVEN name. An instructor grading
// a class by hand works from a surname-ordered list — their own gradebook,
// a printed roll — and matching one against the other by first name is slow
// and error-prone. Asked for by an instructor grading a class manually while
// SpeedGrader was unusable.
//
// We hold no separate surname: the LMS sends given/family parts on launch but
// we join them into one string and keep only that. So the key is derived, and
// derivation has to be honest about the cases it cannot know.

const rosterSort = require('../../public/js/courseEditor/rosterSort');

describe('rosterSort.key — surname ordering', () => {
  const by = (name) => rosterSort.key(name, 'last');

  it('puts the surname first for an ordinary two-part name', () => {
    expect(by('Alexandra Brantley')).toBe('brantley alexandra');
  });

  it('keeps middle names with the given names, after the surname', () => {
    expect(by('Ada Byron Lovelace')).toBe('lovelace ada byron');
  });

  it('orders a class the way an instructor reads a roll', () => {
    const names = ['Bob Adams', 'alice zeigler', 'Carol Adams', 'Dave Brown'];
    const sorted = names.slice().sort((a, b) => by(a).localeCompare(by(b)));
    expect(sorted).toEqual(['Bob Adams', 'Carol Adams', 'Dave Brown', 'alice zeigler']);
  });

  it('keeps particles with the surname', () => {
    expect(by('Jane van der Berg')).toBe('van der berg jane');
    expect(by('Ana de la Cruz')).toBe('de la cruz ana');
    expect(by('Ludwig von Mises')).toBe('von mises ludwig');
  });

  it('does not absorb a name that merely looks like a particle prefix', () => {
    // "McDonald" is one token, not a particle plus a surname.
    expect(by('John McDonald')).toBe('mcdonald john');
    expect(by('Sean MacLeod')).toBe('macleod sean');
  });

  it('ignores a generational or academic suffix', () => {
    expect(by('Bob Smith Jr.')).toBe('smith bob');
    expect(by('Bob Smith III')).toBe('smith bob');
    expect(by('Rosalind Franklin, PhD')).toBe('franklin rosalind');
  });

  it('handles a single-word name', () => {
    expect(by('Cher')).toBe('cher');
  });

  it('is whitespace- and case-insensitive', () => {
    expect(by('  ADA    LOVELACE  ')).toBe('lovelace ada');
  });

  it('never throws on missing or junk input', () => {
    expect(by('')).toBe('');
    expect(by(null)).toBe('');
    expect(by(undefined)).toBe('');
    expect(by('   ')).toBe('');
  });
});

describe('rosterSort.key — given-name ordering keeps today\'s behaviour', () => {
  const by = (name) => rosterSort.key(name, 'first');

  it('orders by the name as written', () => {
    expect(by('Alexandra Brantley')).toBe('alexandra brantley');
  });

  it('matches what orderBy:displayName used to produce', () => {
    const names = ['Carol Adams', 'bob adams', 'Alice Zeigler'];
    const sorted = names.slice().sort((a, b) => by(a).localeCompare(by(b)));
    expect(sorted).toEqual(['Alice Zeigler', 'bob adams', 'Carol Adams']);
  });

  it('defaults to given-name order for an unknown field', () => {
    expect(rosterSort.key('Alexandra Brantley', 'nonsense')).toBe('alexandra brantley');
    expect(rosterSort.key('Alexandra Brantley')).toBe('alexandra brantley');
  });
});

describe('rosterSort.fields — what the picker offers', () => {
  it('offers surname and given name, surname first', () => {
    expect(rosterSort.fields.map((f) => f.value)).toEqual(['last', 'first']);
    expect(rosterSort.fields[0].label).toMatch(/last/i);
  });
});
