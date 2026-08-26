> **STATUS (2026-08-15):** archived draft. The bug is FIXED in this repo's main
> (movematerial via the hapi-20 port fixes; shortCode tracked as our #151 —
> latent, zero call sites). Still live in trinketapp/main; file upstream only
> if/when we re-engage there (our PR #25 there was closed unmerged).

# `internals.findById` misreads its fallback arg as a `next` callback under Hapi 20 → moving/reordering materials returns 500

> Draft issue for **trinketapp/trinket-oss**. Confirmed present in `trinketapp/main` (`lib/util/helpers.js`, `config/api_routes.js`). Tweak before submitting.

## Summary

The `parent` server method (`internals.findById(Lesson)`) is invoked from a **string pre-handler** `'parent(payload.parent, pre.lesson)'`. Under Hapi 4 the framework appended a `next` callback as a trailing arg; under Hapi 20 the migration shim invokes the method with **only the resolved args (no `next`)**. `findById` then runs an arity-2 heuristic that mistakes the fallback `lesson` document for the `next` callback and calls it — `"next is not a function"` → **500**. This breaks **reordering and moving materials** between lessons.

## Root cause

Route pre (`config/api_routes.js`, the material "move" route, line ~241):
```js
'parent(payload.parent,pre.lesson)'
```
Server method (`lib/util/helpers.js` ~287): `server.method('parent', internals.findById(Lesson))`.

The shim invokes string-pre server methods with exactly the resolved args, no trailing `next` (`lib/util/routeParser.js` ~227):
```js
return serverMethod.apply(null, args);   // args = [payload.parent, pre.lesson] — 2 args, no next
```

`internals.findById` (`lib/util/helpers.js` ~31–59):
```js
return function(id, optional, next) {
  if (typeof optional === 'function') { next = optional; optional = false; }
  else if (arguments.length === 2 && typeof optional !== 'boolean') {  // HARMFUL heuristic
    next = optional; optional = false;                                  // next := the lesson DOC
  }
  if (!id) {
    var err = optional ? optional : Boom.badRequest();
    return next ? next(err) : Promise.reject(err);                      // next(...) → DOC is not a function
  }
  return model.findById(id).then(function(doc) {
    var result = (doc && !doc.deletedAt) ? doc : Boom.notFound();
    return next ? next(result) : result;                               // next(...) → DOC is not a function
  })...
```

Intended legacy semantics: `parent(id, fallbackLesson)` + a Hapi-4-appended `next` — "find parent by id; if no id, fall back to the lesson doc." With no `next` appended under Hapi 20, the arity-2 heuristic reassigns `next = pre.lesson` (a Mongoose doc), then:
- **Same-lesson reorder** (no `payload.parent`): `!id` → `next(err)` → calling a doc → crash.
- **Cross-lesson transfer** (`payload.parent` present): `next(result)` → same crash.

Both → 500. (Verified over a real HTTP listener.)

## Impact / reproduction

PUT the material "move" route (reorder within a lesson, or move to another lesson). Expected: material reordered/moved. Actual: **500**. The reorder/move-material feature is broken.

## Proposed fix (`lib/util/helpers.js`, `internals.findById`)

Drop the arity-2 heuristic (a genuine callback is already caught by `typeof optional === 'function'`), and in promise mode **resolve** with the fallback instead of rejecting:

```js
internals.findById = function(model, fallback) {
  return function(id, optional, next) {
    if (typeof optional === 'function') { next = optional; optional = false; }
    // (removed the arguments.length===2 heuristic that misread a fallback doc as `next`)

    if (!id) {
      var hasFallback   = optional && typeof optional !== 'boolean'; // e.g. pre.lesson
      var errOrFallback = hasFallback ? optional : Boom.badRequest();
      if (next) return next(errOrFallback);
      return hasFallback ? Promise.resolve(errOrFallback) : Promise.reject(errOrFallback);
    }

    return model.findById(id)
      .then(function(doc) {
        var result = (doc && !doc.deletedAt) ? doc : Boom.notFound();
        return next ? next(result) : result;
      })
      .catch(function(err) { if (next) return next(err); throw err; });
  };
};
```
- Same-lesson reorder: `findById(undefined, lessonDoc)` → `Promise.resolve(lessonDoc)` → `pre.parent = lessonDoc` → the route's `parent = request.pre.parent || lesson` works.
- Cross-lesson: `findById(realId, lessonDoc)` → resolves the found parent doc.

## Blast radius

`findById` backs ~9 server methods; every other call site passes a **single** arg (`course(...)`, `lesson(...)`, `material(...)`, `file(...)`, `user(...)`, …) and never hit the removed heuristic. `parent` is the only 2-arg fallback caller. Low risk. (Other multi-arg string pre-handlers — `populate`, `hasLesson`, `hasMaterial` — map to different methods, not `findById`; worth a sanity check but out of scope.)
