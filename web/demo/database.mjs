let database;
export const setDatabase = value => { database = value; database.exec('PRAGMA foreign_keys=ON'); };
export const getDb = () => database;
export const nowIso = () => new Date().toISOString();
export function all(sql, ...params) {
  const statement = database.prepare(sql);
  try {
    statement.bind(params.map(value => typeof value === 'bigint' ? Number(value) : value));
    const rows = []; while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally { statement.free(); }
}
export const get = (sql, ...params) => all(sql, ...params)[0];
export function run(sql, ...params) {
  database.run(sql, params.map(value => typeof value === 'bigint' ? Number(value) : value));
  return { changes: database.getRowsModified(), lastInsertRowid: get('SELECT last_insert_rowid() id').id };
}
export function transaction(fn) {
  database.exec('BEGIN');
  try { const result = fn(); database.exec('COMMIT'); return result; }
  catch (error) { database.exec('ROLLBACK'); throw error; }
}
