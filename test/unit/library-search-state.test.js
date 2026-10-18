'use strict';
const fs = require('fs');
const path = require('path');
const s = require('../../public/js/library/trinkets/list/search-state.js');

const fresh = () => ({ filters: { name: '', scope: 'root' }, sortBy: '-lastUpdated', saved: null });

describe('library search state', () => {
  it('enter switches to all folders, relevance, and the term', () => {
    const st = s.enter(fresh(), 'pend');
    expect(st.filters.q).toBe('pend');
    expect(st.filters.scope).toBe('all');
    expect(st.sortBy).toBe('relevance');
  });
  it('leave restores the previous sort and scope', () => {
    const st = s.leave(s.enter(fresh(), 'pend'));
    expect(st.filters.q).toBeUndefined();
    expect(st.filters.scope).toBe('root');
    expect(st.sortBy).toBe('-lastUpdated');
    expect(st.saved).toBeNull();
  });
  it('a second See all keeps the original saved sort', () => {
    const st = s.leave(s.enter(s.enter(fresh(), 'pend'), 'wave'));
    expect(st.sortBy).toBe('-lastUpdated');
  });
  it('a sort picked while searching survives leaving', () => {
    const st = s.enter(fresh(), 'pend');
    st.sortBy = 'name';
    expect(s.leave(st).sortBy).toBe('name');
  });
  it('never persists relevance', () => {
    expect(s.persistableSort('relevance', { sortBy: '-lastUpdated' })).toBe('-lastUpdated');
    expect(s.persistableSort('relevance', null)).toBe('-lastView.viewedOn');
    expect(s.persistableSort('name', null)).toBe('name');
  });
});

describe('library list wiring', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
  it('list.html shows a removable search chip', () => {
    const html = read('public/js/library/trinkets/list/list.html');
    expect(html).toContain('filters.q');
    expect(html).toContain('clearSearch()');
    expect(html).toContain('(name or instructions)');
  });
  it('only the library list passes see-all', () => {
    expect(read('public/js/library/trinkets/list/list.html')).toContain('see-all="onSeeAll"');
    for (const p of ['public/js/library/trinkets/list/folder.html',
                     'public/partials/assignment_editor.html',
                     'public/partials/material.html']) {
      expect(read(p)).not.toContain('see-all=');
    }
  });
  it('the controller sends q and never caches relevance', () => {
    const js = read('public/js/library/trinkets/list/list-controller.js');
    expect(js).toContain('params.q');
    expect(js).toContain('persistableSort');
  });
  it('search-state.js is loaded before list-controller.js', () => {
    const lines = read('config/default.yaml').split('\n');
    const i = lines.findIndex((l) => l.includes("'/js/library/trinkets/list/list-controller.js'"));
    expect(lines.slice(0, i).some((l) => l.includes("'/js/library/trinkets/list/search-state.js'"))).toBe(true);
  });
});
