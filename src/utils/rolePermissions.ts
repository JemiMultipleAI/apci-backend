import { Request, Response, NextFunction } from 'express';
import { createError } from '../middleware/errorHandler';
import { isSuperAdmin } from './companyAccess';

export type Role = 'super_admin' | 'admin' | 'manager' | 'viewer';

export interface RolePermissions {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canViewUsers: boolean;
  canManageCampaigns: boolean;
  canManageSurveys: boolean;
  canManageContacts: boolean;
  canManageAccounts: boolean;
  canViewAnalytics: boolean;
  canExportData: boolean;
  canExecuteCampaigns: boolean;
}

const rolePermissions: Record<Role, RolePermissions> = {
  super_admin: {
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    canViewUsers: true,
    canManageCampaigns: true,
    canManageSurveys: true,
    canManageContacts: true,
    canManageAccounts: true,
    canViewAnalytics: true,
    canExportData: true,
    canExecuteCampaigns: true,
  },
  admin: {
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    canViewUsers: true,
    canManageCampaigns: true,
    canManageSurveys: true,
    canManageContacts: true,
    canManageAccounts: false, // Only super_admin can manage companies
    canViewAnalytics: true,
    canExportData: true,
    canExecuteCampaigns: true,
  },
  manager: {
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    canViewUsers: true,
    canManageCampaigns: true,
    canManageSurveys: true,
    canManageContacts: true,
    canManageAccounts: false,
    canViewAnalytics: true,
    canExportData: true,
    canExecuteCampaigns: true,
  },
  viewer: {
    canCreate: false,
    canUpdate: false,
    canDelete: false,
    canViewUsers: false,
    canManageCampaigns: false,
    canManageSurveys: false,
    canManageContacts: false,
    canManageAccounts: false,
    canViewAnalytics: true,
    canExportData: false,
    canExecuteCampaigns: false,
  },
};

/**
 * Check if a role has a specific permission
 */
export function hasPermission(role: Role, permission: keyof RolePermissions): boolean {
  return rolePermissions[role]?.[permission] ?? false;
}

/**
 * Check if a role can perform write operations (create/update)
 */
export function canPerformWriteOperation(role: Role): boolean {
  return rolePermissions[role]?.canCreate && rolePermissions[role]?.canUpdate;
}

/**
 * Check if a role can perform delete operations
 */
export function canPerformDeleteOperation(role: Role): boolean {
  return rolePermissions[role]?.canDelete ?? false;
}

/**
 * Middleware to require a specific permission
 */
export function requirePermission(permission: keyof RolePermissions) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    // Super_admin bypasses all checks
    if (isSuperAdmin(req.user)) {
      return next();
    }

    const role = req.user.role as Role;
    if (!hasPermission(role, permission)) {
      return next(createError('Forbidden: Insufficient permissions', 403));
    }

    next();
  };
}
