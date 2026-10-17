/**
 * Documents, the data room, and the audit trail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import { DATA_ROOM_FOLDERS } from '../src/api/service.js';

function orgWithOwner() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const org = svc.createOrganisation(ctx, { name: 'Test Co' }).body.organisation;
  return { db, ctx, org, storage: fakeStorage() };
}

test('seeding creates all ten data-room folders — the call that was broken', () => {
  const { db, ctx, org } = orgWithOwner();
  const res = svc.seedDataRoom(ctx, org.id);

  assert.equal(res.status, 201);
  assert.equal(res.body.folders, 10);
  assert.equal(db.count('data_room_node', { org_id: org.id }), 10);

  const rows = db.find('data_room_node', { org_id: org.id })
    .sort((a, b) => a.sort_key.localeCompare(b.sort_key));
  assert.deepEqual(rows.map((r) => r.sort_key), DATA_ROOM_FOLDERS.map(([k]) => k));
  assert.equal(rows[0].name, 'Executive overview');
  assert.equal(rows[0].required, 1);
  assert.equal(rows[9].required, 0);
});

test('seeding is refused rather than duplicating folders', () => {
  const { db, ctx, org } = orgWithOwner();
  svc.seedDataRoom(ctx, org.id);
  expectRefusal(() => svc.seedDataRoom(ctx, org.id), 'already_seeded', 409);
  assert.equal(db.count('data_room_node', { org_id: org.id }), 10);
});

test('REGRESSION: an abandoned upload is not mistaken for a real document', () => {
  // The first implementation created the register row at ticket time in state
  // PENDING, so a client that never completed the PUT left a row that looked
  // like a document but pointed at an object which never arrived.
  const { ctx, org, storage } = orgWithOwner();

  const doc = svc.createUploadTicket(ctx, org.id,
    { filename: 'accounts 2025.pdf', size_bytes: 2048, kind: 'ACCOUNTS' }, storage).body.document;

  const row = ctx.db.get('document', doc.id);
  assert.equal(row.extract_state, 'AWAITING_UPLOAD', 'not a document until the bytes land');
  assert.equal(row.uploaded_at, null);

  // A download cannot be issued for something that was never uploaded.
  expectRefusal(() => svc.createDownloadUrl(ctx, org.id, doc.id, storage), 'upload_incomplete', 409);

  svc.confirmUpload(ctx, org.id, doc.id);
  const confirmed = ctx.db.get('document', doc.id);
  assert.equal(confirmed.extract_state, 'PENDING');
  assert.ok(confirmed.uploaded_at);
  assert.equal(svc.createDownloadUrl(ctx, org.id, doc.id, storage).status, 200);
});

test('the storage key is org-namespaced so documents cannot collide across orgs', () => {
  const { ctx, org, storage } = orgWithOwner();
  const doc = svc.createUploadTicket(ctx, org.id, { filename: 'a b/c.pdf', size_bytes: 10 }, storage).body.document;
  const row = ctx.db.get('document', doc.id);
  assert.ok(row.storage_key.startsWith(`orgs/${org.id}/documents/`));
  assert.equal(/[^A-Za-z0-9._/-]/.test(row.storage_key), false, 'the filename is sanitised into the key');
});

test('upload size is bounded', () => {
  const { ctx, org, storage } = orgWithOwner();
  expectRefusal(() => svc.createUploadTicket(ctx, org.id,
    { filename: 'big.bin', size_bytes: 200 * 1024 * 1024 }, storage), 'file_too_large', 400);
  expectRefusal(() => svc.createUploadTicket(ctx, org.id,
    { filename: 'empty.bin', size_bytes: 0 }, storage), 'invalid_size', 400);
});

test('bytes never pass through the server — only presigned URLs', () => {
  const { ctx, org, storage } = orgWithOwner();
  const doc = svc.createUploadTicket(ctx, org.id, { filename: 'a.pdf', size_bytes: 1 }, storage).body;
  assert.match(doc.upload.url, /^https:\/\//);
  assert.equal(doc.upload.method, 'PUT');
  assert.equal(doc.upload.expiresInSeconds, 600);
});

test('every download URL issue is audited — §3.7', () => {
  const { ctx, org, storage } = orgWithOwner();
  const doc = svc.createUploadTicket(ctx, org.id, { filename: 'a.pdf', size_bytes: 1 }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  svc.createDownloadUrl(ctx, org.id, doc.id, storage);

  const actions = svc.listAudit(ctx, org.id).body.entries.map((e) => e.action);
  assert.ok(actions.includes('document.download_url_issued'));
});

test('deleting a document removes the stored object as well as the row', () => {
  const { ctx, org, storage } = orgWithOwner();
  const doc = svc.createUploadTicket(ctx, org.id, { filename: 'a.pdf', size_bytes: 1 }, storage).body.document;
  const key = ctx.db.get('document', doc.id).storage_key;

  svc.deleteDocument(ctx, org.id, doc.id, storage);
  assert.equal(ctx.db.get('document', doc.id), null);
  assert.deepEqual(storage.removed, [key], 'the object was deleted, not orphaned');
});

test('every mutation writes an audit row', () => {
  const { ctx, org, storage } = orgWithOwner();
  svc.seedDataRoom(ctx, org.id);
  svc.createFact(ctx, org.id, { fact_key: 'a', label: 'A', value_text: 'x', source: 'USER_ENTERED' });
  const doc = svc.createUploadTicket(ctx, org.id, { filename: 'a.pdf', size_bytes: 1 }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  svc.createInvite(ctx, org.id, { email: 'new@example.com' });

  const actions = svc.listAudit(ctx, org.id).body.entries.map((e) => e.action);
  for (const expected of [
    'organisation.created', 'dataroom.seeded', 'fact.created',
    'document.upload_ticket_issued', 'document.upload_confirmed', 'invite.created',
  ]) assert.ok(actions.includes(expected), `missing audit row: ${expected}`);
});

test('the audit trail is readable by members and nobody else', () => {
  const { db, ctx, org } = orgWithOwner();
  const outsider = ctxFor(db, 'u-outsider');
  expectRefusal(() => svc.listAudit(outsider, org.id), 'not_found', 404);
  assert.ok(svc.listAudit(ctx, org.id).body.entries.length > 0);
});
