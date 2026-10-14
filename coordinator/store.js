// coordinator/store.js: picks where tasks live.
//   DATABASE_URL set  -> PostgreSQL  (store-pg.js)
//   not set           -> in memory   (store-memory.js)
// Both export the same functions: add, get, claimNext, complete (all async).
module.exports = process.env.DATABASE_URL
  ? require('./store-pg')
  : require('./store-memory');