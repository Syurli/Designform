import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import type { ProjectSnapshot } from '../shared/model.ts';
import { resolveInside } from './files.ts';

/** 索引可从 Markdown 完全重建，绝不从这里覆盖正式正文。 */
export async function indexSnapshot(root: string, snapshot: ProjectSnapshot) {
  await mkdir(await resolveInside(root, '.cewen'), { recursive: true });
  const database = new DatabaseSync(await resolveInside(root, '.cewen/index.sqlite'));
  try {
    database.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY,path TEXT,title TEXT,hash TEXT,body TEXT); CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY,document_id TEXT,content TEXT); CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY,source TEXT,target TEXT,content TEXT);');
    if (database.prepare("SELECT value FROM metadata WHERE key='fingerprint'").get()?.value === snapshot.fingerprint) return;
    database.exec('BEGIN IMMEDIATE; DELETE FROM documents; DELETE FROM nodes; DELETE FROM relations;');
    const document = database.prepare('INSERT OR REPLACE INTO documents VALUES (?,?,?,?,?)');
    for (const item of snapshot.documents) document.run(item.id, item.path, item.title, item.hash, item.text);
    const node = database.prepare('INSERT OR REPLACE INTO nodes VALUES (?,?,?)');
    for (const item of snapshot.nodes) node.run(item.id, item.documentId, JSON.stringify(item));
    const relation = database.prepare('INSERT OR REPLACE INTO relations VALUES (?,?,?,?)');
    for (const item of snapshot.edges) relation.run(item.id, item.source, item.target, JSON.stringify(item));
    database.prepare("INSERT INTO metadata VALUES ('fingerprint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(snapshot.fingerprint);
    database.exec('COMMIT');
  } catch (error) { try { database.exec('ROLLBACK'); } catch { /* 尚未进入事务时无需撤回。 */ } throw error; }
  finally { database.close(); }
}
