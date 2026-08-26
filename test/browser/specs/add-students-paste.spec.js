const { test, expect } = require('@playwright/test');

// picup #167 / #166: instructors paste rows straight out of a spreadsheet, so
// they arrive TAB-delimited, and some rows carry no email at all (a header row,
// or a name whose address is in another sheet).
//
// The parser has unit tests. What they cannot cover is the wiring: that
// held-back lines STAY in the box instead of vanishing, that the message says
// how many were held back, and that the good rows actually reach the roster.
//
// Runs against the local GCP-shape stack, where global-setup signs in through
// the Firebase Auth emulator — the deployed servers have no such seam.
//
// Getting to this form is not obvious: the course page has a "Users" button that
// opens a modal, and the Add Students fieldset lives inside it behind an
// "Add Users" toggle.
const GOOD_1 = 'paste-ada@example.com';
const GOOD_2 = 'paste-blaise@example.com';
const PASTE = [
  ['Ada', 'Lovelace', GOOD_1].join('\t'),
  ['Blaise', 'Pascal', GOOD_2].join('\t'),
  ['Charlie', 'NoAddress', ''].join('\t'),
].join('\n');

test.describe('Add Students accepts a spreadsheet paste', () => {
  let courseId = null;

  test('invites the rows with emails and keeps the rest in the box', async ({ page, baseURL }) => {
    const api = async (method, path, body) => {
      const res = await page.request.fetch(new URL(path, baseURL).toString(), {
        method, headers: { 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status(), body: await res.json().catch(() => ({})) };
    };

    const created = await api('POST', '/api/courses',
      { name: 'paste ' + Math.random().toString(36).slice(2, 8), description: 'add-students paste test' });
    expect(created.status).toBe(200);
    const course = created.body.course || {};
    courseId = course.id;

    await page.goto(`/${course.ownerSlug}/courses/${course.slug}`);

    // Users button -> modal -> expand Add Users -> expand the Add Students fieldset.
    await page.locator('a', { hasText: /^\s*Users\s*$/ }).first().click();
    // The section renders collapsed (class="collapsed"); the Add Users toggle
    // adds show-add-users, so assert attachment here and visibility after.
    await expect(page.locator('#add-users-container')).toBeAttached();
    await page.locator('a', { hasText: 'Add Users' }).first().click();
    await page.locator('legend', { hasText: 'Add Students' }).first().click();

    const box = page.locator('textarea[ng-model="inviteForm.studentList"]');
    await expect(box).toBeVisible();
    await box.fill(PASTE);
    await page.locator('form[name="invite-users-form"] button[type="submit"]').click();

    // The result goes through notify.js, which renders a floating element rather
    // than filling #invitations-sent-messages — assert on the page text.
    await expect(page.getByText(/no email address/i).first())
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/1 line\(s\) had no email address/i).first()).toBeVisible();

    // The junk row stays so it can be fixed; the invited rows are cleared.
    const left = await box.inputValue();
    expect(left, 'the row without an email should remain').toMatch(/NoAddress/);
    expect(left, 'invited rows should be cleared').not.toContain(GOOD_1);
    expect(left).not.toContain(GOOD_2);

    // The two good rows become PENDING INVITATIONS (they are not users until the
    // student signs in with that address), so check there, not the roster.
    const invites = JSON.stringify((await api('GET', `/api/courses/${courseId}/invitations`)).body);
    expect(invites, 'Ada should have been invited').toContain(GOOD_1);
    expect(invites, 'Blaise should have been invited').toContain(GOOD_2);
    expect(invites, 'the email-less row must never be invited').not.toMatch(/NoAddress/);
  });

  test.afterEach(async ({ page, baseURL }) => {
    if (!courseId) return;
    await page.request.fetch(new URL(`/api/courses/${courseId}`, baseURL).toString(), { method: 'DELETE' }).catch(() => {});
    courseId = null;
  });
});
