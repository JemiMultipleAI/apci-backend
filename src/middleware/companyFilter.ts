import { Request, Response, NextFunction } from 'express';
import { getEffectiveCompanyId } from '../utils/companyAccess';
import { createError } from './errorHandler';
import { z } from 'zod';

/**
 * Company filter configuration
 */
export interface CompanyFilter {
  clause: string;
  value: string | null;
  paramIndex: number;
}

/**
 * Middleware to apply company filtering to requests
 * Adds req.companyFilter with the appropriate WHERE clause
 */
export const applyCompanyFilter = (tableAlias: string = '') => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return next(createError('Unauthorized', 401));
      }

      const { company_id } = req.query;
      
      // Validate UUID format if provided
      if (company_id && typeof company_id === 'string') {
        const uuidSchema = z.string().uuid();
        if (!uuidSchema.safeParse(company_id).success) {
          return next(createError('Invalid company ID format', 400));
        }
      }

      const effectiveCompanyId = await getEffectiveCompanyId(
        req.user,
        company_id as string | undefined,
        req.userCompanyId
      );

      // Determine which column to use based on table alias
      // Default to tenant_id for multi-tenant isolation
      const column = tableAlias ? `${tableAlias}.tenant_id` : 'tenant_id';
      
      req.companyFilter = effectiveCompanyId !== null
        ? {
            clause: `AND ${column} = $1`,
            value: effectiveCompanyId,
            paramIndex: 1,
          }
        : {
            clause: '',
            value: null,
            paramIndex: 0,
          };

      next();
    } catch (error: any) {
      next(createError(error.message || 'Failed to apply company filter', 500));
    }
  };
};

// Extend Express Request to include company filter
declare global {
  namespace Express {
    interface Request {
      companyFilter?: CompanyFilter;
    }
  }
}

