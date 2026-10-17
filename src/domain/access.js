/**
 * Access rules — org isolation and role gates.
 *
 * Every one of these is a pure function so it can be tested exhaustively
 * without a server, a session or a network. The bugs that shipped in the first
 * implementation were all in this category and all were untestable where they
 * lived.
 */

export const ROLES = Object.freeze(['OWNER', 'EDITOR', 'VIEWER']);

/** Rank for comparisons. Higher can do everything lower can. */
const RANK = Object.freeze({ VIEWER: 0, EDITOR: 1, OWNER: 2 });

export class AccessError extends Error {
  constructor(code, status, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * Resolve what a caller may do in an organisation.
 *
 * A caller with no membership gets 404, never 403. A 403 would confirm the
 * organisation exists, which leaks the existence of a company that may be
 * in a confidential process.
 *
 * @param {object|null} membership  the caller's membership row, or null
 * @param {'read'|'write'|'own'} need
 */
export function authorise(membership, need) {
  if (!membership) throw new AccessError('not_found', 404);

  const role = membership.role;
  if (!ROLES.includes(role)) throw new AccessError('not_found', 404);

  const required = { read: 'VIEWER', write: 'EDITOR', own: 'OWNER' }[need];
  if (required === undefined) throw new AccessError('unknown_permission', 500);

  if (RANK[role] < RANK[required]) {
    throw new AccessError('forbidden', 403, { required });
  }
  return role;
}

/**
 * Guard against removing or demoting the last OWNER.
 * An organisation with no owner cannot be administered by anyone.
 */
export function assertNotLastOwner(targetMembership, ownerCount, { toRole = null } = {}) {
  if (targetMembership.role !== 'OWNER') return;
  if (toRole === 'OWNER') return;          // no change in owner count
  if (ownerCount <= 1) {
    throw new AccessError(toRole ? 'cannot_demote_last_owner' : 'cannot_remove_last_owner', 409);
  }
}

/**
 * Cross-organisation guard for any row that carries an org_id.
 *
 * Call this on EVERY row fetched by id, even after the caller's membership has
 * been checked — membership proves they belong to org A, not that the row they
 * asked for belongs to org A.
 */
export function assertBelongsToOrg(row, orgId) {
  if (!row || row.org_id !== orgId) throw new AccessError('not_found', 404);
  return row;
}
