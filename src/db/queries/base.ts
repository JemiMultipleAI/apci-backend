import { query, queryOne } from '../connection';

/**
 * Base query utilities for reusable database operations
 */

export interface PaginationParams {
  page?: number;
  limit?: number;
  offset?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Build pagination SQL
 */
export const buildPagination = (params: PaginationParams): string => {
  const limit = params.limit || 10;
  const offset = params.offset !== undefined 
    ? params.offset 
    : ((params.page || 1) - 1) * limit;
  
  return `LIMIT ${limit} OFFSET ${offset}`;
};

/**
 * Execute a paginated query
 */
export const queryPaginated = async <T>(
  dataQuery: string,
  countQuery: string,
  params: any[] = [],
  pagination: PaginationParams = {}
): Promise<PaginatedResult<T>> => {
  const limit = pagination.limit || 10;
  const offset = pagination.offset !== undefined 
    ? pagination.offset 
    : ((pagination.page || 1) - 1) * limit;

  const [data, countResult] = await Promise.all([
    query<T>(`${dataQuery} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      limit,
      offset,
    ]),
    queryOne<{ count: string }>(countQuery, params),
  ]);

  const total = parseInt(countResult?.count || '0', 10);
  const page = pagination.page || 1;

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

/**
 * Build WHERE clause from filters
 */
export const buildWhereClause = (
  filters: Record<string, any>,
  paramIndex: number = 1
): { clause: string; params: any[] } => {
  const conditions: string[] = [];
  const params: any[] = [];
  let currentIndex = paramIndex;

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      if (Array.isArray(value)) {
        conditions.push(`${key} = ANY($${currentIndex})`);
        params.push(value);
      } else if (typeof value === 'string' && value.includes('%')) {
        conditions.push(`${key} ILIKE $${currentIndex}`);
        params.push(value);
      } else {
        conditions.push(`${key} = $${currentIndex}`);
        params.push(value);
      }
      currentIndex++;
    }
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
};

/**
 * Build ORDER BY clause
 */
export const buildOrderBy = (
  sortBy?: string,
  sortOrder: 'ASC' | 'DESC' = 'ASC'
): string => {
  if (!sortBy) return 'ORDER BY created_at DESC';
  return `ORDER BY ${sortBy} ${sortOrder}`;
};

