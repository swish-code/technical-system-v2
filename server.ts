import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import { createServer as createViteServer } from "vite";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import * as XLSX from "xlsx";
import * as fs from "fs";
import webpush from "web-push";
import multer from "multer";

const { Pool } = pg;

console.log("SERVER.TS STARTING INITIALIZATION...");
console.log("DATABASE_URL check:", process.env.DATABASE_URL ? "SET" : "NOT SET");
console.log("Current directory:", process.cwd());

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const connectionString = process.env.DATABASE_URL;
if (connectionString) {
  try {
    const url = new URL(connectionString);
    const isInternal = url.hostname.includes('railway.internal');
    console.log(`[DB] Connection string detected.`);
    console.log(`[DB] Host: ${url.hostname.replace(/./g, (c, i) => i < 3 ? c : '*')}`);
    if (isInternal) {
      console.error("[DB] WARNING: Still using INTERNAL Railway URL. DNS resolution will fail.");
    } else {
      console.log("[DB] SUCCESS: Using PUBLIC connection string. Connection should work.");
    }
  } catch (e) {
    console.log(`[DB] Invalid connection string format.`);
  }
}

const pool = new Pool({
  connectionString: connectionString,
  ssl: connectionString?.includes('railway') ? { rejectUnauthorized: false } : false
});

