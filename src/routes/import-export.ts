import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { getUserCompanyId, isSuperAdmin } from '../utils/companyAccess';
import { logger } from '../utils/logger';

// Extend Express Request to include multer file
interface MulterRequest extends Omit<Request, 'file'> {
  file?: {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  };
}

const router = Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (_req: Request, file: any, cb: any) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  },
});

// POST /api/import-export/contacts/import - Import contacts from CSV
router.post(
  '/contacts/import',
  authenticate,
  enrichUser,
  upload.single('file'),
  async (req: MulterRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw createError('No file uploaded', 400);
      }

      if (!req.user) {
        throw createError('Unauthorized', 401);
      }

      // Get user's company ID for auto-assignment (unless super_admin)
      let accountId: string | null = null;
      if (!isSuperAdmin(req.user)) {
        accountId = await getUserCompanyId(req.user);
      }

      // Extract group name from filename (remove .csv extension)
      // Allow override via form data
      const filename = req.file.originalname.replace(/\.csv$/i, '');
      const contactGroupName = (req.body.contact_group_name as string)?.trim() || filename;

      const csvContent = req.file.buffer.toString('utf-8');
      
      // Parse CSV using csv-parse
      let records: Record<string, string>[];
      try {
        records = parse(csvContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_quotes: true,
          relax_column_count: true,
        }) as Record<string, string>[];
      } catch (parseError: any) {
        throw createError(`CSV parsing error: ${parseError.message}`, 400);
      }

      if (records.length === 0) {
        throw createError('CSV file is empty', 400);
      }

      // Validate required columns
      const requiredColumns = ['first_name', 'last_name'];
      const csvColumns = Object.keys(records[0]);
      const missingColumns = requiredColumns.filter(col => !csvColumns.includes(col));

      if (missingColumns.length > 0) {
        throw createError(`Missing required columns: ${missingColumns.join(', ')}`, 400);
      }

      // Process records
      const results = {
        total: records.length,
        success: 0,
        failed: 0,
        errors: [] as string[],
        contactIds: [] as string[], // Track successfully imported contact IDs
      };

      for (const record of records) {
        try {
          // Use account_id from CSV if provided, otherwise use user's company
          const contactAccountId = record.account_id || accountId;
          
          const contactResult = await queryOne<{ id: string }>(
            `INSERT INTO contacts (
              account_id, first_name, last_name, email, mobile,
              job_title, department, lifecycle_stage, notes, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id`,
            [
              contactAccountId || null,
              record.first_name || '',
              record.last_name || '',
              record.email || null,
              record.mobile || null,
              record.job_title || null,
              record.department || null,
              record.lifecycle_stage || 'lead',
              record.notes || null,
              req.user?.userId || null,
            ]
          );
          
          if (contactResult?.id) {
            results.success++;
            results.contactIds.push(contactResult.id);
          }
        } catch (error: any) {
          results.failed++;
          results.errors.push(`Row ${results.total - records.length + 1}: ${error.message}`);
        }
      }

      // Handle contact group assignment (using filename as default)
      let groupId: string | null = null;
      if (contactGroupName && results.contactIds.length > 0) {
        try {
          // Check if group exists (within company scope)
          let whereClause = 'WHERE name = $1';
          const groupParams: any[] = [contactGroupName];
          
          if (!isSuperAdmin(req.user!)) {
            if (accountId) {
              whereClause += ' AND account_id = $2';
              groupParams.push(accountId);
            } else {
              whereClause += ' AND account_id IS NULL';
            }
          }

          let existingGroup = await queryOne<{ id: string }>(
            `SELECT id FROM contact_groups ${whereClause} LIMIT 1`,
            groupParams
          );

          if (existingGroup) {
            // Use existing group
            groupId = existingGroup.id;
          } else {
            // Create new group
            const newGroup = await queryOne<{ id: string }>(
              `INSERT INTO contact_groups (name, description, account_id, created_by)
               VALUES ($1, $2, $3, $4)
               RETURNING id`,
              [
                contactGroupName,
                `Auto-created from CSV import on ${new Date().toISOString()}`,
                accountId || null,
                req.user?.userId || null,
              ]
            );
            groupId = newGroup?.id || null;
          }

          // Add all imported contacts to the group
          if (groupId && results.contactIds.length > 0) {
            const placeholders = results.contactIds.map((_, index) => 
              `($1, $${index + 2}, CURRENT_TIMESTAMP, $${results.contactIds.length + 2})`
            ).join(', ');
            const values: any[] = [groupId, ...results.contactIds, req.user?.userId || null];

            await query(
              `INSERT INTO contact_group_members (contact_group_id, contact_id, added_at, added_by)
               VALUES ${placeholders}
               ON CONFLICT (contact_id, contact_group_id) DO NOTHING`,
              values
            );
          }
        } catch (error: any) {
          // Log error but don't fail the import
          logger.warn('Failed to assign contacts to group', {
            groupName: contactGroupName,
            error: error.message,
          });
          results.errors.push(`Warning: Failed to assign contacts to group "${contactGroupName}": ${error.message}`);
        }
      }

      res.json({
        success: true,
        data: {
          ...results,
          groupId: groupId || undefined,
          groupName: contactGroupName || undefined,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/import-export/contacts/export - Export contacts to CSV
router.get('/contacts/export', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      throw createError('Unauthorized', 401);
    }

    const { lifecycle_stage, limit } = req.query;
    
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;
    
    // Apply company filter for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = await getUserCompanyId(req.user);
      if (userCompanyId) {
        whereClause += ` AND account_id = $${paramIndex}`;
        params.push(userCompanyId);
        paramIndex++;
      }
    }
    
    if (lifecycle_stage) {
      whereClause += ` AND lifecycle_stage = $${paramIndex}`;
      params.push(lifecycle_stage);
      paramIndex++;
    }

    const limitClause = limit ? `LIMIT $${paramIndex}` : '';
    if (limit) {
      params.push(parseInt(limit as string));
      paramIndex++;
    }

    const contacts = await query(
      `SELECT 
        first_name, last_name, email, mobile,
        job_title, department, lifecycle_stage, notes,
        created_at, updated_at
      FROM contacts ${whereClause} ORDER BY created_at DESC ${limitClause}`,
      params
    );

    // Generate CSV using csv-stringify
    const columns = [
      'first_name', 'last_name', 'email', 'mobile',
      'job_title', 'department', 'lifecycle_stage', 'notes',
      'created_at', 'updated_at'
    ];
    
    const csv = stringify(contacts, {
      header: true,
      columns: columns,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts-export.csv');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

// POST /api/import-export/accounts/import - Import accounts from CSV
router.post(
  '/accounts/import',
  authenticate,
  upload.single('file'),
  async (req: MulterRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw createError('No file uploaded', 400);
      }

      const csvContent = req.file.buffer.toString('utf-8');
      
      // Parse CSV using csv-parse
      let records: Record<string, string>[];
      try {
        records = parse(csvContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_quotes: true,
          relax_column_count: true,
        }) as Record<string, string>[];
      } catch (parseError: any) {
        throw createError(`CSV parsing error: ${parseError.message}`, 400);
      }

      if (records.length === 0) {
        throw createError('CSV file is empty', 400);
      }

      if (!records[0].name) {
        throw createError('Missing required column: name', 400);
      }

      const results = {
        total: records.length,
        success: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (const record of records) {
        try {
          await query(
            `INSERT INTO accounts (
              name, website, industry, phone, email,
              address, city, state, country, postal_code, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              record.name || '',
              record.website || null,
              record.industry || null,
              record.phone || null,
              record.email || null,
              record.address || null,
              record.city || null,
              record.state || null,
              record.country || null,
              record.postal_code || null,
              req.user?.userId || null,
            ]
          );
          results.success++;
        } catch (error: any) {
          results.failed++;
          results.errors.push(`Row ${results.total - records.length + 1}: ${error.message}`);
        }
      }

      res.json({
        success: true,
        data: results,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/import-export/accounts/export - Export accounts to CSV
router.get('/accounts/export', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await query(
      `SELECT 
        name, website, industry, phone, email,
        address, city, state, country, postal_code,
        created_at, updated_at
      FROM accounts ORDER BY created_at DESC`
    );

    // Generate CSV using csv-stringify
    const columns = [
      'name', 'website', 'industry', 'phone', 'email',
      'address', 'city', 'state', 'country', 'postal_code',
      'created_at', 'updated_at'
    ];
    
    const csv = stringify(accounts, {
      header: true,
      columns: columns,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=accounts-export.csv');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

// GET /api/import-export/deals/export - Export deals to CSV
router.get('/deals/export', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deals = await query(
      `SELECT 
        name, stage, value, probability, currency,
        expected_close_date, actual_close_date, description,
        created_at, updated_at
      FROM deals ORDER BY created_at DESC`
    );

    // Generate CSV using csv-stringify
    const columns = [
      'name', 'stage', 'value', 'probability', 'currency',
      'expected_close_date', 'actual_close_date', 'description',
      'created_at', 'updated_at'
    ];
    
    const csv = stringify(deals, {
      header: true,
      columns: columns,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=deals-export.csv');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

export default router;
