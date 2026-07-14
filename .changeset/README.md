# Changesets

Every public package change must include a changeset describing the SemVer impact. The six
`@tf/*` packages form one fixed group and are versioned together, as required by ADR-007.

Run `pnpm changeset` to add an entry. Release publication is intentionally deferred until the
CNB Registry endpoint and release identity are approved.
