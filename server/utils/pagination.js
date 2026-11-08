// Turns ?page=&limit= into safe numbers. Without this, ?limit=abc reaches
// .skip(NaN) and throws a 500, and ?limit=0 means "no limit" to MongoDB.
// The ceiling stays high because client-legacy requests limit=1000.
export function parsePagination(query, defaultLimit = 20, maxLimit = 1000) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}
