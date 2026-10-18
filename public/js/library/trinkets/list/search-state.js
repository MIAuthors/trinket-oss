// Library list "See all" search state (#344): entering a search switches to all
// folders and relevance order; leaving restores what the user had. Plain
// functions so vitest can test them; also window.librarySearchState.
(function(root) {
  var DEFAULT_SORT = '-lastView.viewedOn';
  // Narrowing filters a See-all search clears, so the list shows every match
  // the dropdown counted; leave() puts them back.
  var CLEARED = { name: '', updatedWithin: 'all', updatedAfter: '', updatedBefore: '' };

  function enter(state, term) {
    if (!state.saved) {
      state.saved = { sortBy: state.sortBy, scope: state.filters.scope, filters: {} };
      Object.keys(CLEARED).forEach(function(k) {
        state.saved.filters[k] = state.filters[k];
        state.filters[k] = CLEARED[k];
      });
    }
    state.filters.q     = term;
    state.filters.scope = 'all';
    state.sortBy        = 'relevance';
    return state;
  }

  function leave(state) {
    var saved = state.saved || {};
    delete state.filters.q;
    if (state.sortBy === 'relevance') {
      state.sortBy = saved.sortBy || DEFAULT_SORT;
    }
    state.filters.scope = saved.scope || 'root';
    Object.keys(CLEARED).forEach(function(k) {
      if (saved.filters && saved.filters[k] !== undefined) state.filters[k] = saved.filters[k];
    });
    state.saved = null;
    return state;
  }

  function persistableSort(sortBy, saved) {
    if (sortBy !== 'relevance') return sortBy;
    return (saved && saved.sortBy) || DEFAULT_SORT;
  }

  // A copy of the list's search state to keep in libraryState while the user
  // visits a trinket, so Back returns to the same search (chip included).
  function carry(filters, saved) {
    return {
      filters : JSON.parse(JSON.stringify(filters || {})),
      saved   : saved ? JSON.parse(JSON.stringify(saved)) : null
    };
  }

  var api = { enter: enter, leave: leave, persistableSort: persistableSort, carry: carry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.librarySearchState = api;
})(typeof window !== 'undefined' ? window : null);
