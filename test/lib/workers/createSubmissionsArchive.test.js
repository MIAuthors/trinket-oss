'use strict';
// Lazily required in beforeAll (not at module top): lib/workers/exports.js
// pulls in config/app.config -> routes -> controllers -> @hapi/hapi. The
// global test setup (test/helpers/vitest-setup.cjs) boots app.js and applies
// required config fixups (redis disabled + mocked, session secret, etc.)
// inside its own beforeAll. A top-level require here would run at test-file
// collection time, BEFORE that setup runs, and hits real Redis + a
// hapi/@hapi-validate version-skew crash that only happens on that early,
// unconfigured path.
const AdmZip = require('adm-zip');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Export isn't one of app.js's "global for backwards compatibility" model
// assignments (Course/Lesson/Material/User/Trinket are), so pull it in
// directly. Requiring the model file itself (not the worker) has no
// app-booting side effects.
const Export = require('../../../lib/models/export');

let createSubmissionsArchive;
beforeAll(() => {
  ({ createSubmissionsArchive } = require('../../../lib/workers/exports'));
});

describe('createSubmissionsArchive', () => {
  let owner, student1, student2, course, material, tempFile;

  beforeEach(async () => {
    owner = new User({ fullname: 'Prof Owner', username: 'profowner', email: 'profowner@example.com', password: 'password' });
    await owner.save();

    student1 = new User({ fullname: 'Jane Student', username: 'janestudent', email: 'jane@example.com', password: 'password' });
    await student1.save();

    student2 = new User({ fullname: 'Bob Student', username: 'bobstudent', email: 'bob@example.com', password: 'password' });
    await student2.save();

    const promptTrinket = new Trinket({
      name: 'Assignment Prompt', lang: 'python3', code: 'print("prompt")',
      _owner: owner, _creator: owner
    });
    await promptTrinket.save();

    material = new Material({
      name: 'HW1', type: 'assignment', _owner: owner,
      trinket: {
        trinketId: promptTrinket.id,
        name: promptTrinket.name,
        shortCode: promptTrinket.shortCode,
        lang: promptTrinket.lang
      }
    });
    await material.save();

    const lesson = new Lesson({ name: 'Lesson 1', _owner: owner, materials: [material.id] });
    await lesson.save();

    course = new Course({ name: 'Physics 101', _owner: owner, ownerSlug: owner.username, lessons: [lesson.id] });
    await course.save();
    await course.addUser(owner, ['course-owner']);
    await course.addUser(student1, ['course-student']);
    await course.addUser(student2, ['course-student']);

    const sub1 = new Trinket({
      name: 'Jane Submission', lang: 'python3', code: 'print("jane")',
      _owner: student1, _creator: student1,
      courseId: course.id, materialId: material.id,
      submissionState: 'submitted', submittedOn: new Date(),
      comments: [{ commentType: 'feedback', commentText: 'nice', commented: new Date(), displayName: 'Prof Owner' }]
    });
    await sub1.save();

    const sub2 = new Trinket({
      name: 'Bob Submission', lang: 'python3', code: 'print("bob")',
      _owner: student2, _creator: student2,
      courseId: course.id, materialId: material.id,
      submissionState: 'submitted', submittedOn: new Date()
    });
    await sub2.save();

    tempFile = path.join(os.tmpdir(), 'test-submissions-archive-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.zip');
  });

  afterEach(() => {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  });

  it('builds a by-assignment/student archive with manifest, prompt, code, feedback, and metadata', async () => {
    const exportRecord = new Export({ type: 'course-submissions', courseId: course.id, _owner: owner });

    const result = await createSubmissionsArchive(exportRecord, tempFile);

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.assignmentCount).toBe(1);

    const zip = new AdmZip(tempFile);
    const names = zip.getEntries().map((e) => e.entryName);

    expect(names).toContain('manifest.json');
    expect(names.some((n) => n.startsWith('HW1/_assignment/'))).toBe(true);
    expect(names).toContain('HW1/janestudent/main.py');
    expect(names).toContain('HW1/janestudent/feedback.md');
    expect(names).toContain('HW1/janestudent/submission.json');
    expect(names).toContain('HW1/bobstudent/main.py');
    expect(names).toContain('HW1/bobstudent/feedback.md');
    expect(names).toContain('HW1/bobstudent/submission.json');

    const janeFeedback = zip.readAsText('HW1/janestudent/feedback.md');
    expect(janeFeedback).toContain('nice');

    const bobFeedback = zip.readAsText('HW1/bobstudent/feedback.md');
    expect(bobFeedback).toMatch(/No feedback/i);

    const janeMeta = JSON.parse(zip.readAsText('HW1/janestudent/submission.json'));
    expect(janeMeta.state).toBe('submitted');
    expect(janeMeta.hasFeedback).toBe(true);
    expect(janeMeta).not.toHaveProperty('score');

    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    expect(manifest.scope).toBe('course-submissions');
    expect(manifest.course.name).toBe('Physics 101');
    expect(manifest.assignments).toHaveLength(1);
    expect(manifest.assignments[0].slug).toBe('HW1');
    expect(manifest.assignments[0].submissionCount).toBe(2);
    expect(manifest.assignments[0].students.map((s) => s.slug).sort()).toEqual(['bobstudent', 'janestudent']);
  });

  it('restricts to a single assignment for assignment-submissions scope', async () => {
    const exportRecord = new Export({
      type: 'assignment-submissions', courseId: course.id, materialId: material.id, _owner: owner
    });

    const result = await createSubmissionsArchive(exportRecord, tempFile);

    expect(result.assignmentCount).toBe(1);

    const zip = new AdmZip(tempFile);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names.every((n) => n === 'manifest.json' || n.startsWith('HW1/'))).toBe(true);
  });

  it('records an empty assignment with submissionCount 0 and skips a missing prompt trinket', async () => {
    // Remove all submissions for this material, and break the prompt reference
    // by pointing it at a trinket id that doesn't exist.
    const TrinketModel = Trinket.model;
    await TrinketModel.deleteMany({ materialId: material.id });
    material.trinket.trinketId = '507f191e810c19729de860ea';
    await material.save();

    const exportRecord = new Export({ type: 'course-submissions', courseId: course.id, _owner: owner });
    const result = await createSubmissionsArchive(exportRecord, tempFile);

    expect(result.processed).toBe(0);
    expect(result.assignmentCount).toBe(1);

    const zip = new AdmZip(tempFile);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toEqual(['manifest.json']);

    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    expect(manifest.assignments[0].submissionCount).toBe(0);
    expect(manifest.assignments[0].students).toEqual([]);
  });
});
