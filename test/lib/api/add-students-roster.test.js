// Add Students must accept exactly what the client sends.
//
// Reported 2026-08-27 (Purdue, PHYS172H_Lab2_2026): an instructor typed
// "Reece, Sweet, sweetr@purdue.edu" — the documented format — clicked Add
// Students, and got "no students have been added". The server returned HTTP 200
// and created nothing.
//
// Cause: studentListParser emits {email, name, line}; the route schema allowed
// only email and name. Validation rejected every row, and because a validation
// failure here answers 200-with-a-flash rather than 4xx, the client's SUCCESS
// path ran, found empty enrolled/invitations, and reported "no students added".
// Since `line` is on every parsed row, this broke Add Students for everyone.
//
// The test posts the PARSER'S OWN OUTPUT rather than a hand-written object, so
// it keeps failing if the parser grows another field the schema doesn't allow.
const flow   = require('../../helpers/flow.cjs');
const parser = require('../../../public/js/courseEditor/studentListParser.js');

describe('POST /api/courses/{id}/invitations', () => {
  beforeEach(() => { flow.cookies = {}; });

  async function ownCourse(name) {
    await flow.switchUser('user');
    await flow.createCourse({ name: name + ' ' + Math.random().toString(36).slice(2, 7) });
    return flow.lastResponse.body.course;
  }

  it('accepts the parser output verbatim and creates the invitation', async () => {
    const course = await ownCourse('Roster');
    const parsed = parser.parse('Reece, Sweet, sweetr@example.edu');

    await flow.post('/api/courses/' + course.id + '/invitations', { students: parsed.students });

    const body = flow.lastResponse.body || {};
    expect(body.flash && body.flash.validation,
      'payload must not fail validation: ' + JSON.stringify(body.flash || {})).toBeFalsy();
    expect(body.success).toBe(true);
    expect(body.invitations.length, 'the student must actually be invited').toBe(1);
    expect(body.invitations[0].email).toBe('sweetr@example.edu');
    expect(body.invitations[0].name).toBe('Reece Sweet');
  });

  it('handles a spreadsheet paste (tabs) the same way', async () => {
    const course = await ownCourse('Roster Tabs');
    const parsed = parser.parse('Reece\tSweet\tsweetr2@example.edu');

    await flow.post('/api/courses/' + course.id + '/invitations', { students: parsed.students });

    expect(flow.lastResponse.body.flash && flow.lastResponse.body.flash.validation).toBeFalsy();
    expect(flow.lastResponse.body.invitations.length).toBe(1);
  });

  it('still rejects a row with no email at all', async () => {
    const course = await ownCourse('Roster Bad');
    await flow.post('/api/courses/' + course.id + '/invitations',
                    { students: [{ name: 'No Email', line: 'No Email' }] });
    expect(flow.lastResponse.body.success).toBeFalsy();
  });
});
