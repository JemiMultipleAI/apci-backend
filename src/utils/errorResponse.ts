/**
 * Standardized error response utility
 */

export interface ErrorResponse {
  success: false;
  error: {
    message: string;
    code: string;
    status: number;
    details?: any;
  };
}

export interface SuccessResponse<T = any> {
  success: true;
  data: T;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export const createErrorResponse = (
  message: string,
  code: string,
  status: number,
  details?: any
): ErrorResponse => ({
  success: false,
  error: {
    message,
    code,
    status,
    ...(details && { details }),
  },
});

export const createSuccessResponse = <T>(
  data: T,
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }
): SuccessResponse<T> => ({
  success: true,
  data,
  ...(pagination && { pagination }),
});

