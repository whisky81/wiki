import Database from "better-sqlite3";

const db = new Database(process.env.DB_PATH ?? "./data/wiki.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL
  )
`);

export interface Page {
  id: number;
  title: string;
  content: string;
}

export function getPages(): Page[] {
  return db
    .prepare(`
      SELECT id, title, content
      FROM pages
      ORDER BY id DESC
    `)
    .all() as Page[];
}

export function createPage(
  title: string,
  content: string,
): void {
  db
    .prepare(`
      INSERT INTO pages (
        title,
        content
      )
      VALUES (?, ?)
    `)
    .run(title, content);
}

export function checkDatabase(): void {
  db
    .prepare("SELECT 1")
    .get();
}