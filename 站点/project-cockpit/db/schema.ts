import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', { id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(), passwordHash: text('password_hash').notNull(), workspaceRole: text('workspace_role').notNull(), status: text('status').notNull().default('active'), version: integer('version').notNull().default(1), timeZone: text('time_zone').notNull().default('Asia/Shanghai') });
export const sessions = sqliteTable('sessions', { tokenHash: text('token_hash').primaryKey(), userId: text('user_id').notNull(), csrf: text('csrf').notNull(), expires: integer('expires').notNull() });
export const entities = sqliteTable('entities', { kind: text('kind').notNull(), id: text('id').primaryKey(), projectId: text('project_id'), version: integer('version').notNull(), deletedAt: text('deleted_at'), payload: text('payload').notNull() }, table => [index('entity_kind_project').on(table.kind, table.projectId)]);
export const invitations = sqliteTable('invitations', { id: text('id').primaryKey(), tokenHash: text('token_hash').notNull().unique(), email: text('email').notNull(), payload: text('payload').notNull(), expires: integer('expires').notNull(), used: integer('used').notNull().default(0), revoked: integer('revoked').notNull().default(0) });
export const audit = sqliteTable('audit', { id: text('id').primaryKey(), projectId: text('project_id'), actorId: text('actor_id').notNull(), action: text('action').notNull(), kind: text('kind'), objectId: text('object_id'), createdAt: text('created_at').notNull(), details: text('details').notNull() }, table => [index('audit_project_object').on(table.projectId, table.kind, table.objectId)]);
export const operations = sqliteTable('operations', { userId: text('user_id').notNull(), key: text('key').notNull(), requestHash: text('request_hash').notNull(), response: text('response').notNull() }, table => [primaryKey({ columns: [table.userId, table.key] })]);
export const loginAttempts = sqliteTable('login_attempts', { key: text('key').primaryKey(), failures: integer('failures').notNull(), resetAt: integer('reset_at').notNull() });
export const settings = sqliteTable('settings', { key: text('key').primaryKey(), value: text('value').notNull() });
export const files = sqliteTable('files', { id: text('id').primaryKey(), objectKey: text('object_key').notNull().unique(), size: integer('size').notNull(), sha256: text('sha256').notNull(), createdAt: text('created_at').notNull() });
// A tiny revision guard, not an application-state JSON row. The first mutation
// inserts this singleton outside migrations; later CAS updates abort the whole
// D1 batch by violating NOT NULL when its expected revision is stale.
export const cloudRevision = sqliteTable('cloud_revision', { id: integer('id').primaryKey(), revision: integer('revision').notNull() });
export const uploadCleanup = sqliteTable('upload_cleanup', { objectKey: text('object_key').primaryKey(), nextAttemptAt: integer('next_attempt_at').notNull(), attempts: integer('attempts').notNull().default(0), createdAt: text('created_at').notNull() });
