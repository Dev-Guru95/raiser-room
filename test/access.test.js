/**
 * Org isolation and role gates — the acceptance criteria that could not be
 * machine-verified on the previous platform, which is how four broken handlers
 * were reported as one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';

function twoOrgs() {
  const db = freshDb();
  const alice = ctxFor(db, 'u-alice');
  const bob = ctxFor(db, 'u-bob');
  const orgA = svc.createOrganisation(alice, { name: 'Alpha Ltd' }).body.organisation;
  const orgB = svc.createOrganisation(bob, { name: 'Bravo Inc' }).body.organisation;
  return { db, alice, bob, orgA, orgB };
}

test('a non-member gets 404, never 403 — existence is not confirmed', () => {
  const { alice, orgB } = twoOrgs();
  for (const call of [
    () => svc.listFacts(alice, orgB.id),
    () => svc.listMembers(alice, orgB.id),
    () => svc.listAudit(alice, orgB.id),
    () => svc.createFact(alice, orgB.id, { fact_key: 'x', label: 'X', value_text: 'y', source: 'USER_ENTERED' }),
    () => svc.updateOrganisation(alice, orgB.id, { name: 'Hijacked' }),
  ]) {
    const err = expectRefusal(call, 'not_found', 404);
    assert.notEqual(err.status, 403, 'a 403 would confirm the organisation exists');
  }
});

test('org A data never leaks into an org B query', () => {
  const { db, alice, bob, orgA, orgB } = twoOrgs();
  svc.createFact(alice, orgA.id, { fact_key: 'arr', label: 'ARR', value_numeric: 1, source: 'USER_ENTERED' });
  svc.createFact(bob, orgB.id, { fact_key: 'arr', label: 'ARR', value_numeric: 2, source: 'USER_ENTERED' });

  assert.equal(svc.listFacts(alice, orgA.id).body.facts.length, 1);
  assert.equal(svc.listFacts(alice, orgA.id).body.facts[0].value_numeric, 1);
  assert.equal(db.count('fact'), 2, 'both facts exist; only one is visible to Alice');
});

test('a row fetched by id is re-checked against the org — membership is not enough', () => {
  const { db, alice, bob, orgA, orgB } = twoOrgs();

  // Alice joins org B as an EDITOR, so she genuinely PASSES the role gate there.
  // That is what makes this a test of the cross-org check specifically: if the
  // role gate caught her instead, the org check would be untested.
  svc.createInvite(bob, orgB.id, { email: 'u-alice@example.com', role: 'EDITOR' });
  svc.listOrganisations(alice);                       // claims the invite

  const factInA = svc.createFact(alice, orgA.id,
    { fact_key: 'secret', label: 'Secret', value_text: 's', source: 'USER_ENTERED' }).body.fact;

  // Confirm she really can write in org B — the role gate is not what stops her.
  assert.equal(svc.createFact(alice, orgB.id,
    { fact_key: 'ok', label: 'OK', value_text: 'y', source: 'USER_ENTERED' }).status, 201);

  // Now the real assertion: an org A row addressed through org B is not found.
  expectRefusal(() => svc.supersedeFact(alice, orgB.id, factInA.id, { value_text: 'tampered' }),
    'not_found', 404);
  assert.equal(db.get('fact', factInA.id).value_text, 's', 'the fact was not modified');
  assert.equal(db.get('fact', factInA.id).superseded_by, null, 'nor superseded');
});

test('VIEWER may read but not write — enforced in the domain, not the UI', () => {
  const { db, alice, bob, orgB } = twoOrgs();
  svc.createInvite(bob, orgB.id, { email: 'u-alice@example.com', role: 'VIEWER' });
  svc.listOrganisations(alice);

  assert.ok(svc.listFacts(alice, orgB.id).body, 'viewer can read');
  assert.equal(svc.listFacts(alice, orgB.id).body.my_role, 'VIEWER');

  for (const call of [
    () => svc.createFact(alice, orgB.id, { fact_key: 'x', label: 'X', value_text: 'y', source: 'USER_ENTERED' }),
    () => svc.createInvite(alice, orgB.id, { email: 'c@example.com' }),
    () => svc.seedDataRoom(alice, orgB.id),
    () => svc.createUploadTicket(alice, orgB.id, { filename: 'a.pdf', size_bytes: 1 }, fakeStorage()),
  ]) expectRefusal(call, 'forbidden', 403);

  // EDITOR-level writes are refused for VIEWER but OWNER-only actions too.
  expectRefusal(() => svc.updateOrganisation(alice, orgB.id, { name: 'x' }), 'forbidden', 403);
  assert.equal(db.count('fact', { org_id: orgB.id }), 0);
});

test('EDITOR can write facts but cannot administer the organisation', () => {
  const { alice, bob, orgB } = twoOrgs();
  svc.createInvite(bob, orgB.id, { email: 'u-alice@example.com', role: 'EDITOR' });
  svc.listOrganisations(alice);

  assert.equal(svc.createFact(alice, orgB.id,
    { fact_key: 'arr', label: 'ARR', value_numeric: 10, source: 'USER_ENTERED' }).status, 201);

  expectRefusal(() => svc.updateOrganisation(alice, orgB.id, { name: 'x' }), 'forbidden', 403);
  const bobMembership = svc.listMembers(bob, orgB.id).body.members.find((m) => m.user_id === 'u-bob');
  expectRefusal(() => svc.changeMemberRole(alice, orgB.id, bobMembership.id, 'VIEWER'), 'forbidden', 403);
});

test('the last OWNER cannot be demoted or removed', () => {
  const { alice, orgA } = twoOrgs();
  const mine = svc.listMembers(alice, orgA.id).body.members[0];

  expectRefusal(() => svc.changeMemberRole(alice, orgA.id, mine.id, 'VIEWER'), 'cannot_demote_last_owner', 409);
  expectRefusal(() => svc.removeMember(alice, orgA.id, mine.id), 'cannot_remove_last_owner', 409);

  // With a second owner, both become permitted.
  svc.createInvite(alice, orgA.id, { email: 'u-bob@example.com', role: 'EDITOR' });
  const bobCtx = ctxFor(alice.db, 'u-bob');
  svc.listOrganisations(bobCtx);
  const bobM = svc.listMembers(alice, orgA.id).body.members.find((m) => m.user_id === 'u-bob');
  svc.changeMemberRole(alice, orgA.id, bobM.id, 'OWNER');

  assert.equal(svc.changeMemberRole(alice, orgA.id, mine.id, 'VIEWER').status, 200);
});

test('invite claim on first sign-in writes a membership — the handler that was missed', () => {
  const { db, alice, bob, orgB } = twoOrgs();
  svc.createInvite(bob, orgB.id, { email: 'u-alice@example.com', role: 'EDITOR' });

  assert.equal(db.count('membership', { org_id: orgB.id }), 1, 'only Bob so far');
  const orgs = svc.listOrganisations(alice).body.organisations;

  assert.equal(orgs.length, 2, 'Alice now sees her own org and the one she was invited to');
  assert.equal(db.count('membership', { org_id: orgB.id }), 2);
  assert.equal(orgs.find((o) => o.id === orgB.id).role, 'EDITOR');
});

test('claiming an invite twice does not duplicate the membership', () => {
  const { db, alice, bob, orgB } = twoOrgs();
  svc.createInvite(bob, orgB.id, { email: 'u-alice@example.com', role: 'VIEWER' });
  svc.listOrganisations(alice);
  svc.listOrganisations(alice);
  assert.equal(db.count('membership', { org_id: orgB.id, user_id: 'u-alice' }), 1);
});

test('an invite to a deleted organisation is ignored rather than throwing', () => {
  const { db, alice, bob, orgB } = twoOrgs();
  svc.createInvite(bob, orgB.id, { email: 'u-alice@example.com', role: 'VIEWER' });
  db.remove('organisation', orgB.id);
  assert.doesNotThrow(() => svc.listOrganisations(alice));
});

test('inviting an existing member is refused', () => {
  const { bob, orgB } = twoOrgs();
  expectRefusal(() => svc.createInvite(bob, orgB.id, { email: 'u-bob@example.com' }), 'already_a_member', 409);
});
