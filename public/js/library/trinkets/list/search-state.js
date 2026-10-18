// Library list "See all" search state (#344): entering a search switches to all
// folders and relevance order; leaving restores what the user had. Plain
// functions so vitest can test them; also window.librarySearchState.
(function(root) {
  var DEFAULT_SORT = '-lastView.viewedOn';

  function enter(state, term) {
    if (!state.saved) {
      state.saved = { sortBy: state.sortBy, scope: state.filters.scope };
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
    state.saved = null;
    return state;
  }

  function persistableSort(sortBy, saved) {
    if (sortBy !== 'relevance') return sortBy;
    return (saved && saved.sortBy) || DEFAULT_SORT;
  }

  var api = { enter: enter, leave: leave, persistableSort: persistableSort };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.librarySearchState = api;
})(typeof window !== 'undefined' ? window : null);
