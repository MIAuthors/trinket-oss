# specs/ and plans/ — point-in-time design history

These are the working artifacts of feature development: a dated **spec**
(design doc) and usually a matching **implementation plan** per feature,
written *before* the code and frozen at merge time.

**They are snapshots, not living documentation.** A spec describes the design
as it stood on its date; review findings, merge conflicts, and later PRs
routinely changed details without circling back to edit the spec. When a spec
disagrees with the code, the code is right. For current behavior, read the
code and its tests; for current operational guidance, see
[`docs/README.md`](../README.md).

They stay in the repo because they answer the question code can't: *why* a
feature is shaped the way it is — the alternatives weighed, the constraints
that drove decisions, and what was deliberately deferred.