if (process.env.DATABASE_URL?.includes('postgres.railway.internal')) {
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.error("CRITICAL CONFIGURATION ERROR: Railway Internal URL Detected");
  console.error("The hostname 'postgres.railway.internal' only works inside Railway.");
  console.error("You MUST use the 'Public Connection String' from your Railway dashboard.");
  console.error("It should look like: postgresql://postgres:PASSWORD@proxy.railway.app:PORT/railway");
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Required environment variable ${name} is not set. Refusing to start.`);
  }
  return v;
}

const JWT_SECRET = requireEnv("JWT_SECRET");

const publicVapidKey = requireEnv("VAPID_PUBLIC_KEY");
const privateVapidKey = requireEnv("VAPID_PRIVATE_KEY");

webpush.setVapidDetails(
  "mailto:example@yourdomain.com",
  publicVapidKey,
  privateVapidKey
);

// Compatibility wrapper for PostgreSQL (Async)
const db = {
  query: (text: string, params?: any[]) => pool.query(text, params),
  exec: (sql: string) => pool.query(sql),
  get: async (text: string, params?: any[]) => {
    const res = await pool.query(text, params);
    return res.rows[0];
  },
  all: async (text: string, params?: any[]) => {
    const res = await pool.query(text, params);
    return res.rows;
  },
  // Transaction helper
  transaction: async (fn: (client: any) => Promise<any>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
};

const getBranchRestriction = async (user: any) => {
  if (user.role_name === 'Area Manager') {
    const userBranchesResult = await db.query(`
      SELECT branch_id FROM user_branches WHERE user_id = $1
    `, [user.id]);
    return userBranchesResult.rows.map((b: any) => b.branch_id);
  }
  if (user.branch_id) {
    return [user.branch_id];
  }
  return null;
};

const getBrandRestriction = async (user: any) => {
  if (user.role_name === 'Area Manager' && user.brand_id) {
    const brandResult = await db.query("SELECT name FROM brands WHERE id = $1", [user.brand_id]);
    const brand = brandResult.rows[0];
    if (brand) {
      return { type: 'include', brands: [brand.name] };
    }
  }

  // Check junction table for multiple brands (for Marketing Team, Call Center or Restaurants)
  const userBrandsResult = await db.query(`
    SELECT b.name 
    FROM user_brands ub 
    JOIN brands b ON ub.brand_id = b.id 
    WHERE ub.user_id = $1
  `, [user.id]);
  const userBrands = userBrandsResult.rows;

  if (userBrands.length > 0) {
    return { type: 'include', brands: userBrands.map(b => b.name) };
  }

  if (user.brand_id) {
    const brandResult = await db.query("SELECT name FROM brands WHERE id = $1", [user.brand_id]);
    const brand = brandResult.rows[0];
    if (brand) {
      return { type: 'include', brands: [brand.name] };
    }
  }
  return null;
};

function getCurrentKuwaitTime() {
  return new Date().toISOString();
}

// Audit Log Function
async function logAction(userId: number, action: string, targetTable: string, targetId: number | null, oldValue: any, newValue: any) {
  try {
    await db.query(
      "INSERT INTO audit_logs (user_id, action, target_table, target_id, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        userId,
        action,
        targetTable,
        targetId,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
      ]
    );
  } catch (error) {
    console.error("Failed to log action:", error);
  }
}

// Best-effort: keep the hide_history (BI/reporting) table in sync when an admin
// edits a hide/unhide session on the Operation History page. There is no direct
// link between audit_logs and hide_history, so we update the single hide_history
// row that is closest in time for the same product/branch/action. Guarded so a
// failure here never breaks the main audit_logs edit.
async function syncHideHistory(action: string, productId: any, branchId: any, oldTs: any, newTs: string | null, reason: any, responsibleParty?: any) {
  if (!productId || !newTs) return;
  try {
    const params: any[] = [newTs, productId, action];
    let branchClause = '';
    if (branchId !== undefined && branchId !== null) {
      params.push(branchId);
      branchClause = ` AND branch_id = $${params.length}`;
    }
    params.push(reason ?? null);
    const reasonIdx = params.length;
    params.push(responsibleParty ?? null);
    const respIdx = params.length;
    params.push(oldTs);
    const oldTsIdx = params.length;
    await db.query(`
      UPDATE hide_history
      SET timestamp = $1,
          reason = COALESCE($${reasonIdx}, reason),
          responsible_party = COALESCE($${respIdx}, responsible_party)
      WHERE id = (
        SELECT id FROM hide_history
        WHERE product_id = $2 AND action = $3${branchClause}
        ORDER BY ABS(EXTRACT(EPOCH FROM (timestamp - $${oldTsIdx}::timestamptz)))
        LIMIT 1
      )
    `, params);
  } catch (e: any) {
    console.error("hide_history sync skipped:", e?.message);
  }
}

// Multer setup for file uploads. v2 hardening (S-6):
// - MIME whitelist (images + PDF only) so an attacker can't upload .html/.svg
//   that becomes same-origin stored XSS when served from /uploads.
// - Allowed-extension whitelist as belt-and-suspenders (mimetype is client-
//   supplied; double-check against the extension).
// - Filename sanitization: never trust originalname; strip path separators
//   and use only the safe extension we recognized.
// The /uploads static route is also wrapped with authenticate further down,
// so browsers must hold a valid session cookie to fetch attachments.
// UPLOAD_DIR lets us point at a persistent Railway Volume (e.g. /data/uploads)
// so attachments survive redeploys. Falls back to the local folder in dev.
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const ALLOWED_UPLOAD_MIMES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    // Use only the canonical extension we recognized, never the original filename.
    const ext = ALLOWED_UPLOAD_MIMES[file.mimetype] || ".bin";
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB — was 50MB; nothing here needs that much.
    files: 6,
  },
  fileFilter: (_req, file, cb) => {
    if (!(file.mimetype in ALLOWED_UPLOAD_MIMES)) {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

// Seed Data Function
const ALLOWED_BRANDS = ["SHAKIR", "YELLO PIZZA", "BBT", "PATTIE", "CHILI", "SLICE", "JUST C", "MISHMASH", "TABLE", "FM"];

async function seedData() {
  console.log("Reconciling brand variations (non-destructive)...");

  // Preserve brands that aren't in ALLOWED_BRANDS; merge known variations into their canonical name.
  // The previous version of this code deleted all related products/branches/users for any brand
  // not in ALLOWED_BRANDS, which is a data-loss footgun on every restart. See TECHNICAL_SYSTEM_ANALYSIS.md S-8.
  const existingBrands = await db.all("SELECT id, name FROM brands");
  for (const brand of existingBrands) {
    const brandUpper = brand.name.toUpperCase();
    const targetBrandName = ALLOWED_BRANDS.find(b =>
      b.toUpperCase() === brandUpper ||
      (b.toUpperCase() === 'YELLO PIZZA' && ['YELO', 'YELO PIZZA', 'YELLOW PIZZA'].includes(brandUpper)) ||
      (b.toUpperCase() === 'FM' && brandUpper === 'FOREVERMORE')
    );

    if (!targetBrandName) {
      console.warn(
        `Unknown brand "${brand.name}" not in ALLOWED_BRANDS. Preserved to avoid data loss. ` +
        `If this brand should be canonical, add it to ALLOWED_BRANDS; if it should be merged, add a variation rule above.`
      );
    } else if (brand.name !== targetBrandName) {
      // Merge variation into target brand
      console.log(`Merging brand variation: ${brand.name} -> ${targetBrandName}`);
      
      // Ensure target brand exists
      await db.query("INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [targetBrandName]);
      const targetBrand = await db.get("SELECT id FROM brands WHERE name = $1", [targetBrandName]);
      
      if (targetBrand && targetBrand.id !== brand.id) {
        // Update all related tables
        const tablesToUpdate = [
          "users", "branches", "products", "late_order_requests", 
          "user_brands", "hidden_items", "hide_history"
        ];
        
        for (const table of tablesToUpdate) {
          try {
            if (table === "user_brands") {
              // Handle unique constraint for user_brands
              await db.query(`
                DELETE FROM user_brands 
                WHERE brand_id = $1 
                AND user_id IN (SELECT user_id FROM user_brands WHERE brand_id = $2)
              `, [targetBrand.id, brand.id]);
            }
            await db.query(`UPDATE ${table} SET brand_id = $1 WHERE brand_id = $2`, [targetBrand.id, brand.id]);
          } catch (e) {
            console.error(`Error updating table ${table} during brand merge:`, e);
          }
        }
        
        // Delete the old variation
        await db.query("DELETE FROM brands WHERE id = $1", [brand.id]);
      } else {
        // Just rename if it's the same ID but different casing
        await db.query("UPDATE brands SET name = $1 WHERE id = $2", [targetBrandName, brand.id]);
      }
    }
  }

  // Ensure Brands exist
  for (const brandName of ALLOWED_BRANDS) {
    await db.query("INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [brandName]);
  }

  // Ensure all brands are assigned to relevant users for testing
  const allBrands = await db.all("SELECT id FROM brands");
  const usersToAssign = await db.all("SELECT id FROM users WHERE username IN ('Mohamed_Gharib', 'Mahmoud_Atef', 'Super Visor', 'admin')");
  for (const user of usersToAssign) {
    for (const brand of allBrands) {
      await db.query("INSERT INTO user_brands (user_id, brand_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [user.id, brand.id]);
    }
  }

  const roles = [
    "Technical Back Office",
    "Manager",
    "Super Visor",
    "Area Manager",
    "Restaurants",
    "Call Center",
    "Marketing Team",
    "Coding Team",
    "Operation Manager"
  ];

  for (const role of roles) {
    await db.query("INSERT INTO roles (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [role]);
  }

  // v2: no hardcoded admin seed. Bootstrap a first admin via one-shot SQL when
  // starting from an empty DB. See README "First-time bootstrap".

  const bbtBrand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1", ["BBT"]);
  const chiliBrand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1", ["CHILI"]);
  const shakirBrand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1", ["SHAKIR"]);
  const yeloBrand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1", ["YELO PIZZA"]);
  const pattieBrand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1", ["PATTIE"]);
  const sliceBrand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1", ["SLICE"]);
  const justcBrand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1", ["JUST C"]);
  const mishBrand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1", ["MISHMASH"]);
  const tableBrand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1", ["TABLE"]);
  const fmBrand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1", ["FM"]);

  // Ensure Branches exist
  if (bbtBrand) {
    const bbtBranches = ["Qurain", "Kaifan", "Jabriya", "Salmiya", "Fintas"];
    for (const branchName of bbtBranches) {
      await db.query("INSERT INTO branches (brand_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [bbtBrand.id, branchName]);
    }
  }

  if (chiliBrand) {
    const chiliBranches = ["Salmiya", "Avenues", "360 Mall", "Gate Mall"];
    for (const branchName of chiliBranches) {
      await db.query("INSERT INTO branches (brand_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [chiliBrand.id, branchName]);
    }
  }

  const otherBrands = [shakirBrand, yeloBrand, pattieBrand, sliceBrand, justcBrand, mishBrand, tableBrand, fmBrand];
  for (const brand of otherBrands) {
    if (brand) {
      await db.query("INSERT INTO branches (brand_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [brand.id, "Main Branch"]);
      await db.query("INSERT INTO branches (brand_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [brand.id, "Airport"]);
    }
  }

  // Ensure essential dynamic fields exist
  const fields = [
    { name_en: "Product Name (EN)", name_ar: "اسم المنتج (انجليزي)", type: "text", order: 1 },
    { name_en: "Category Name (EN)", name_ar: "اسم الفئة (انجليزي)", type: "text", order: 2 },
    { name_en: "Description (EN)", name_ar: "الوصف (انجليزي)", type: "text", order: 3 },
    { name_en: "Price", name_ar: "السعر", type: "number", order: 4 },
    { name_en: "Category Name (AR)", name_ar: "اسم الفئة (عربي)", type: "text", order: 5 },
    { name_en: "Product Name (AR)", name_ar: "اسم المنتج (عربي)", type: "text", order: 6 },
    { name_en: "Description (AR)", name_ar: "الوصف (عربي)", type: "text", order: 7 },
    { name_en: "Ingredients", name_ar: "المكونات", type: "text", order: 8 }
  ];

  for (const f of fields) {
    await db.query(
      "INSERT INTO dynamic_fields (name_en, name_ar, type, field_order) VALUES ($1, $2, $3, $4) ON CONFLICT (name_en) DO NOTHING",
      [f.name_en, f.name_ar, f.type, f.order]
    );
  }
}

// Initialize Database Function
async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn("WARNING: DATABASE_URL is not set. Database operations will fail.");
    return;
  }

  console.log("Initializing database schema...");
  await db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS brands (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS branches (
      id SERIAL PRIMARY KEY,
      brand_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );
  `);

  // Cleanup duplicate branches and add unique constraint
  try {
    const duplicates = await db.all(`
      SELECT brand_id, name, MIN(id) as keep_id, ARRAY_AGG(id) as all_ids
      FROM branches
      GROUP BY brand_id, name
      HAVING COUNT(*) > 1
    `);

    for (const dup of duplicates) {
      const keepId = dup.keep_id;
      const deleteIds = dup.all_ids.filter((id: number) => id !== keepId);
      
      if (deleteIds.length > 0) {
        console.log(`Merging duplicate branches for brand ${dup.brand_id}, name ${dup.name}: keeping ${keepId}, deleting ${deleteIds.join(', ')}`);
        
        const tables = [
          { name: 'users', col: 'branch_id' },
          { name: 'hidden_items', col: 'branch_id' },
          { name: 'hide_history', col: 'branch_id' },
          { name: 'late_order_requests', col: 'branch_id' },
          { name: 'user_branches', col: 'branch_id' }
        ];

        for (const table of tables) {
          try {
            if (table.name === 'user_branches') {
              for (const delId of deleteIds) {
                await db.query(`
                  DELETE FROM user_branches 
                  WHERE branch_id = $1 
                  AND user_id IN (SELECT user_id FROM user_branches WHERE branch_id = $2)
                `, [keepId, delId]);
              }
            }
            await db.query(`UPDATE ${table.name} SET ${table.col} = $1 WHERE ${table.col} = ANY($2)`, [keepId, deleteIds]);
          } catch (e) {
            console.error(`Error updating table ${table.name} during branch merge:`, e);
          }
        }
        await db.query(`DELETE FROM branches WHERE id = ANY($1)`, [deleteIds]);
      }
    }

    await db.exec("ALTER TABLE branches ADD CONSTRAINT branches_brand_id_name_unique UNIQUE (brand_id, name)");
    console.log("Added unique constraint to branches table");
  } catch (e) {
    // Constraint might already exist
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role_id INTEGER NOT NULL,
      brand_id INTEGER,
      branch_id INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (role_id) REFERENCES roles(id),
      FOREIGN KEY (brand_id) REFERENCES brands(id),
      FOREIGN KEY (branch_id) REFERENCES branches(id)
    );

    CREATE TABLE IF NOT EXISTS user_brands (
      user_id INTEGER NOT NULL,
      brand_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, brand_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_branches (
      user_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, branch_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS late_order_requests (
      id SERIAL PRIMARY KEY,
      call_center_user_id INTEGER NOT NULL,
      brand_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      order_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      call_center_message TEXT,
      case_type TEXT DEFAULT 'Late Order',
      dedication_time TIMESTAMP,
      status TEXT DEFAULT 'Pending', -- Pending, Approved, Rejected
      restaurant_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      restaurant_viewed_at TIMESTAMP,
      manager_viewed_at TIMESTAMP,
      restaurant_response_at TIMESTAMP,
      manager_responded_at TIMESTAMP,
      technical_type TEXT,
      attachment_url TEXT,
      attachment_type TEXT,
      FOREIGN KEY (call_center_user_id) REFERENCES users(id),
      FOREIGN KEY (brand_id) REFERENCES brands(id),
      FOREIGN KEY (branch_id) REFERENCES branches(id)
    );
  `);

  // Ensure technical_type column exists in late_order_requests
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN technical_type TEXT");
  } catch (e) {}

  // Ensure attachment columns exist in late_order_requests
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN attachment_url TEXT");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN attachment_type TEXT");
  } catch (e) {}

  await db.exec(`
    CREATE TABLE IF NOT EXISTS call_center_form_fields (
      id SERIAL PRIMARY KEY,
      name_en TEXT NOT NULL,
      name_ar TEXT NOT NULL,
      type TEXT NOT NULL, -- 'text', 'selection', 'number', 'textarea'
      is_required INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS call_center_field_options (
      id SERIAL PRIMARY KEY,
      field_id INTEGER NOT NULL,
      value_en TEXT NOT NULL,
      value_ar TEXT NOT NULL,
      display_order INTEGER DEFAULT 0,
      FOREIGN KEY (field_id) REFERENCES call_center_form_fields(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS late_order_field_values (
      request_id INTEGER NOT NULL,
      field_id INTEGER NOT NULL,
      value TEXT,
      PRIMARY KEY (request_id, field_id),
      FOREIGN KEY (request_id) REFERENCES late_order_requests(id) ON DELETE CASCADE,
      FOREIGN KEY (field_id) REFERENCES call_center_form_fields(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS late_order_attachments (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      type TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (request_id) REFERENCES late_order_requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS technical_case_types (
      id SERIAL PRIMARY KEY,
      name_en TEXT NOT NULL,
      name_ar TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS call_center_platforms (
      id SERIAL PRIMARY KEY,
      name_en TEXT NOT NULL,
      name_ar TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS call_center_case_types (
      id SERIAL PRIMARY KEY,
      name_en TEXT NOT NULL,
      name_ar TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.exec(`
  CREATE TABLE IF NOT EXISTS dynamic_fields (
    id SERIAL PRIMARY KEY,
    name_en TEXT UNIQUE NOT NULL,
    name_ar TEXT NOT NULL,
    type TEXT NOT NULL, -- text, number, dropdown, multiselect, checkbox
    is_mandatory INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    field_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS field_options (
    id SERIAL PRIMARY KEY,
    field_id INTEGER NOT NULL,
    value_en TEXT NOT NULL,
    value_ar TEXT NOT NULL,
    price DECIMAL DEFAULT 0,
    FOREIGN KEY (field_id) REFERENCES dynamic_fields(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    status TEXT DEFAULT 'Draft', -- Draft, Pending Coding, Completed
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (brand_id) REFERENCES brands(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS product_field_values (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    field_id INTEGER NOT NULL,
    value TEXT, -- JSON string for complex types
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (field_id) REFERENCES dynamic_fields(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS modifier_groups (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    name_en TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    selection_type TEXT CHECK(selection_type IN ('single', 'multiple')) DEFAULT 'single',
    is_required INTEGER DEFAULT 0,
    min_selection INTEGER DEFAULT 0,
    max_selection INTEGER DEFAULT 1,
    code TEXT,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS modifier_options (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL,
    name_en TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    price_adjustment DECIMAL DEFAULT 0,
    code TEXT,
    FOREIGN KEY (group_id) REFERENCES modifier_groups(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS category_codes (
    id SERIAL PRIMARY KEY,
    category_name TEXT UNIQUE NOT NULL,
    code TEXT NOT NULL,
    updated_by INTEGER NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS product_codes (
    id SERIAL PRIMARY KEY,
    product_id INTEGER UNIQUE NOT NULL,
    code TEXT NOT NULL,
    updated_by INTEGER NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (updated_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS product_channels (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    channel_name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_table TEXT NOT NULL,
    target_id INTEGER,
    old_value TEXT,
    new_value TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS busy_period_records (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    brand TEXT NOT NULL,
    branch TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    total_duration TEXT NOT NULL,
    total_duration_minutes INTEGER DEFAULT 0,
    reason_category TEXT NOT NULL,
    responsible_party TEXT NOT NULL,
    comment TEXT,
    internal_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS busy_branch_reasons (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS busy_branch_responsible (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS performance_targets (
    metric TEXT PRIMARY KEY,
    value NUMERIC,
    updated_by INTEGER,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS branch_messages (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    sender_role TEXT NOT NULL,
    comment TEXT,
    image_url TEXT,
    image_type TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_branch_messages_branch ON branch_messages(branch_id, created_at);

  CREATE TABLE IF NOT EXISTS hidden_items (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    brand_id INTEGER NOT NULL,
    branch_id INTEGER, -- NULL means All Branches
    product_id INTEGER NOT NULL,
    agent_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    action_to_unhide TEXT,
    comment TEXT,
    requested_at TIMESTAMP,
    responsible_party TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (brand_id) REFERENCES brands(id),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS hide_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    brand_id INTEGER NOT NULL,
    branch_id INTEGER, -- NULL means All Branches
    product_id INTEGER NOT NULL,
    action TEXT NOT NULL, -- 'HIDE' or 'UNHIDE'
    agent_name TEXT,
    reason TEXT,
    action_to_unhide TEXT,
    comment TEXT,
    requested_at TIMESTAMP,
    responsible_party TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (brand_id) REFERENCES brands(id),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pending_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL, -- 'hide_unhide', 'busy_branch'
    data TEXT NOT NULL, -- JSON string
    status TEXT DEFAULT 'Pending', -- 'Pending', 'Approved', 'Rejected'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_by INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (processed_by) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
  CREATE INDEX IF NOT EXISTS idx_products_created_by ON products(created_by);
  CREATE INDEX IF NOT EXISTS idx_product_field_values_product ON product_field_values(product_id);
  CREATE INDEX IF NOT EXISTS idx_product_field_values_field ON product_field_values(field_id);
  CREATE INDEX IF NOT EXISTS idx_modifier_groups_product ON modifier_groups(product_id);
  CREATE INDEX IF NOT EXISTS idx_modifier_options_group ON modifier_options(group_id);
  CREATE INDEX IF NOT EXISTS idx_product_channels_product ON product_channels(product_id);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_busy_period_records_created ON busy_period_records(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_hidden_items_created ON hidden_items(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_hide_history_timestamp ON hide_history(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_branches_brand ON branches(brand_id);
`);

// Migration: Add is_offline to products if it doesn't exist
try {
  await db.exec("ALTER TABLE products ADD COLUMN is_offline INTEGER DEFAULT 0");
  console.log("Added is_offline column to products");
} catch (e) {
  // Column already exists
}

  // Migration: Add total_duration_minutes to busy_period_records if it doesn't exist
  try {
    await db.exec("ALTER TABLE busy_period_records ADD COLUMN total_duration_minutes INTEGER DEFAULT 0");
    console.log("Added total_duration_minutes column to busy_period_records");
  } catch (e) {
    // Column already exists
  }

  // Migration: Add missing columns to hide_history if they don't exist
  const hideHistoryColumns = [
    { name: 'agent_name', type: 'TEXT' },
    { name: 'reason', type: 'TEXT' },
    { name: 'action_to_unhide', type: 'TEXT' },
    { name: 'comment', type: 'TEXT' },
    { name: 'requested_at', type: 'TIMESTAMP' },
    { name: 'responsible_party', type: 'TEXT' }
  ];

  for (const col of hideHistoryColumns) {
    try {
      await db.exec(`ALTER TABLE hide_history ADD COLUMN ${col.name} ${col.type}`);
      console.log(`Added ${col.name} column to hide_history`);
    } catch (e) {
      // Column already exists or other error
    }
  }

  // Migration: Add timer columns to busy_period_records
  try {
    await db.exec("ALTER TABLE busy_period_records ADD COLUMN timer_duration INTEGER");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE busy_period_records ADD COLUMN timer_expires_at TIMESTAMP");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE busy_period_records ADD COLUMN alarm_triggered BOOLEAN DEFAULT FALSE");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE busy_period_records ADD COLUMN alarm_dismissed BOOLEAN DEFAULT FALSE");
  } catch (e) {}

  await db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      subscription TEXT NOT NULL, -- JSON string
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Migration: Add updated_at and updated_by to hidden_items
  try {
    await db.exec("ALTER TABLE hidden_items ADD COLUMN updated_at TIMESTAMP");
    await db.exec("ALTER TABLE hidden_items ADD COLUMN updated_by INTEGER");
    console.log("Added updated_at and updated_by columns to hidden_items");
  } catch (e) {
    // Columns already exist
  }

  // Migration: Add Ingredients field if it doesn't exist
  const ingredientsField = await db.get("SELECT id FROM dynamic_fields WHERE name_en = $1", ['Ingredients']);
  if (!ingredientsField) {
    await db.query("INSERT INTO dynamic_fields (name_en, name_ar, type, is_mandatory) VALUES ($1, $2, $3, $4)", ['Ingredients', 'المكونات', 'text', 0]);
    console.log("Added Ingredients dynamic field");
  }

  const roles = ["Marketing Team", "Coding Team", "Technical Team", "Call Center", "Technical Back Office", "Manager", "Restaurants", "Super Visor", "Area Manager", "Operation Manager"];
  for (const roleName of roles) {
    const exists = await db.get("SELECT id FROM roles WHERE name = $1", [roleName]);
    if (!exists) {
      await db.query("INSERT INTO roles (name) VALUES ($1)", [roleName]);
    }
  }

  // v2: removed hardcoded "Super Visor" / "supervisor123" seed. Create via bootstrap SQL.

  // Remove unwanted marketing roles and reassign users
  const marketingTeamRole = await db.get("SELECT id FROM roles WHERE name = $1", ["Marketing Team"]) as { id: number };
  if (marketingTeamRole) {
    const unwantedRoles = ["Marketing Yellow", "Marketing ERMG", "Marketing Swish"];
    for (const roleName of unwantedRoles) {
      const role = await db.get("SELECT id FROM roles WHERE name = $1", [roleName]) as { id: number } | undefined;
      if (role) {
        // Reassign users to Marketing Team
        await db.query("UPDATE users SET role_id = $1 WHERE role_id = $2", [marketingTeamRole.id, role.id]);
        // Delete the role
        await db.query("DELETE FROM roles WHERE id = $1", [role.id]);
        console.log(`Removed role ${roleName} and reassigned users to Marketing Team`);
      }
    }

    // Also remove the specific users if they exist
    const unwantedUsers = ["marketing_yellow", "marketing_ermg", "marketing_swish", "Market", "Markett"];
    for (const username of unwantedUsers) {
      await db.query("DELETE FROM users WHERE username = $1", [username]);
    }
  }

  // v2: removed second hardcoded "admin" / "admin123" seed AND the force-reset of
  // admin's role on every startup. Both were anti-patterns. Roles are now managed
  // through the UI and persist across restarts.
  const managerRole = await db.get("SELECT id FROM roles WHERE name = $1", ["Manager"]) as { id: number } | undefined;

  // Migration: Merge 'bbt' and 'BBT' brands - REMOVED redundant logic as it's now handled in seedData()
  
  // Seed Brands if empty - REMOVED redundant logic as it's now handled in seedData()

  // v2: removed hardcoded "marketing_team" / "marketing123" seed. Create via bootstrap SQL.
  // The brand assignments below run for ANY existing marketing_team user, idempotently.
  if (marketingTeamRole) {
    const marketingUser = await db.get("SELECT id FROM users WHERE username = $1", ['marketing_team']) as { id: number } | undefined;
    if (marketingUser) {
      const brandsToAssign = ["YELO PIZZA", "MISHMASH", "TABLE"];
      for (const brandName of brandsToAssign) {
        const brand = await db.get("SELECT id FROM brands WHERE name = $1", [brandName]) as { id: number };
        if (brand) {
          await db.query("INSERT INTO user_brands (user_id, brand_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [marketingUser.id, brand.id]);
        }
      }
      console.log(`marketing_team user found; ensured brand assignments`);
    }
  }

  // Seed Branches if empty
  const branchesMap: Record<string, string[]> = {
    "SHAKIR": ["Rai", "Qurain", "Salmiya", "City", "Jahra", "Ardiya", "Egaila", "Hawally", "Sabah Al Ahmed"],
    "BBT": ["Shamiya", "Hilltop", "West Mishref", "Yard (Vibes)", "Salmiya", "Adriya", "Jahra", "Adailiya", "Shuhada", "Mangaf"],
    "SLICE": ["Mishref", "City", "Yard Mall", "Adailiya", "Jabriya", "Ardiya", "Jahra"],
    "PATTIE": ["Adailiya", "Mishref", "Ardiya", "Jahra", "Salmiya", "Yard", "Hawally"],
    "JUST C": ["Qortuba", "Yard"],
    "CHILI": ["Qortuba", "Yard", "Hawally"],
    "MISHMASH": ["Ardiya", "Kaifan", "Mahboula", "Jabriya", "S-Salem", "S-Abdallah", "Salmiya", "Khaitan", "Mangaf", "W-Abdullah", "Salwa", "Qadsiya", "Qurain", "Khairan"],
    "TABLE": ["Al-Rai", "Adriya", "Kuwait City", "Salmiya", "Hawally", "Jahra", "Egaila", "Aswaq Al-Qurain", "Sabah Al Ahmed"],
    "YELO PIZZA": [
      "Adailiya", "Khairan", "Jaber Al-Ahmad", "Sabah Al-Salem", "Vibes", "Qortuba", 
      "Dahiya Abdullah", "Fahaheel", "Jleeb Al-Shuyo", "Egaila", "Salmiya", "Jabriya", 
      "Ishbiliya (New)", "Sabah Al Ahmad", "Ardiya", "Midan Hawally", "Yard Mall", 
      "Jahra", "Salwa", "Zahra"
    ],
    "FM": ["Main Branch"]
  };

  for (const [brandName, branches] of Object.entries(branchesMap)) {
    const brand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1 OR UPPER(name) = $2", [brandName.toUpperCase(), brandName.toUpperCase().replace("YELLO", "YELO")]) as { id: number };
    if (brand) {
      for (const branchName of branches) {
        const exists = await db.get("SELECT id FROM branches WHERE brand_id = $1 AND name = $2", [brand.id, branchName]);
        if (!exists) {
          await db.query("INSERT INTO branches (brand_id, name) VALUES ($1, $2)", [brand.id, branchName]);
        }
      }
    }
  }

  // Seed Dynamic Fields
  const fields = [
    { name_en: "Category Name (EN)", name_ar: "اسم الفئة (EN)", type: "text", is_mandatory: 1 },
    { name_en: "Product Name (EN)", name_ar: "اسم المنتج (EN)", type: "text", is_mandatory: 1 },
    { name_en: "Description (EN)", name_ar: "الوصف (EN)", type: "text", is_mandatory: 1 },
    { name_en: "Price", name_ar: "السعر", type: "number", is_mandatory: 1 },
    { name_en: "Category Name (AR)", name_ar: "اسم الفئة (AR)", type: "text", is_mandatory: 1 },
    { name_en: "Product Name (AR)", name_ar: "اسم المنتج (AR)", type: "text", is_mandatory: 1 },
    { name_en: "Description (AR)", name_ar: "الوصف (AR)", type: "text", is_mandatory: 1 },
    { name_en: "Ingredients", name_ar: "المكونات", type: "text", is_mandatory: 0 },
    { name_en: "Primary Reason", name_ar: "السبب الرئيسي", type: "dropdown", is_mandatory: 1 },
    { name_en: "Sticker", name_ar: "ملصق", type: "text", is_mandatory: 0 },
    { name_en: "Deal Category", name_ar: "فئة العرض", type: "text", is_mandatory: 0 }
  ];

  for (const f of fields) {
    const exists = await db.get("SELECT id FROM dynamic_fields WHERE name_en = $1", [f.name_en]);
    if (!exists) {
      await db.query("INSERT INTO dynamic_fields (name_en, name_ar, type, is_mandatory) VALUES ($1, $2, $3, $4)", [f.name_en, f.name_ar, f.type, f.is_mandatory]);
    }
  }

  // Seed Primary Reason Options
  const primaryReasonField = await db.get("SELECT id FROM dynamic_fields WHERE name_en = $1", ["Primary Reason"]) as { id: number };
  if (primaryReasonField) {
    const optionsCount = await db.get("SELECT COUNT(*) as count FROM field_options WHERE field_id = $1", [primaryReasonField.id]) as { count: string | number };
    if (parseInt(optionsCount.count.toString()) === 0) {
      const reasons = [
        { en: "Supply Chain Delay", ar: "تأخير في التوريد" },
        { en: "Quality Issue", ar: "مشكلة جودة" },
        { en: "Out of Stock", ar: "نفاد الكمية" },
        { en: "Equipment Failure", ar: "عطل في المعدات" },
        { en: "Staff Shortage", ar: "نقص في الموظفين" }
      ];
      for (const r of reasons) {
        await db.query("INSERT INTO field_options (field_id, value_en, value_ar) VALUES ($1, $2, $3)", [primaryReasonField.id, r.en, r.ar]);
      }
    }
  }

  // Seed Busy Branch Config if empty
  const reasonCountResult = await db.get("SELECT COUNT(*) as count FROM busy_branch_reasons") as { count: string | number };
  const reasonCount = parseInt(reasonCountResult.count.toString());
  if (reasonCount === 0) {
    const reasons = ["High Volume", "System Down", "Staff Shortage", "Equipment Failure", "Other"];
    for (const r of reasons) {
      await db.query("INSERT INTO busy_branch_reasons (name) VALUES ($1)", [r]);
    }
  }

  const respCountResult = await db.get("SELECT COUNT(*) as count FROM busy_branch_responsible") as { count: string | number };
  const respCount = parseInt(respCountResult.count.toString());
  const newResponsible = ["Store", "Warhorse", "Bakery", "CPU", "Logistics"];

  if (respCount === 0) {
    for (const r of newResponsible) {
      await db.query("INSERT INTO busy_branch_responsible (name) VALUES ($1)", [r]);
    }
  } else {
    const currentResp = await db.all("SELECT name FROM busy_branch_responsible") as { name: string }[];
    const hasOldDefaults = currentResp.some(r => r.name === "Operations" || r.name === "IT Support");
    
    if (hasOldDefaults) {
      await db.query("DELETE FROM busy_branch_responsible");
      for (const r of newResponsible) {
        await db.query("INSERT INTO busy_branch_responsible (name) VALUES ($1)", [r]);
      }
    }
  }

// Helper functions for product seeding
const getCategory = (itemName: string) => {
  const lower = itemName.toLowerCase();
  if (lower.includes("pizza")) return { en: "Pizza", ar: "بيتزا" };
  if (lower.includes("burger") || lower.includes("slider") || lower.includes("pattie")) return { en: "Burgers", ar: "برجر" };
  if (lower.includes("drink") || lower.includes("cola") || lower.includes("pepsi") || lower.includes("water") || lower.includes("juice") || lower.includes("latte") || lower.includes("shake")) return { en: "Drinks", ar: "مشروبات" };
  if (lower.includes("fries") || lower.includes("wedges") || lower.includes("nuggets") || lower.includes("wings") || lower.includes("bites") || lower.includes("bread")) return { en: "Sides & Appetizers", ar: "مقبلات وجوانب" };
  if (lower.includes("salad") || lower.includes("fattoush") || lower.includes("tabboulah") || lower.includes("rocca")) return { en: "Salads", ar: "سلطات" };
  if (lower.includes("wrap") || lower.includes("sandwich") || lower.includes("roll") || lower.includes("arayes")) return { en: "Sandwiches & Wraps", ar: "ساندوتشات ولفائف" };
  if (lower.includes("rice bowl") || lower.includes("bowl") || lower.includes("platter") || lower.includes("meal") || lower.includes("box")) return { en: "Meals & Bowls", ar: "وجبات وأطباق" };
  if (lower.includes("dessert") || lower.includes("cookie") || lower.includes("pancake") || lower.includes("oats") || lower.includes("parfait")) return { en: "Desserts", ar: "حلويات" };
  if (lower.includes("sauce") || lower.includes("mayo") || lower.includes("ranch") || lower.includes("dip")) return { en: "Sauces", ar: "صوصات" };
  return { en: "Main Course", ar: "طبق رئيسي" };
};

const getDescription = (itemName: string) => {
  return {
    en: `Freshly prepared ${itemName} with high-quality ingredients.`,
    ar: `${itemName} طازج محضر من أجود المكونات.`
  };
};

const getPrice = () => (Math.random() * 4 + 1.5).toFixed(3);

// Seed Forevermore products for Hide Item demo
const productSeedingData: Record<string, string[]> = {
  "CHILI": [
    "12 Taco DIY Box",
    "Amigo Fries",
    "aquafina water",
    "Build Your Burrito",
    "Build Your Burrito Bowl",
    "Build Your Quesadilla",
    "Build Your Set Of 3 Tacos",
    "Build Your Taco",
    "Caramello",
    "Cheese Broccoli Soup",
    "Chicken Enchilada Soup",
    "Chips & Salsa",
    "Lipton Iced Tea- Lemon Zero",
    "Lipton Iced Tea- Peach Zero",
    "Lipton Iced Tea- Red Fruits Zero",
    "Lipton Iced Tea -Tropical Zero",
    "Low Carb",
    "Nachos",
    "Slim Churros",
    "Traditional Burrito",
    "Traditional Burrito Bowl",
    "Traditional Chicken Taco",
    "Traditional Quesadilla",
    "Traditional Shrimp Taco",
    "Traditional Steak Taco",
    "Vegan",
    "Vodavoda Water",
    "Build Your Burrito Bowl combo",
    "Shani",
    "Mirinda",
    "7up",
    "Pepsi Diet",
    "Pepsi"
  ],
  "FM": [
    "Guacamole Egg Tacos",
    "3.5KD Deal",
    "Turkish Egg Tacos",
    "Bacon & Egg Muffin",
    "FM Egg Muffin",
    "FM Breakfast",
    "Breakfast Cheese Platter",
    "Spanish Omlette",
    "Egg Avocado Platter",
    "Vanilla Pancake",
    "Crispy airBaked™ Chicken Katsu",
    "Grilled Lemon Chicken",
    "Chicken Fajita Pasta",
    "Steak With Mushroom Sauce",
    "Truffle Chicken Pasta",
    "Spaghetti Bolognese",
    "Zucchini Beef Lasagna",
    "Chicken Machboos",
    "Peri Peri Chicken",
    "Mongolian Beef",
    "Shrimp Spaghetti",
    "Dijon Chicken Pasta",
    "Maqlouba",
    "Short Ribs Tacos",
    "Shish Tawook with Batata Harra",
    "Short Ribs & Mash",
    "Kung Pao Chicken",
    "Butter Chicken",
    "Black Pepper Beef",
    "Murabyan",
    "Chicken Pink Pasta",
    "Zucchini Chicken Lasagna",
    "Burgers",
    "proPatty™ Fhopper",
    "proPatty™ Big FM",
    "airBaked™ Chicken Foyale",
    "airBaked™ Fwister",
    "airBaked™ FM Chicken",
    "proPatty™ FM Burger with Fries",
    "proPatty™ Double Cheese Burger with Fries",
    "airBaked™ Chicken Burger with Fries",
    "proPatty™ FM Burger with Sweet Potato Fries",
    "proPatty™ Double Cheese Burger with Sweet Potato Fries",
    "airBaked™ Chicken Burger with Sweet Potato Fries",
    "proPatty™ FM Burger",
    "proPatty™ Double Cheese Burger",
    "Mushroom proPatty™ Burger",
    "airBaked™ Chicken Burger",
    "airBaked™ Chicken Supreme Burger",
    "Spicy slaw airBaked™ Chicken Burger",
    "Spicy airBaked™ Supreme Burger",
    "Burrata Sandwich",
    "Halloumi Sandwich",
    "Club Sandwich",
    "Turkey Pesto Sandwich",
    "Chicken Shawarma Wrap",
    "Beef Shawarma Wrap",
    "Grilled Chicken Quesadillas",
    "Philly Cheesesteak",
    "Beef Burrito",
    "Chicken Burrito",
    "Chicken Philly Sandwich",
    "Mozzarella Pesto Sandwich",
    "Mushroom Egg Wrap",
    "Lil airBaked™ Chicken Burger",
    "Lil proPatty™ Cheese Burger",
    "Mini Spaghetti Bolognese",
    "Mini airBaked™ Chicken Wrap",
    "Mini airBaked™ Chicken Nuggets",
    "Couscous Beetroot Tabbouleh",
    "Mini Fattoush",
    "Mini Asian Chicken Salad",
    "Mini Italian Salad",
    "Mini Chicken Caesar Salad",
    "Quinoa Salad",
    "Crisp Garden Salad",
    "Rocca Feta Salad",
    "Mexican Salad",
    "Chicken Caesar Salad",
    "Asian Salad",
    "Fattoush",
    "Asian Chicken Bowl",
    "Steak Rice Bowl",
    "Chicken Shawarma Bowl",
    "Mushroom Steak Bowl",
    "Beef Shawarma Bowl",
    "Beef Shawarma Side",
    "Chicken Fajita Side",
    "Chicken Shawarma",
    "Jasmine Rice",
    "airBaked™ Fries",
    "airBaked™ Potato Wedges",
    "Messy airBaked™ Fries",
    "airBaked™ Sweet Potato Fries",
    "Batata Harra",
    "airBaked™ Nashville Hot Chicken Bites",
    "airBaked™ Buffalo Shrimp Bites",
    "Lentil Soup",
    "Mushroom Soup",
    "Jareesh",
    "Mini Grilled Corn",
    "Hummus",
    "Lotus Oats",
    "Mango Yogurt",
    "Beetroot Pot",
    "Edamame",
    "Veggies Crudités",
    "Chocolate Oats",
    "Triple Berry Oats",
    "Berry Parfait",
    "Pro Chips Sea Salt & Vinegar",
    "Pro Puffs Spicy Pizza",
    "Pro Puffs Cheese",
    "Pro Puffs Spicy",
    "Pro Puffs Chili Lemon",
    "Pro Chips Sweet Chili",
    "Spicy Mexican Mayo",
    "Tahina",
    "Guacamole",
    "Light Smoke House",
    "Light Ranch",
    "Light Honey Mustard",
    "Big FM Sauce",
    "Fwister Sauce",
    "Light Mayo Sauce",
    "Ketchup",
    "Tropical Fruits",
    "Classic Fruit Salad",
    "Exotic Fruit Salad",
    "Seasonal Fruit Salad",
    "Fresh Pomegranate",
    "Red Grapes",
    "Roasted Coconut Truffle",
    "Pistachio Chocolate Bite",
    "Pecan Turtle",
    "Peanut Bites",
    "Snickers Bar",
    "Peanut Butter Protein Bar",
    "Hazelnut Protein Bar",
    "Salted Caramel Protein Bar",
    "Pecan cheesecake",
    "Mini Peanut Butter Bite",
    "Salted Pecan Bites",
    "Mango Zest",
    "Orange Citrus",
    "Watermelon Lemonade",
    "Pomade",
    "Sparkling Water",
    "Pepsi Diet",
    "Pepsi Zero Sugar",
    "7up Zero Sugar",
    "Voda Voda water 330 ml",
    "Kinza Diet Cola",
    "Kinza Zero Lemon",
    "Vanilla Protein shake",
    "Chocolate Protein Shake",
    "Matcha Protein Shake",
    "Spanish Latte",
    "Cold Brew",
    "Classic Latte",
    "Vanilla Protein Latte",
    "Zing Shot",
    "Energy Shot",
    "Immunity Shot",
    "Heart Beet Shot",
    "MATAFI airBaked™ Supreme",
    "MATAFI airBaked™ Chicken",
    "MATAFI Loaded airBaked™ Fries",
    "MATAFI airBaked™ Chicken Wrap",
    "Super Dandash Salad",
    "airBaked™ Giant Nugget Original",
    "airBaked™ Giant Nugget Sandwich",
    "airBaked™ Giant Nugget Keto",
    "Super Grilled Chicken",
    "Super airBaked™ Chicken",
    "Super Beef Shawarma",
    "Super Chicken Shawarma",
    "Super Grilled Shrimp",
    "Super Herb Salmon",
    "Super Sous-Vide Steak",
    "Sweet & Sour Chicken Bowl",
    "Salmon & Dill Rice",
    "Pepperoni Pizza",
    "Chicken Ranch Pizza",
    "Classic Margherita Pizza",
    "Halal Girls proSauce™",
    "Beetroot proSauce™",
    "MATES Hazelnut Protein Bar",
    "MATES Peanut Butter Protein Bar",
    "Snickers HiProtein Bar",
    "Snickers White HiProtein Bar",
    "Chipotle proSauce™",
    "Avo-Lime proSauce™",
    "Golden Mustard proSauce™"
  ],
  "JUST C": [
    "12 PCS of potato buns, pattiesand Slice Cheese",
    "18 PCS of potato buns, pattiesand Slice Cheese",
    "6 PCS of potato buns, pattiesand Slice Cheese",
    "7up",
    "7up Zero Sugar",
    "Avocado",
    "Bacon",
    "BBQ Box",
    "BBQ Burger",
    "BBQ Sauce",
    "BBQ Slider",
    "Beef patty ( 100 gm )",
    "Beef patty ( 140 gm )",
    "Big C Burger",
    "C - Fries",
    "C- Sauce",
    "Cheddar Cheese",
    "Classic Burger",
    "Classic Chicken Burger",
    "Classic Chicken Slider",
    "Classic Meal Combo",
    "Classic Slider",
    "Crispy Cheese",
    "DOUBLE DECKER SESAME BUN",
    "Epsa Iced Tea - Lemon",
    "Epsa Iced Tea - Peach",
    "Epsa Iced Tea - Pink Lemonade",
    "Honey Mustard Sauce",
    "Jarritos Guava",
    "Jarritos Lime",
    "Jarritos Mandarin",
    "Jarritos Mexican Cola",
    "Just C Meal",
    "Lipton Ice Tea - Lemon Zero",
    "Lipton Ice Tea - Peach Zero",
    "Lipton Ice Tea - Red Fruits Zero",
    "Lipton Ice Tea - Tropical Zero",
    "Mapple Sauce",
    "Mirinda",
    "Mountain Dew",
    "Mushroom Burger",
    "Mushroom Slider",
    "Pepsi",
    "Pepsi Diet",
    "POTATO BUN",
    "Provolone Cheese",
    "SESAME BUN",
    "Shani",
    "SLIDER POTATO",
    "SLIDER SESAME",
    "Special Chicken Slider",
    "Spical Chicken ( Moderately Spicy )",
    "Truffle Aioli Sauce",
    "Truffle Burger",
    "Truffle Slider",
    "Vodavoda Water",
    "Ziggy Fries",
    "Ziggy Fries With Cheese"
  ],
  "MISHMASH": [
    "Beef Philly Steak Samoon",
    "3.5KD Deal",
    "Tenders 5pc Combo",
    "Double Puri",
    "Chicken Bites Wrap",
    "Chicken Caesar wrap",
    "Musahab wrap",
    "Chicken Philly Steak Samoon",
    "Kabab Samoon",
    "Mushroom Steak Samoon",
    "Shabah Samoon",
    "Tawook Samoon",
    "Chicken Tenders",
    "Telyani Samoon",
    "BBQ Burger",
    "Cheeseburger",
    "Creamy Mushroom Burger",
    "Cheesy Puri",
    "Classic Puri",
    "Spicy Puri",
    "Chicken Puri feast",
    "Classic Chicken Fillet",
    "Chick-Spicy Fillet",
    "Buffalo Chicken Fillet",
    "Grilled Chicken Burger",
    "Beef Philly Steak Sandwich",
    "Chicken Philly Steak Sandwich",
    "Mishmash Quesadilla",
    "Grilled Chicken Quesadilla",
    "Toasted Grill’d Chicken",
    "Toasted Cheeseburger",
    "Toasted BBQ Burger",
    "Toasted Mushroom Burger",
    "Beef Kabab (Regular)",
    "Beef Kabab (Healthy)",
    "Khishkhash Beef Kabab (Regular)",
    "Khishkhash Beef Kabab (Healthy)",
    "Shish Tawouk (Regular)",
    "Shish Tawouk (Healthy)",
    "Tikka Tenderloin (Regular)",
    "Tikka Tenderloin (Healthy)",
    "Mix Grills (Regular)",
    "Mix Grills (Healthy)",
    "Classic Arayis",
    "Arayis with Cheese",
    "Chicken Grills (Regular)",
    "Chicken Grills (Healthy)",
    "Half Deboned Chicken (Regular)",
    "Half Deboned Chicken (Spicy)",
    "Half Deboned Chicken (Healthy Regular)",
    "Half Deboned Chicken (Healthy Spicy)",
    "Deboned Chicken (Whole) (Regular)",
    "Deboned Chicken (Whole) (Spicy)",
    "Deboned Chicken (Whole) (Healthy Regular)",
    "Deboned Chicken (Whole) (Healthy Spicy)",
    "Beef Steak Tenderloin Rice Bowl",
    "Chicken Rice Bowl",
    "Grilled Tenderloin Steak Bowl",
    "Grilled Chicken Steak Bowl",
    "Grilld Chic Bowl",
    "Grilld Tawouk Bowl",
    "Grilld Tikka Bowl",
    "Burghul Super Bowl",
    "Lettuce Super Bowl",
    "Beef Shawarma",
    "Chicken Shawarma",
    "Kabab Grilled Wrap",
    "Khishkhash Grilled Wrap",
    "Tawouk Grilled Wrap",
    "Original Fries",
    "Cheese Fries",
    "Mishmash Fries",
    "MxS Shrimp Wrap",
    "MxS Dynamite Shrimp",
    "Philly Steak Fries",
    "Chicken Bites",
    "Buffalo Bites",
    "Chicken Wings (Grilled)",
    "Chicken Wings (Bufflo)",
    "Chicken Wings (BBQ)",
    "Jalapeno Bites",
    "Onion Rings",
    "Chicken Caesar Salad",
    "Peanut Butter Coleslaw",
    "Hummus",
    "Mutabbal",
    "Tabboulah",
    "Plain Rice",
    "Plain Burghul",
    "Mishmash Bread",
    "Hoagie Rolls",
    "Pumpkin Burger Bun",
    "Appetizer Feast",
    "Chicken Grilld Feast",
    "Mishmash Feast",
    "Chicken Feast",
    "Chicken Burger Feast",
    "Beef Burger Feast",
    "Medium Grills Feast",
    "Large Grills Feast",
    "Philly Steak Feast",
    "Shawarma Feas",
    "Char-Grilled Wraps Feast",
    "Buffalo Sauce",
    "Caeser Sauce",
    "Cheese Sauce",
    "Chick-Spicy Sauce",
    "Garlic Sauce",
    "Honey Mustard Sauce",
    "Ketchup",
    "Ketchup And Mayonnaise",
    "Khishkhash Sauce",
    "Pepper Sauce",
    "Ranch Sauce",
    "Real Mayonnaise",
    "Slimmed Sour Cream",
    "Special BBQ Sauce",
    "Spicy Ranch Sauce",
    "Tahini Sauce",
    "Vinaigrette Sauce",
    "Coca Cola",
    "Coca Cola Light",
    "Coca Cola Zero",
    "Sprite",
    "Sprite Zero",
    "Alsi Cola",
    "Alsi Cola Zero",
    "Mineral Water",
    "Fresh Lemon With Mint Juice",
    "Fresh Orange Juice",
    "Vimto",
    "Belgian Chocolate Cookie",
    "Angus Beef Burger BBQ Plate",
    "Chicken Breast BBQ Plate",
    "Chopped Tenderloin Steak BBQ Plate",
    "Chopped Chicken Steak BBQ Plate",
    "Tikka Tenderloin BBQ Plate",
    "Shish Tawouk BBQ Plate",
    "Beef Kabab BBQ Plate",
    "Meat Arayis BBQ Plate",
    "BBQ Arayis with Cheese",
    "Vegetables Plate BBQ",
    "Char-Grills BBQ Box",
    "Beef Burger BBQ Box",
    "Chicken Burger BBQ Box",
    "Tenderloin Steak BBQ Box",
    "Chicken Steak BBQ Box",
    "Nashville Bites",
    "Nashville Chicken Fillet",
    "Nashville Fries",
    "NASHVILLE MESSY FRIES",
    "Nashville Quesadilla",
    "Nashville Sauce",
    "Nashville Shish Tawook Wrap",
    "Nashville Shish Tawouk",
    "Nashville Tenders 5pc Combo"
  ],
  "TABLE": [
    "Eggplant Fattah",
    "Grilled Wings",
    "Roasted Potato Fingers",
    "Tabel™ Batata Harra",
    "Tabel™ Grape Leaves",
    "Hummus",
    "3.5KD Deal",
    "Tabel™ Hummus",
    "Kabab Coconut Curry Bowl",
    "Tawook Coconut Curry Bowl",
    "Tawook Bowl combo",
    "Deboned Chicken Family Box",
    "Beef Hummus",
    "Farm Salad",
    "Chef Salad",
    "Creamy Tawook Hamsa",
    "Halloumi Tomato Hamsa",
    "Tikka Mushroom Hamsa",
    "Tikka Tomato Hamsa",
    "Fattoush",
    "Tabboulah",
    "Mutabbal",
    "Muhammarah",
    "Yogurt Salad",
    "Organic Brown Rice",
    "Tabel™ Bread",
    "Roasted Pumpkin Soup",
    "Tabel™ Tahini- 150 Ml",
    "Tabel™ Spicy Tahini- 150 Ml",
    "Brown Rice Wholesome Bowl",
    "Quinoa & Brown Rice Wholesome Bowl",
    "Quinoa Wholesome Bowl",
    "Veggies Wholesome Bowl",
    "Herbs Tawouk & Chimichurri Pesto Rice Bowl",
    "Herbs Tawouk & Karaz Rice Bowl",
    "Herbs Tawouk & Khishkhash Rice Bowl",
    "Herbs Tawouk & Mushroom Rice Bowl",
    "Herbs Tawouk & Tahini Rice Bowl",
    "Herbs Tawouk Rice Bowl without sauce",
    "Kabab & Chimichurri Pesto Rice Bowl",
    "Kabab & Karaz Rice Bowl",
    "Kabab & Khishkhash Rice Bowl",
    "Kabab & Mushroom Rice Bowl",
    "Kabab & Tahini Rice Bowl",
    "Kabab Rice Bowl without sauce",
    "Tawouk & Chimichurri Pesto Rice Bowl",
    "Tawouk & Karaz Rice Bowl",
    "Tawouk & Khishkhash Rice Bowl",
    "Tawouk & Mushroom Rice Bowl",
    "Tawouk & Tahini Rice Bowl",
    "Tawouk Rice Bowl without sauce",
    "Tenderloin & Chimichurri Pesto Rice Bowl",
    "Tenderloin & Karaz Rice Bowl",
    "Tenderloin & Khishkhash Rice Bowl",
    "Tenderloin & Mushroom Rice Bowl",
    "Tenderloin & Tahini Rice Bowl",
    "Tenderloin Rice Bowl without sauce",
    "Herbs Tawook Coconut Curry Bowl",
    "Tenderloin Coconut Curry Bowl",
    "Chimichurri Pesto \"Mangoo3\"",
    "Karaz \"Mangoo3\"",
    "Khishkhash \"Mangoo3\"",
    "Mushroom \"Mangoo3\"",
    "Tahini \"Mangoo3\"",
    "Half Grilled Chicken (Regular)",
    "Grilled Half Grilled Chicken (Spicy)",
    "Whole Grilled Chicken (Regular)",
    "Whole Grilled Chicken (Spicy)",
    "Herbs Tawouk",
    "Shish Tawouk",
    "Kabab",
    "Khishkhash Kabab",
    "Tenderloin Tikka",
    "Mixed Grills",
    "Beef Arayis",
    "Beef Arayis With Cheese",
    "Mix Arayis",
    "\"Mangoo3\" Goodness Box",
    "Appetizer Goodness Box",
    "Brown Rice Goodness Box",
    "Chargrilled Wraps Goodness Box",
    "Shawarma Goodness Box",
    "Fam Goodness Box",
    "Gathering Goodness Box",
    "Beef Shawarma",
    "Chicken Shawarma",
    "Grilled Halloumi wrap",
    "Herbs Tawouk Wrap",
    "Tabel Tawouk Wrap",
    "Khishkhash Kabab Wrap",
    "Mutabbal Kabab Wrap",
    "Chimichurri Pesto",
    "Garlic Chimmichuri",
    "Garlic Sauce",
    "Khishkhash Sauce",
    "Mushroom Sauce",
    "Tabel™ Karaz Sauce",
    "Tabel™ Sauce",
    "Tabel™ Spicy Sauce",
    "Tabel™ Tahini",
    "Tabel™ Spicy Tahini",
    "Alsi Cola",
    "Alsi Cola Zero",
    "Carbonated Water",
    "Lemon Falvor Carbonated Water",
    "Strawberry Flavor Carbonated Water",
    "Mineral Water",
    "Mint Lemonade",
    "Orange Juice",
    "Creamy Choconafa",
    "Creamy Choconafa Goodness Box",
    "Herbs Tawook Mushroom Bil Fern",
    "Meat Ball Khishkhash Bil Fern",
    "Meat Ball Mushroom Bil Fern",
    "Meat Ball Tahina Bil Fern",
    "Tawouk Coconut Curry Bil Fern",
    "Iskender Tenderloin Burgul Bowl",
    "Red Pepper & Garlic Sauce",
    "Sujuk Hummus",
    "Turkish Beef Rolls",
    "Sujuk platter",
    "Turkish Kabab Dish",
    "Turkish Mixed Grill - Sujuk",
    "Turkish Mixed Grills - Tikka",
    "Turkish Shish Tawook Dish",
    "Turkish Tikka Dish",
    "Turkish Shish Tawook saj",
    "Turkish Sujuk Saj",
    "Turkish Tikka Saj",
    "Turkish Kabab saj",
    "Turkish Chicken Shawarma Saj"
  ],
  "SHAKIR": [
    "1 Beef Arayes Sandwich",
    "1 Beef Kaizer Shawarma",
    "1 Beef Kebab Sandwich",
    "1 Beef Kebab Wrap",
    "1 Bun",
    "3.5KD Deal",
    "1 Chicken Arayes Sandwich",
    "1 Chicken Kaizer Shawarma",
    "1 Lebanese Chicken Shawarma",
    "1 Lebanese Meat Shawarma",
    "1 Mixed Grill Platter (4 People)",
    "1 Regular Beef Shawarma",
    "1 Regular Chicken Shawarma",
    "1 Regular Meat Shawarma",
    "1 Shish Tawouq Wrap",
    "1 Spicy Beef Kaizer Shawarma",
    "1 Spicy Beef Shawarma",
    "1 Spicy Chicken Kaizer Shawarma",
    "1 Spicy Chicken Shawarma",
    "1 Spicy Meat Shawarma",
    "1 Tawouq Sandwich",
    "2 Beef & 2 Chicken",
    "2 Fattoush",
    "2 Hummus",
    "2 Mixed Grill Platter (4 People)",
    "2 Shakir Salad",
    "3 Fattoush",
    "3 Hummus",
    "3 Pcs Of Beef",
    "3 Pcs Of Chicken",
    "3 Pcs Of Spicy Beef",
    "3 Pcs Of Spicy Chicken",
    "3 Shakir Salad",
    "4 Pcs Of Beef",
    "4 Pcs Of Chicken",
    "4 Regular Fries",
    "7up",
    "7up Zero Sugar",
    "8 Regular Fries",
    "Arayes & Wraps Combo",
    "Aquafina Water",
    "Banana & Fruits Mix",
    "Beef Kaizer Combo",
    "Beef Kebab Platter",
    "Beef Kebab Sandwich",
    "Beef Kebab Wrap",
    "Beef Tikka Platter",
    "Broasted Garlic Sauce",
    "Bun",
    "Cheese Sticks",
    "Chicken Arayes Sandwich",
    "Chicken Kaizer Combo",
    "Chicken Kebab Platter",
    "Coconut & Pineapple Mix",
    "Coleslaw",
    "Crispy Wrap Regular",
    "Crispy Wrap Spicy",
    "Crispy Box ( 4 Pieces) Regular",
    "Crispy Box ( 4 Pieces) Spicy",
    "Crispy Box ( 6 Pieces) Regular",
    "Crispy Box ( 6 Pieces) Spicy",
    "Crispy Wrap Combo Regular",
    "Crispy Wrap Combo Spicy",
    "Diwaniya Pack (6-8)",
    "Diwaniya Pack 2 (10-12)",
    "Fattoush",
    "Fried Sliced Potato",
    "Fruits & Icecream Mix",
    "Garlic Sauce",
    "Grilled Sandwiches Combo",
    "Grilled wings",
    "Hummus",
    "Hummus With Beef Shawarma",
    "Kabab Combo",
    "kinza cola",
    "kinza diet cola",
    "kinza diet lemon",
    "kinza lemon",
    "kinza orange",
    "Laban",
    "Lebanese Beef Shawarma",
    "Lebanese Box",
    "Lebanese Chicken Shawarma",
    "Lipton Ice Tea - Lemon Zero",
    "Lipton Ice Tea - Peach Zero",
    "Lipton Ice Tea - Red Fruits Zero",
    "Lipton Ice Tea - Tropical Zero",
    "Meat Arayes Sandwich",
    "Mirinda",
    "MIX Combo",
    "Mixed Grill Platter",
    "Mixed Grill Platter (4 People)",
    "Mountain Dew",
    "Muhammara",
    "Muttabal",
    "Musahab Wrap",
    "Mini Katayef",
    "Musahab Rice Bowl",
    "Grilled Chicken Platter",
    "Musahab Wrap Combo",
    "Peach, Fruits & Ice Cream Mix",
    "Pepsi",
    "Pepsi Diet",
    "Plain Beef",
    "Plain Chicken",
    "Plain Meat",
    "Regular Chicken Shawarma",
    "Regular Fries",
    "Regular Meat Shawarma",
    "Shakir Banana",
    "Shakir Broasted Meal",
    "Shakir Broasted Meal Spicy",
    "Shakir Grills Sauce",
    "Shakir Hummus",
    "Shakir Lemonade",
    "Shakir Mango",
    "Shakir Mini Meat Shawarma",
    "Shakir Peach",
    "Shakir Salad",
    "Shakir Shawarma Chicken Platter",
    "Shakir Shawarma Meat Platter",
    "Shakir Spicy Garlic",
    "Shakir Watermelon",
    "Shakirs Large Platter",
    "Shakirs Medium Platter",
    "Shani",
    "Shawarma Shakir Box",
    "2 Shawarma Combo",
    "3 Shawarma Combo",
    "Shawarma Combo",
    "Shish Tawouq Platter",
    "Shish Tawouq Sandwich",
    "Shish Tawouq Wrap",
    "Spicy Chicken Shawarma",
    "Spicy Fried Sliced Potatoes",
    "Spicy Garlic Broasted Sauce",
    "Spicy Meat Shawarma",
    "Spicy Mix",
    "Spicy Tahina",
    "Super Beef Shawarma",
    "Super Chicken Shawarma",
    "Samoun Chicken Shawarma",
    "3 Samoun Chicken Shawarma",
    "Tahina Garlic Sauce",
    "Tahina Sauce",
    "Tawouq Combo",
    "Tawouq & Arayes Combo",
    "Vimto",
    "Pepsi 1.25L",
    "Diet Pepsi 1.25L",
    "Miranda 1.25L",
    "7UP 1.25L",
    "7UP Diet 1.25L",
    "8 shawerma combo",
    "12pc Broasted Box",
    "12pc Family Meal"
  ],
  "YELLO PIZZA": [
    "2 pcs Pepperoni Garlic Bread",
    "2 pcs Pesto Garlic Bread",
    "2pcs Garlic Bread",
    "3 Pc Cheesy Garlic Bread",
    "3 Pc Pepporoni Garlic Bread",
    "3 Pc Pesto Garlic Bread",
    "3x3x3 - Good for 3",
    "4 for 4",
    "3.5KD Deal",
    "4 pcs BBQ Wings",
    "4 pcs Buffalo Wings",
    "5 for 5 ( NY Pizza )",
    "5 for 5 ( Square Pizza)",
    "7-Up Zero Sugar",
    "7-Up",
    "All for One - Good for 1",
    "Apricot Jam",
    "Aquafina Water",
    "Bacon Ranch",
    "Bacon",
    "Baked Wedges",
    "BBQ Chicken Wings",
    "BBQ Ranch",
    "Black Olives",
    "Buffalo Chicken (Thin - Pan - NY)",
    "Buffalo Chicken Wings",
    "Buffalo Chicken",
    "Buffalo Mac & Cheese",
    "Buffalo Ranch",
    "Cheese",
    "Cheesy Garlic Bread",
    "Chicken",
    "Chili Flakes",
    "Classic Crispy Chicken",
    "Classic Pepperoni Pizza (Thin - Pan - NY)",
    "Classic Pepperoni",
    "Cheesy Crust",
    "Cheesy Jalapeno Crust",
    "Cookie",
    "Cool Ranch",
    "Chicken Alfredo Pizza",
    "Alfredo Pasta",
    "Diet Pepsi",
    "Duo Combo",
    "Everything (Thin - Pan - NY)",
    "Supreme (Everything)",
    "Fresh Mushroom",
    "Garlic Bread",
    "Green Capsicum",
    "Green Pepper",
    "Group 1 - Good for 2",
    "Group 2 - Good for 2-3",
    "Group 3 - Good for 3-4",
    "Group 4 - Good for 3",
    "Group 6 - Good for 3-4",
    "Group 7 - Good for 2",
    "Honey Mustard Ranch",
    "Jalapeno",
    "Kinza Citrus",
    "Kinza Cola",
    "Kinza Diet Cola",
    "Kinza Diet Lemon",
    "Kinza Lemon",
    "Kinza Orange",
    "Ketchup",
    "Large Half and Half",
    "Large NY Buffalo Chicken",
    "Large NY Classic Crispy Chicken",
    "Large NY Classic Pepperoni",
    "Large NY Everything",
    "Large NY Margherita",
    "Large NY MeatLover",
    "Large NY Pesto",
    "Large NY Soho",
    "Large NY Spicy Crispy Chicken",
    "Large NY Tornado Crispy Chicken",
    "Large NY Veggie",
    "Large NY Yelo Pepperoni",
    "Loaded Wedges",
    "Long Pizza & Wedges",
    "Long Pizza & Drink",
    "Long Pizza & Garlic Bread",
    "Mac & Cheese",
    "Margharita",
    "Margherita Pizza (Thin - Pan - NY)",
    "Margherita",
    "Meat Balls",
    "Meat Lovers (Thin - Pan - NY)",
    "Meat Lovers",
    "Medium Half and Half",
    "Medium NY Buffalo Chicken",
    "Medium NY Margherita",
    "Medium NY Pepperoni",
    "Mineral Water",
    "Mirinda",
    "Mountain Dew",
    "Mushroom",
    "New York Large (Classic)",
    "New York Large",
    "New York Medium (Classic)",
    "New York Medium",
    "NY Buffalo Chicken",
    "NY Classic Crispy Chicken",
    "NY Classic Pepperoni",
    "NY Everything",
    "NY Eveything",
    "NY Margherita",
    "NY MeatLover",
    "NY Medium Buffalo Chicken",
    "NY Medium Classic Crispy Chicken",
    "NY Medium Classic Pepperoni",
    "NY Medium Everything",
    "NY Medium Margherita",
    "NY Medium Meat Lovers",
    "NY Medium Pepperoni",
    "NY Medium Spicy Crispy Chicken",
    "NY Medium Tornado Crispy Chicken",
    "NY Medium Veggie",
    "NY Medium Yelo Pepperoni",
    "NY Pepperoni",
    "NY Pesto",
    "NY Soho",
    "NY Spicy Crispy Chicken",
    "NY Tornado Crispy Chicken",
    "NY Veggie",
    "NY Yelo Pepperoni",
    "NY Yelo Peppperoni",
    "Mushroom Truffle",
    "Olives",
    "One for All",
    "Onion",
    "Pan Buffalo Chicken",
    "Pan Classic Crispy Chicken",
    "Pan Everything",
    "Pan Margherita",
    "Pan MeatLover",
    "Pan Medium",
    "Pan Pepperoni",
    "Pan Pesto",
    "Pan Soho",
    "Pan Spicy Crispy Chicken",
    "Pan Tornado Crispy Chicken",
    "Pan Veggie",
    "Pepperoni Garlic Bread",
    "Pepperoni",
    "Pepsi Diet",
    "Pepsi Zero",
    "Pepsi",
    "Pesto Garlic Bread",
    "Pesto Pizza (Thin - Pan - NY)",
    "Pesto Ranch Sauce",
    "Pesto Ranch",
    "Pesto",
    "Potato Wedges",
    "Red Capsicum",
    "Ranch Supreme",
    "Seen Jeem Long Pizza",
    "Shani",
    "Shredded Mozzarella Cheese",
    "Skinny Ranch",
    "Soft Drinks",
    "Soho Pizza (Thin - Pan - NY)",
    "Soho",
    "HOT WHEELS™ Kids Meal Chicken Chunks",
    "HOT WHEELS™ Kids Meal Pepperoni",
    "HOT WHEELS™ Kids Meal Margarita",
    "Small Pan Margarita",
    "Small NY Margarita",
    "Small Pan Pepperoni",
    "Small NY Pepperoni",
    "KDD Apple juice",
    "KDD Orange Juice",
    "Solo 1 - Good for 1",
    "Solo 2 - Good for 1-2",
    "Solo 4 - Good for 1",
    "Spicy Crispy Chicken",
    "Spicy Ranch",
    "Spicy Chipotle Bacon Pizza",
    "Peri Peri Ranch Chicken Pizza",
    "Spicy Honey Pepperoni Pizza",
    "Summer Saver Box",
    "Sweet Honey Bacon",
    "Ramadan Solo Meal",
    "Thin Crust Buffalo Chicken",
    "Thin Crust Classic Crispy Chicken",
    "Thin Crust Everything",
    "Thin Crust Margharita",
    "Thin Crust Meat Lover",
    "Thin Crust Medium (New)",
    "Thin Crust Medium Buffalo Chicken",
    "Thin Crust Medium Everything",
    "Thin Crust Medium Margharita",
    "Thin Crust Medium Pepperoni",
    "Thin Crust Medium Pesto",
    "Thin Crust Medium Soho",
    "Thin Crust Medium Veggie",
    "Thin Crust Pepperoni",
    "Thin Crust Pesto",
    "Thin Crust Soho",
    "Thin Crust Spicy Crispy Chicken",
    "Thin Crust Tornado Crispy Chicken",
    "Thin Crust Veggie",
    "Tomato",
    "Tornado Crispy Chicken",
    "Truffle Ranch",
    "Veggie Pizza (Thin - Pan - NY)",
    "Veggie",
    "Yelo Pepperoni Pizza (NY)",
    "Yelo Pepperoni",
    "Vimto",
    "Yelo! Kids Meal"
  ],
  "SLICE": [
    "2 7up",
    "2 7up Zero Sugar",
    "2 Aquafina Water",
    "2 Kinza Citrus",
    "2 Kinza Cola",
    "2 Kinza Diet Cola",
    "2 Kinza Diet Lemon",
    "2 Kinza Lemon",
    "2 Kinza Orange",
    "2 Mirinda",
    "2 Pepsi",
    "2 Pepsi Diet",
    "2 Shani",
    "4 7up",
    "4 7up Zero Sugar",
    "4 Aquafina Water",
    "4 Fries",
    "4 Kinza Citrus",
    "4 Kinza Cola",
    "4 Kinza Diet Cola",
    "4 Kinza Diet Lemon",
    "4 Kinza Lemon",
    "4 Kinza Orange",
    "4 Mirinda",
    "4 Pepsi",
    "4 Pepsi Diet",
    "4 Shani",
    "7up",
    "7up Zero Sugar",
    "8 Fries",
    "Aquafina Water",
    "BBQ Sauce",
    "Beef",
    "Beef & Chicken",
    "Caesar Sauce",
    "Caramel Feuille",
    "Ceasar Sauce",
    "Cheese Bites",
    "Chicken",
    "Classic Fries",
    "Combo Box 12 Pcs",
    "Combo Box 24 Pcs",
    "Create Your Own Doner",
    "Create Your Own Meal Doner",
    "Create Your Own Meal Slicer",
    "Create Your Own Rice Bowl",
    "Create Your Own Salad",
    "Create Your Own Slicer",
    "Crispy Onion",
    "Crispy Onions",
    "Extra Beef",
    "Extra Chicken",
    "Garlic Mayo",
    "Hot Sauce",
    "KDD Apple & Rasberry (0% Sugar & Calories)",
    "KDD Cocktail (0% Sugar & Calories)",
    "KDD Lemon & Mint Mojito (0% Sugar & Calories)",
    "KDD Mango & Peach (0% Sugar & Calories)",
    "Kids Meal",
    "Kinza Citrus",
    "Kinza Cocktail",
    "Kinza Cola",
    "Kinza Diet Cola",
    "Kinza Diet Lemon",
    "Kinza Lemon",
    "Kinza Lift Up",
    "Kinza Orange",
    "Lettuce",
    "Lipton Ice Tea - Lemon Zero",
    "Lipton Ice Tea - Peach Zero",
    "Lipton Ice Tea - Red Fruits Zero",
    "Lipton Ice Tea - Tropical Zero",
    "Mirinda",
    "Mountain Dew",
    "No Sauce",
    "No Vegetables",
    "Onion",
    "Parmesan Caesar",
    "Parmesan Caesar Doner",
    "Parmesan Caesar Slicer",
    "Parmesan Ceasar Doner",
    "Pepsi",
    "Pepsi Diet",
    "Pickles",
    "Pita",
    "Pita Doner",
    "Pita Slicer",
    "Purple Cabbage",
    "Roasted Doner",
    "Roasted Sauce",
    "Roasted Signature Doner",
    "Roasted Slicer",
    "Saj",
    "Saj Doner",
    "Saj Slicer",
    "Sauces",
    "Seasoned Fries",
    "Shani",
    "Signature Fries",
    "Signature Sauces",
    "Slice Combo",
    "Special Sauce",
    "Spicy Doner",
    "Spicy Ranch",
    "Spicy Signature Doner",
    "Spicy Signature Sauce",
    "Spicy Slicer",
    "Tahina Sauce",
    "Tomatos",
    "Unseasoned Fries",
    "Vodavoda Water",
    "White Ranch",
    "Without Crispy Onion",
    "Without Seasoning",
    "Without Spicy Ranch",
    "Without White Ranch",
    "Yoghurt Sauce"
  ],
  "PATTIE": [
    "(5Pcs) 4pcs Happy Nuggets Pattie",
    "(5Pcs) Aquafina Water",
    "(5Pcs) Capri Sun Apple",
    "(5Pcs) Capri Sun Orange",
    "(5Pcs) Classic Pattie",
    "(5Pcs) Crispy Chicken Pattie",
    "(5Pcs) Mirinda",
    "(5Pcs) Pattie Pattie",
    "(5Pcs) Pepsi",
    "(5Pcs) Pepsi Zero",
    "10 Pcs Nuggets",
    "12 Slider Combo",
    "12 Sliders",
    "2 Fries",
    "3.5KD Deal",
    "2 Pcs Of Beef Crunch",
    "2 Pcs Of Cheesestake Pattie",
    "2 Pcs Of Chicken Bites",
    "2 Pcs Of Classic Pattie",
    "2 Pcs Of Crispy Chicken Pattie",
    "2 Pcs Of Honey Mustard",
    "2 Pcs Of Onion Rings",
    "2 Pcs Of Pattie Pattie",
    "2 Pcs Of Pattie Pattie Mayo",
    "2 Pcs Of Pattie Pattie Sauce",
    "2 Pcs Of Ranch",
    "2 Pcs Of Spicy Chicken Pattie",
    "2 Pcs Of Sweet Bacon Pattie",
    "2 Pcs Of Sweet Chili",
    "2 Pcs Of Truffle Mushroom Pattie",
    "24 Slider Combo",
    "24 Sliders",
    "3 Pcs Of Cheesestake Pattie",
    "3 Pcs Of Classic Pattie",
    "3 Pcs Of Crispy Chicken",
    "3 Pcs Of Pattie Pattie",
    "3 Pcs Of Spicy Chicken",
    "3 Pcs Of Sweet Bacon",
    "3 Pcs Of Sweet Bacon Pattie",
    "3 Pcs Of Truffle Mushroom",
    "3 Pcs Of Truffle Mushroom Pattie",
    "5 Pcs Nuggets",
    "6 Pcs Of Cheesestake Pattie",
    "6 Pcs Of Classic Pattie",
    "6 Pcs Of Crispy Chicken",
    "6 Pcs Of Pattie Pattie",
    "6 Pcs Of Spicy Chicken",
    "6 Pcs Of Sweet Bacon",
    "6 Pcs Of Truffle Mushroom",
    "6 Pcs Of Truffle Mushroom Pattie",
    "6 Slider Combo",
    "7up",
    "Aquafina Water",
    "Beef Crunch",
    "Capri-sun juice apple",
    "Capri-sun juice orange",
    "Cheesesteak Pattie Slider",
    "Chicken Bites",
    "Chicken Nuggets",
    "Chicken Slider Combo",
    "Classic Pattie",
    "Classic Pattie Slider",
    "Crispy Chicken",
    "Crispy chicken nuggets (4 pcs)",
    "Crispy Chicken Pattie Slider",
    "Family Fries",
    "Fries",
    "Happie Nuggets Pattie",
    "Happie Pattie Party Pack",
    "Happie Slider Pattie",
    "Honey Mustard",
    "Jalapeno Cheese Nuggets",
    "Kinza cola",
    "Kinza diet cola",
    "Kinza diet lemon",
    "Kinza lemon",
    "Lipton Ice Tea - Lemon Zero",
    "Lipton Ice Tea - Peach Zero",
    "Lipton Ice Tea - Red Fruits Zero",
    "Lipton Ice Tea - Tropical Zero",
    "Nashville Chicken Slider",
    "Nashville Chicken Bites",
    "Nashville Loaded Fries",
    "Curly Fries",
    "Cookies",
    "Marinara",
    "Mirinda",
    "Mountain Dew",
    "Onion Rings",
    "Pattie Fries",
    "Pattie Pattie",
    "Pattie Pattie Mayo",
    "Pattie Pattie Sauce",
    "Pattie Pattie Slider",
    "Pepsi",
    "Pepsi Diet",
    "Pepsi Zero",
    "Ranch",
    "Shani",
    "Solo Feast",
    "Solo Meal",
    "Spiced Corn",
    "Spicy Chicken Pattie Slider",
    "Sweet Bacon Slider",
    "Sweet Chili",
    "The Original",
    "The Trio",
    "Truffle Mushroom Pattie Slider",
    "Water",
    "Crispy Chicken Pattie Slider PLUS+",
    "Spicy Chicken Pattie Slider PLUS+",
    "Nashville Chicken slider PLUS+",
    "Cheesesteak Pattie Slider PLUS+",
    "Classic Pattie Slider PLUS+",
    "Sweet Bacon Slider PLUS+",
    "Truffle Mushroom Pattie Slider PLUS+",
    "Pattie Pattie slider PLUS+",
    "Rodeo Chicken Slider",
    "Rodeo Chicken Slider PLUS+",
    "Rodeo Beef Slider",
    "Rodeo Beef Slider PLUS+",
    "BBQ Fries",
    "BBQ Chicken Fries"
  ],
  "BBT": [
    "7up",
    "Aquafina Water",
    "3.5KD Deal",
    "BBQ Sauce",
    "BBT Mayo",
    "BBT Ranch Sauce",
    "BBT Sauce",
    "Buttercup",
    "Cheese Dip",
    "CLASSIC ROLLS BEEF",
    "CLASSIC ROLLS BEEF Meal",
    "Cheeseburger Duo Combo",
    "Chicken Fillaaa",
    "Chicken Fillaaa Meal",
    "Chicken Nugget Meal",
    "Chicken Nuggets",
    "Chili Lime",
    "Chilli Lime Old Skool",
    "Chilli Lime Supreme",
    "Chilli Lime Old Skool Meal",
    "Chilli Lime Supreme Meal",
    "Chilli Lime Tenders Fillaaa (New)",
    "Classic Old Skool",
    "Classic Supreme",
    "Classic Old Skool Meal",
    "Classic Supreme Meal",
    "Coleslaw",
    "Crispy Fries",
    "Curly Fries",
    "Extra 1pc Tenders",
    "Extra 1pc Toast",
    "Extra Cheese",
    "Extra Coleslaw",
    "Extra Sauce",
    "Fillaaa Sauce",
    "FILAAA PARTY",
    "French Fries",
    "Fries",
    "Honey Mustard",
    "Kinza Cola",
    "Kinza Diet Cola",
    "Kinza Diet Lemon",
    "Kinza Lemon",
    "Kinza Orange",
    "Lipton Ice Tea - Lemon Zero",
    "Lipton Ice Tea - Peach Zero",
    "Lipton Ice Tea - Red Fruits Zero",
    "Lipton Ice Tea - Tropical Zero",
    "Little Cheeseburger",
    "Little Chicken Burger",
    "Little Chicken Burger Duo Combo",
    "Little Wrap Fillaaa Meal",
    "Little Wrap Fillaaa Duo Combo",
    "Little Wrap Fillaaaa",
    "Messy Fries",
    "Miranda",
    "Mirinda",
    "Mountain Dew",
    "Nesqiuk",
    "Nuggets",
    "Nuggets Duo Combo",
    "Oreo Madness",
    "Peanut Butter",
    "Pepsi",
    "Pepsi Zero",
    "Quarter Pounder Burger",
    "Quarter Pounder Meal",
    "Schnitzel x Burger",
    "Schnitzel X Meal",
    "Salt",
    "SMOKEY ROLLS BEEF",
    "SMOKEY ROLLS BEEF Meal",
    "Shani",
    "Southwest Burger",
    "Southwest Meal",
    "Salt n Vinegar Tenders Fillaaa",
    "\"Not So Ranch\" Sauce",
    "Strawberry",
    "Sweet Chili",
    "Suuuper Beef",
    "Suuuper Beef Combo",
    "Suuuper Chicken",
    "Suuuper Chicken Combo",
    "Tang",
    "Tenders Fillaaa",
    "Toast",
    "Triple X",
    "Triple X Box",
    "TRIPLE X Meal",
    "Water",
    "Westcoast Burger",
    "Westcoast Meal",
    "Kidkit Little chicken",
    "Kidkit Little Cheese Burger",
    "Kidkit Chicken Nuggets",
    "XL Fillaaa Sauce",
    "3amos Burger combo"
  ]
};

  const fieldNames = [
    "Category Name (EN)", "Product Name (EN)", "Description (EN)", "Price",
    "Category Name (AR)", "Product Name (AR)", "Description (AR)", "Ingredients"
  ];
  const fieldIdMap: Record<string, number> = {};
  for (const name of fieldNames) {
    const field = await db.get("SELECT id FROM dynamic_fields WHERE name_en = $1", [name]) as { id: number } | undefined;
    if (field) fieldIdMap[name] = field.id;
  }

  // Get admin user ID for product seeding
  const admin = await db.get("SELECT id FROM users WHERE username = $1", ["admin"]);
  const adminUserId = admin?.id || 1;

  console.log("Starting seedData...");
  for (const [brandName, items] of Object.entries(productSeedingData)) {
    const brand = await db.get("SELECT id FROM brands WHERE UPPER(name) = $1 OR UPPER(name) = $2", [brandName.toUpperCase(), brandName.toUpperCase().replace("YELLO", "YELO")]) as { id: number };
    if (brand) {
      console.log(`Checking brand: ${brandName} (ID: ${brand.id})`);
      
      const countResult = await db.get("SELECT COUNT(*) as count FROM products WHERE brand_id = $1", [brand.id]);
      const currentCount = Number(countResult.count);
      console.log(`Brand ${brandName}: current count ${currentCount}, expected ${items.length}`);
      
      if (currentCount >= items.length && items.length > 0) {
        console.log(`Skipping seeding for ${brandName} as it already has ${currentCount} products.`);
        continue;
      }

      console.log(`Seeding missing products for brand: ${brandName}...`);
      
      try {
        await db.transaction(async (client) => {
          const productNameFieldId = fieldIdMap["Product Name (EN)"];
          if (!productNameFieldId) return;

          // Get existing product names for this brand to avoid duplicates
          const existingProductsResult = await client.query(`
            SELECT pfv.value as name
            FROM products p
            JOIN product_field_values pfv ON p.id = pfv.product_id
            WHERE p.brand_id = $1 AND pfv.field_id = $2
          `, [brand.id, productNameFieldId]);
          
          const existingNames = new Set(existingProductsResult.rows.map((r: any) => r.name));

          for (const itemName of items) {
            if (existingNames.has(itemName)) continue;

            const result = await client.query("INSERT INTO products (brand_id, created_by, status) VALUES ($1, $2, $3) RETURNING id", [brand.id, adminUserId || 1, 'Completed']);
            const productId = result.rows[0].id;
            
            const category = getCategory(itemName);
            const description = getDescription(itemName);
            const price = getPrice();
            const ingredients = `Sample ingredients for ${itemName}: Flour, Water, Salt, and Secret Spices.`;

            const values = [
              { name: "Category Name (EN)", val: category.en },
              { name: "Product Name (EN)", val: itemName },
              { name: "Description (EN)", val: description.en },
              { name: "Price", val: price },
              { name: "Category Name (AR)", val: category.ar },
              { name: "Product Name (AR)", val: itemName },
              { name: "Description (AR)", val: description.ar },
              { name: "Ingredients", val: ingredients }
            ];

            for (const v of values) {
              const fieldId = fieldIdMap[v.name];
              if (fieldId) {
                await client.query("INSERT INTO product_field_values (product_id, field_id, value) VALUES ($1, $2, $3)", [productId, fieldId, v.val]);
              }
            }
          }
        });
        console.log(`Successfully completed seeding for ${brandName}`);
      } catch (err) {
        console.error(`Failed to seed products for ${brandName}:`, err);
      }
    }
  }

  // Seed Call Center Platforms
  const platformCountResult = await db.get("SELECT COUNT(*) as count FROM call_center_platforms") as { count: string | number };
  const platformCount = parseInt(platformCountResult.count.toString());
  if (platformCount === 0) {
    const platforms = [
      { en: "Deliveroo", ar: "دليفرو" },
      { en: "Talabat", ar: "طلبات" },
      { en: "Jahez", ar: "جاهز" },
      { en: "Hungerstation", ar: "هنجرستيشن" },
      { en: "Careem", ar: "كريم" },
      { en: "Call Center", ar: "كول سنتر" },
      { en: "Direct Call", ar: "اتصال مباشر" },
      { en: "Web Site", ar: "الموقع الإلكتروني" },
      { en: "V-thru", ar: "في-ثرو" },
      { en: "Keeta", ar: "كيتا" }
    ];
    for (const p of platforms) {
      await db.query("INSERT INTO call_center_platforms (name_en, name_ar) VALUES ($1, $2)", [p.en, p.ar]);
    }
  }

  // Seed Call Center Case Types
  const caseTypeCountResult = await db.get("SELECT COUNT(*) as count FROM call_center_case_types") as { count: string | number };
  const caseTypeCount = parseInt(caseTypeCountResult.count.toString());
  if (caseTypeCount === 0) {
    const caseTypes = [
      { en: "Late Order", ar: "طلب متأخر" },
      { en: "Wrong Item", ar: "صنف خطأ" },
      { en: "Missing Item", ar: "صنف ناقص" },
      { en: "Quality Issue", ar: "مشكلة جودة" },
      { en: "Driver Issue", ar: "مشكلة سائق" },
      { en: "Dedication", ar: "إهداء" },
      { en: "Technical", ar: "تقني" },
      { en: "Inquiry", ar: "استفسار" },
      { en: "Suggestion", ar: "اقتراح" }
    ];
    for (const c of caseTypes) {
      await db.query("INSERT INTO call_center_case_types (name_en, name_ar) VALUES ($1, $2)", [c.en, c.ar]);
    }
  }

  // Seed Technical Case Types
  const techTypeCountResult = await db.get("SELECT COUNT(*) as count FROM technical_case_types") as { count: string | number };
  const techTypeCount = parseInt(techTypeCountResult.count.toString());
  if (techTypeCount === 0) {
    const techTypes = [
      { en: "System Down", ar: "النظام معطل" },
      { en: "Printer Issue", ar: "مشكلة طابعة" },
      { en: "Network Issue", ar: "مشكلة شبكة" },
      { en: "Tablet Issue", ar: "مشكلة تابلت" },
      { en: "Other", ar: "أخرى" }
    ];
    for (const t of techTypes) {
      await db.query("INSERT INTO technical_case_types (name_en, name_ar) VALUES ($1, $2)", [t.en, t.ar]);
    }
  }

  // Seed sample data for auto-fill testing
  const busyCount = await db.get("SELECT COUNT(*) as count FROM busy_period_records");
  if (Number(busyCount.count) === 0) {
    const yeloSalmiya = await db.get("SELECT id, brand_id FROM branches WHERE name = 'Salmiya' AND brand_id = (SELECT id FROM brands WHERE name = 'Yelo Pizza')");
    if (yeloSalmiya) {
      for (let i = 0; i < 5; i++) {
        await db.query(`
          INSERT INTO busy_period_records (brand_id, branch, reason_category, responsible_party, user_id, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [yeloSalmiya.brand_id, 'Salmiya', 'High Order Volume', 'Kitchen', adminUserId, 'Resolved']);
      }
    }
  }

  const hiddenCount = await db.get("SELECT COUNT(*) as count FROM hidden_items");
  if (Number(hiddenCount.count) === 0) {
    const yeloSalmiya = await db.get("SELECT id, brand_id FROM branches WHERE name = 'Salmiya' AND brand_id = (SELECT id FROM brands WHERE name = 'Yelo Pizza')");
    const sampleProduct = await db.get("SELECT id FROM products WHERE brand_id = $1 LIMIT 1", [yeloSalmiya?.brand_id]);
    if (yeloSalmiya && sampleProduct) {
      for (let i = 0; i < 5; i++) {
        await db.query(`
          INSERT INTO hidden_items (user_id, brand_id, branch_id, product_id, agent_name, reason, responsible_party)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [adminUserId, yeloSalmiya.brand_id, yeloSalmiya.id, sampleProduct.id, 'System Seed', 'Out of Stock', 'Kitchen']);
      }
    }
  }
  console.log("seedData completed.");
}

async function startServer() {
  console.log("Starting server...");
  
  const app = express();
  // No CORS middleware: frontend is served same-origin in dev (Vite middleware)
  // and prod (express.static of dist/). If you ever serve the API to a different
  // origin, add cors({ origin: process.env.FRONTEND_ORIGIN }) — never cors() bare.
  const server = http.createServer(app);
  // S-5: WebSocket auth at handshake. Verify the JWT from the auth cookie
  // before letting any upgrade complete. Anonymous connections are dropped
  // with 401 — v1 accepted every connection and broadcast operational events
  // to everyone on the network.
  const wss = new WebSocketServer({ noServer: true });
  const PORT = 3000;

  server.on("upgrade", (req, socket, head) => {
    const cookieHeader = req.headers.cookie || "";
    const match = cookieHeader.match(/(?:^|;\s*)swish_token=([^;]+)/);
    const token = match ? decodeURIComponent(match[1]) : null;

    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      wss.handleUpgrade(req, socket, head, (ws) => {
        (ws as unknown as { user: any }).user = decoded;
        wss.emit("connection", ws, req);
      });
    } catch (_err) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    }
  });

  app.use(express.json());
  app.use(cookieParser());

  // Cookie options shared by /api/login (set) and /api/logout (clear).
  const AUTH_COOKIE_NAME = "swish_token";
  const AUTH_COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8h, matches JWT expiresIn.
  const isProd = process.env.NODE_ENV === "production";
  const authCookieOptions = {
    httpOnly: true,
    secure: isProd,         // Set-Cookie is only sent over HTTPS in prod.
    sameSite: "lax" as const, // Lax keeps the cookie on top-level navigations from external sites; strict would also work.
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
    path: "/",
  };

  // Request logger — path only, no query string (which can contain search terms,
  // filter values, and other request data). For body-level audit, use audit_logs.
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });

  // Suppress 404 noise from PWA/iOS asset probes that the app doesn't serve.
  app.get(["/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png",
          "/apple-touch-icon-120x120.png", "/apple-touch-icon-120x120-precomposed.png",
          "/.well-known/assetlinks.json"], (_req, res) => res.status(204).end());

  // Initialize Database in background to avoid blocking server startup
  (async () => {
    try {
      console.log("Connecting to PostgreSQL...");
      await initDb();
      
      // Ensure unique constraints exist for ON CONFLICT
      try { await db.exec("ALTER TABLE roles ADD CONSTRAINT roles_name_unique UNIQUE (name)"); } catch (e) {}
      
      // Clean up brands before adding unique constraint
      console.log("Starting brand cleanup and migration...");
      await seedData();
      
      try { 
        await db.exec("ALTER TABLE brands ADD CONSTRAINT brands_name_unique UNIQUE (name)"); 
      } catch (e) {
        console.log("Note: brands_name_unique constraint already exists or could not be added.");
      }
      
      try { await db.exec("ALTER TABLE dynamic_fields ADD CONSTRAINT dynamic_fields_name_en_unique UNIQUE (name_en)"); } catch (e) {}
      
      console.log("Database initialization complete.");
    } catch (dbErr: any) {
      console.error("CRITICAL ERROR: Failed to initialize database.");
      
      if (dbErr.code === 'EAI_AGAIN' || dbErr.message?.includes('getaddrinfo')) {
        console.error("DNS RESOLUTION ERROR: The database host could not be reached.");
        if (process.env.DATABASE_URL?.includes('postgres.railway.internal')) {
          console.error("ADVICE: You are using a Railway INTERNAL URL. Please switch to the PUBLIC connection string.");
        } else {
          console.error("ADVICE: Check if your database host is correct and accessible from the internet.");
        }
      }

      console.error("Check your DATABASE_URL environment variable.");
      console.error("Error details:", dbErr);
    }
  })();

  console.log("NODE_ENV:", process.env.NODE_ENV);

  // Health check
  app.get("/api/health", async (req, res) => {
    try {
      await db.query("SELECT 1");
      const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
      res.json({ 
        status: "ok", 
        database: "connected",
        host: url ? url.hostname.replace(/./g, (c, i) => i < 3 ? c : '*') : 'none',
        timestamp: new Date().toISOString() 
      });
    } catch (error: any) {
      console.error("Health check failed:", error);
      const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
      const isRailwayInternal = process.env.DATABASE_URL?.includes('postgres.railway.internal');
      res.status(503).json({ 
        status: "error", 
        database: "disconnected",
        host: url ? url.hostname.replace(/./g, (c, i) => i < 3 ? c : '*') : 'none',
        error: error.message,
        isRailwayInternal,
        advice: isRailwayInternal 
          ? "You are using a Railway INTERNAL URL. Please switch to the PUBLIC connection string in the Settings menu."
          : "Check your DATABASE_URL environment variable in the Settings menu."
      });
    }
  });

  // Simple debug route
  app.get("/debug", (req, res) => {
    res.send("<h1>Server is running!</h1><p>If you see this, the server is listening on port 3000.</p>");
  });

  // WebSocket broadcast helper. S-15: filter delivery by role_target / user_id
  // so events with PII (DEDICATION_ALERT customer_name, etc.) only reach the
  // intended audience. Un-tagged events go to all authenticated clients.
  const broadcast = (data: any) => {
    const roleTarget: string[] | null = Array.isArray(data.role_target) ? data.role_target : null;
    const targetUserId: number | null =
      typeof data.user_id === "number" ? data.user_id :
      typeof data?.data?.call_center_user_id === "number" ? data.data.call_center_user_id : null;

    wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const u = (client as unknown as { user?: { id?: number; role_name?: string } }).user;
      if (!u) return; // shouldn't happen post-S-5 but defensive

      if (roleTarget && !roleTarget.includes(u.role_name || "")) return;
      if (targetUserId !== null && u.id !== targetUserId) return;

      client.send(JSON.stringify(data));
    });

    // Trigger push notifications for new pending requests
    if (data.type === 'PENDING_REQUEST_CREATED') {
      sendPushToRoles(["Manager", "Super Visor", "Technical Back Office"], {
        title: "New Pending Request",
        body: "A new Hide/Busy request requires your approval.",
        tag: "pending-request",
        data: { type: "PENDING_REQUEST" }
      });
    }
  };

  const sendSystemNotification = (titleEn: string, titleAr: string, messageEn: string, messageAr: string, roles: string[], type: string = "NEW_REQUEST") => {
    broadcast({
      type: "NOTIFICATION",
      notificationType: type,
      title_en: titleEn,
      title_ar: titleAr,
      message_en: messageEn,
      message_ar: messageAr,
      role_target: roles
    });
  };

  const sendPushToRoles = async (roles: string[], payload: any, branchId?: number) => {
    try {
      const roleIds = await db.all(`SELECT id FROM roles WHERE name = ANY($1)`, [roles]);
      const ids = roleIds.map((r: any) => r.id);
      const params: any[] = [ids];
      let branchClause = '';
      if (branchId) {
        params.push(branchId);
        branchClause = ` AND u.branch_id = $${params.length}`;
      }
      const subs = await db.all(`
        SELECT ps.subscription
        FROM push_subscriptions ps
        JOIN users u ON ps.user_id = u.id
        WHERE u.role_id = ANY($1)${branchClause}
      `, params);

      for (const row of subs) {
        const sub = JSON.parse(row.subscription);
        webpush.sendNotification(sub, JSON.stringify(payload)).catch(err => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired or no longer valid
            db.query("DELETE FROM push_subscriptions WHERE subscription = $1", [row.subscription]);
          }
        });
      }
    } catch (error) {
      console.error("Error sending push notifications:", error);
    }
  };

  const getProductNameFieldId = async () => {
    const field = await db.get("SELECT id FROM dynamic_fields WHERE name_en = 'Product Name (EN)'") as { id: number } | undefined;
    return field?.id || 3;
  };

  const getIngredientsFieldId = async () => {
    const field = await db.get("SELECT id FROM dynamic_fields WHERE name_en = 'Ingredients'") as { id: number } | undefined;
    return field?.id || 4;
  };

  // Middleware: Auth
  // Reads the JWT from the httpOnly cookie set by /api/login. Falls back to
  // an Authorization: Bearer header so legacy clients / API integrations still
  // work, but the browser app no longer uses the header path.
  const authenticate = async (req: any, res: any, next: any) => {
    const token: string | undefined =
      req.cookies?.[AUTH_COOKIE_NAME] ||
      req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      // Fetch fresh user data to ensure role_id is correct after DB resets
      const freshUser = await db.get("SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1", [decoded.id]) as any;
      if (!freshUser) return res.status(401).json({ error: "User no longer exists" });
      req.user = freshUser;
      next();
    } catch (e) {
      res.status(401).json({ error: "Invalid token" });
    }
  };

  // Middleware: Role check
  const authorize = (roles: string[]) => (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.user.role_name)) {
      console.warn(`Access denied for user ${req.user.username}. Role ${req.user.role_name} not in ${roles.join(", ")}`);
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };

  // Pending Requests API
  app.get("/api/pending-requests", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor", "Restaurants", "Operation Manager"]), async (req, res) => {
    const { page, limit, status, type, brand, branch, search, date } = req.query as any;
    
    let whereClauses = [];
    let params: any[] = [];

    if ((req as any).user.role_name === 'Restaurants') {
      whereClauses.push(`pr.user_id = $${params.length + 1}`);
      params.push((req as any).user.id);
    }

    if (status && status !== 'all') {
      if (status === 'History') {
        whereClauses.push(`pr.status != 'Pending'`);
      } else {
        whereClauses.push(`pr.status = $${params.length + 1}`);
        params.push(status);
      }
    }

    if (type && type !== 'all') {
      if (type === 'HIDE') {
        whereClauses.push(`pr.type = 'hide_unhide' AND pr.data::jsonb->>'action' = 'HIDE'`);
      } else if (type === 'UNHIDE') {
        whereClauses.push(`pr.type = 'hide_unhide' AND pr.data::jsonb->>'action' = 'UNHIDE'`);
      } else if (type === 'BUSY') {
        whereClauses.push(`pr.type = 'busy_branch' AND (pr.data::jsonb->>'action' = 'BUSY' OR pr.data::jsonb->>'action' IS NULL)`);
      } else if (type === 'OPEN') {
        whereClauses.push(`pr.type = 'busy_branch' AND pr.data::jsonb->>'action' = 'OPEN'`);
      } else {
        whereClauses.push(`pr.type = $${params.length + 1}`);
        params.push(type);
      }
    }

    if (brand && brand !== 'all') {
      whereClauses.push(`(
        (pr.type = 'hide_unhide' AND pr.data::jsonb->>'brand_name' = $${params.length + 1}) OR
        (pr.type = 'busy_branch' AND pr.data::jsonb->>'brand' = $${params.length + 1})
      )`);
      params.push(brand);
    }

    if (branch && branch !== 'all') {
      whereClauses.push(`(
        (pr.type = 'hide_unhide' AND pr.data::jsonb->>'branch_name' = $${params.length + 1}) OR
        (pr.type = 'busy_branch' AND (pr.data::jsonb->>'branch' = $${params.length + 1} OR pr.data::jsonb->>'branch_name' = $${params.length + 1}))
      )`);
      params.push(branch);
    }

    if (search) {
      whereClauses.push(`(
        pr.id::text LIKE $${params.length + 1} OR
        pr.type LIKE $${params.length + 1} OR
        u.username LIKE $${params.length + 1}
      )`);
      params.push(`%${search}%`);
    }

    if (date) {
      whereClauses.push(`pr.created_at::text LIKE $${params.length + 1}`);
      params.push(`${date}%`);
    }

    const whereSection = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Optimization: Bulk fetch names to avoid N+1 queries in resolveRequestData
    const [brandsTable, branchesTable] = await Promise.all([
      db.all("SELECT id, name FROM brands"),
      db.all("SELECT id, name FROM branches")
    ]);
    const brandsMap = Object.fromEntries(brandsTable.map((b: any) => [String(b.id), b.name]));
    const branchesMap = Object.fromEntries(branchesTable.map((b: any) => [String(b.id), b.name]));

    const resolveRequestData = async (r: any) => {
      const data = JSON.parse(r.data);
      if (r.type === 'hide_unhide') {
        // Brand: prefer the request's own brand_id, else fall back to the
        // requesting user's brand (e.g. unhide requests carry no brand_id).
        if (data.brand_id) {
          data.brand_name = brandsMap[String(data.brand_id)] || 'Unknown';
        } else if (r.requester_brand_id) {
          data.brand_name = brandsMap[String(r.requester_brand_id)] || data.brand_name;
        }
        // Branch: prefer the request's own branch_id; if missing (e.g. unhide
        // requests), show the requesting restaurant user's own branch instead of
        // the misleading "All Branches". Only true brand-wide requests with no
        // requester branch fall back to "All Branches".
        if (data.branch_id) {
          data.branch_name = branchesMap[String(data.branch_id)] || 'Unknown';
        } else if (r.requester_branch_id) {
          data.branch_name = branchesMap[String(r.requester_branch_id)] || 'All Branches';
        } else {
          data.branch_name = 'All Branches';
        }
        if (data.product_ids && data.product_ids.length > 0) {
          const productNameFieldId = await getProductNameFieldId();
          const placeholders = data.product_ids.map((_: any, i: number) => `$${i + 2}`).join(',');
          const products = await db.all(`
            SELECT fv.product_id, fv.value as name
            FROM product_field_values fv
            WHERE fv.field_id = $1 AND fv.product_id IN (${placeholders})
          `, [productNameFieldId, ...data.product_ids]) as { product_id: number, name: string }[];
          data.resolved_products = products;
        }
      }
      return { ...r, data };
    };

    // If no pagination requested, return all (backward compatibility)
    if (!page) {
      const query = `
        SELECT pr.*, u.username, u.brand_id AS requester_brand_id, u.branch_id AS requester_branch_id, p.username as processor_name
        FROM pending_requests pr
        JOIN users u ON pr.user_id = u.id
        LEFT JOIN users p ON pr.processed_by = p.id
        ${whereSection}
        ORDER BY pr.created_at DESC
      `;
      const requests = await db.all(query, params);
      const parsedRequests = await Promise.all(requests.map(resolveRequestData));
      return res.json(parsedRequests);
    }

    // Pagination logic
    const limitNum = Number(limit) || 10;
    const offset = (Number(page) - 1) * limitNum;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM pending_requests pr
      JOIN users u ON pr.user_id = u.id
      ${whereSection}
    `;
    const totalResult = await db.get(countQuery, params) as { total: string };
    const total = parseInt(totalResult.total || '0');

    const query = `
      SELECT pr.*, u.username, p.username as processor_name
      FROM pending_requests pr
      JOIN users u ON pr.user_id = u.id
      LEFT JOIN users p ON pr.processed_by = p.id
      ${whereSection}
      ORDER BY pr.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    
    const requests = await db.all(query, [...params, limitNum, offset]);
    const parsedRequests = await Promise.all(requests.map(resolveRequestData));
    
    res.json({
      data: parsedRequests,
      total,
      page: Number(page),
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum)
    });
  });

  app.post("/api/pending-requests", authenticate, async (req, res) => {
    const { type, data } = req.body;
    const result = await db.query(`
      INSERT INTO pending_requests (user_id, type, data)
      VALUES ($1, $2, $3) RETURNING id
    `, [(req as any).user.id, type, JSON.stringify(data)]);
    
    broadcast({ type: "PENDING_REQUEST_CREATED" });
    const branchName = data.branch_name || data.branch || "Unknown Branch";
    sendSystemNotification(
      "New Request Submitted",
      "تم إرسال طلب جديد",
      `New request received from ${branchName}`,
      `طلب جديد مستلم من ${branchName}`,
      ["Technical Back Office"]
    );
    res.json({ id: result.rows[0].id });
  });

  app.post("/api/pending-requests/:id/approve", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    const { id } = req.params;
    const request = await db.get("SELECT * FROM pending_requests WHERE id = $1", [id]) as any;
    
    if (!request || request.status !== 'Pending') {
      return res.status(400).json({ error: "Invalid request" });
    }
    
    const data = JSON.parse(request.data);
    
    try {
      if (request.type === 'hide_unhide') {
        if (data.action === 'UNHIDE') {
          const unhide_at = getCurrentKuwaitTime();
          const productNameFieldId = await getProductNameFieldId();

          for (const id of data.ids) {
            const item = await db.get(`
              SELECT hi.*, fv.value as product_name, br.name as branch_name, b.name as brand_name
              FROM hidden_items hi
              LEFT JOIN product_field_values fv ON hi.product_id = fv.product_id AND fv.field_id = $1
              LEFT JOIN branches br ON hi.branch_id = br.id
              LEFT JOIN brands b ON hi.brand_id = b.id
              WHERE hi.id = $2
            `, [productNameFieldId, id]) as any;

            if (item) {
              await logAction(request.user_id, "UNHIDE", "products", item.product_id, { 
                product_name: item.product_name || 'Unknown Product', 
                brand_name: item.brand_name || 'Unknown Brand',
                branch: item.branch_name || 'All Branches',
                brand_id: item.brand_id,
                branch_id: item.branch_id
              }, null);

              await db.query(`
                INSERT INTO hide_history (
                  user_id, brand_id, branch_id, product_id, action,
                  agent_name, reason, action_to_unhide, comment, requested_at, responsible_party, timestamp
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
              `, [
                request.user_id, item.brand_id, item.branch_id, item.product_id, 'UNHIDE',
                item.agent_name, item.reason, item.action_to_unhide, 
                item.comment, unhide_at, item.responsible_party, unhide_at
              ]);

              await db.query("DELETE FROM hidden_items WHERE id = $1", [id]);
            }
          }
          broadcast({
            type: "NOTIFICATION",
            notificationType: "HIDDEN_ITEM",
            title_en: "Unhide Request Approved",
            title_ar: "تمت الموافقة على طلب الإظهار",
            message_en: `Unhide request approved`,
            message_ar: `تمت الموافقة على طلب إظهار المنتج`,
            role_target: ["Restaurants", "Manager", "Super Visor", "Area Manager"]
          });
          broadcast({ type: "HIDDEN_ITEMS_UPDATED" });
          broadcast({
            type: "NOTIFICATION",
            notificationType: "SYSTEM_ACTION",
            title_en: "Request Approved",
            title_ar: "تمت الموافقة على طلب",
            message_en: `A hide/unhide request has been approved`,
            message_ar: `تمت الموافقة على طلب إخفاء/إظهار`,
          });
        } else if (data.branch_id === null) {
          const branches = await db.all("SELECT id, name FROM branches WHERE brand_id = $1", [data.brand_id]) as { id: number, name: string }[];
          const productNameFieldId = await getProductNameFieldId();
          const brand = await db.get("SELECT name FROM brands WHERE id = $1", [data.brand_id]) as { name: string };

          for (const productId of data.product_ids) {
            const product = await db.get(`
              SELECT fv.value as name
              FROM product_field_values fv
              WHERE fv.product_id = $1 AND fv.field_id = $2
            `, [productId, productNameFieldId]) as { name: string };

            for (const branch of branches) {
              await db.query(`
                INSERT INTO hidden_items (
                  user_id, brand_id, branch_id, product_id, agent_name, reason,
                  action_to_unhide, comment, requested_at, responsible_party
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
              `, [request.user_id, data.brand_id, branch.id, productId, data.agent_name, data.reason, data.action_to_unhide, data.comment, data.requested_at, data.responsible_party]);

              await db.query(`
                INSERT INTO hide_history (
                  user_id, brand_id, branch_id, product_id, action,
                  agent_name, reason, action_to_unhide, comment, requested_at, responsible_party
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              `, [request.user_id, data.brand_id, branch.id, productId, 'HIDE', data.agent_name, data.reason, data.action_to_unhide, data.comment, data.requested_at, data.responsible_party]);

              // Log one HIDE per branch (matching the direct hide path) so each
              // branch's later UNHIDE pairs with it by exact product+branch key.
              await logAction(request.user_id, "HIDE", "products", productId, {
                product_name: product?.name || 'Unknown Product',
                brand_name: brand?.name || 'Unknown Brand',
                branch: branch.name,
                brand_id: data.brand_id,
                branch_id: branch.id,
                reason: data.reason,
                responsible_party: data.responsible_party
              }, null);
            }
          }
          broadcast({
            type: "NOTIFICATION",
            notificationType: "HIDDEN_ITEM",
            title_en: "Hide Request Approved",
            title_ar: "تمت الموافقة على طلب الإخفاء",
            message_en: `Hide request approved`,
            message_ar: `تمت الموافقة على طلب إخفاء المنتج`,
            role_target: ["Restaurants", "Manager", "Super Visor", "Area Manager"],
            user_id: request.user_id
          });
          broadcast({ type: "HIDDEN_ITEMS_UPDATED" });
        } else {
          const productNameFieldId = await getProductNameFieldId();
          const brand = await db.get("SELECT name FROM brands WHERE id = $1", [data.brand_id]) as { name: string };
          const branch = await db.get("SELECT name FROM branches WHERE id = $1", [data.branch_id]) as { name: string };

          for (const productId of data.product_ids) {
            const product = await db.get(`
              SELECT fv.value as name 
              FROM product_field_values fv 
              WHERE fv.product_id = $1 AND fv.field_id = $2
            `, [productId, productNameFieldId]) as { name: string };

            await db.query(`
              INSERT INTO hidden_items (
                user_id, brand_id, branch_id, product_id, agent_name, reason, 
                action_to_unhide, comment, requested_at, responsible_party
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [request.user_id, data.brand_id, data.branch_id, productId, data.agent_name, data.reason, data.action_to_unhide, data.comment, data.requested_at, data.responsible_party]);
            
            await db.query(`
              INSERT INTO hide_history (
                user_id, brand_id, branch_id, product_id, action,
                agent_name, reason, action_to_unhide, comment, requested_at, responsible_party
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [request.user_id, data.brand_id, data.branch_id, productId, 'HIDE', data.agent_name, data.reason, data.action_to_unhide, data.comment, data.requested_at, data.responsible_party]);

            await logAction(request.user_id, "HIDE", "products", productId, {
              product_name: product?.name || 'Unknown Product',
              brand_name: brand?.name || 'Unknown Brand',
              branch: branch?.name || 'Unknown Branch',
              brand_id: data.brand_id,
              branch_id: data.branch_id,
              reason: data.reason,
              responsible_party: data.responsible_party
            }, null);
          }
          broadcast({
            type: "NOTIFICATION",
            notificationType: "HIDDEN_ITEM",
            title_en: "Hide Request Approved",
            title_ar: "تمت الموافقة على طلب الإخفاء",
            message_en: `Hide request approved`,
            message_ar: `تمت الموافقة على طلب إخفاء المنتج`,
            role_target: ["Restaurants", "Manager", "Super Visor", "Area Manager"],
            user_id: request.user_id
          });
          broadcast({ type: "HIDDEN_ITEMS_UPDATED" });
        }
      } else if (request.type === 'busy_branch') {
        if (data.action === 'OPEN') {
          const now = new Date();
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Kuwait',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          });
          const end_time = formatter.format(now);
          
          // Calculate duration
          let total_duration = '0h 0m';
          let total_duration_minutes = 0;
          try {
            const startParts = data.start_time.split(':');
            const endParts = end_time.split(':');
            
            const startTotalMinutes = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
            const endTotalMinutes = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
            
            let diff = endTotalMinutes - startTotalMinutes;
            if (diff < 0) diff += 24 * 60; // handle overnight
            
            const hours = Math.floor(diff / 60);
            const minutes = diff % 60;
            total_duration = `${hours}h ${minutes}m`;
            total_duration_minutes = diff;
          } catch (e) {
            console.error("Error calculating duration", e);
          }

          await db.query(`
            UPDATE busy_period_records 
            SET end_time = $1, total_duration = $2, total_duration_minutes = $3
            WHERE id = $4
          `, [end_time, total_duration, total_duration_minutes, data.id]);

          await logAction((req as any).user.id, "BUSY_UPDATE", "busy_period_records", Number(data.id), null, { 
            brand: data.brand, branch: data.branch, end_time, total_duration, reason_category: data.reason_category, approved_open: true
          });

          broadcast({
            type: "NOTIFICATION",
            notificationType: "BUSY_BRANCH",
            title_en: "Open Request Approved",
            title_ar: "تمت الموافقة على طلب الفتح",
            message_en: `Open branch request approved for ${data.branch}`,
            message_ar: `تمت الموافقة على طلب فتح الفرع لـ ${data.branch}`,
            brand_id: data.brand,
            role_target: ["Restaurants", "Manager", "Super Visor", "Area Manager"],
            user_id: request.user_id
          });
          broadcast({ type: "BUSY_PERIOD_UPDATED" });
        } else {
          // Calculate timer_expires_at from NOW (approval time) if duration is provided
          let timer_expires_at = data.timer_expires_at;
          if (data.timer_duration && Number(data.timer_duration) > 0) {
            timer_expires_at = new Date(Date.now() + Number(data.timer_duration) * 60000).toISOString();
          }

          await db.query(`
            INSERT INTO busy_period_records (
              user_id, date, brand, branch, start_time, end_time, 
              total_duration, total_duration_minutes, reason_category, responsible_party, 
              comment, internal_notes, timer_duration, timer_expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          `, [
            request.user_id, data.date, data.brand, data.branch, data.start_time, data.end_time,
            data.total_duration, data.total_duration_minutes || 0, data.reason_category, data.responsible_party,
            data.comment, data.internal_notes, data.timer_duration, timer_expires_at
          ]);
          broadcast({
            type: "NOTIFICATION",
            notificationType: "BUSY_BRANCH",
            title_en: "Request Approved",
            title_ar: "تمت الموافقة على الطلب",
            message_en: `Busy branch request approved`,
            message_ar: `تمت الموافقة على طلب فرع مشغول`,
            brand_id: data.brand,
            branch_id: data.branch,
            role_target: ["Restaurants", "Manager", "Super Visor", "Area Manager"],
            user_id: request.user_id
          });
          broadcast({ type: "BUSY_PERIOD_CREATED" });
        }
      }
      
      await db.query("UPDATE pending_requests SET status = 'Approved', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [(req as any).user.id, id]);
        
      broadcast({ type: "PENDING_REQUEST_UPDATED" });
      res.json({ success: true });
    } catch (error) {
      console.error("Error approving request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/pending-requests/:id/reject", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    const { id } = req.params;
    const request = await db.get("SELECT * FROM pending_requests WHERE id = $1", [id]) as any;
    if (request) {
      const data = JSON.parse(request.data);
      broadcast({
        type: "NOTIFICATION",
        notificationType: "NEW_REQUEST",
        title_en: "Request Rejected",
        title_ar: "تم رفض الطلب",
        message_en: `Your ${request.type} request was rejected`,
        message_ar: `تم رفض طلبك (${request.type})`,
        brand_id: data.brand_id || data.brand,
        branch_id: data.branch_id || data.branch,
        role_target: ["Restaurants"],
        user_id: request.user_id
      });
    }
    await db.query("UPDATE pending_requests SET status = 'Rejected', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [(req as any).user.id, id]);
      
    broadcast({ type: "PENDING_REQUEST_UPDATED" });
    broadcast({
      type: "NOTIFICATION",
      notificationType: "SYSTEM_ACTION",
      title_en: "Request Rejected",
      title_ar: "تم رفض طلب",
      message_en: `A ${request.type} request has been rejected`,
      message_ar: `تم رفض طلب (${request.type})`,
    });
    res.json({ success: true });
  });

  // Late Order Requests
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN call_center_message TEXT");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN case_type TEXT DEFAULT 'Late Order'");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN dedication_time TIMESTAMP");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN alert_sent INTEGER DEFAULT 0");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN restaurant_response_at TIMESTAMP");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN manager_viewed_at TIMESTAMP");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN manager_responded_at TIMESTAMP");
  } catch (e) {}
  try {
    // Who (which user) sent the office-side response, so the UI shows the real name.
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN responded_by INTEGER");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN restaurant_viewed_at TIMESTAMP");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE late_order_requests ADD COLUMN viewed_at TIMESTAMP");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE pending_requests ADD COLUMN viewed_at TIMESTAMP");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE products ADD COLUMN viewed_at TIMESTAMP");
  } catch (e) {}

  // Late Order Alert Checker
  setInterval(async () => {
    const now = new Date();
    try {
      // Basic check for internal Railway URL to avoid spamming errors
      if (process.env.DATABASE_URL?.includes('postgres.railway.internal')) {
        console.warn("CRITICAL: You are using an INTERNAL Railway URL. Please update DATABASE_URL in Settings to use the PUBLIC URL (DATABASE_PUBLIC_URL).");
        return;
      }

      const pendingAlerts = await db.all(`
        SELECT lo.*, b.name as brand_name, br.name as branch_name
        FROM late_order_requests lo
        JOIN brands b ON lo.brand_id = b.id
        JOIN branches br ON lo.branch_id = br.id
        WHERE lo.case_type = 'Dedication' 
        AND lo.alert_sent = 0
      `) as any[];

      for (const alert of pendingAlerts) {
        if (!alert.dedication_time) continue;
        
        const dTime = new Date(alert.dedication_time);
        if (dTime <= now) {
          // PII delivery: customer_name is in the payload, so target only the
          // originating Call Center user and the Restaurants role for that
          // branch. The browser-side filter narrows further to the actual user.
          broadcast({
            type: "DEDICATION_ALERT",
            role_target: ["Call Center", "Restaurants"],
            data: {
              id: alert.id,
              order_id: alert.order_id,
              customer_name: alert.customer_name,
              brand_name: alert.brand_name,
              branch_name: alert.branch_name,
              branch_id: alert.branch_id,
              call_center_user_id: alert.call_center_user_id,
              brand_id: alert.brand_id
            }
          });

          broadcast({
            type: "NOTIFICATION",
            notificationType: "DEDICATION_ALERT",
            title_en: "Dedication Alert!",
            title_ar: "تنبيه إهداء!",
            message_en: `Time to process dedication for order #${alert.order_id}`,
            message_ar: `حان وقت معالجة الإهداء للطلب رقم #${alert.order_id}`,
            brand_id: alert.brand_id,
            branch_id: alert.branch_id,
            role_target: ["Call Center", "Restaurants", "Manager", "Super Visor"]
          });

          await db.query("UPDATE late_order_requests SET alert_sent = 1 WHERE id = $1", [alert.id]);
        }
      }
    } catch (err) {
      console.error("Error in Late Order Alert Checker:", err);
    }
  }, 10000); // Check every 10 seconds for better precision

  app.get("/api/unread-counts", authenticate, async (req, res) => {
    try {
      const user = (req as any).user;
      const branchIds = await getBranchRestriction(user);
      const brandRestriction = await getBrandRestriction(user);

      // 1. Late Orders
      let lateOrdersQuery = `
        SELECT COUNT(*) as count FROM late_order_requests lo
        JOIN brands b ON lo.brand_id = b.id
        WHERE lo.viewed_at IS NULL
      `;
      const lateParams: any[] = [];
      if (branchIds) {
        lateParams.push(branchIds);
        lateOrdersQuery += ` AND lo.branch_id = ANY($${lateParams.length})`;
      }
      if (brandRestriction) {
        lateParams.push(brandRestriction.brands);
        if (brandRestriction.type === 'include') lateOrdersQuery += ` AND b.name = ANY($${lateParams.length})`;
        else lateOrdersQuery += ` AND b.name != ALL($${lateParams.length})`;
      }
      const lateResult = await db.get(lateOrdersQuery, lateParams) as { count: string };

      // 2. Pending Requests (Hide/Unhide and Busy Branch)
      let pendingQuery = `
        SELECT type, COUNT(*) as count FROM pending_requests pr
        WHERE pr.viewed_at IS NULL AND pr.status = 'Pending'
        GROUP BY type
      `;
      const pendingResult = await db.all(pendingQuery) as { type: string, count: string }[];
      const hideUnhideCount = parseInt(pendingResult.find(r => r.type === 'hide_unhide')?.count || '0');
      const busyBranchCount = parseInt(pendingResult.find(r => r.type === 'busy_branch')?.count || '0');

      // 3. New Products
      let productsQuery = `
        SELECT COUNT(*) as count FROM products p
        JOIN brands b ON p.brand_id = b.id
        WHERE p.viewed_at IS NULL
      `;
      const prodParams: any[] = [];
      if (brandRestriction) {
        prodParams.push(brandRestriction.brands);
        if (brandRestriction.type === 'include') productsQuery += ` AND b.name = ANY($${prodParams.length})`;
        else productsQuery += ` AND b.name != ALL($${prodParams.length})`;
      }
      const prodResult = await db.get(productsQuery, prodParams) as { count: string };

      res.json({
        late_orders: parseInt(lateResult.count),
        hide_unhide: hideUnhideCount,
        busy_periods: busyBranchCount,
        products: parseInt(prodResult.count)
      });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/mark-viewed/:type", authenticate, async (req, res) => {
    try {
      const { type } = req.params;
      const user = (req as any).user;
      const branchIds = await getBranchRestriction(user);
      const brandRestriction = await getBrandRestriction(user);

      if (type === 'late_orders') {
        let query = `UPDATE late_order_requests lo SET viewed_at = CURRENT_TIMESTAMP FROM brands b WHERE lo.brand_id = b.id AND lo.viewed_at IS NULL`;
        const params: any[] = [];
        if (branchIds) { params.push(branchIds); query += ` AND lo.branch_id = ANY($${params.length})`; }
        if (brandRestriction) {
          params.push(brandRestriction.brands);
          if (brandRestriction.type === 'include') query += ` AND b.name = ANY($${params.length})`;
          else query += ` AND b.name != ALL($${params.length})`;
        }
        await db.query(query, params);
        broadcast({ type: "LATE_ORDERS_VIEWED" });
      } else if (type === 'hide_unhide' || type === 'busy_periods') {
        const dbType = type === 'busy_periods' ? 'busy_branch' : 'hide_unhide';
        await db.query("UPDATE pending_requests SET viewed_at = CURRENT_TIMESTAMP WHERE type = $1 AND viewed_at IS NULL", [dbType]);
        broadcast({ type: "PENDING_REQUESTS_VIEWED", requestType: type });
      } else if (type === 'products') {
        let query = `UPDATE products p SET viewed_at = CURRENT_TIMESTAMP FROM brands b WHERE p.brand_id = b.id AND p.viewed_at IS NULL`;
        const params: any[] = [];
        if (brandRestriction) {
          params.push(brandRestriction.brands);
          if (brandRestriction.type === 'include') query += ` AND b.name = ANY($${params.length})`;
          else query += ` AND b.name != ALL($${params.length})`;
        }
        await db.query(query, params);
        broadcast({ type: "PRODUCTS_VIEWED" });
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/late-orders/unread-count", authenticate, async (req, res) => {
    try {
      const user = (req as any).user;
      const branchIds = await getBranchRestriction(user);
      const brandRestriction = await getBrandRestriction(user);

      let query = `
        SELECT COUNT(*) as count 
        FROM late_order_requests lo
        JOIN brands b ON lo.brand_id = b.id
        WHERE lo.viewed_at IS NULL
      `;
      const params: any[] = [];

      if (branchIds) {
        params.push(branchIds);
        query += ` AND lo.branch_id = ANY($${params.length})`;
      }

      if (brandRestriction) {
        params.push(brandRestriction.brands);
        if (brandRestriction.type === 'include') {
          query += ` AND b.name = ANY($${params.length})`;
        } else {
          query += ` AND b.name != ALL($${params.length})`;
        }
      }

      const result = await db.get(query, params) as { count: string };
      res.json({ count: parseInt(result.count) });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/late-orders/mark-viewed", authenticate, async (req, res) => {
    try {
      const user = (req as any).user;
      const branchIds = await getBranchRestriction(user);
      const brandRestriction = await getBrandRestriction(user);

      let query = `
        UPDATE late_order_requests lo
        SET viewed_at = CURRENT_TIMESTAMP
        FROM brands b
        WHERE lo.brand_id = b.id AND lo.viewed_at IS NULL
      `;
      const params: any[] = [];

      if (branchIds) {
        params.push(branchIds);
        query += ` AND lo.branch_id = ANY($${params.length})`;
      }

      if (brandRestriction) {
        params.push(brandRestriction.brands);
        if (brandRestriction.type === 'include') {
          query += ` AND b.name = ANY($${params.length})`;
        } else {
          query += ` AND b.name != ALL($${params.length})`;
        }
      }

      await db.query(query, params);
      broadcast({ type: "LATE_ORDERS_VIEWED" });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/late-orders", authenticate, authorize(["Call Center", "Restaurants", "Technical Back Office", "Operation Manager"]), upload.array('attachments', 6), async (req, res) => {
    try {
      const { brand_id, branch_id, customer_name, customer_phone, order_id, platform, call_center_message, case_type, technical_type, dedication_time, dynamic_values } = req.body;
      
      // Support multiple attachments. Keep attachment_url/type = the first file
      // for backward compatibility with existing single-attachment records/code.
      const files = (req.files as Express.Multer.File[]) || [];
      const attachment_url = files[0] ? `/uploads/${files[0].filename}` : null;
      const attachment_type = files[0] ? files[0].mimetype : null;
      
      // Validation for Dedication. Coerce empty string to null so Postgres doesn't
      // throw 22007 (DateTimeParseError) on non-Dedication cases that send "".
      // See RAILWAY_LOG_ANALYSIS.md N-1.
      let isoDedicationTime: string | null = dedication_time || null;
      if (case_type === 'Dedication' && dedication_time) {
        const dTime = new Date(dedication_time);
        isoDedicationTime = dTime.toISOString();
        const now = new Date();
        const diff = dTime.getTime() - now.getTime();
        const twentyFourHours = 24 * 60 * 60 * 1000;
        
        if (diff < 0) {
          return res.status(400).json({ error: "Dedication time must be in the future" });
        }
        if (diff > twentyFourHours) {
          return res.status(400).json({ error: "Dedication time must be within 24 hours" });
        }
      }

      const result = await db.query(`
        INSERT INTO late_order_requests (call_center_user_id, brand_id, branch_id, customer_name, customer_phone, order_id, platform, call_center_message, case_type, technical_type, dedication_time, created_at, attachment_url, attachment_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id
      `, [
        (req as any).user.id, 
        brand_id, 
        branch_id, 
        customer_name, 
        customer_phone, 
        order_id, 
        platform, 
        call_center_message, 
        case_type || 'Late Order', 
        technical_type, 
        isoDedicationTime, 
        getCurrentKuwaitTime(),
        attachment_url,
        attachment_type
      ]);
      
      const requestId = result.rows[0].id;

      // Store every uploaded file as its own attachment row.
      for (const f of files) {
        await db.query(
          "INSERT INTO late_order_attachments (request_id, url, type) VALUES ($1, $2, $3)",
          [requestId, `/uploads/${f.filename}`, f.mimetype]
        );
      }

      if (dynamic_values && typeof dynamic_values === 'object') {
        for (const [fieldId, value] of Object.entries(dynamic_values)) {
          if (value !== undefined && value !== null) {
            await db.query("INSERT INTO late_order_field_values (request_id, field_id, value) VALUES ($1, $2, $3)", [requestId, fieldId, value.toString()]);
          }
        }
      }

      // Direction-aware: a restaurant-created case alerts the office (which has no
      // brand/branch, so DON'T scope by brand/branch or they'd be filtered out);
      // an office-created case alerts that restaurant branch (scoped).
      const creatorIsRestaurant = (req as any).user.role_name === 'Restaurants';
      const newCaseRecipients = creatorIsRestaurant
        ? ["Technical Back Office", "Call Center", "Manager", "Super Visor", "Operation Manager"]
        : ["Restaurants", "Area Manager", "Manager", "Super Visor"];

      broadcast({
        type: "NOTIFICATION",
        notificationType: "CALL_CENTER",
        title_en: "New Call Center Case",
        title_ar: "حالة كول سنتر جديدة",
        message_en: `New case for order #${order_id}`,
        message_ar: `حالة جديدة للطلب رقم #${order_id}`,
        role_target: newCaseRecipients,
        ...(creatorIsRestaurant ? {} : { brand_id, branch_id }),
        case_id: requestId,
      });

      // Desktop push too (branch-scoped for the restaurant direction).
      const newCasePush = {
        title: "New Call Center Case",
        body: `New case for order #${order_id}`,
        tag: `late-order-${requestId}`,
        data: { type: "LATE_ORDER_MESSAGE", caseId: requestId, url: `/?case=${requestId}` },
      };
      if (creatorIsRestaurant) {
        await sendPushToRoles(newCaseRecipients, newCasePush);
      } else {
        await sendPushToRoles(["Restaurants", "Area Manager"], newCasePush, branch_id);
      }
      broadcast({ type: "LATE_ORDER_CREATED" });
      res.json({ id: requestId });
    } catch (error: any) {
      console.error("Error creating late order:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  app.get("/api/late-orders", authenticate, async (req, res) => {
    const user = (req as any).user;
    const restriction = await getBrandRestriction(user);
    
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    
    const searchPhone = req.query.searchPhone as string;
    const searchOrderId = req.query.searchOrderId as string;
    const brandId = req.query.brandId as string;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const activeTab = req.query.activeTab as string;
    const userId = req.query.userId as string;

    let query = `
      FROM late_order_requests lo
      JOIN users u ON lo.call_center_user_id = u.id
      JOIN roles r ON u.role_id = r.id
      JOIN brands b ON lo.brand_id = b.id
      JOIN branches br ON lo.branch_id = br.id
      LEFT JOIN users ru ON lo.responded_by = ru.id
    `;
    const params: any[] = [];
    const conditions: string[] = [];

    // Role-based base conditions
    if (user.role_name === 'Call Center') {
      if (restriction) {
        const placeholders = restriction.brands.map((_: any, i: number) => `$${params.length + i + 1}`).join(',');
        conditions.push(`b.name ${restriction.type === 'include' ? 'IN' : 'NOT IN'} (${placeholders})`);
        params.push(...restriction.brands);
      } else {
        conditions.push(`(lo.call_center_user_id = $${params.length + 1} OR r.name = 'Restaurants')`);
        params.push(user.id);
      }
    } else if (user.role_name === 'Area Manager') {
      const branchIds = await getBranchRestriction(user);
      if (branchIds && branchIds.length > 0) {
        const placeholders = branchIds.map((_, i) => `$${params.length + i + 1}`).join(',');
        conditions.push(`lo.branch_id IN (${placeholders})`);
        params.push(...branchIds);
      } else {
        conditions.push("1 = 0");
      }
    } else if (user.role_name === 'Restaurants') {
      if (user.branch_id) {
        conditions.push(`lo.branch_id = $${params.length + 1}`);
        params.push(user.branch_id);
      } else if (restriction) {
        const placeholders = restriction.brands.map((_: any, i: number) => `$${params.length + i + 1}`).join(',');
        conditions.push(`b.name ${restriction.type === 'include' ? 'IN' : 'NOT IN'} (${placeholders})`);
        params.push(...restriction.brands);
      } else {
        conditions.push("1 = 0");
      }
    } else if (user.role_name === 'Technical Back Office') {
      // Technical Back Office sees all case types (not just 'Technical'),
      // respecting any brand restriction on the account.
      if (restriction) {
        const placeholders = restriction.brands.map((_: any, i: number) => `$${params.length + i + 1}`).join(',');
        conditions.push(`b.name ${restriction.type === 'include' ? 'IN' : 'NOT IN'} (${placeholders})`);
        params.push(...restriction.brands);
      }
    } else if (user.role_name === 'Manager' || user.role_name === 'Marketing Team' || user.role_name === 'Super Visor') {
      if (restriction) {
        const placeholders = restriction.brands.map((_: any, i: number) => `$${params.length + i + 1}`).join(',');
        conditions.push(`b.name ${restriction.type === 'include' ? 'IN' : 'NOT IN'} (${placeholders})`);
        params.push(...restriction.brands);
      }
    }

    // Additional filters from query params
    if (searchPhone) {
      conditions.push(`lo.customer_phone ILIKE $${params.length + 1}`);
      params.push(`%${searchPhone}%`);
    }
    if (searchOrderId) {
      conditions.push(`lo.order_id ILIKE $${params.length + 1}`);
      params.push(`%${searchOrderId}%`);
    }
    if (brandId) {
      conditions.push(`lo.brand_id = $${params.length + 1}`);
      params.push(brandId);
    }
    if (startDate) {
      conditions.push(`(lo.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= $${params.length + 1}`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`(lo.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date <= $${params.length + 1}`);
      params.push(endDate);
    }
    if (userId) {
      conditions.push(`lo.call_center_user_id = $${params.length + 1}`);
      params.push(userId);
    }

    // Tab filtering logic
    if (activeTab) {
      if (user.role_name === 'Call Center' || user.role_name === 'Technical Back Office') {
        if (activeTab === 'restaurant') {
          conditions.push("r.name = 'Restaurants'");
        } else {
          conditions.push("r.name != 'Restaurants'");
        }
      } else if (user.role_name === 'Restaurants') {
        if (activeTab === 'standard') {
          conditions.push("r.name = 'Restaurants'");
        } else {
          conditions.push("r.name != 'Restaurants'");
        }
      }
    }

    const whereClause = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
    
    // Get total count
    const countResult = await db.get(`SELECT COUNT(*) as total ${query} ${whereClause}`, params);
    const total = parseInt(countResult.total);
    const totalPages = Math.ceil(total / limit);

    // Get paginated data
    const dataQuery = `
      SELECT lo.*, u.username as call_center_name, r.name as creator_role, b.name as brand_name, br.name as branch_name, ru.username as responder_name
      ${query}
      ${whereClause}
      ORDER BY lo.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const requests = await db.all(dataQuery, [...params, limit, offset]) as any[];

    if (requests.length > 0) {
      const requestIds = requests.map(r => r.id);
      const placeholders = requestIds.map((_: any, i: number) => `$${i + 1}`).join(',');
      const fieldValues = await db.all(`
        SELECT fv.*, f.name_en, f.name_ar, f.type
        FROM late_order_field_values fv
        JOIN call_center_form_fields f ON fv.field_id = f.id
        WHERE fv.request_id IN (${placeholders})
      `, requestIds) as any[];

      const attachmentRows = await db.all(`
        SELECT request_id, url, type FROM late_order_attachments
        WHERE request_id IN (${placeholders})
        ORDER BY id ASC
      `, requestIds) as any[];

      requests.forEach(r => {
        r.dynamic_values = fieldValues.filter(fv => fv.request_id === r.id);
        // Unified attachments list: prefer the per-file rows; fall back to the
        // legacy single attachment_url for older records.
        r.attachments = attachmentRows
          .filter(a => a.request_id === r.id)
          .map(a => ({ url: a.url, type: a.type }));
        if (r.attachments.length === 0 && r.attachment_url) {
          r.attachments = [{ url: r.attachment_url, type: r.attachment_type }];
        }
      });
    }

    res.json({
      requests,
      total,
      totalPages,
      page,
      limit
    });
  });

  app.put("/api/late-orders/:id", authenticate, authorize(["Restaurants", "Manager", "Super Visor", "Call Center", "Technical Back Office", "Operation Manager"]), async (req, res) => {
    const { id } = req.params;
    const { status, restaurant_message } = req.body;
    const user = (req as any).user;
    
    let query = "UPDATE late_order_requests SET status = $1, restaurant_message = $2, updated_at = CURRENT_TIMESTAMP";
    const params: any[] = [status, restaurant_message];

    const fromRestaurant = user.role_name === 'Restaurants';
    if (fromRestaurant) {
      query += ", restaurant_response_at = CURRENT_TIMESTAMP";
    } else {
      // Any office-side responder (Manager / Super Visor / Technical Back Office /
      // Call Center / Operation Manager). Record WHO responded so the UI can show
      // the actual employee name instead of a hard-coded "Manager".
      query += ", manager_responded_at = CURRENT_TIMESTAMP, responded_by = $" + (params.length + 1);
      params.push(user.id);
    }

    // Mark the case unread again so the recipient gets an unread bump + highlight.
    query += ", viewed_at = NULL";

    query += " WHERE id = $" + (params.length + 1);
    params.push(id);

    await db.query(query, params);

    // Notify the OTHER party about the new message/reply.
    try {
      const lo = await db.get(`
        SELECT lo.order_id, lo.brand_id, lo.branch_id, b.name AS brand_name, br.name AS branch_name
        FROM late_order_requests lo
        JOIN brands b ON lo.brand_id = b.id
        JOIN branches br ON lo.branch_id = br.id
        WHERE lo.id = $1
      `, [id]) as any;

      if (lo) {
        const orderRef = lo.order_id ? `#${lo.order_id}` : `#${id}`;
        const restaurant = `${lo.brand_name} · ${lo.branch_name}`;
        const sender = fromRestaurant ? restaurant : user.username;
        const preview = (restaurant_message || '').toString().slice(0, 80);
        // Recipients: restaurant reply -> office; office reply -> the restaurant branch.
        const recipients = fromRestaurant
          ? ["Technical Back Office", "Call Center", "Manager", "Super Visor", "Operation Manager"]
          : ["Restaurants"];

        broadcast({
          type: "NOTIFICATION",
          notificationType: "CALL_CENTER",
          title_en: `New message · Order ${orderRef}`,
          title_ar: `رسالة جديدة · طلب ${orderRef}`,
          message_en: `${restaurant} — ${sender}: ${preview}`,
          message_ar: `${restaurant} — ${sender}: ${preview}`,
          role_target: recipients,
          // Only scope by brand/branch when notifying RESTAURANTS (so just that
          // branch is alerted). Office roles (TBO/Call Center/Manager) have no
          // brand/branch, so including these would wrongly filter them out.
          ...(fromRestaurant ? {} : { brand_id: lo.brand_id, branch_id: lo.branch_id }),
          case_id: Number(id),
        });

        const pushPayload = {
          title: `New message · Order ${orderRef}`,
          body: `${restaurant} — ${sender}: ${preview}`,
          tag: `late-order-${id}`,
          data: { type: "LATE_ORDER_MESSAGE", caseId: Number(id), url: `/?case=${id}` },
        };
        if (fromRestaurant) {
          await sendPushToRoles(recipients, pushPayload);
        } else {
          // Only the restaurant users of this branch.
          await sendPushToRoles(["Restaurants"], pushPayload, lo.branch_id);
        }
      }
    } catch (e) {
      console.error("Failed to send case-message notification", e);
    }

    broadcast({ type: "LATE_ORDER_UPDATED", id });
    res.json({ success: true });
  });

  // Call Center Form Configuration
  app.get("/api/call-center/config", authenticate, async (req, res) => {
    const fields = await db.all("SELECT * FROM call_center_form_fields WHERE is_active = 1 ORDER BY display_order");
    const options = await db.all("SELECT * FROM call_center_field_options ORDER BY display_order");
    const technicalTypes = await db.all("SELECT * FROM technical_case_types WHERE is_active = 1");
    const platforms = await db.all("SELECT * FROM call_center_platforms WHERE is_active = 1");
    const caseTypes = await db.all("SELECT * FROM call_center_case_types WHERE is_active = 1");
    const brands = await db.all("SELECT id, name FROM brands");

    res.json({
      fields,
      options,
      technicalTypes,
      platforms,
      caseTypes,
      brands
    });
  });

  app.post("/api/call-center/platforms", authenticate, authorize(["Manager", "Operation Manager"]), async (req, res) => {
    const { name_en, name_ar } = req.body;
    const result = await db.query("INSERT INTO call_center_platforms (name_en, name_ar) VALUES ($1, $2) RETURNING id", [name_en, name_ar]);
    res.json({ id: result.rows[0].id });
  });

  app.delete("/api/call-center/platforms/:id", authenticate, authorize(["Manager", "Operation Manager"]), async (req, res) => {
    await db.query("DELETE FROM call_center_platforms WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  });

  app.post("/api/call-center/case-types", authenticate, authorize(["Manager", "Operation Manager"]), async (req, res) => {
    const { name_en, name_ar } = req.body;
    const result = await db.query("INSERT INTO call_center_case_types (name_en, name_ar) VALUES ($1, $2) RETURNING id", [name_en, name_ar]);
    res.json({ id: result.rows[0].id });
  });

  app.delete("/api/call-center/case-types/:id", authenticate, authorize(["Manager", "Operation Manager"]), async (req, res) => {
    await db.query("DELETE FROM call_center_case_types WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  });

  app.get("/api/call-center/fields", authenticate, async (req, res) => {
    try {
      const fields = await db.all("SELECT * FROM call_center_form_fields ORDER BY display_order ASC");
      const options = await db.all("SELECT * FROM call_center_field_options ORDER BY display_order ASC");
      const technicalTypes = await db.all("SELECT * FROM technical_case_types WHERE is_active = 1 ORDER BY created_at DESC");
      res.json({ fields, options, technicalTypes });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch call center fields" });
    }
  });

  app.post("/api/call-center/technical-types", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    const { name_en, name_ar } = req.body;
    try {
      const result = await db.query("INSERT INTO technical_case_types (name_en, name_ar) VALUES ($1, $2) RETURNING id", [name_en, name_ar]);
      res.json({ id: result.rows[0].id });
    } catch (error) {
      res.status(500).json({ error: "Failed to add technical type" });
    }
  });

  app.delete("/api/call-center/technical-types/:id", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    try {
      await db.query("DELETE FROM technical_case_types WHERE id = $1", [req.params.id]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete technical type" });
    }
  });

  app.post("/api/call-center/fields", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    const { name_en, name_ar, type, is_required, display_order } = req.body;
    try {
      const result = await db.query(`
        INSERT INTO call_center_form_fields (name_en, name_ar, type, is_required, display_order)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [name_en, name_ar, type, is_required || 0, display_order || 0]);
      res.json({ id: result.rows[0].id });
    } catch (error) {
      res.status(500).json({ error: "Failed to create field" });
    }
  });

  app.put("/api/call-center/fields/:id", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    const { name_en, name_ar, type, is_required, display_order, is_active } = req.body;
    try {
      await db.query(`
        UPDATE call_center_form_fields
        SET name_en = $1, name_ar = $2, type = $3, is_required = $4, display_order = $5, is_active = $6
        WHERE id = $7
      `, [name_en, name_ar, type, is_required, display_order, is_active, req.params.id]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to update field" });
    }
  });

  app.delete("/api/call-center/fields/:id", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    try {
      await db.query("DELETE FROM call_center_form_fields WHERE id = $1", [req.params.id]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete field" });
    }
  });

  app.post("/api/call-center/fields/:id/options", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    const { value_en, value_ar, display_order } = req.body;
    try {
      const result = await db.query(`
        INSERT INTO call_center_field_options (field_id, value_en, value_ar, display_order)
        VALUES ($1, $2, $3, $4) RETURNING id
      `, [req.params.id, value_en, value_ar, display_order || 0]);
      res.json({ id: result.rows[0].id });
    } catch (error) {
      res.status(500).json({ error: "Failed to add option" });
    }
  });

  app.delete("/api/call-center/fields/options/:id", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    try {
      await db.query("DELETE FROM call_center_field_options WHERE id = $1", [req.params.id]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete option" });
    }
  });

  app.post("/api/late-orders/:id/view", authenticate, authorize(["Restaurants", "Manager", "Super Visor"]), async (req, res) => {
    const { id } = req.params;
    const user = (req as any).user;
    
    if (user.role_name === 'Restaurants') {
      await db.query("UPDATE late_order_requests SET restaurant_viewed_at = CURRENT_TIMESTAMP WHERE id = $1 AND restaurant_viewed_at IS NULL", [id]);
    } else if (user.role_name === 'Manager') {
      await db.query("UPDATE late_order_requests SET manager_viewed_at = CURRENT_TIMESTAMP WHERE id = $1 AND manager_viewed_at IS NULL", [id]);
    }
    
    broadcast({ type: "LATE_ORDER_UPDATED", id });
    res.json({ success: true });
  });

  // Login rate limit: 5 attempts per 15 minutes per IP. Counts only failed attempts
  // (skipSuccessfulRequests) so a legitimate user typing wrong password 5 times
  // doesn't lock themselves out for the rest of the day after one successful login.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many login attempts. Try again in 15 minutes." },
  });

  // Auth Routes
  app.post("/api/login", loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    // Note: do NOT log usernames here. Auth events should go to audit_logs only.
    try {
      const user = await db.get(`
        SELECT u.*, r.name as role_name, b.name as brand_name, br.name as branch_name
        FROM users u
        JOIN roles r ON u.role_id = r.id
        LEFT JOIN brands b ON u.brand_id = b.id
        LEFT JOIN branches br ON u.branch_id = br.id
        WHERE u.username = $1 AND u.is_active = 1
      `, [username]) as any;

      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const isMatch = await bcrypt.compare(password, user.password_hash);

      if (!isMatch) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const userBrands = await db.all("SELECT brand_id FROM user_brands WHERE user_id = $1", [user.id]) as any[];
      const brandIds = userBrands.map(ub => ub.brand_id);

      const userBranches = await db.all("SELECT branch_id FROM user_branches WHERE user_id = $1", [user.id]) as any[];
      const branchIds = userBranches.map(ub => ub.branch_id);
      
      const userData = { 
        id: user.id, 
        username: user.username, 
        role_id: user.role_id, 
        role_name: user.role_name,
        brand_id: user.brand_id,
        brand_name: user.brand_name,
        branch_id: user.branch_id,
        branch_name: user.branch_name,
        brand_ids: brandIds,
        branch_ids: branchIds
      };
      
      const token = jwt.sign(userData, JWT_SECRET, { expiresIn: "8h", algorithm: "HS256" });
      // Set the JWT as an httpOnly cookie. Token is NOT echoed in the response
      // body, so XSS can't read it from localStorage like in v1 (S-13/S-14).
      res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions);
      res.json({ user: userData });
    } catch (error: any) {
      console.error(`Login error:`, error?.code || error?.message || "unknown");
      if (error.code === 'EAI_AGAIN' || error.message?.includes('getaddrinfo')) {
        return res.status(500).json({ 
          error: "Database connection error. If you are using Railway, ensure you use the PUBLIC connection string (proxy.railway.app) instead of the INTERNAL one (postgres.railway.internal).",
          details: error.message
        });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Logout — clear the auth cookie. Doesn't require auth itself so an expired
  // session can still log out cleanly.
  app.post("/api/logout", (_req, res) => {
    res.clearCookie(AUTH_COOKIE_NAME, { ...authCookieOptions, maxAge: undefined });
    res.json({ success: true });
  });

  // Brands Routes
  app.get("/api/brands", authenticate, async (req, res) => {
    const { all } = req.query;
    const restriction = all === 'true' ? null : await getBrandRestriction((req as any).user);
    let brands;
    if (restriction) {
      const placeholders = restriction.brands.map((_: any, i: number) => `$${i + 1}`).join(',');
      if (restriction.type === 'include') {
        brands = await db.all(`SELECT * FROM brands WHERE name IN (${placeholders}) ORDER BY name ASC`, restriction.brands);
      } else {
        brands = await db.all(`SELECT * FROM brands WHERE name NOT IN (${placeholders}) ORDER BY name ASC`, restriction.brands);
      }
    } else {
      brands = await db.all("SELECT * FROM brands ORDER BY name ASC");
    }
    res.json(brands);
  });

  app.post("/api/brands", authenticate, authorize(["Technical Back Office", "Manager"]), async (req, res) => {
    const { name } = req.body;
    if (!ALLOWED_BRANDS.includes(name.toUpperCase())) {
      return res.status(400).json({ error: "Unauthorized brand name. Only specific brands are allowed." });
    }
    try {
      const result = await db.query("INSERT INTO brands (name) VALUES ($1) RETURNING id", [name.toUpperCase()]);
      const brandId = Number(result.rows[0].id);
      await logAction((req as any).user.id, "CREATE", "brands", brandId, null, { name: name.toUpperCase() });

      broadcast({
        type: "NOTIFICATION",
        notificationType: "SYSTEM_ACTION",
        title_en: "New Brand Created",
        title_ar: "تم إنشاء براند جديد",
        message_en: `New brand ${name.toUpperCase()} has been created by ${(req as any).user.username}`,
        message_ar: `تم إنشاء براند جديد ${name.toUpperCase()} من قبل ${(req as any).user.username}`,
      });

      res.json({ id: brandId, name: name.toUpperCase() });
    } catch (e) {
      res.status(400).json({ error: "Brand already exists" });
    }
  });

  app.delete("/api/brands/:id", authenticate, authorize(["Technical Back Office", "Manager"]), async (req, res) => {
    await db.query("DELETE FROM brands WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  });

  // Dynamic Fields Routes
  app.get("/api/fields", authenticate, async (req, res) => {
    const fields = await db.all("SELECT * FROM dynamic_fields ORDER BY field_order ASC");
    const options = await db.all("SELECT * FROM field_options");
    
    const fieldsWithOptions = fields.map(field => ({
      ...field,
      options: options.filter(opt => opt.field_id === field.id)
    }));
    
    res.json({ fields: fieldsWithOptions, options });
  });

  app.post("/api/fields", authenticate, authorize(["Manager"]), async (req, res) => {
    const { name_en, name_ar, type, is_mandatory } = req.body;
    const result = await db.query("INSERT INTO dynamic_fields (name_en, name_ar, type, is_mandatory) VALUES ($1, $2, $3, $4) RETURNING id", [name_en, name_ar, type, is_mandatory ? 1 : 0]);
    res.json({ id: result.rows[0].id });
  });

  app.put("/api/fields/:id", authenticate, authorize(["Manager"]), async (req, res) => {
    const { name_en, name_ar, type, is_mandatory } = req.body;
    await db.query("UPDATE dynamic_fields SET name_en = $1, name_ar = $2, type = $3, is_mandatory = $4 WHERE id = $5", [name_en, name_ar, type, is_mandatory ? 1 : 0, req.params.id]);
    res.json({ success: true });
  });

  app.delete("/api/fields/options/:id", authenticate, authorize(["Manager", "Technical Back Office"]), async (req, res) => {
    await db.query("DELETE FROM field_options WHERE id = $1", [req.params.id]);
    broadcast({ type: 'FIELDS_UPDATED' });
    res.json({ success: true });
  });

  app.delete("/api/fields/:id", authenticate, authorize(["Manager"]), async (req, res) => {
    const fieldId = req.params.id;
    try {
      const result = await db.query("DELETE FROM dynamic_fields WHERE id = $1", [fieldId]);
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Field not found" });
      }

      broadcast({ type: 'FIELDS_UPDATED' });
      res.json({ success: true });
    } catch (error: any) {
      console.error("Delete field error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/fields/:id/options", authenticate, authorize(["Manager", "Technical Back Office"]), async (req, res) => {
    const { value_en, value_ar, price } = req.body;
    const fieldId = req.params.id;
    const result = await db.query("INSERT INTO field_options (field_id, value_en, value_ar, price) VALUES ($1, $2, $3, $4) RETURNING id", [fieldId, value_en, value_ar, price || 0]);
    broadcast({ type: 'FIELDS_UPDATED' });
    res.json({ id: result.rows[0].id });
  });

  // Products Routes
  app.get("/api/products", authenticate, async (req, res) => {
    const { brand_id, all, page = '1', limit = '20', search, code, days } = req.query;
    const restriction = all === 'true' ? null : await getBrandRestriction((req as any).user);
    const pageNum = parseInt(page as string) || 1;
    const limitNum = parseInt(limit as string) || 20;
    const offset = (pageNum - 1) * limitNum;
    
    let baseQuery = `
      FROM products p
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN users u ON p.created_by = u.id
      LEFT JOIN product_codes pc ON p.id = pc.product_id
    `;
    const params: any[] = [];
    const conditions: string[] = [];

    if (brand_id) {
      conditions.push("p.brand_id = $" + (params.length + 1));
      params.push(brand_id);
    }

    if (search) {
      // Search in product name (from field values) or brand name
      conditions.push(`(
        EXISTS (
          SELECT 1 FROM product_field_values fv 
          WHERE fv.product_id = p.id AND LOWER(fv.value) LIKE LOWER($${params.length + 1})
        ) OR LOWER(b.name) LIKE LOWER($${params.length + 1})
      )`);
      params.push(`%${search}%`);
    }

    if (code) {
      conditions.push("LOWER(pc.code) LIKE LOWER($" + (params.length + 1) + ")");
      params.push(`%${code}%`);
    }

    if (days && days !== 'all') {
      if (days === 'today') {
        conditions.push("p.created_at >= CURRENT_DATE");
      } else {
        const daysNum = parseInt(days as string);
        if (!isNaN(daysNum)) {
          conditions.push(`p.created_at >= CURRENT_TIMESTAMP - INTERVAL '${daysNum} days'`);
        }
      }
    }

    if (restriction) {
      const placeholders = restriction.brands.map((_: any, i: number) => `$${params.length + i + 1}`).join(',');
      if (restriction.type === 'include') {
        conditions.push(`b.name IN (${placeholders})`);
      } else {
        conditions.push(`b.name NOT IN (${placeholders})`);
      }
      params.push(...restriction.brands);
    }

    let whereClause = "";
    if (conditions.length > 0) {
      whereClause = " WHERE " + conditions.join(" AND ");
    }

    // Get total count for pagination
    const countResult = await db.get(`SELECT COUNT(*) as total ${baseQuery} ${whereClause}`, params);
    const total = parseInt(countResult.total);

    let query = `
      SELECT p.*, b.name as brand_name, pc.code as product_code, u.username as creator_name
      ${baseQuery}
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    
    const products = await db.all(query, [...params, limitNum, offset]) as any[];
    const productIds = products.map(p => p.id);
    
    if (productIds.length === 0) {
      return res.json({ products: [], fieldValues: [], total, page: pageNum, totalPages: Math.ceil(total / limitNum) });
    }

    const productNameFieldId = await getProductNameFieldId();
    
    const placeholders = productIds.map((_: any, i: number) => `$${i + 1}`).join(',');
    
    const fieldValues = await db.all(`SELECT * FROM product_field_values WHERE product_id IN (${placeholders})`, productIds);
    const modifierGroups = await db.all(`SELECT * FROM modifier_groups WHERE product_id IN (${placeholders})`, productIds);
    const groupIds = modifierGroups.map((mg: any) => mg.id);
    
    let modifierOptions: any[] = [];
    if (groupIds.length > 0) {
      const groupPlaceholders = groupIds.map((_: any, i: number) => `$${i + 1}`).join(',');
      modifierOptions = await db.all(`SELECT * FROM modifier_options WHERE group_id IN (${groupPlaceholders})`, groupIds);
    }

    const productChannels = await db.all(`SELECT * FROM product_channels WHERE product_id IN (${placeholders})`, productIds);
    
    // Efficiently map related data to products
    const filteredProducts = products.map((p: any) => {
      const pModifiers = modifierGroups
        .filter((mg: any) => mg.product_id === p.id)
        .map((mg: any) => ({
          ...mg,
          options: modifierOptions.filter((mo: any) => mo.group_id === mg.id)
        }));

      const pChannels = productChannels.filter((pc: any) => pc.product_id === p.id).map((pc: any) => pc.channel_name);

      const result = { ...p, modifierGroups: pModifiers, channels: pChannels };
      
      if ((req as any).user.role_name.startsWith("Marketing")) {
        delete result.product_code;
      }
      
      return result;
    });

    res.json({ 
      products: filteredProducts, 
      fieldValues,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum)
    });
  });

  app.post("/api/products/:id/toggle-offline", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    const { id } = req.params;
    const product = await db.get("SELECT is_offline FROM products WHERE id = $1", [id]) as any;
    if (!product) return res.status(404).json({ error: "Product not found" });

    const newStatus = product.is_offline ? 0 : 1;
    await db.query("UPDATE products SET is_offline = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [newStatus, id]);
    
    await logAction((req as any).user.id, "UPDATE", "products", Number(id), null, { is_offline: newStatus });
    
    // Broadcast update
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'PRODUCT_UPDATED', id }));
      }
    });

    res.json({ success: true, is_offline: newStatus });
  });

  app.post("/api/products", authenticate, authorize(["Marketing Team", "Technical Team", "Technical Back Office", "Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    const { brand_id, fieldValues, modifierGroups, channels } = req.body;
    
    // Brand Restriction Check
    const restriction = await getBrandRestriction((req as any).user);
    if (restriction) {
      const brand = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as { name: string };
      if (restriction.type === 'include') {
        if (!restriction.brands.includes(brand.name)) {
          return res.status(403).json({ error: "You are not authorized to add products for this brand" });
        }
      } else {
        if (restriction.brands.includes(brand.name)) {
          return res.status(403).json({ error: "You are not authorized to add products for this brand" });
        }
      }
    }

    try {
      const productId = await db.transaction(async (client) => {
        const productResult = await client.query("INSERT INTO products (brand_id, created_by) VALUES ($1, $2) RETURNING id", [brand_id, (req as any).user.id]);
        const productId = productResult.rows[0].id;
        
        // Save dynamic field values
        for (const [fieldId, value] of Object.entries(fieldValues)) {
          await client.query("INSERT INTO product_field_values (product_id, field_id, value) VALUES ($1, $2, $3)", [productId, fieldId, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
        }

        // Save modifier groups
        if (modifierGroups && Array.isArray(modifierGroups)) {
          for (const group of modifierGroups) {
            const groupResult = await client.query(
              "INSERT INTO modifier_groups (product_id, name_en, name_ar, selection_type, is_required, min_selection, max_selection, code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
              [
                productId,
                group.name_en,
                group.name_ar,
                group.selection_type || 'single',
                group.is_required ? 1 : 0,
                group.min_selection || 0,
                group.max_selection || 1,
                group.code || null
              ]
            );
            const groupId = groupResult.rows[0].id;

            if (group.options && Array.isArray(group.options)) {
              for (const option of group.options) {
                await client.query("INSERT INTO modifier_options (group_id, name_en, name_ar, price_adjustment, code) VALUES ($1, $2, $3, $4, $5)", [groupId, option.name_en, option.name_ar, option.price_adjustment || 0, option.code || null]);
              }
            }
          }
        }

        // Save channels
        if (channels && Array.isArray(channels)) {
          for (const channel of channels) {
            await client.query("INSERT INTO product_channels (product_id, channel_name) VALUES ($1, $2)", [productId, channel]);
          }
        }
        
        return productId;
      });

      const brand = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as { name: string };
      const productNameFieldId = await getProductNameFieldId();
      const productName = fieldValues[productNameFieldId.toString()] || "Unknown Product";
      await logAction((req as any).user.id, "CREATE", "products", Number(productId), null, { 
        product_name: productName, 
        brand_name: brand?.name || 'Unknown Brand',
        brand_id, 
        fieldValues, 
        modifierGroups, 
        channels 
      });
      broadcast({ type: "PRODUCT_CREATED", productId });
      broadcast({
        type: "NOTIFICATION",
        notificationType: "SYSTEM_ACTION",
        title_en: "New Product Added",
        title_ar: "تم إضافة منتج جديد",
        message_en: `${productName} has been added to ${brand?.name || 'Unknown Brand'}`,
        message_ar: `تم إضافة ${productName} إلى ${brand?.name || 'Unknown Brand'}`,
        user_id: (req as any).user.id
      });
      res.json({ id: productId });
    } catch (error) {
      console.error("Create product error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/products/bulk-import", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor"]), async (req, res) => {
    const { brand_id, products } = req.body;
    
    if (!brand_id || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: "Invalid request data" });
    }

    try {
      // Brand Restriction Check
      const restriction = await getBrandRestriction((req as any).user);
      if (restriction) {
        const brand = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as { name: string };
        if (!brand) {
          return res.status(400).json({ error: "Invalid brand selected" });
        }
        if (restriction.type === 'include') {
          if (!restriction.brands.includes(brand.name)) {
            return res.status(403).json({ error: "You are not authorized to add products for this brand" });
          }
        } else {
          if (restriction.brands.includes(brand.name)) {
            return res.status(403).json({ error: "You are not authorized to add products for this brand" });
          }
        }
      }

      const results = await db.transaction(async (client) => {
        const importedIds = [];
        const fields = await client.query("SELECT id, name_en FROM dynamic_fields").then((res: any) => res.rows);
        const fieldMap: Record<string, number> = {};
        fields.forEach((f: any) => {
          fieldMap[f.name_en] = f.id;
        });

        for (const p of products) {
          const productResult = await client.query("INSERT INTO products (brand_id, created_by) VALUES ($1, $2) RETURNING id", [parseInt(brand_id), (req as any).user.id]);
          const productId = productResult.rows[0].id;
          importedIds.push(productId);

          // Map Excel columns to field IDs
          const fieldValues: Record<number, any> = {};
          if (p['Product Name En'] !== undefined && fieldMap['Product Name (EN)']) fieldValues[fieldMap['Product Name (EN)']] = p['Product Name En'];
          if (p['Category En'] !== undefined && fieldMap['Category Name (EN)']) fieldValues[fieldMap['Category Name (EN)']] = p['Category En'];
          if (p['description En'] !== undefined && fieldMap['Description (EN)']) fieldValues[fieldMap['Description (EN)']] = p['description En'];
          if (p['price'] !== undefined && fieldMap['Price']) fieldValues[fieldMap['Price']] = p['price'];
          if (p['Product_Arabic'] !== undefined && fieldMap['Product Name (AR)']) fieldValues[fieldMap['Product Name (AR)']] = p['Product_Arabic'];
          if (p['Category Arabic'] !== undefined && fieldMap['Category Name (AR)']) fieldValues[fieldMap['Category Name (AR)']] = p['Category Arabic'];
          if (p['description_Arabic'] !== undefined && fieldMap['Description (AR)']) fieldValues[fieldMap['Description (AR)']] = p['description_Arabic'];

          for (const [fieldId, value] of Object.entries(fieldValues)) {
            if (value !== null && value !== undefined && value !== '') {
              await client.query("INSERT INTO product_field_values (product_id, field_id, value) VALUES ($1, $2, $3)", [productId, parseInt(fieldId), String(value)]);
            }
          }

          // Save PLU to product_codes
          if (p['PLU']) {
            await client.query("INSERT INTO product_codes (product_id, code, updated_by) VALUES ($1, $2, $3)", [productId, String(p['PLU']), (req as any).user.id]);
          }

          // Default channels
          const defaultChannels = ['Talabat', 'Keeta', 'Jahez', 'Deliveroo', 'Call Center', 'Web Site', 'Walk In', 'V-thru'];
          for (const channel of defaultChannels) {
            await client.query("INSERT INTO product_channels (product_id, channel_name) VALUES ($1, $2)", [productId, channel]);
          }
        }
        return importedIds;
      });

      broadcast({ type: "PRODUCT_CREATED" });
      res.json({ success: true, count: results.length });
    } catch (error) {
      console.error("Bulk import error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
    }
  });

  app.put("/api/products/:id", authenticate, authorize(["Marketing Team", "Technical Team", "Technical Back Office", "Manager", "Super Visor", "Restaurants", "Operation Manager"]), async (req, res) => {
    const { fieldValues, modifierGroups, channels } = req.body;
    const productId = req.params.id;

    // Brand Restriction Check
    const restriction = await getBrandRestriction((req as any).user);
    if (restriction) {
      const product = await db.get("SELECT brand_id FROM products WHERE id = $1", [productId]) as { brand_id: number };
      const brand = await db.get("SELECT name FROM brands WHERE id = $1", [product.brand_id]) as { name: string };
      if (restriction.type === 'include') {
        if (!restriction.brands.includes(brand.name)) {
          return res.status(403).json({ error: "You are not authorized to edit products for this brand" });
        }
      } else {
        if (restriction.brands.includes(brand.name)) {
          return res.status(403).json({ error: "You are not authorized to edit products for this brand" });
        }
      }
    }
    
    try {
      await db.transaction(async (client) => {
        if ((req as any).user.role_name === 'Restaurants') {
          // Restricted update for Restaurants: Only Ingredients
          const ingredientsField = await db.get("SELECT id FROM dynamic_fields WHERE name_en = 'Ingredients'") as { id: number } | undefined;
          if (ingredientsField && fieldValues && fieldValues[ingredientsField.id] !== undefined) {
            const exists = await db.get("SELECT id FROM product_field_values WHERE product_id = $1 AND field_id = $2", [productId, ingredientsField.id]) as { id: number } | undefined;
            if (exists) {
              await client.query("UPDATE product_field_values SET value = $1 WHERE id = $2", [String(fieldValues[ingredientsField.id]), exists.id]);
            } else {
              await client.query("INSERT INTO product_field_values (product_id, field_id, value) VALUES ($1, $2, $3)", [productId, ingredientsField.id, String(fieldValues[ingredientsField.id])]);
            }
          }
        } else {
          // Full update for other roles
          await client.query("DELETE FROM product_field_values WHERE product_id = $1", [productId]);
          for (const [fieldId, value] of Object.entries(fieldValues)) {
            await client.query("INSERT INTO product_field_values (product_id, field_id, value) VALUES ($1, $2, $3)", [productId, fieldId, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
          }

          await client.query("DELETE FROM modifier_groups WHERE product_id = $1", [productId]);
          if (modifierGroups && Array.isArray(modifierGroups)) {
            for (const group of modifierGroups) {
              const groupResult = await client.query(
                "INSERT INTO modifier_groups (product_id, name_en, name_ar, selection_type, is_required, min_selection, max_selection, code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
                [
                  productId,
                  group.name_en,
                  group.name_ar,
                  group.selection_type || 'single',
                  group.is_required ? 1 : 0,
                  group.min_selection || 0,
                  group.max_selection || 1,
                  group.code || null
                ]
              );
              const groupId = groupResult.rows[0].id;

              if (group.options && Array.isArray(group.options)) {
                for (const option of group.options) {
                  await client.query("INSERT INTO modifier_options (group_id, name_en, name_ar, price_adjustment, code) VALUES ($1, $2, $3, $4, $5)", [groupId, option.name_en, option.name_ar, option.price_adjustment || 0, option.code || null]);
                }
              }
            }
          }

          await client.query("DELETE FROM product_channels WHERE product_id = $1", [productId]);
          if (channels && Array.isArray(channels)) {
            for (const channel of channels) {
              await client.query("INSERT INTO product_channels (product_id, channel_name) VALUES ($1, $2)", [productId, channel]);
            }
          }
        }

        await client.query("UPDATE products SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [productId]);
      });

      const product = await db.get("SELECT brand_id FROM products WHERE id = $1", [productId]) as { brand_id: number };
      const brand = await db.get("SELECT name FROM brands WHERE id = $1", [product.brand_id]) as { name: string };
      const productNameFieldId = await getProductNameFieldId();
      const productName = fieldValues[productNameFieldId.toString()] || "Unknown Product";
      await logAction((req as any).user.id, "UPDATE", "products", Number(productId), null, { 
        product_name: productName, 
        brand_name: brand?.name || 'Unknown Brand',
        fieldValues, 
        modifierGroups, 
        channels 
      });
      broadcast({ type: "PRODUCT_UPDATED", productId });
      broadcast({
        type: "NOTIFICATION",
        notificationType: "SYSTEM_ACTION",
        title_en: "Product Updated",
        title_ar: "تم تحديث منتج",
        message_en: `${productName} in ${brand?.name || 'Unknown Brand'} has been updated`,
        message_ar: `تم تحديث ${productName} في ${brand?.name || 'Unknown Brand'}`,
        user_id: (req as any).user.id
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Update product error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/products/:id", authenticate, authorize(["Marketing Team", "Technical Team", "Technical Back Office", "Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    await db.query("DELETE FROM products WHERE id = $1", [req.params.id]);
    await db.query("DELETE FROM product_field_values WHERE product_id = $1", [req.params.id]);
    res.json({ success: true });
  });

  // Product Codes (Coding Team)
  app.post("/api/products/:id/code", authenticate, authorize(["Coding Team", "Technical Team", "Technical Back Office", "Manager", "Super Visor"]), async (req, res) => {
    const { productCode, modifierGroups } = req.body;
    const productId = req.params.id;
    
    try {
      await db.transaction(async (client) => {
        // 1. Product Code
        const existingProductCode = await db.get("SELECT id FROM product_codes WHERE product_id = $1", [productId]);
        if (existingProductCode) {
          await client.query("UPDATE product_codes SET code = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE product_id = $3", [productCode, (req as any).user.id, productId]);
        } else {
          await client.query("INSERT INTO product_codes (product_id, code, updated_by) VALUES ($1, $2, $3)", [productId, productCode, (req as any).user.id]);
        }

        // 2. Modifier Groups and Options Codes
        if (modifierGroups && Array.isArray(modifierGroups)) {
          for (const group of modifierGroups) {
            await client.query("UPDATE modifier_groups SET code = $1 WHERE id = $2", [group.code, group.id]);
            if (group.options && Array.isArray(group.options)) {
              for (const option of group.options) {
                await client.query("UPDATE modifier_options SET code = $1 WHERE id = $2", [option.code, option.id]);
              }
            }
          }
        }
      });
      
      broadcast({ type: "CODE_UPDATED", productId });
      await logAction((req as any).user.id, "UPDATE_CODES", "products", Number(productId), null, { productCode, modifierGroups });
      res.json({ success: true });
    } catch (error) {
      console.error("Update product code error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // User Management
  app.post("/api/notifications/subscribe", authenticate, async (req, res) => {
    const subscription = req.body;
    const userId = (req as any).user.id;

    try {
      const existing = await db.get("SELECT id FROM push_subscriptions WHERE user_id = $1 AND subscription = $2", [userId, JSON.stringify(subscription)]);
      if (!existing) {
        await db.query("INSERT INTO push_subscriptions (user_id, subscription) VALUES ($1, $2)", [userId, JSON.stringify(subscription)]);
      }
      res.status(201).json({});
    } catch (error) {
      console.error("Error saving push subscription:", error);
      res.status(500).json({ error: "Failed to subscribe" });
    }
  });

  app.get("/api/notifications/vapid-public-key", (req, res) => {
    res.json({ publicKey: publicVapidKey });
  });

  try {
    await db.exec("ALTER TABLE users ADD COLUMN branch_id INTEGER REFERENCES branches(id)");
  } catch (e) {}

  // User Management
  app.get("/api/roles", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    const roles = await db.all("SELECT * FROM roles");
    res.json(roles);
  });

  app.get("/api/users", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    const users = await db.all(`
      SELECT u.id, u.username, u.role_id, u.brand_id, u.branch_id, u.is_active, r.name as role_name, b.name as brand_name, br.name as branch_name 
      FROM users u 
      JOIN roles r ON u.role_id = r.id
      LEFT JOIN brands b ON u.brand_id = b.id
      LEFT JOIN branches br ON u.branch_id = br.id
    `) as any[];

    const usersWithDetails = [];
    for (const user of users) {
      const brands = await db.all(`
        SELECT b.id, b.name 
        FROM user_brands ub 
        JOIN brands b ON ub.brand_id = b.id 
        WHERE ub.user_id = $1
      `, [user.id]) as { id: number, name: string }[];

      const branches = await db.all(`
        SELECT b.id, b.name 
        FROM user_branches ub 
        JOIN branches b ON ub.branch_id = b.id 
        WHERE ub.user_id = $1
      `, [user.id]) as { id: number, name: string }[];
      
      usersWithDetails.push({
        ...user,
        brand_ids: brands.map(b => b.id),
        brand_names: brands.map(b => b.name),
        branch_ids: branches.map(b => b.id),
        branch_names: branches.map(b => b.name)
      });
    }

    res.json(usersWithDetails);
  });

  app.post("/api/users", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    const { username, password, role_id, brand_id, branch_id, brand_ids, branch_ids } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);
    try {
      const userId = await db.transaction(async (client) => {
        const result = await client.query("INSERT INTO users (username, password_hash, role_id, brand_id, branch_id) VALUES ($1, $2, $3, $4, $5) RETURNING id", [username, hashedPassword, role_id, brand_id || null, branch_id || null]);
        const newUserId = result.rows[0].id;

        broadcast({
          type: "NOTIFICATION",
          notificationType: "SYSTEM_ACTION",
          title_en: "New User Created",
          title_ar: "تم إنشاء مستخدم جديد",
          message_en: `New user ${username} has been created by ${(req as any).user.username}`,
          message_ar: `تم إنشاء مستخدم جديد ${username} من قبل ${(req as any).user.username}`,
        });

        if (brand_ids && Array.isArray(brand_ids)) {
          for (const bid of brand_ids) {
            await client.query("INSERT INTO user_brands (user_id, brand_id) VALUES ($1, $2)", [newUserId, bid]);
          }
        }
        if (branch_ids && Array.isArray(branch_ids)) {
          for (const bid of branch_ids) {
            await client.query("INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)", [newUserId, bid]);
          }
        }
        return newUserId;
      });

      res.json({ id: userId });
    } catch (e) {
      console.error("Create user error:", e);
      res.status(400).json({ error: "Username already exists" });
    }
  });

  app.put("/api/users/:id", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    const { is_active, role_id, username, password, brand_id, branch_id, brand_ids, branch_ids } = req.body;
    const userId = req.params.id;
    
    try {
      await db.transaction(async (client) => {
        if (password) {
          const hashedPassword = bcrypt.hashSync(password, 10);
          await client.query("UPDATE users SET username = $1, password_hash = $2, is_active = $3, role_id = $4, brand_id = $5, branch_id = $6 WHERE id = $7", 
            [username, hashedPassword, is_active ? 1 : 0, role_id, brand_id || null, branch_id || null, userId]);
        } else {
          await client.query("UPDATE users SET username = $1, is_active = $2, role_id = $3, brand_id = $4, branch_id = $5 WHERE id = $6", 
            [username, is_active ? 1 : 0, role_id, brand_id || null, branch_id || null, userId]);
        }

        // Update multiple brands
        await client.query("DELETE FROM user_brands WHERE user_id = $1", [userId]);
        if (brand_ids && Array.isArray(brand_ids)) {
          for (const bid of brand_ids) {
            await client.query("INSERT INTO user_brands (user_id, brand_id) VALUES ($1, $2)", [userId, bid]);
          }
        }

        // Update multiple branches
        await client.query("DELETE FROM user_branches WHERE user_id = $1", [userId]);
        if (branch_ids && Array.isArray(branch_ids)) {
          for (const bid of branch_ids) {
            await client.query("INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)", [userId, bid]);
          }
        }
      });

      broadcast({
        type: "NOTIFICATION",
        notificationType: "SYSTEM_ACTION",
        title_en: "User Updated",
        title_ar: "تم تحديث مستخدم",
        message_en: `User ${username || userId} has been updated by ${(req as any).user.username}`,
        message_ar: `تم تحديث المستخدم ${username || userId} من قبل ${(req as any).user.username}`,
      });

      res.json({ success: true });
    } catch (e) {
      console.error("Update user error:", e);
      res.status(400).json({ error: "Username already exists or update failed" });
    }
  });

  app.delete("/api/users/:id", authenticate, authorize(["Manager", "Super Visor"]), async (req, res) => {
    const userId = req.params.id;
    // Prevent deleting self
    if (Number(userId) === (req as any).user.id) {
      return res.status(400).json({ error: "Cannot delete yourself" });
    }
    await db.query("DELETE FROM users WHERE id = $1", [userId]);
    res.json({ success: true });
  });

  // Audit Logs
  app.get("/api/audit-logs", authenticate, authorize(["Technical Back Office", "Manager", "Call Center", "Super Visor", "Restaurants", "Area Manager", "Operation Manager"]), async (req, res) => {
    const restriction = await getBrandRestriction((req as any).user);
    const logs = await db.all(`
      SELECT a.*, u.username 
      FROM audit_logs a 
      LEFT JOIN users u ON a.user_id = u.id 
      WHERE (a.action IN ('HIDE', 'UNHIDE', 'EDIT_HIDDEN_ITEM'))
        AND (a.target_table IN ('products', 'hidden_items'))
      ORDER BY timestamp DESC
    `);

    let filteredLogs = logs;
    if (restriction) {
      filteredLogs = logs.filter(log => {
        try {
          const data = JSON.parse(log.new_value || log.old_value || '{}');
          const brandName = data.brand_name || data.brand;
          if (!brandName) return true; 
          if (restriction.type === 'include') {
            return restriction.brands.includes(brandName);
          } else {
            return !restriction.brands.includes(brandName);
          }
        } catch (e) {
          return true;
        }
      });
    }

    res.json(filteredLogs);
  });

  // Edit a hide/unhide history session (Manager/admin only) to correct a
  // wrongly recorded hide time, unhide time, or reason.
  app.put("/api/history/session", authenticate, authorize(["Manager"]), async (req, res) => {
    const user = (req as any).user;
    const { hideLogId, unhideLogId, hideTime, unhideTime, reason, responsibleParty } = req.body;
    // Only update responsible party when a non-empty value is supplied, so that
    // editing the time/reason never wipes an existing responsible party.
    const rp = (typeof responsibleParty === 'string' && responsibleParty.trim()) ? responsibleParty.trim() : null;

    // Convert a Kuwait local datetime ("YYYY-MM-DDTHH:MM[:SS]") to a UTC ISO string.
    const toUtc = (local: string | undefined | null) => {
      if (!local) return null;
      const s = String(local).trim();
      const withSecs = s.length === 16 ? `${s}:00` : s;
      const d = new Date(`${withSecs}+03:00`); // Kuwait is UTC+3 (no DST)
      return isNaN(d.getTime()) ? null : d.toISOString();
    };

    const hideUtc = toUtc(hideTime);
    const unhideUtc = toUtc(unhideTime);

    try {
      // --- HIDE row in audit_logs (what the page reads) ---
      if (hideLogId) {
        const hideLog = await db.get("SELECT * FROM audit_logs WHERE id = $1 AND action = 'HIDE'", [hideLogId]) as any;
        if (hideLog) {
          let data: any = {};
          try { data = JSON.parse(hideLog.new_value || '{}'); } catch (e) { data = {}; }
          if (reason !== undefined && reason !== null && reason !== '') data.reason = reason;
          if (rp) data.responsible_party = rp;
          await db.query(
            "UPDATE audit_logs SET new_value = $1, timestamp = COALESCE($2, timestamp) WHERE id = $3",
            [JSON.stringify(data), hideUtc, hideLogId]
          );
          await syncHideHistory('HIDE', data.product_id ?? hideLog.target_id, data.branch_id, hideLog.timestamp, hideUtc, (reason ?? null), rp);

          // Update the still-hidden item too, if it exists.
          if (rp && (data.product_id ?? hideLog.target_id)) {
            await db.query(
              `UPDATE hidden_items SET responsible_party = $1 WHERE product_id = $2 AND branch_id IS NOT DISTINCT FROM $3`,
              [rp, data.product_id ?? hideLog.target_id, data.branch_id ?? null]
            );
          }
        }
      }

      // --- UNHIDE row in audit_logs ---
      if (unhideLogId) {
        const unhideLog = await db.get("SELECT * FROM audit_logs WHERE id = $1 AND action = 'UNHIDE'", [unhideLogId]) as any;
        if (unhideLog) {
          await db.query(
            "UPDATE audit_logs SET timestamp = COALESCE($1, timestamp) WHERE id = $2",
            [unhideUtc, unhideLogId]
          );
          let udata: any = {};
          try { udata = JSON.parse(unhideLog.old_value || '{}'); } catch (e) { udata = {}; }
          await syncHideHistory('UNHIDE', udata.product_id ?? unhideLog.target_id, udata.branch_id, unhideLog.timestamp, unhideUtc, null, rp);
        }
      }

      await logAction(user.id, "EDIT_HISTORY", "audit_logs", hideLogId || unhideLogId || null, null, {
        hideLogId: hideLogId || null,
        unhideLogId: unhideLogId || null,
        hide_time: hideUtc,
        unhide_time: unhideUtc,
        reason: reason ?? null,
        responsible_party: rp,
      });

      broadcast({ type: "HIDDEN_ITEMS_UPDATED" });
      res.json({ success: true });
    } catch (err: any) {
      console.error("Failed to edit history session", err);
      res.status(500).json({ error: "Failed to update history record" });
    }
  });

  // Busy Branch Records
  app.get("/api/busy-periods/export", authenticate, async (req, res) => {
    const restriction = await getBrandRestriction((req as any).user);
    let query = `
      SELECT b.*, u.username 
      FROM busy_period_records b 
      JOIN users u ON b.user_id = u.id 
    `;
    const params: any[] = [];

    if (restriction) {
      const placeholders = restriction.brands.map((_, i) => `$${i + 1}`).join(',');
      if (restriction.type === 'include') {
        query += ` WHERE b.brand IN (${placeholders})`;
      } else {
        query += ` WHERE b.brand NOT IN (${placeholders})`;
      }
      params.push(...restriction.brands);
    }

    query += " ORDER BY b.created_at DESC";
    const records = await db.all(query, params) as any[];

    const formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true, timeZone: 'Asia/Kuwait'
    });

    const data = records.map(r => ({
      'Brand': r.brand,
      'Branch': r.branch,
      'Date': r.date,
      'Start Time': r.start_time,
      'End Time': r.end_time,
      'Duration': r.total_duration,
      'Reason': r.reason_category,
      'Responsible': r.responsible_party,
      'Comment': r.comment || '',
      'Notes': r.internal_notes || '',
      'Recorded By': r.username,
      'Recorded Date & time': r.created_at ? formatter.format(new Date(String(r.created_at) + (String(r.created_at).includes('Z') || String(r.created_at).includes('T') ? '' : 'Z'))) : ''
    }));

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Busy Periods");
    
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=busy_periods_export.xlsx');
    res.send(buffer);
  });

  app.get("/api/busy-periods/most-frequent", authenticate, async (req, res) => {
    const user = (req as any).user;
    console.log(`[DEBUG] Busy periods auto-fill requested by user: ${user.username}, role: ${user.role_name}, branch_id: ${user.branch_id}`);
    let branchName = null;

    if (user.role_name === 'Restaurants' && user.branch_id) {
      const branch = await db.get("SELECT name FROM branches WHERE id = $1", [user.branch_id]);
      branchName = branch?.name;
    }

    if (!branchName) {
      console.log(`[DEBUG] No branch found for user ${user.username}`);
      return res.json({ reason_category: null, responsible_party: null });
    }

    const mostFrequentReason = await db.get(`
      SELECT reason_category, COUNT(*) as count 
      FROM busy_period_records 
      WHERE branch = $1 
      GROUP BY reason_category 
      ORDER BY count DESC 
      LIMIT 1
    `, [branchName]);

    const mostFrequentResponsible = await db.get(`
      SELECT responsible_party, COUNT(*) as count 
      FROM busy_period_records 
      WHERE branch = $1 
      GROUP BY responsible_party 
      ORDER BY count DESC 
      LIMIT 1
    `, [branchName]);

    console.log(`[DEBUG] Busy periods auto-fill result: reason=${mostFrequentReason?.reason_category}, resp=${mostFrequentResponsible?.responsible_party}`);

    res.json({
      reason_category: mostFrequentReason?.reason_category || null,
      responsible_party: mostFrequentResponsible?.responsible_party || null
    });
  });

  app.get("/api/hidden-items/most-frequent", authenticate, async (req, res) => {
    const user = (req as any).user;
    console.log(`[DEBUG] Hidden items auto-fill requested by user: ${user.username}, role: ${user.role_name}, branch_id: ${user.branch_id}`);

    if (user.role_name === 'Restaurants' && user.branch_id) {
      const mostFrequentReason = await db.get(`
        SELECT reason, COUNT(*) as count 
        FROM hidden_items 
        WHERE branch_id = $1 
        GROUP BY reason 
        ORDER BY count DESC 
        LIMIT 1
      `, [user.branch_id]);

      const mostFrequentResponsible = await db.get(`
        SELECT responsible_party, COUNT(*) as count 
        FROM hidden_items 
        WHERE branch_id = $1 
        GROUP BY responsible_party 
        ORDER BY count DESC 
        LIMIT 1
      `, [user.branch_id]);

      console.log(`[DEBUG] Hidden items auto-fill result: reason=${mostFrequentReason?.reason}, resp=${mostFrequentResponsible?.responsible_party}`);

      return res.json({
        reason: mostFrequentReason?.reason || null,
        responsible_party: mostFrequentResponsible?.responsible_party || null
      });
    }

    console.log(`[DEBUG] No branch_id or wrong role for user ${user.username}`);
    res.json({ reason: null, responsible_party: null });
  });

  app.get("/api/busy-periods", authenticate, async (req, res) => {
    const user = (req as any).user;
    const restriction = await getBrandRestriction(user);
    let query = `
      SELECT b.*, u.username 
      FROM busy_period_records b 
      JOIN users u ON b.user_id = u.id 
    `;
    const params: any[] = [];
    const conditions: string[] = [];
    
    if (user.role_name === 'Area Manager') {
      const branchIds = await getBranchRestriction(user);
      if (branchIds && branchIds.length > 0) {
        const branchNamesResult = await db.all(`SELECT name FROM branches WHERE id IN (${branchIds.map((_, i) => `$${i + 1}`).join(',')})`, branchIds);
        const branchNames = branchNamesResult.map(b => b.name);
        const placeholders = branchNames.map((_, i) => `$${params.length + i + 1}`).join(',');
        conditions.push(`b.branch IN (${placeholders})`);
        params.push(...branchNames);
      } else {
        conditions.push("1 = 0");
      }
    } else if (user.role_name === 'Restaurants') {
      if (restriction) {
        const placeholders = restriction.brands.map((_, i) => `$${params.length + i + 1}`).join(',');
        if (restriction.type === 'include') {
          conditions.push(`b.brand IN (${placeholders})`);
        } else {
          conditions.push(`b.brand NOT IN (${placeholders})`);
        }
        params.push(...restriction.brands);
      }
    } else if (restriction) {
      const placeholders = restriction.brands.map((_, i) => `$${params.length + i + 1}`).join(',');
      if (restriction.type === 'include') {
        conditions.push(`b.brand IN (${placeholders})`);
      } else {
        conditions.push(`b.brand NOT IN (${placeholders})`);
      }
      params.push(...restriction.brands);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY b.created_at DESC LIMIT 500";
    const records = await db.all(query, params);
    res.json(records);
  });

  // Hidden Items Routes
  app.get("/api/hidden-items", authenticate, async (req, res) => {
    const user = (req as any).user;
    const restriction = await getBrandRestriction(user);
    const productNameFieldId = await getProductNameFieldId();
    const ingredientsFieldId = await getIngredientsFieldId();

    let query = `
      SELECT h.*, u.username, b.name as brand_name, br.name as branch_name, 
             fv.value as product_name, fv_ing.value as ingredients, uu.username as updated_by_username
      FROM hidden_items h
      JOIN users u ON h.user_id = u.id
      JOIN brands b ON h.brand_id = b.id
      LEFT JOIN branches br ON h.branch_id = br.id
      LEFT JOIN product_field_values fv ON h.product_id = fv.product_id AND fv.field_id = $1
      LEFT JOIN product_field_values fv_ing ON h.product_id = fv_ing.product_id AND fv_ing.field_id = $2
      LEFT JOIN users uu ON h.updated_by = uu.id
    `;
    const params: any[] = [productNameFieldId, ingredientsFieldId];
    const conditions: string[] = [];

    if (user.role_name === 'Area Manager') {
      const branchIds = await getBranchRestriction(user);
      if (branchIds && branchIds.length > 0) {
        const placeholders = branchIds.map((_, i) => `$${params.length + i + 1}`).join(',');
        conditions.push(`h.branch_id IN (${placeholders})`);
        params.push(...branchIds);
      } else {
        conditions.push("1 = 0");
      }
    } else if (user.role_name === 'Restaurants') {
      if (user.branch_id) {
        conditions.push(`h.branch_id = $${params.length + 1}`);
        params.push(user.branch_id);
      } else if (restriction) {
        const placeholders = restriction.brands.map((_, i) => `$${params.length + i + 1}`).join(',');
        if (restriction.type === 'include') {
          conditions.push(`b.name IN (${placeholders})`);
        } else {
          conditions.push(`b.name NOT IN (${placeholders})`);
        }
        params.push(...restriction.brands);
      } else {
        conditions.push("1 = 0");
      }
    } else if (restriction) {
      const placeholders = restriction.brands.map((_, i) => `$${params.length + i + 1}`).join(',');
      if (restriction.type === 'include') {
        conditions.push(`b.name IN (${placeholders})`);
      } else {
        conditions.push(`b.name NOT IN (${placeholders})`);
      }
      params.push(...restriction.brands);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY h.created_at DESC LIMIT 500";
    const records = await db.all(query, params);
    res.json(records);
  });

  app.put("/api/hidden-items/:id", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor"]), async (req, res) => {
    const { id } = req.params;
    const { brand_id, branch_id, product_id, agent_name, reason, action_to_unhide, comment, requested_at, responsible_party } = req.body;
    const now = getCurrentKuwaitTime();
    const userId = (req as any).user.id;

    try {
      const oldItem = await db.get("SELECT * FROM hidden_items WHERE id = $1", [id]);
      if (!oldItem) {
        return res.status(404).json({ error: "Hidden item not found" });
      }

      const result = await db.query(`
        UPDATE hidden_items 
        SET brand_id = $1, branch_id = $2, product_id = $3, agent_name = $4, reason = $5, action_to_unhide = $6, comment = $7, requested_at = $8, responsible_party = $9, updated_at = $10, updated_by = $11
        WHERE id = $12
      `, [brand_id, branch_id, product_id, agent_name, reason, action_to_unhide, comment, requested_at, responsible_party, now, userId, id]);

      if (result.rowCount > 0) {
        // Log the edit action
        const productNameFieldId = await getProductNameFieldId();
        const productInfo = await db.get(`
          SELECT fv.value as product_name, b.name as brand_name
          FROM products p
          LEFT JOIN product_field_values fv ON p.id = fv.product_id AND fv.field_id = $1
          LEFT JOIN brands b ON p.brand_id = b.id
          WHERE p.id = $2
        `, [productNameFieldId, product_id]) as any;

        const branchInfo = branch_id ? await db.get("SELECT name FROM branches WHERE id = $1", [branch_id]) as any : { name: 'All Branches' };

        const logData = {
          ...req.body,
          product_name: productInfo?.product_name || 'Unknown Product',
          brand_name: productInfo?.brand_name || 'Unknown Brand',
          branch_name: branchInfo?.name || 'All Branches'
        };

        await db.query(`
          INSERT INTO audit_logs (user_id, action, target_table, target_id, old_value, new_value, timestamp)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [userId, 'EDIT_HIDDEN_ITEM', 'hidden_items', id, JSON.stringify(oldItem), JSON.stringify(logData), now]);

        broadcast({ type: "HIDDEN_ITEMS_UPDATED" });
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "Hidden item not found" });
      }
    } catch (error) {
      console.error("Error updating hidden item:", error);
      res.status(500).json({ error: "Failed to update hidden item" });
    }
  });

  app.post("/api/hidden-items", authenticate, authorize(["Technical Back Office", "Manager", "Restaurants", "Super Visor", "Area Manager", "Operation Manager"]), async (req, res) => {
    const { 
      brand_id, branch_id, product_ids, agent_name, reason, 
      action_to_unhide, comment, responsible_party 
    } = req.body;
    const requested_at = getCurrentKuwaitTime();

    if ((req as any).user.role_name === 'Restaurants' || (req as any).user.role_name === 'Area Manager') {
      const productNameFieldId = await getProductNameFieldId();
      const resolvedProducts = await db.all(`
        SELECT p.id as product_id, fv.value as name
        FROM products p
        LEFT JOIN product_field_values fv ON p.id = fv.product_id AND fv.field_id = $1
        WHERE p.id = ANY($2)
      `, [productNameFieldId, product_ids]);

      const brand = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as { name: string };
      const branch = branch_id ? await db.get("SELECT name FROM branches WHERE id = $1", [branch_id]) as { name: string } : { name: 'All Branches' };

      const result = await db.query(`
        INSERT INTO pending_requests (user_id, type, data, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [(req as any).user.id, 'hide_unhide', JSON.stringify({ 
        ...req.body, 
        brand_name: brand?.name || 'Unknown',
        branch_name: branch?.name || 'All Branches',
        action: 'HIDE', 
        requested_at, 
        resolved_products: resolvedProducts 
      }), getCurrentKuwaitTime(), getCurrentKuwaitTime()]);
      
      broadcast({ type: "PENDING_REQUEST_CREATED" });
      const branchName = req.body.branch_name || "Unknown Branch";
      sendSystemNotification(
        "New Hide Request",
        "طلب إخفاء جديد",
        `New hide request received from ${branchName}`,
        `طلب إخفاء جديد مستلم من ${branchName}`,
        ["Technical Back Office"]
      );
      return res.json({ id: result.rows[0].id, pending: true });
    }

    try {
      await db.transaction(async (client) => {
        const now = getCurrentKuwaitTime();
        const productNameFieldId = await getProductNameFieldId();
        const brand = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as { name: string };
        
        if (branch_id === null) {
          // Hide for all branches of the brand
          const branches = await db.all("SELECT id, name FROM branches WHERE brand_id = $1", [brand_id]) as { id: number, name: string }[];
          for (const productId of product_ids) {
            const product = await db.get(`
              SELECT fv.value as name 
              FROM product_field_values fv 
              WHERE fv.product_id = $1 AND fv.field_id = $2
            `, [productId, productNameFieldId]) as { name: string };

            for (const branch of branches) {
              await client.query(`
                INSERT INTO hidden_items (
                  user_id, brand_id, branch_id, product_id, agent_name, reason, 
                  action_to_unhide, comment, requested_at, responsible_party, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              `, [(req as any).user.id, brand_id, branch.id, productId, agent_name, reason, action_to_unhide, comment, requested_at, responsible_party, now]);
              
              await client.query(`
                INSERT INTO hide_history (
                  user_id, brand_id, branch_id, product_id, action,
                  agent_name, reason, action_to_unhide, comment, requested_at, responsible_party, timestamp
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
              `, [(req as any).user.id, brand_id, branch.id, productId, 'HIDE', agent_name, reason, action_to_unhide, comment, requested_at, responsible_party, now]);
              
              await logAction((req as any).user.id, "HIDE", "products", productId, null, { 
                product_name: product?.name || 'Unknown', 
                brand_name: brand?.name || 'Unknown',
                branch: branch.name,
                reason: reason,
                brand_id: brand_id,
                branch_id: branch.id,
                responsible_party: responsible_party
              });
            }
          }
        } else {
          // Hide for specific branch
          const branch = await db.get("SELECT name FROM branches WHERE id = $1", [branch_id]) as { name: string };
          for (const productId of product_ids) {
            const product = await db.get(`
              SELECT fv.value as name 
              FROM product_field_values fv 
              WHERE fv.product_id = $1 AND fv.field_id = $2
            `, [productId, productNameFieldId]) as { name: string };

            await client.query(`
              INSERT INTO hidden_items (
                user_id, brand_id, branch_id, product_id, agent_name, reason, 
                action_to_unhide, comment, requested_at, responsible_party, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [(req as any).user.id, brand_id, branch_id, productId, agent_name, reason, action_to_unhide, comment, requested_at, responsible_party, now]);
            
            await client.query(`
              INSERT INTO hide_history (
                user_id, brand_id, branch_id, product_id, action,
                agent_name, reason, action_to_unhide, comment, requested_at, responsible_party, timestamp
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [(req as any).user.id, brand_id, branch_id, productId, 'HIDE', agent_name, reason, action_to_unhide, comment, requested_at, responsible_party, now]);
            
            await logAction((req as any).user.id, "HIDE", "products", productId, null, { 
              product_name: product?.name || 'Unknown', 
              brand_name: brand?.name || 'Unknown',
              branch: branch?.name || 'Unknown',
              reason: reason,
              brand_id: brand_id,
              branch_id: branch_id,
              responsible_party: responsible_party
            });
          }
        }
      });

      broadcast({
        type: "NOTIFICATION",
        notificationType: "HIDDEN_ITEM",
        title_en: "Item Hidden",
        title_ar: "إخفاء عنصر",
        message_en: `Item(s) hidden in branch ${branch_id}`,
        message_ar: `تم إخفاء عناصر في فرع ${branch_id}`,
        brand_id,
        branch_id,
        role_target: ["Manager", "Super Visor", "Area Manager", "Call Center"]
      });
      broadcast({ type: "HIDDEN_ITEMS_UPDATED" });
      res.json({ success: true });
    } catch (error) {
      console.error("Error adding hidden items:", error);
      res.status(500).json({ error: "Failed to add hidden items" });
    }
  });

  app.get("/api/hidden-items/export", authenticate, async (req, res) => {
    const restriction = await getBrandRestriction((req as any).user);
    let query = `
      SELECT 
        hi.id,
        b.name as brand_name,
        br.name as branch_name,
        fv.value as product_name,
        hi.agent_name,
        hi.reason,
        hi.action_to_unhide,
        hi.comment,
        hi.requested_at,
        hi.responsible_party,
        hi.created_at,
        u.username
      FROM hidden_items hi
      JOIN brands b ON hi.brand_id = b.id
      LEFT JOIN branches br ON hi.branch_id = br.id
      JOIN products p ON hi.product_id = p.id
      JOIN product_field_values fv ON p.id = fv.product_id AND fv.field_id = $1
      JOIN users u ON hi.user_id = u.id
    `;
    const productNameFieldId = await getProductNameFieldId();
    const params: any[] = [productNameFieldId];

    if (restriction) {
      const placeholders = restriction.brands.map((_, i) => `$${i + 2}`).join(',');
      if (restriction.type === 'include') {
        query += ` WHERE b.name IN (${placeholders})`;
      } else {
        query += ` WHERE b.name NOT IN (${placeholders})`;
      }
      params.push(...restriction.brands);
    }

    query += " ORDER BY hi.created_at DESC";
    const records = await db.all(query, params);

    const formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true, timeZone: 'Asia/Kuwait'
    });

    const data = records.map((r: any) => ({
      'Brand': r.brand_name,
      'Branch': r.branch_name || 'All Branches',
      'Item': r.product_name,
      'Agent': r.agent_name,
      'Reason': r.reason,
      'Comment': r.comment,
      'Requested At': r.requested_at ? formatter.format(new Date(r.requested_at)) : '',
      'Responsible Party': r.responsible_party,
      'Recorded By': r.username,
      'Recorded At': r.created_at ? formatter.format(new Date(String(r.created_at) + (String(r.created_at).includes('Z') || String(r.created_at).includes('T') ? '' : 'Z'))) : ''
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Hidden Items");
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=hidden_items.xlsx');
    res.send(buffer);
  });

  app.get("/api/export-history", authenticate, authorize(["Technical Back Office", "Manager", "Call Center", "Super Visor", "Restaurants", "Area Manager", "Operation Manager"]), async (req, res) => {
    const { startDate, endDate, brandId, branchId } = req.query as any;
    const restriction = await getBrandRestriction((req as any).user);

    const logs = await db.all(`
      SELECT l.*, u.username
      FROM audit_logs l
      JOIN users u ON l.user_id = u.id
      WHERE (l.action = 'HIDE' OR l.action = 'UNHIDE' OR l.action = 'EDIT_HIDDEN_ITEM')
      AND (l.target_table = 'products' OR l.target_table = 'hidden_items')
      ORDER BY l.timestamp ASC
    `) as any[];

    let filteredLogs = logs;
    if (restriction) {
      filteredLogs = logs.filter(log => {
        try {
          const data = JSON.parse(log.new_value || log.old_value || '{}');
          const brandName = data.brand_name || data.brand;
          if (!brandName) return true;
          if (restriction.type === 'include') {
            return restriction.brands.includes(brandName);
          } else {
            return !restriction.brands.includes(brandName);
          }
        } catch (e) {
          return true;
        }
      });
    }

    const sessions: any[] = [];
    const activeSessions: { [key: string]: any } = {};

    filteredLogs.forEach(log => {
      try {
        const data = JSON.parse(log.new_value || log.old_value || '{}');
        const productId = log.action === 'EDIT_HIDDEN_ITEM' ? data.product_id : log.target_id;
        const branch = data.branch_name || data.branch || data.branches || 'All Branches';
        const key = `${productId}-${branch}`;

        if (log.action === 'HIDE') {
          const session = {
            id: log.id,
            Brand: data.brand_name || 'Unknown Brand',
            Branch: branch,
            Item: data.product_name || 'Unknown Product',
            'Hide Time': log.timestamp,
            'Unhide Time': null,
            'Update Info': '',
            updateLogs: [] as any[],
            'Duration (Min)': null as number | null,
            Agent: data.agent_name || '',
            Reason: data.reason || '',
            Comment: data.comment || '',
            'Requested At': data.requested_at || '',
            'Recorded By': log.username,
            brand_id: data.brand_id,
            branch_id: data.branch_id
          };
          sessions.push(session);
          activeSessions[key] = session;
        } else if (log.action === 'UNHIDE') {
          let sessionKey = key;
          let session = activeSessions[key];

          if (!session && branch !== 'All Branches') {
            const allBranchesKey = `${productId}-All Branches`;
            session = activeSessions[allBranchesKey];
            if (session) sessionKey = allBranchesKey;
          }

          if (session) {
            if (!session['Unhide Time']) {
              session['Unhide Time'] = log.timestamp;
              session.Branch = branch;
              const hideTimeStr = String(session['Hide Time']);
              const unhideTimeStr = String(log.timestamp);
              const hideTime = new Date(hideTimeStr + (hideTimeStr.includes('Z') || hideTimeStr.includes('T') ? '' : 'Z')).getTime();
              const unhideTime = new Date(unhideTimeStr + (unhideTimeStr.includes('Z') || unhideTimeStr.includes('T') ? '' : 'Z')).getTime();
              session['Duration (Min)'] = Math.round((unhideTime - hideTime) / (1000 * 60));

              // Retire only on an exact product+branch match; keep "All Branches"
              // sessions active so other branches' unhides can still pair with them.
              if (sessionKey === key) {
                delete activeSessions[key];
              }
            } else if (session['Unhide Time'] === log.timestamp) {
              if (session.Branch !== branch && !session.Branch.includes(branch)) {
                if (session.Branch !== 'All Branches') {
                  session.Branch = "Multiple Branches";
                }
              }
            } else {
              const newSession = {
                ...session,
                id: log.id,
                Branch: branch,
                'Unhide Time': log.timestamp,
                updateLogs: [...session.updateLogs],
              };
              const hideTimeStr = String(newSession['Hide Time']);
              const unhideTimeStr = String(log.timestamp);
              const hideTime = new Date(hideTimeStr + (hideTimeStr.includes('Z') || hideTimeStr.includes('T') ? '' : 'Z')).getTime();
              const unhideTime = new Date(unhideTimeStr + (unhideTimeStr.includes('Z') || unhideTimeStr.includes('T') ? '' : 'Z')).getTime();
              newSession['Duration (Min)'] = Math.round((unhideTime - hideTime) / (1000 * 60));
              sessions.push(newSession);
            }
          } else {
            sessions.push({
              Brand: data.brand_name || 'Unknown Brand',
              Branch: branch,
              Item: data.product_name || 'Unknown Product',
              'Hide Time': null,
              'Unhide Time': log.timestamp,
              'Update Info': '',
              updateLogs: [],
              'Duration (Min)': null,
              Agent: data.agent_name || '',
              Reason: data.reason || '',
              Comment: data.comment || '',
              'Requested At': data.requested_at || '',
              'Recorded By': log.username,
              brand_id: data.brand_id,
              branch_id: data.branch_id
            });
          }
        } else if (log.action === 'EDIT_HIDDEN_ITEM') {
          let session = activeSessions[key];
          if (!session && branch !== 'All Branches') {
            const allBranchesKey = `${productId}-All Branches`;
            session = activeSessions[allBranchesKey];
          }

          if (session) {
            session.updateLogs.push(log);
          } else {
            const lastSession = [...sessions].reverse().find(s => 
              s.Item === (data.product_name || 'Unknown Product') && 
              (s.Branch === branch || s.Branch === 'All Branches')
            );
            if (lastSession) {
              lastSession.updateLogs.push(log);
            }
          }
        }
      } catch (e) {
        console.error("Error parsing log data for export", e);
      }
    });

    let filteredSessions = [...sessions];

    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      filteredSessions = filteredSessions.filter(s => {
        const hideTimeVal = s['Hide Time'] ? String(s['Hide Time']) : null;
        const unhideTimeVal = s['Unhide Time'] ? String(s['Unhide Time']) : null;
        const hideTime = hideTimeVal ? new Date(hideTimeVal + (hideTimeVal.includes('Z') || hideTimeVal.includes('T') ? '' : 'Z')) : null;
        const unhideTime = unhideTimeVal ? new Date(unhideTimeVal + (unhideTimeVal.includes('Z') || unhideTimeVal.includes('T') ? '' : 'Z')) : null;
        return (hideTime && hideTime >= start) || (unhideTime && unhideTime >= start);
      });
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filteredSessions = filteredSessions.filter(s => {
        const hideTimeVal = s['Hide Time'] ? String(s['Hide Time']) : null;
        const unhideTimeVal = s['Unhide Time'] ? String(s['Unhide Time']) : null;
        const hideTime = hideTimeVal ? new Date(hideTimeVal + (hideTimeVal.includes('Z') || hideTimeVal.includes('T') ? '' : 'Z')) : null;
        const unhideTime = unhideTimeVal ? new Date(unhideTimeVal + (unhideTimeVal.includes('Z') || unhideTimeVal.includes('T') ? '' : 'Z')) : null;
        return (hideTime && hideTime <= end) || (unhideTime && unhideTime <= end);
      });
    }

    if (brandId) {
      const brand = await db.get("SELECT name FROM brands WHERE id = $1", [brandId]) as { name: string };
      filteredSessions = filteredSessions.filter(s => {
        if (s.brand_id) return String(s.brand_id) === String(brandId);
        // Fallback for older logs
        return brand && s.Brand === brand.name;
      });
    }

    if (branchId) {
      if (branchId === 'all') {
        filteredSessions = filteredSessions.filter(s => s.Branch === 'All Branches');
      } else {
        const branch = await db.get("SELECT name FROM branches WHERE id = $1", [branchId]) as { name: string };
        filteredSessions = filteredSessions.filter(s => {
          if (s.branch_id) return String(s.branch_id) === String(branchId);
          // Fallback for older logs
          return branch && s.Branch === branch.name;
        });
      }
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true, timeZone: 'Asia/Kuwait'
    });

    const formattedHistory = filteredSessions.reverse().map(s => {
      let updateInfo = '';
      if (s.updateLogs.length > 0) {
        const lastUpdate = s.updateLogs[s.updateLogs.length - 1];
        const lastUpdateTs = String(lastUpdate.timestamp);
        updateInfo = `Last update: ${formatter.format(new Date(lastUpdateTs + (lastUpdateTs.includes('Z') || lastUpdateTs.includes('T') ? '' : 'Z')))} by ${lastUpdate.username}`;
        if (s.updateLogs.length > 1) {
          updateInfo += ` (${s.updateLogs.length} total edits)`;
        }
      }

      const hideTimeVal = s['Hide Time'] ? String(s['Hide Time']) : null;
      const unhideTimeVal = s['Unhide Time'] ? String(s['Unhide Time']) : null;

      return {
        'Brand': s.Brand,
        'Branch': s.Branch,
        'Item': s.Item,
        'Hide Time': hideTimeVal ? formatter.format(new Date(hideTimeVal + (hideTimeVal.includes('Z') || hideTimeVal.includes('T') ? '' : 'Z'))) : 'N/A',
        'Unhide Time': unhideTimeVal ? formatter.format(new Date(unhideTimeVal + (unhideTimeVal.includes('Z') || unhideTimeVal.includes('T') ? '' : 'Z'))) : 'STILL HIDDEN',
        'Update Info': updateInfo || '-',
        'Duration (Min)': s['Duration (Min)'] !== null ? s['Duration (Min)'] : (s['Hide Time'] && !s['Unhide Time'] ? '-' : 'N/A'),
        'Agent': s.Agent,
        'Reason': s.Reason,
        'Action to Unhide': s['Action to Unhide'],
        'Comment': s.Comment,
        'Requested At': s['Requested At'] 
          ? (String(s['Requested At']).includes('/') || String(s['Requested At']).includes('-') 
              ? formatter.format(new Date(String(s['Requested At']) + (String(s['Requested At']).includes('Z') || String(s['Requested At']).includes('T') ? '' : 'Z')))
              : s['Requested At'])
          : '',
        'Recorded By': s['Recorded By']
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(formattedHistory);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Operation History");
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=operation_history.xlsx');
    res.send(buffer);
  });

  app.delete("/api/hidden-items/:id", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor", "Restaurants", "Area Manager", "Operation Manager"]), async (req, res) => {
    if ((req as any).user.role_name === 'Restaurants' || (req as any).user.role_name === 'Area Manager') {
      const productNameFieldId = await getProductNameFieldId();
      const item = await db.get(`
        SELECT hi.id as hidden_item_id, hi.product_id, fv.value as name
        FROM hidden_items hi
        LEFT JOIN product_field_values fv ON hi.product_id = fv.product_id AND fv.field_id = $1
        WHERE hi.id = $2
      `, [productNameFieldId, req.params.id]) as any;

      if (!item) {
        return res.status(404).json({ error: "Item not found" });
      }

      const result = await db.query(`
        INSERT INTO pending_requests (user_id, type, data, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [
        (req as any).user.id, 
        'hide_unhide', 
        JSON.stringify({ 
          action: 'UNHIDE', 
          ids: [req.params.id], 
          resolved_products: [item] 
        }), 
        getCurrentKuwaitTime(), 
        getCurrentKuwaitTime()
      ]);
      
      broadcast({ type: "PENDING_REQUEST_CREATED" });
      const branchName = req.body.branch_name || "Unknown Branch";
      sendSystemNotification(
        "New Unhide Request",
        "طلب إظهار جديد",
        `New unhide request received from ${branchName}`,
        `طلب إظهار جديد مستلم من ${branchName}`,
        ["Technical Back Office"]
      );
      return res.json({ id: result.rows[0].id, pending: true });
    }

    const item = await db.get(`
      SELECT hi.*, fv.value as product_name, br.name as branch_name, b.name as brand_name
      FROM hidden_items hi
      LEFT JOIN product_field_values fv ON hi.product_id = fv.product_id AND fv.field_id = $1
      LEFT JOIN branches br ON hi.branch_id = br.id
      LEFT JOIN brands b ON hi.brand_id = b.id
      WHERE hi.id = $2
    `, [await getProductNameFieldId(), req.params.id]) as any;

    if (item) {
      const unhide_at = getCurrentKuwaitTime();
      await logAction((req as any).user.id, "UNHIDE", "products", item.product_id, { 
        product_name: item.product_name || 'Unknown Product', 
        brand_name: item.brand_name || 'Unknown Brand',
        branch: item.branch_name || 'All Branches',
        brand_id: item.brand_id,
        branch_id: item.branch_id
      }, null);
      await db.query(`
        INSERT INTO hide_history (
          user_id, brand_id, branch_id, product_id, action,
          agent_name, reason, action_to_unhide, comment, requested_at, responsible_party, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        (req as any).user.id, item.brand_id, item.branch_id, item.product_id, 'UNHIDE',
        item.agent_name, item.reason, item.action_to_unhide, 
        item.comment, unhide_at, item.responsible_party, unhide_at
      ]);
    }

    await db.query("DELETE FROM hidden_items WHERE id = $1", [req.params.id]);
    broadcast({ type: "HIDDEN_ITEMS_UPDATED" });
    res.json({ success: true });
  });

  app.post("/api/hidden-items/bulk-unhide", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor", "Restaurants", "Area Manager", "Operation Manager"]), async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Invalid IDs" });
    }

    if ((req as any).user.role_name === 'Restaurants' || (req as any).user.role_name === 'Area Manager') {
      const productNameFieldId = await getProductNameFieldId();
      const resolvedProducts = await db.all(`
        SELECT hi.id as hidden_item_id, hi.product_id, fv.value as name
        FROM hidden_items hi
        LEFT JOIN product_field_values fv ON hi.product_id = fv.product_id AND fv.field_id = $1
        WHERE hi.id IN (${ids.map((_, i) => `$${i + 2}`).join(',')})
      `, [productNameFieldId, ...ids]);

      const result = await db.query(`
        INSERT INTO pending_requests (user_id, type, data, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [
        (req as any).user.id, 
        'hide_unhide', 
        JSON.stringify({ 
          action: 'UNHIDE', 
          ids, 
          resolved_products: resolvedProducts 
        }), 
        getCurrentKuwaitTime(), 
        getCurrentKuwaitTime()
      ]);
      
      broadcast({ type: "PENDING_REQUEST_CREATED" });
      const branchName = req.body.branch_name || "Unknown Branch";
      sendSystemNotification(
        "New Bulk Hide Request",
        "طلب إخفاء متعدد جديد",
        `New bulk hide request received from ${branchName}`,
        `طلب إخفاء متعدد جديد مستلم من ${branchName}`,
        ["Technical Back Office"]
      );
      return res.json({ id: result.rows[0].id, pending: true });
    }

    await db.transaction(async (client) => {
      const unhide_at = getCurrentKuwaitTime();
      const productNameFieldId = await getProductNameFieldId();

      for (const id of ids) {
        const item = await client.query(`
          SELECT hi.*, fv.value as product_name, br.name as branch_name, b.name as brand_name
          FROM hidden_items hi
          LEFT JOIN product_field_values fv ON hi.product_id = fv.product_id AND fv.field_id = $1
          LEFT JOIN branches br ON hi.branch_id = br.id
          LEFT JOIN brands b ON hi.brand_id = b.id
          WHERE hi.id = $2
        `, [productNameFieldId, id]).then(res => res.rows[0]) as any;

        if (item) {
          await logAction((req as any).user.id, "UNHIDE", "products", item.product_id, { 
            product_name: item.product_name || 'Unknown Product', 
            brand_name: item.brand_name || 'Unknown Brand',
            branch: item.branch_name || 'All Branches',
            brand_id: item.brand_id,
            branch_id: item.branch_id
          }, null);

          await client.query(`
            INSERT INTO hide_history (
              user_id, brand_id, branch_id, product_id, action,
              agent_name, reason, action_to_unhide, comment, requested_at, responsible_party, timestamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `, [
            (req as any).user.id, item.brand_id, item.branch_id, item.product_id, 'UNHIDE',
            item.agent_name, item.reason, item.action_to_unhide, 
            item.comment, unhide_at, item.responsible_party, unhide_at
          ]);

          await client.query("DELETE FROM hidden_items WHERE id = $1", [id]);
        }
      }
    });

    broadcast({ type: "HIDDEN_ITEMS_UPDATED" });
    res.json({ success: true });
  });

  app.post("/api/busy-periods", authenticate, async (req, res) => {
    const { 
      date, brand, branch, reason_category, responsible_party, 
      comment, internal_notes, timer_duration
    } = req.body;

    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kuwait',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const start_time = formatter.format(now);
    const end_time = '';
    const total_duration = '';
    const total_duration_minutes = 0;

    let timer_expires_at = null;
    if (timer_duration && Number(timer_duration) > 0) {
      timer_expires_at = new Date(now.getTime() + Number(timer_duration) * 60000).toISOString();
    }

    if ((req as any).user.role_name === 'Restaurants') {
      try {
        const result = await db.transaction(async (client) => {
          // Use advisory lock to prevent race conditions on duplicate check
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`busy_branch_busy_${branch.trim().toUpperCase()}`]);

          // Check for existing pending BUSY request for this branch
          const existingRequest = await client.query(`
            SELECT id FROM pending_requests 
            WHERE type = 'busy_branch' 
            AND status = 'Pending' 
            AND (UPPER(data::jsonb->>'action') = 'BUSY' OR data::jsonb->>'action' IS NULL)
            AND TRIM(UPPER(data::jsonb->>'branch')) = TRIM(UPPER($1))
          `, [branch]);

          if (existingRequest.rows.length > 0) {
            throw new Error("DUPLICATE_REQUEST");
          }

          return await client.query(`
            INSERT INTO pending_requests (user_id, type, data, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
          `, [(req as any).user.id, 'busy_branch', JSON.stringify({ ...req.body, action: 'BUSY', start_time, end_time, total_duration, total_duration_minutes, timer_expires_at }), getCurrentKuwaitTime(), getCurrentKuwaitTime()]);
        });
        
        broadcast({ type: "PENDING_REQUEST_CREATED" });
        sendSystemNotification(
          "New Busy Branch Request",
          "طلب فرع مزدحم جديد",
          `New busy branch request received from ${branch}`,
          `طلب فرع مزدحم جديد مستلم من ${branch}`,
          ["Technical Back Office"]
        );
        return res.json({ id: result.rows[0].id, pending: true });
      } catch (err: any) {
        if (err.message === "DUPLICATE_REQUEST") {
          return res.status(400).json({ 
            error: "تم إرسال طلب إغلاق الفرع بالفعل، الطلب قيد المراجعة حالياً في انتظار الموافقة.",
            error_en: "A busy branch request has already been sent and is currently under review."
          });
        }
        throw err;
      }
    }
    
    const result = await db.query(`
      INSERT INTO busy_period_records (
        user_id, date, brand, branch, start_time, end_time, 
        total_duration, total_duration_minutes, reason_category, responsible_party, 
        comment, internal_notes, created_at, timer_duration, timer_expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id
    `, [
      (req as any).user.id, date, brand, branch, start_time, end_time,
      total_duration, total_duration_minutes, reason_category, responsible_party,
      comment, internal_notes, getCurrentKuwaitTime(), timer_duration, timer_expires_at
    ]);
    
    await logAction((req as any).user.id, "BUSY", "busy_period_records", Number(result.rows[0].id), null, { 
      date, brand, branch, start_time, end_time, total_duration, reason_category, timer_duration 
    });
    
    broadcast({
      type: "NOTIFICATION",
      notificationType: "SYSTEM_ACTION",
      title_en: "Branch Busy Status",
      title_ar: "حالة الفرع مشغول",
      message_en: `Branch ${branch} is now Busy`,
      message_ar: `الفرع ${branch} الآن مشغول`,
    });
    broadcast({ type: "BUSY_PERIOD_CREATED" });
    res.json({ id: result.rows[0].id });
  });

  app.put("/api/busy-periods/:id", authenticate, async (req, res) => {
    const { id } = req.params;
    let { action, start_time, end_time, total_duration, total_duration_minutes } = req.body;
    const user = (req as any).user;

    const record = await db.get("SELECT * FROM busy_period_records WHERE id = $1", [id]) as any;
    if (!record) return res.status(404).json({ error: "Record not found" });

    // Manual edit by an admin/manager to correct a wrongly recorded start/end time.
    if (req.body.manual_edit === true) {
      if (user.role_name === 'Call Center' || user.role_name === 'Restaurants') {
        return res.status(403).json({ error: "Not authorized to edit records" });
      }
      const newStart = (start_time ?? record.start_time);
      const newEnd = (end_time ?? record.end_time) || null;
      let dur = record.total_duration;
      let durMin = record.total_duration_minutes;
      if (newEnd) {
        try {
          const sp = String(newStart).split(':');
          const ep = String(newEnd).split(':');
          let diff = (parseInt(ep[0]) * 60 + parseInt(ep[1])) - (parseInt(sp[0]) * 60 + parseInt(sp[1]));
          if (diff < 0) diff += 24 * 60; // overnight
          dur = `${Math.floor(diff / 60)}h ${diff % 60}m`;
          durMin = diff;
        } catch (e) {
          // keep existing duration if the times can't be parsed
        }
      }
      await db.query(`
        UPDATE busy_period_records
        SET start_time = $1, end_time = $2, total_duration = $3, total_duration_minutes = $4
        WHERE id = $5
      `, [newStart, newEnd, dur, durMin || 0, id]);

      await logAction(user.id, "BUSY_EDIT", "busy_period_records", Number(id),
        { start_time: record.start_time, end_time: record.end_time, total_duration: record.total_duration },
        { start_time: newStart, end_time: newEnd, total_duration: dur });

      broadcast({ type: "BUSY_PERIOD_UPDATED" });
      return res.json({ success: true });
    }

    if (user.role_name === 'Restaurants' && action === 'OPEN') {
      try {
        await db.transaction(async (client) => {
          // Use advisory lock to prevent race conditions on duplicate check
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`busy_branch_open_${record.branch.trim().toUpperCase()}`]);

          // Check for existing pending OPEN request for this branch
          const existingRequest = await client.query(`
            SELECT id FROM pending_requests 
            WHERE type = 'busy_branch' 
            AND status = 'Pending' 
            AND UPPER(data::jsonb->>'action') = 'OPEN' 
            AND TRIM(UPPER(data::jsonb->>'branch')) = TRIM(UPPER($1))
          `, [record.branch]);

          if (existingRequest.rows.length > 0) {
            throw new Error("DUPLICATE_REQUEST");
          }

          await client.query(`
            INSERT INTO pending_requests (user_id, type, data, status)
            VALUES ($1, $2, $3, $4)
          `, [user.id, 'busy_branch', JSON.stringify({ ...record, action: 'OPEN' }), 'Pending']);
        });
        
        broadcast({
          type: "NOTIFICATION",
          notificationType: "SYSTEM_ACTION",
          title_en: "New Open Branch Request",
          title_ar: "طلب فتح فرع جديد",
          message_en: `New open branch request from ${user.username}`,
          message_ar: `طلب فتح فرع جديد من ${user.username}`,
        });
        
        broadcast({ type: "PENDING_REQUEST_UPDATED" });
        return res.json({ success: true, pending: true });
      } catch (err: any) {
        if (err.message === "DUPLICATE_REQUEST") {
          return res.status(400).json({ 
            error: "تم إرسال طلب إعادة فتح الفرع بالفعل، الطلب قيد المراجعة حالياً في انتظار الموافقة.",
            error_en: "An open branch request has already been sent and is currently under review."
          });
        }
        throw err;
      }
    }

    if (action === 'OPEN' || !end_time) {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kuwait',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      end_time = formatter.format(now);
      
      // Calculate duration
      try {
        const startParts = record.start_time.split(':');
        const endParts = end_time.split(':');
        
        const startTotalMinutes = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
        const endTotalMinutes = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
        
        let diff = endTotalMinutes - startTotalMinutes;
        if (diff < 0) diff += 24 * 60; // handle overnight
        
        const hours = Math.floor(diff / 60);
        const minutes = diff % 60;
        total_duration = `${hours}h ${minutes}m`;
        total_duration_minutes = diff;
      } catch (e) {
        console.error("Error calculating duration", e);
        total_duration = '0h 0m';
        total_duration_minutes = 0;
      }
    }

    await db.query(`
      UPDATE busy_period_records 
      SET end_time = $1, total_duration = $2, total_duration_minutes = $3
      WHERE id = $4
    `, [end_time, total_duration, total_duration_minutes || 0, id]);
    
    await logAction((req as any).user.id, "BUSY_UPDATE", "busy_period_records", Number(id), null, { 
      brand: record.brand, branch: record.branch, end_time, total_duration, reason_category: record.reason_category 
    });
    
    broadcast({ type: "BUSY_PERIOD_UPDATED" });
    res.json({ success: true });
  });

  app.get("/api/busy-periods/active-alarms", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    try {
      const alarms = await db.all(`
        SELECT * FROM busy_period_records 
        WHERE (timer_expires_at AT TIME ZONE 'UTC') <= (NOW() AT TIME ZONE 'UTC')
        AND alarm_dismissed = FALSE 
        AND (end_time IS NULL OR end_time = '')
      `);
      res.json(alarms || []);
    } catch (err) {
      console.error("[Active Alarms] Error:", err);
      res.status(500).json({ error: "Failed to fetch active alarms" });
    }
  });

  app.post("/api/busy-periods/:id/dismiss-alarm", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    await db.query("UPDATE busy_period_records SET alarm_dismissed = TRUE WHERE id = $1", [req.params.id]);
    broadcast({ type: "ALARM_DISMISSED", id: req.params.id });
    res.json({ success: true });
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Background timer checker (Recursive Timeout for safety)
  const checkExpiredBusyPeriods = async () => {
    try {
      // Use explicit UTC comparison to match toISOString() values
      const expired = await db.all(`
        SELECT * FROM busy_period_records 
        WHERE (timer_expires_at AT TIME ZONE 'UTC') <= (NOW() AT TIME ZONE 'UTC')
        AND alarm_triggered = FALSE 
        AND alarm_dismissed = FALSE 
        AND (end_time IS NULL OR end_time = '')
      `);
      
      if (expired.length > 0) {
        console.log(`[Timer] Found ${expired.length} expired busy periods`);
      }

      for (const record of expired) {
        console.log(`[Timer] Triggering alarm for record ${record.id} (${record.branch})`);
        await db.query("UPDATE busy_period_records SET alarm_triggered = TRUE WHERE id = $1", [record.id]);
        broadcast({ 
          type: "BUSY_TIMER_EXPIRED", 
          record: record
        });
        
        sendSystemNotification(
          "Busy Timer Expired",
          "انتهى مؤقت الازدحام",
          `Timer for ${record.branch} (${record.brand}) has expired!`,
          `انتهى الوقت المحدد لفرع ${record.branch} (${record.brand})!`,
          ["Technical Back Office", "Manager", "Super Visor", "Operation Manager"],
          "BUSY_BRANCH"
        );
      }
    } catch (err) {
      console.error("[Timer] Error in background checker:", err);
    } finally {
      setTimeout(checkExpiredBusyPeriods, 15000); // Check every 15 seconds
    }
  };

  // Start the background checker after a short delay
  setTimeout(checkExpiredBusyPeriods, 5000);

  // Busy Branch Config Routes
  app.get("/api/branches", authenticate, async (req, res) => {
    const user = (req as any).user;
    const { brand_id, all } = req.query;
    const restriction = all === 'true' ? null : await getBrandRestriction(user);
    let query = "SELECT b.*, br.name as brand_name FROM branches b JOIN brands br ON b.brand_id = br.id";
    const params: any[] = [];
    const conditions: string[] = [];

    if (brand_id) {
      conditions.push("b.brand_id = $" + (params.length + 1));
      params.push(brand_id);
    }

    if (user.branch_id) {
      conditions.push("b.id = $" + (params.length + 1));
      params.push(user.branch_id);
    }

    if (restriction) {
      const placeholders = restriction.brands.map((_, i) => '$' + (params.length + i + 1)).join(',');
      if (restriction.type === 'include') {
        conditions.push(`br.name IN (${placeholders})`);
      } else {
        conditions.push(`br.name NOT IN (${placeholders})`);
      }
      params.push(...restriction.brands);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    const branches = await db.all(query, params);
    res.json(branches);
  });

  app.post("/api/branches", authenticate, authorize(["Technical Back Office", "Manager"]), async (req, res) => {
    const { brand_id, name } = req.body;
    await db.query("INSERT INTO branches (brand_id, name) VALUES ($1, $2)", [brand_id, name]);
    
    broadcast({
      type: "NOTIFICATION",
      notificationType: "SYSTEM_ACTION",
      title_en: "New Branch Created",
      title_ar: "تم إنشاء فرع جديد",
      message_en: `New branch ${name} has been created by ${(req as any).user.username}`,
      message_ar: `تم إنشاء فرع جديد ${name} من قبل ${(req as any).user.username}`,
    });

    res.json({ success: true });
  });

  app.delete("/api/branches/:id", authenticate, authorize(["Technical Back Office", "Manager"]), async (req, res) => {
    await db.query("DELETE FROM branches WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  });

  app.get("/api/busy-reasons", authenticate, async (req, res) => {
    const reasons = await db.all("SELECT * FROM busy_branch_reasons");
    res.json(reasons);
  });

  app.post("/api/busy-reasons", authenticate, authorize(["Manager", "Technical Back Office", "Operation Manager"]), async (req, res) => {
    await db.query("INSERT INTO busy_branch_reasons (name) VALUES ($1)", [req.body.name]);
    res.json({ success: true });
  });

  app.delete("/api/busy-reasons/:id", authenticate, authorize(["Manager", "Technical Back Office", "Operation Manager"]), async (req, res) => {
    await db.query("DELETE FROM busy_branch_reasons WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  });

  app.get("/api/busy-responsible", authenticate, async (req, res) => {
    const resp = await db.all("SELECT * FROM busy_branch_responsible");
    res.json(resp);
  });

  app.post("/api/busy-responsible", authenticate, authorize(["Technical Back Office", "Manager", "Operation Manager"]), async (req, res) => {
    await db.query("INSERT INTO busy_branch_responsible (name) VALUES ($1)", [req.body.name]);
    res.json({ success: true });
  });

  app.delete("/api/busy-responsible/:id", authenticate, authorize(["Technical Back Office", "Manager", "Operation Manager"]), async (req, res) => {
    await db.query("DELETE FROM busy_branch_responsible WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  });

  // Reports Routes
  app.get("/api/reports/brands", authenticate, async (req, res) => {
    const { brand_id } = req.query;
    let query = `
      SELECT 
        b.name as brand_name,
        (SELECT COUNT(*) FROM products WHERE brand_id = b.id) as total_products,
        (SELECT COUNT(DISTINCT product_id) FROM hidden_items WHERE brand_id = b.id) as hidden_products
      FROM brands b
    `;
    const params: any[] = [];
    const user = (req as any).user;
    if (user.role_name === 'Area Manager' && user.brand_id) {
      query += " WHERE b.id = $1";
      params.push(user.brand_id);
    } else if (brand_id) {
      query += " WHERE b.id = $1";
      params.push(brand_id);
    }
    query += " ORDER BY total_products DESC";
    
    const report = await db.all(query, params);
    res.json(report);
  });

  app.get("/api/reports/branch-hides", authenticate, async (req, res) => {
    const { branch_id, brand_id, date } = req.query;
    let query = `
      SELECT 
        br.name as branch_name,
        COUNT(CASE WHEN (hh.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date THEN 1 END) as today_count,
        COUNT(CASE WHEN (hh.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '7 days' THEN 1 END) as week_count,
        COUNT(CASE WHEN (hh.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '30 days' THEN 1 END) as month_count,
        COUNT(hh.id) as total_count
      FROM branches br
      LEFT JOIN hide_history hh ON br.id = hh.branch_id AND hh.action = 'HIDE'
    `;
    const params: any[] = [];
    const conditions: string[] = [];

    const user = (req as any).user;
    if (user.role_name === 'Area Manager') {
      const branchIds = await getBranchRestriction(user);
      if (branchIds && branchIds.length > 0) {
        const placeholders = branchIds.map((_, i) => `$${params.length + i + 1}`).join(',');
        conditions.push(`br.id IN (${placeholders})`);
        params.push(...branchIds);
      } else {
        conditions.push("1 = 0");
      }
    } else if (branch_id) {
      conditions.push("br.id = $" + (params.length + 1));
      params.push(branch_id);
    }
    if (brand_id) {
      conditions.push("br.brand_id = $" + (params.length + 1));
      params.push(brand_id);
    }

    const { startDate, endDate } = req.query as any;
    if (startDate) { conditions.push(`(hh.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= $${params.length + 1}`); params.push(startDate); }
    if (endDate) { conditions.push(`(hh.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date <= $${params.length + 1}`); params.push(endDate); }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " GROUP BY br.id, br.name ORDER BY total_count DESC";
    
    const report = await db.all(query, params);
    res.json(report);
  });

  app.get("/api/reports/branch-busy", authenticate, async (req, res) => {
    const { branch_id, brand_id, date, period } = req.query;
    let query = `
      SELECT 
        branch as branch_name,
        COUNT(*) as total_instances,
        SUM(total_duration_minutes) as total_minutes,
        AVG(total_duration_minutes) as avg_minutes
      FROM busy_period_records
    `;
    const params: any[] = [];
    const conditions: string[] = [];

    const user = (req as any).user;
    if (user.role_name === 'Area Manager') {
      const branchIds = await getBranchRestriction(user);
      if (branchIds && branchIds.length > 0) {
        const branchNamesResult = await db.all(`SELECT name FROM branches WHERE id IN (${branchIds.map((_, i) => `$${i + 1}`).join(',')})`, branchIds);
        const branchNames = branchNamesResult.map(b => b.name);
        const placeholders = branchNames.map((_, i) => `$${params.length + i + 1}`).join(',');
        conditions.push(`branch IN (${placeholders})`);
        params.push(...branchNames);
      } else {
        conditions.push("1 = 0");
      }
    } else if (branch_id) {
      const branchResult = await db.get("SELECT name FROM branches WHERE id = $1", [branch_id]) as { name: string };
      if (branchResult) {
        conditions.push("branch = $" + (params.length + 1));
        params.push(branchResult.name);
      }
    }
    if (brand_id) {
      const brandResult = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as { name: string };
      if (brandResult) {
        conditions.push("brand = $" + (params.length + 1));
        params.push(brandResult.name);
      }
    }

    if (date) {
      conditions.push("date = $" + (params.length + 1));
      params.push(date);
    }

    const { startDate, endDate } = req.query as any;
    if (startDate) { conditions.push(`(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= $${params.length + 1}`); params.push(startDate); }
    if (endDate) { conditions.push(`(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date <= $${params.length + 1}`); params.push(endDate); }
    if (!startDate && !endDate) {
      if (period === 'today') {
        conditions.push("(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date");
      } else if (period === 'week') {
        conditions.push("(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '7 days'");
      } else if (period === 'month') {
        conditions.push("(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '30 days'");
      }
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " GROUP BY branch ORDER BY total_minutes DESC";
    
    const report = await db.all(query, params);
    res.json(report);
  });

  app.get("/api/reports/reasons", authenticate, async (req, res) => {
    const { period, startDate, endDate, brand_id, branch_id } = req.query as any;
    let query = `SELECT reason_category as name, COUNT(*) as value FROM busy_period_records`;
    const conditions: string[] = [];
    const params: any[] = [];
    if (brand_id) {
      const brandRow = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as any;
      if (brandRow?.name) { conditions.push(`brand = $${params.length + 1}`); params.push(brandRow.name); }
    }
    if (branch_id) {
      const branchRow = await db.get("SELECT name FROM branches WHERE id = $1", [branch_id]) as any;
      if (branchRow?.name) { conditions.push(`branch = $${params.length + 1}`); params.push(branchRow.name); }
    }
    if (startDate) { conditions.push(`(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= $${params.length + 1}`); params.push(startDate); }
    if (endDate) { conditions.push(`(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date <= $${params.length + 1}`); params.push(endDate); }
    if (!startDate && !endDate) {
      if (period === 'today') conditions.push("(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date");
      else if (period === 'week') conditions.push("(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '7 days'");
      else if (period === 'month') conditions.push("(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '30 days'");
    }

    if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
    query += " GROUP BY reason_category ORDER BY value DESC";
    res.json(await db.all(query, params));
  });

  app.get("/api/reports/timeline", authenticate, async (req, res) => {
    const { startDate, endDate, brand_id, branch_id } = req.query as any;
    const dateExpr = "(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date";
    const params: any[] = [];
    const conditions: string[] = [];

    if (startDate) { conditions.push(`${dateExpr} >= $${params.length + 1}`); params.push(startDate); }
    if (endDate) { conditions.push(`${dateExpr} <= $${params.length + 1}`); params.push(endDate); }
    if (!startDate && !endDate) {
      conditions.push(`${dateExpr} >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '30 days'`);
    }
    if (brand_id) {
      const brandRow = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as any;
      if (brandRow?.name) { conditions.push(`brand = $${params.length + 1}`); params.push(brandRow.name); }
    }
    if (branch_id) {
      const branchRow = await db.get("SELECT name FROM branches WHERE id = $1", [branch_id]) as any;
      if (branchRow?.name) { conditions.push(`branch = $${params.length + 1}`); params.push(branchRow.name); }
    }

    const query = `
      SELECT ${dateExpr} as date,
        COUNT(*) as incidents,
        SUM(total_duration_minutes) as duration
      FROM busy_period_records
      WHERE ${conditions.join(' AND ')}
      GROUP BY ${dateExpr}
      ORDER BY date ASC
    `;
    res.json(await db.all(query, params));
  });

  app.get("/api/reports/user-kpi", authenticate, async (req, res) => {
    const user = (req as any).user;
    let { user_id, period, startDate, endDate, brand_id, role } = req.query as any;

    // If not manager, force user_id to current user
    if (user.role_name !== 'Manager') {
      user_id = user.id.toString();
    }
    
    let query = `
      SELECT 
        u.id as user_id,
        u.username,
        al.action,
        al.target_table,
        COUNT(*) as count
      FROM audit_logs al
      JOIN users u ON al.user_id = u.id
    `;
    const params: any[] = [];
    const conditions: string[] = [];
    
    if (user_id && user_id !== 'all') {
      conditions.push("al.user_id = $" + (params.length + 1));
      params.push(user_id);
    }

    // User Type (role) filter — restrict to users of the selected role.
    if (role && role !== 'all') {
      conditions.push("u.role_id = (SELECT id FROM roles WHERE name = $" + (params.length + 1) + " LIMIT 1)");
      params.push(role);
    }
    
    // A date range takes precedence over the period preset.
    if (startDate) { conditions.push(`(al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= $${params.length + 1}`); params.push(startDate); }
    if (endDate) { conditions.push(`(al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date <= $${params.length + 1}`); params.push(endDate); }
    if (!startDate && !endDate) {
      if (period === 'today') conditions.push("(al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date");
      else if (period === 'week') conditions.push("(al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '7 days'");
      else if (period === 'month') conditions.push("(al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '30 days'");
    }

    // Brand filter — audit_logs has no brand column, so match the brand name
    // stored in each action's JSON payload (products use brand_name, busy uses brand).
    if (brand_id && brand_id !== 'all') {
      const brandRow = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as any;
      if (brandRow?.name) {
        const bi = params.length + 1;
        params.push(brandRow.name);
        conditions.push(`(
          (CASE WHEN al.new_value ~ '^[{]' THEN al.new_value::jsonb->>'brand_name' END = $${bi})
          OR (CASE WHEN al.new_value ~ '^[{]' THEN al.new_value::jsonb->>'brand' END = $${bi})
          OR (CASE WHEN al.old_value ~ '^[{]' THEN al.old_value::jsonb->>'brand_name' END = $${bi})
          OR (CASE WHEN al.old_value ~ '^[{]' THEN al.old_value::jsonb->>'brand' END = $${bi})
        )`);
      } else {
        conditions.push("1 = 0");
      }
    }

    if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
    query += " GROUP BY u.id, u.username, al.action, al.target_table ORDER BY count DESC";

    const report = await db.all(query, params);
    res.json(report);
  });

  app.get("/api/reports/user-activity-details", authenticate, async (req, res) => {
    const user = (req as any).user;
    let { user_id, period, startDate, endDate, brand_id, role } = req.query as any;

    // If not manager, force user_id to current user
    if (user.role_name !== 'Manager') {
      user_id = user.id.toString();
    }

    let query = `
      SELECT 
        al.id,
        u.username,
        al.action,
        al.target_table,
        al.target_id,
        al.old_value,
        al.new_value,
        al.timestamp
      FROM audit_logs al
      JOIN users u ON al.user_id = u.id
    `;
    const params: any[] = [];
    const conditions: string[] = [];
    
    if (user_id && user_id !== 'all') {
      conditions.push("al.user_id = $" + (params.length + 1));
      params.push(user_id);
    }

    // User Type (role) filter — restrict to users of the selected role.
    if (role && role !== 'all') {
      conditions.push("u.role_id = (SELECT id FROM roles WHERE name = $" + (params.length + 1) + " LIMIT 1)");
      params.push(role);
    }
    
    // A date range takes precedence over the period preset.
    if (startDate) { conditions.push(`(al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= $${params.length + 1}`); params.push(startDate); }
    if (endDate) { conditions.push(`(al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date <= $${params.length + 1}`); params.push(endDate); }
    if (!startDate && !endDate) {
      if (period === 'today') conditions.push("(al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date");
      else if (period === 'week') conditions.push("(al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '7 days'");
      else if (period === 'month') conditions.push("(al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '30 days'");
    }

    // Brand filter — match the brand name stored in each action's JSON payload.
    if (brand_id && brand_id !== 'all') {
      const brandRow = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as any;
      if (brandRow?.name) {
        const bi = params.length + 1;
        params.push(brandRow.name);
        conditions.push(`(
          (CASE WHEN al.new_value ~ '^[{]' THEN al.new_value::jsonb->>'brand_name' END = $${bi})
          OR (CASE WHEN al.new_value ~ '^[{]' THEN al.new_value::jsonb->>'brand' END = $${bi})
          OR (CASE WHEN al.old_value ~ '^[{]' THEN al.old_value::jsonb->>'brand_name' END = $${bi})
          OR (CASE WHEN al.old_value ~ '^[{]' THEN al.old_value::jsonb->>'brand' END = $${bi})
        )`);
      } else {
        conditions.push("1 = 0");
      }
    }

    if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY al.timestamp DESC LIMIT 500";

    const logs = await db.all(query, params);
    res.json(logs);
  });

  // Technical Team performance: how each agent processed hide/busy requests
  // (throughput + approve/reject + response duration from pending_requests).
  app.get("/api/reports/team-performance", authenticate, authorize(["Manager", "Super Visor", "Operation Manager", "Technical Back Office", "Call Center", "Technical Team", "Coding Team", "Marketing Team"]), async (req, res) => {
    const reqUser = (req as any).user;
    let { startDate, endDate, brand_id, branch_id, role, user_id, period } = req.query as any;

    // Non-managers can only see their own row.
    const managerRoles = ["Manager", "Super Visor", "Operation Manager"];
    if (!managerRoles.includes(reqUser.role_name)) {
      user_id = String(reqUser.id);
    }

    const params: any[] = [];
    const conditions: string[] = ["pr.status <> 'Pending'", "pr.processed_by IS NOT NULL"];

    // Default to Technical Back Office; the User Type filter overrides it.
    const roleName = role && role !== 'all' ? role : 'Technical Back Office';
    conditions.push(`pr_role.name = $${params.length + 1}`);
    params.push(roleName);

    if (user_id && user_id !== 'all') {
      conditions.push(`pr.processed_by = $${params.length + 1}`);
      params.push(user_id);
    }

    const procDate = "(pr.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date";
    const today = "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date";
    if (startDate) { conditions.push(`${procDate} >= $${params.length + 1}`); params.push(startDate); }
    if (endDate) { conditions.push(`${procDate} <= $${params.length + 1}`); params.push(endDate); }
    if (!startDate && !endDate) {
      if (period === 'today') conditions.push(`${procDate} = ${today}`);
      else if (period === 'week') conditions.push(`${procDate} >= ${today} - INTERVAL '7 days'`);
      else if (period === 'month') conditions.push(`${procDate} >= ${today} - INTERVAL '30 days'`);
    }

    if (brand_id) {
      const brandRow = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as any;
      if (brandRow?.name) {
        const i = params.length + 1;
        params.push(brandRow.name);
        conditions.push(`(pr.data::jsonb->>'brand_name' = $${i} OR pr.data::jsonb->>'brand' = $${i})`);
      }
    }
    if (branch_id) {
      const branchRow = await db.get("SELECT name FROM branches WHERE id = $1", [branch_id]) as any;
      if (branchRow?.name) {
        const i = params.length + 1;
        params.push(branchRow.name);
        conditions.push(`(pr.data::jsonb->>'branch_name' = $${i} OR pr.data::jsonb->>'branch' = $${i})`);
      }
    }

    const rows = await db.all(`
      SELECT pu.id AS user_id, pu.username,
        COUNT(*)::int AS processed,
        COUNT(*) FILTER (WHERE pr.status='Approved')::int AS approved,
        COUNT(*) FILTER (WHERE pr.status='Rejected')::int AS rejected,
        ROUND(AVG(EXTRACT(EPOCH FROM (pr.updated_at - pr.created_at))/60))::int AS avg_resp_min,
        ROUND(MAX(EXTRACT(EPOCH FROM (pr.updated_at - pr.created_at))/60))::int AS max_resp_min
      FROM pending_requests pr
      JOIN users pu ON pr.processed_by = pu.id
      JOIN roles pr_role ON pu.role_id = pr_role.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY pu.id, pu.username
      ORDER BY processed DESC
    `, params);

    res.json(rows);
  });

  app.get("/api/reports/team-target", authenticate, async (_req, res) => {
    const row = await db.get("SELECT value FROM performance_targets WHERE metric = 'avg_response_min'") as any;
    res.json({ avg_response_min: row?.value != null ? Number(row.value) : null });
  });

  app.put("/api/reports/team-target", authenticate, authorize(["Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    const { avg_response_min } = req.body;
    const val = (avg_response_min === '' || avg_response_min == null) ? null : Number(avg_response_min);
    await db.query(`
      INSERT INTO performance_targets (metric, value, updated_by, updated_at)
      VALUES ('avg_response_min', $1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (metric) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
    `, [val, (req as any).user.id]);
    res.json({ success: true });
  });

  // ---- Branch Chat (invoice photos + comments between a branch and the office) ----
  const CHAT_ROLES = ["Restaurants", "Technical Back Office", "Manager", "Super Visor", "Operation Manager"];

  app.post("/api/branch-chat", authenticate, authorize(CHAT_ROLES), upload.single('image'), async (req, res) => {
    const user = (req as any).user;
    const fromRestaurant = user.role_name === 'Restaurants';
    let branch_id = fromRestaurant ? user.branch_id : req.body.branch_id;
    const comment = (req.body.comment || '').trim() || null;
    const image_url = req.file ? `/uploads/${req.file.filename}` : null;
    const image_type = req.file ? req.file.mimetype : null;

    if (!branch_id) return res.status(400).json({ error: "branch_id required" });
    if (!comment && !image_url) return res.status(400).json({ error: "Message is empty" });

    const branch = await db.get("SELECT id, brand_id, name FROM branches WHERE id = $1", [branch_id]) as any;
    if (!branch) return res.status(404).json({ error: "Branch not found" });

    const ins = await db.query(`
      INSERT INTO branch_messages (brand_id, branch_id, sender_id, sender_role, comment, image_url, image_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at
    `, [branch.brand_id, branch.id, user.id, user.role_name, comment, image_url, image_type]);

    try {
      const brand = await db.get("SELECT name FROM brands WHERE id = $1", [branch.brand_id]) as any;
      const label = `${brand?.name || ''} · ${branch.name}`;
      const preview = comment ? comment.slice(0, 80) : '📷';
      const recipients = fromRestaurant
        ? ["Technical Back Office", "Manager", "Super Visor", "Operation Manager"]
        : ["Restaurants"];
      broadcast({
        type: "NOTIFICATION",
        notificationType: "CALL_CENTER",
        title_en: "New invoice message",
        title_ar: "رسالة فاتورة جديدة",
        message_en: `${label} — ${user.username}: ${preview}`,
        message_ar: `${label} — ${user.username}: ${preview}`,
        role_target: recipients,
        ...(fromRestaurant ? {} : { brand_id: branch.brand_id, branch_id: branch.id }),
        chat_branch_id: branch.id,
      });
      broadcast({ type: "BRANCH_CHAT_UPDATED", branch_id: branch.id });
      const push = {
        title: "New invoice message",
        body: `${label} — ${user.username}: ${preview}`,
        tag: `branch-chat-${branch.id}`,
        data: { type: "BRANCH_CHAT", branchId: branch.id, url: `/?chat=${branch.id}` },
      };
      if (fromRestaurant) await sendPushToRoles(recipients, push);
      else await sendPushToRoles(["Restaurants"], push, branch.id);
    } catch (e) { console.error("branch-chat notify failed", e); }

    res.json({ id: ins.rows[0].id });
  });

  app.get("/api/branch-chat", authenticate, authorize(CHAT_ROLES), async (req, res) => {
    const user = (req as any).user;
    const branch_id = user.role_name === 'Restaurants' ? user.branch_id : (req.query.branch_id as string);
    if (!branch_id) return res.json([]);

    const msgs = await db.all(`
      SELECT bm.id, bm.branch_id, bm.sender_id, bm.sender_role, bm.comment, bm.image_url, bm.image_type, bm.created_at, u.username
      FROM branch_messages bm JOIN users u ON bm.sender_id = u.id
      WHERE bm.branch_id = $1 ORDER BY bm.created_at ASC
    `, [branch_id]);

    // Mark the OTHER side's messages as read for this viewer.
    const isRestaurant = user.role_name === 'Restaurants';
    await db.query(`
      UPDATE branch_messages SET read_at = CURRENT_TIMESTAMP
      WHERE branch_id = $1 AND read_at IS NULL
        AND sender_role ${isRestaurant ? "<>" : "="} 'Restaurants'
    `, [branch_id]);

    res.json(msgs);
  });

  app.get("/api/branch-chat/threads", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    const threads = await db.all(`
      SELECT bm.branch_id, b.name AS brand_name, br.name AS branch_name,
        MAX(bm.created_at) AS last_at,
        COUNT(*) FILTER (WHERE bm.sender_role = 'Restaurants' AND bm.read_at IS NULL)::int AS unread
      FROM branch_messages bm
      JOIN branches br ON bm.branch_id = br.id
      JOIN brands b ON bm.brand_id = b.id
      GROUP BY bm.branch_id, b.name, br.name
      ORDER BY MAX(bm.created_at) DESC
    `);
    res.json(threads);
  });

  app.get("/api/export", authenticate, async (req, res) => {
    const products = await db.all(`
      SELECT p.id, b.name as brand, pc.code as product_code, p.created_at
      FROM products p
      JOIN brands b ON p.brand_id = b.id
      LEFT JOIN product_codes pc ON p.id = pc.product_id
    `);
    
    const ws = XLSX.utils.json_to_sheet(products);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Products");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    
    res.setHeader("Content-Disposition", "attachment; filename=products.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  });

  // Serve static files
  const distPath = path.join(process.cwd(), "dist");
  const distExists = fs.existsSync(distPath);
  
  console.log("--- STATIC FILES DEBUG ---");
  console.log("Current Working Directory (cwd):", process.cwd());
  console.log("Expected Dist Path:", distPath);
  console.log("Dist Folder Exists:", distExists);
  if (distExists) {
    console.log("Contents of dist:", fs.readdirSync(distPath));
  }
  console.log("--------------------------");

  // API 404 Handler - MUST BE BEFORE STATIC SERVING
  app.all("/api/*", (req, res) => {
    console.warn(`API 404: ${req.method} ${req.url}`);
    res.status(404).json({ 
      error: "Not Found", 
      message: `API route ${req.method} ${req.path} not found on this server.`,
      path: req.path
    });
  });

  // Authenticated /uploads. Browsers send the swish_token cookie on <img>
  // and <a download> requests automatically (same-origin), so the existing
  // attachment_url paths in the frontend keep working.
  app.use("/uploads", authenticate, express.static(uploadDir));
  
  if (process.env.NODE_ENV !== "production") {
    console.log("Development mode: Starting Vite middleware...");
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (e) {
      console.error("Vite middleware failed:", e);
    }
  } else if (distExists) {
    console.log("--- DIST FOLDER STRUCTURE ---");
    const walk = (dir: string) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const p = path.join(dir, file);
        if (fs.statSync(p).isDirectory()) {
          walk(p);
        } else {
          console.log("Found File:", p.replace(distPath, ""));
        }
      }
    };
    try { walk(distPath); } catch(e) { console.error("Error walking dist:", e); }
    console.log("-----------------------------");

    console.log("Production mode: Serving from dist folder");
    app.use(express.static(distPath, {
      maxAge: '1h',
      setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
        }
      }
    }));
    
    app.get("*", (req, res, next) => {
      if (req.url.startsWith("/api")) return next();
      
      // Detailed logging for 404 assets
      if (req.path.includes(".") || req.url.includes(".")) {
        const fullPath = path.join(distPath, req.path);
        console.log(`Asset 404: ${req.url} (Checked path: ${fullPath})`);
        
        // Check if the directory exists and what's inside
        const dirPath = path.dirname(fullPath);
        if (fs.existsSync(dirPath)) {
          console.log(`Directory ${dirPath} contents:`, fs.readdirSync(dirPath));
        } else {
          console.log(`Directory ${dirPath} does NOT exist.`);
        }
        
        return res.status(404).send("File not found");
      }

      const filePath = path.join(distPath, "index.html");
      if (fs.existsSync(filePath)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
        res.sendFile(filePath);
      } else {
        console.error("CRITICAL: index.html not found at", filePath);
        res.status(404).send("Frontend build not found. Please run 'npm run build'.");
      }
    });
  } else {
    console.error("CRITICAL ERROR: 'dist' folder not found in production environment!");
    console.log("Current working directory:", process.cwd());
    console.log("Files in current directory:", fs.readdirSync(process.cwd()));
    
    app.get("*", (req, res) => {
      res.status(500).send(`
        <h1>Frontend Build Missing</h1>
        <p>The 'dist' folder was not found. Please ensure 'npm run build' was executed during deployment.</p>
        <p>Current Path: ${distPath}</p>
      `);
    });
  }

  // Global Error Handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Global Error:", err);
    res.status(err.status || 500).json({ 
      error: err.message || "Internal Server Error",
      details: process.env.NODE_ENV === 'production' ? null : err.stack
    });
  });

  console.log("Attempting to start server on port", PORT);
  console.log(`Attempting to listen on 0.0.0.0:${PORT}...`);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server successfully started and listening on http://0.0.0.0:${PORT}`);
  });
}

console.log("Calling startServer()...");
startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
