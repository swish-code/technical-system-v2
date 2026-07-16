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
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

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
      console.log("[DB] Using INTERNAL Railway URL (private network) — recommended: no egress cost.");
    } else {
      console.log("[DB] Using PUBLIC proxy — note: DB traffic is billed as EGRESS. Switch to postgres.railway.internal:5432 to cut cost.");
    }
  } catch (e) {
    console.log(`[DB] Invalid connection string format.`);
  }
}

// Internal Railway networking (postgres.railway.internal) runs over the private
// network — no SSL, and crucially NOT billed as egress (unlike the public
// *.proxy.rlwy.net proxy). Prefer the internal host to cut egress cost.
const isInternalDb = !!connectionString && connectionString.includes('railway.internal');
const pool = new Pool({
  connectionString: connectionString,
  ssl: isInternalDb ? false : (connectionString?.includes('railway') ? { rejectUnauthorized: false } : false)
});

if (isInternalDb) {
  console.log("[DB] Private network in use (postgres.railway.internal) — DB traffic is off billed egress. Good for cost.");
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

// Brand scope as an array of brand_ids for chat queries, or null = unrestricted
// (e.g. Technical Back Office / unrestricted managers). An empty array means
// the user is limited to no brands.
const getAllowedBrandIds = async (user: any): Promise<number[] | null> => {
  const restriction = await getBrandRestriction(user);
  if (!restriction || restriction.type !== 'include') return null;
  if (!restriction.brands.length) return [];
  const rows = await db.all("SELECT id FROM brands WHERE name = ANY($1)", [restriction.brands]);
  return rows.map((r: any) => r.id);
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
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/3gpp": ".3gp",
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
    fileSize: 50 * 1024 * 1024, // 50MB — raised from 10MB to allow short video clips in chat.
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

// Server-side image shrink. Runs on EVERY upload regardless of the client (web,
// PWA, or the APK), so raw full-resolution phone photos (2–4MB) don't get
// stored/served at full size. Downscales the longest edge to 1600px and
// re-encodes (JPEG q78 for the common camera-photo case), keeping invoice text
// legible. Best-effort: on any failure, or if it wouldn't be smaller, the
// original file is left untouched so a message always still sends. Videos, PDFs
// and GIFs are skipped. Overwrites in place, so filename/mimetype stay valid.
const IMAGE_MAX_EDGE = 1600;
async function shrinkImageOnDisk(filePath: string, mimetype: string): Promise<void> {
  if (!mimetype.startsWith("image/") || mimetype === "image/gif") return;
  try {
    const original = fs.statSync(filePath).size;
    let pipeline = sharp(filePath, { failOn: "none" })
      .rotate() // bake in EXIF orientation before we strip metadata
      .resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: "inside", withoutEnlargement: true });
    if (mimetype === "image/png") pipeline = pipeline.png({ compressionLevel: 9, palette: true });
    else if (mimetype === "image/webp") pipeline = pipeline.webp({ quality: 80 });
    else pipeline = pipeline.jpeg({ quality: 78, mozjpeg: true });

    const buf = await pipeline.toBuffer();
    if (buf.length < original) fs.writeFileSync(filePath, buf);
  } catch (e: any) {
    console.error("image shrink skipped:", e?.message || e);
  }
}

// --- Cloudflare R2 (S3-compatible) object storage. When configured, uploaded
// media is pushed to R2 and served from its public URL (free egress + edge
// caching near users) instead of streaming through this app. Falls back to the
// local /uploads path when R2 is off or an upload fails, so media always works.
// Only NEW uploads use R2; existing /uploads URLs keep being served locally.
const R2_ENABLED = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET && process.env.R2_PUBLIC_URL);
const r2Client = R2_ENABLED ? new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
  },
}) : null;
if (R2_ENABLED) console.log("[R2] Enabled — new uploads go to bucket:", process.env.R2_BUCKET);

// Returns the public URL a freshly-uploaded (already shrunk) file should be
// served from. Pushes it to R2 and deletes the local copy on success; on any
// failure or when R2 is off, returns the local /uploads path so media still works.
async function publicUrlForUpload(file: any): Promise<string> {
  const localUrl = `/uploads/${file.filename}`;
  if (!r2Client) return localUrl;
  try {
    const body = await fs.promises.readFile(file.path);
    await r2Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET as string,
      Key: file.filename,
      Body: body,
      ContentType: file.mimetype || "application/octet-stream",
    }));
    try { await fs.promises.unlink(file.path); } catch { /* keep the local copy if unlink fails */ }
    return `${(process.env.R2_PUBLIC_URL as string).replace(/\/+$/, "")}/${file.filename}`;
  } catch (e: any) {
    console.error("[R2] upload failed, serving locally:", e?.message || e);
    return localUrl;
  }
}

// Post-multer middleware: shrink any uploaded image(s), then push them to R2 (if
// configured) and stamp each file with its public URL for the handler to store.
const shrinkUploads = async (req: any, _res: any, next: any) => {
  try {
    const files: any[] = req.file ? [req.file] : (Array.isArray(req.files) ? req.files : []);
    await Promise.all(files.map(async (f) => {
      await shrinkImageOnDisk(f.path, f.mimetype);
      f.publicUrl = await publicUrlForUpload(f);
    }));
  } catch (e) {
    console.error("shrinkUploads error:", e);
  }
  next();
};

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
    "Complain Team",
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

  -- Technical Team KPIs (admin/supervisor). Month-level values shared across all
  -- agents: the editable FTR speed target (minutes) and the company Rating (/5).
  CREATE TABLE IF NOT EXISTS technical_kpi_month (
    period_month TEXT PRIMARY KEY,          -- 'YYYY-MM'
    ftr_target_min NUMERIC,
    rating NUMERIC,                         -- out of 5, same for every agent
    updated_by INTEGER,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  -- Per-agent, per-month SLA score (0-100), entered manually by admin/supervisor.
  CREATE TABLE IF NOT EXISTS technical_kpi_sla (
    period_month TEXT NOT NULL,             -- 'YYYY-MM'
    user_id INTEGER NOT NULL,
    sla NUMERIC,                            -- 0-100
    updated_by INTEGER,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (period_month, user_id)
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
    status TEXT DEFAULT 'pending',
    status_by INTEGER,
    status_at TIMESTAMP,
    reply_to_id INTEGER,
    resolved_at TIMESTAMP,
    resolved_by INTEGER,
    resolve_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_branch_messages_branch ON branch_messages(branch_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_branch_messages_branch_role ON branch_messages(branch_id, sender_role, created_at);

  -- Per-user, per-branch "last read" marker: each user's own independent unread
  -- state in chat. (branch_messages.read_at stays as the shared "the other side
  -- saw it" flag that powers the Seen receipts — the two are separate concerns.)
  CREATE TABLE IF NOT EXISTS branch_reads (
    user_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    last_read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, branch_id)
  );

  -- ===== Technical Task Log (self-contained feature; the "Task" page) =====
  -- One row per logged technical task. Independent of every other table.
  CREATE TABLE IF NOT EXISTS activity_logs (
    id SERIAL PRIMARY KEY,
    log_type TEXT NOT NULL DEFAULT 'technical',
    department TEXT NOT NULL DEFAULT 'Technical',
    activity_type TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    brand_id INTEGER,
    notes TEXT,
    agent_id INTEGER NOT NULL,
    agent_name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_activity_logs_agent ON activity_logs(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);
  -- Customizable dropdown lists for the Task page (edited in its Config section).
  CREATE TABLE IF NOT EXISTS tech_activity (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cc_status (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    counts_time BOOLEAN DEFAULT false,
    sort_order INTEGER DEFAULT 0
  );

  -- Assigned Tasks: a Manager assigns a task to a Technical Back Office employee;
  -- the employee works it New→In Progress→Completed and logs time on completion.
  CREATE TABLE IF NOT EXISTS assigned_tasks (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    assigned_by INTEGER NOT NULL,
    assigned_by_name TEXT NOT NULL,
    assigned_to INTEGER NOT NULL,
    assigned_to_name TEXT,
    department TEXT,
    task_type TEXT,
    template_id INTEGER,
    task_date DATE,
    priority TEXT NOT NULL DEFAULT 'Medium',
    due_date TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'New',
    seen BOOLEAN DEFAULT false,
    duration_seconds INTEGER,
    note TEXT,
    require_time_entry BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_assigned_tasks_to ON assigned_tasks(assigned_to, status);
  CREATE INDEX IF NOT EXISTS idx_assigned_tasks_by ON assigned_tasks(assigned_by, created_at DESC);

  -- Recurring task templates: a Manager defines a task that auto-generates ONE
  -- instance per matching day (Kuwait). assign_mode 'pool' -> status 'Available'
  -- (any On-Shift TBO agent can Claim it); 'auto' -> assigned to the least-loaded
  -- On-Shift agent, falling back to the pool when nobody is On Shift.
  CREATE TABLE IF NOT EXISTS task_templates (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    department TEXT DEFAULT 'Technical Back Office',
    task_type TEXT,
    recurrence TEXT NOT NULL DEFAULT 'daily',   -- 'daily' | 'days'
    days TEXT,                                  -- CSV of 0..6 (Sun..Sat) when recurrence='days'
    due_time TEXT DEFAULT '17:00',
    priority TEXT NOT NULL DEFAULT 'Medium',
    assign_mode TEXT NOT NULL DEFAULT 'pool',   -- 'pool' | 'auto'
    require_time_entry BOOLEAN DEFAULT true,
    active BOOLEAN DEFAULT true,
    created_by INTEGER,
    created_by_name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  -- One instance per template per day: the guard that makes generation idempotent.
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_template_day ON assigned_tasks(template_id, task_date) WHERE template_id IS NOT NULL;

  -- Ticket workflow: an agent PICKS a hide/busy/chat ticket (single assignment),
  -- does the work on the aggregators, then marks it DONE — which records the
  -- action (via applyPendingRequest for hide/busy) and auto-logs a task with
  -- duration = done - picked. Additive; no existing table is touched.
  CREATE TABLE IF NOT EXISTS ticket_assignments (
    id SERIAL PRIMARY KEY,
    ticket_type TEXT NOT NULL,            -- 'hide_unhide' | 'busy_branch' | 'chat'
    ticket_id INTEGER NOT NULL,           -- pending_requests.id or branch_messages.id
    assigned_to INTEGER NOT NULL,         -- agent holding it
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'in_progress', -- 'in_progress' | 'done' | 'transferred'
    done_at TIMESTAMP,
    done_by INTEGER,
    duration_seconds INTEGER,
    task_log_id INTEGER,                  -- the activity_logs row created on done
    brand_id INTEGER,
    branch_id INTEGER
  );
  -- Atomic single-claim: at most one ACTIVE (in_progress) holder per ticket.
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_ticket_active
    ON ticket_assignments (ticket_type, ticket_id) WHERE status = 'in_progress';
  -- Fast "does this agent already hold one?" + queue lookups.
  CREATE INDEX IF NOT EXISTS idx_ticket_active_agent
    ON ticket_assignments (assigned_to) WHERE status = 'in_progress';

  -- Group chat (admin-created, member-scoped, multi-user) — separate from the
  -- branch chat model. chat_group_members controls who can see/use a group.
  CREATE TABLE IF NOT EXISTS chat_groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS chat_group_members (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS group_messages (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    comment TEXT,
    image_url TEXT,
    image_type TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_chat_group_members_user ON chat_group_members(user_id);

  -- Message reactions (one 👍 like per user per message). message_type is
  -- 'branch' or 'group' so a single table covers both chat kinds.
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_type TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL DEFAULT '👍',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_type, message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_message_reactions_msg ON message_reactions(message_type, message_id);

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
  CREATE INDEX IF NOT EXISTS idx_pending_requests_created ON pending_requests(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pending_requests_user ON pending_requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_pfv_field_product ON product_field_values(field_id, product_id);
  CREATE INDEX IF NOT EXISTS idx_hidden_items_created ON hidden_items(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_hide_history_timestamp ON hide_history(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_branches_brand ON branches(brand_id);
`);

  // One-time backfill so switching to per-user chat unread doesn't flood everyone
  // with old threads shown as unread. Seeds every existing (user, branch) pair to
  // "read now" — but only while branch_reads is still empty (first boot post-deploy).
  try {
    await db.query(`
      INSERT INTO branch_reads (user_id, branch_id, last_read_at)
      SELECT u.id, b.id, CURRENT_TIMESTAMP
      FROM users u CROSS JOIN branches b
      WHERE NOT EXISTS (SELECT 1 FROM branch_reads)
      ON CONFLICT (user_id, branch_id) DO NOTHING
    `);
  } catch (e) {
    console.error("branch_reads backfill skipped:", e);
  }

// Migration: Add is_offline to products if it doesn't exist
try {
  await db.exec("ALTER TABLE products ADD COLUMN is_offline INTEGER DEFAULT 0");
  console.log("Added is_offline column to products");
} catch (e) {
  // Column already exists
}

// Migration: Add reply_to_id to group_messages (group chat replies)
try {
  await db.exec("ALTER TABLE group_messages ADD COLUMN reply_to_id INTEGER");
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

  const roles = ["Marketing Team", "Coding Team", "Technical Team", "Call Center", "Complain Team", "Technical Back Office", "Manager", "Restaurants", "Super Visor", "Area Manager", "Operation Manager"];
  for (const roleName of roles) {
    const exists = await db.get("SELECT id FROM roles WHERE name = $1", [roleName]);
    if (!exists) {
      await db.query("INSERT INTO roles (name) VALUES ($1)", [roleName]);
    }
  }

  // Seed the Task page's dropdown lists (only if a value doesn't already exist;
  // fully editable later from the Task page's Configuration section).
  const techActivities = [
    "Delayed Orders Follow-up", "Aggregator Follow-up", "Missing Item Cases", "Wrong Dispatch Cases",
    "Big Order Confirmation", "Order Assignment", "Aggregator Comments", "Punch Orders",
    "Open Branch", "Busy Branch", "Close Branch", "Hide Item", "Unhide Item",
    "Follow-up Groups", "Cancellation Request", "Foodics / POS Issues", "Invoice Chat", "Other",
  ];
  for (let i = 0; i < techActivities.length; i++) {
    await db.query("INSERT INTO tech_activity (name, sort_order) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [techActivities[i], i]);
  }
  const taskStatuses: Array<[string, boolean]> = [["Open", false], ["In Progress", false], ["Completed", true]];
  for (let i = 0; i < taskStatuses.length; i++) {
    await db.query("INSERT INTO cc_status (name, counts_time, sort_order) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING", [taskStatuses[i][0], taskStatuses[i][1], i]);
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
  // Railway sits behind one edge proxy hop that sets X-Forwarded-For. Without
  // this, express-rate-limit (used on /api/login) throws a ValidationError on
  // every request since it can't safely resolve the real client IP, which
  // hangs the login request forever (the throw is an unhandled rejection).
  app.set("trust proxy", 1);
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
        (ws as any).isAlive = true;
        ws.on("pong", () => { (ws as any).isAlive = true; });
        wss.emit("connection", ws, req);
      });
    } catch (_err) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    }
  });

  // WS heartbeat: ping every 30s and drop clients that stopped responding.
  // Keeps connections alive through idle proxy timeouts (which otherwise close
  // the socket during quiet periods) and reaps zombie/half-dead sockets so a
  // client never silently stops receiving live chat/notification events.
  const wsHeartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const c = ws as any;
      if (c.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
      c.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  }, 30000);
  wss.on("close", () => clearInterval(wsHeartbeat));

  app.use(express.json());
  app.use(cookieParser());

  // Cookie options shared by /api/login (set) and /api/logout (clear).
  const AUTH_COOKIE_NAME = "swish_token";
  const AUTH_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000; // 400d — effectively never logs out (browsers cap cookies at ~400d). Matches JWT expiresIn.
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
      // On Railway's private network, DNS for *.railway.internal can take a
      // moment to be ready at cold start. Retry a few times before giving up so
      // switching DATABASE_URL to the internal host doesn't fail on boot.
      for (let attempt = 1; attempt <= 10; attempt++) {
        try { await pool.query("SELECT 1"); break; }
        catch (e: any) {
          if (attempt === 10) throw e;
          console.log(`[DB] Not ready yet (attempt ${attempt}/10: ${e.message}). Retrying in 2s...`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
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

  // One-time media migration to R2: upload every still-local /uploads file to R2
  // (compressing old full-size images along the way) and rewrite its DB URL, so the
  // app STOPS serving — and being billed egress for — old media. Key-protected via
  // MIGRATION_KEY so it can be triggered by curl without a UI session. Idempotent
  // (only touches remaining /uploads URLs) and best-effort (skips missing files).
  app.post("/api/admin/migrate-media-to-r2", async (req, res) => {
    if (!process.env.MIGRATION_KEY || req.query.key !== process.env.MIGRATION_KEY) {
      return res.status(403).json({ error: "forbidden" });
    }
    if (!r2Client) return res.status(400).json({ error: "R2 not configured" });
    res.json({ started: true, note: "running in background — watch logs for [migrate] DONE" });
    (async () => {
      const targets = [
        { table: "branch_messages", col: "image_url" },
        { table: "group_messages", col: "image_url" },
        { table: "late_order_requests", col: "attachment_url" },
        { table: "late_order_attachments", col: "url" },
      ];
      const extMime: Record<string, string> = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
        ".gif": "image/gif", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
        ".mov": "video/quicktime", ".3gp": "video/3gpp",
      };
      const base = (process.env.R2_PUBLIC_URL as string).replace(/\/+$/, "");
      const doneKeys = new Set<string>();
      let rowsUpdated = 0, missing = 0, failed = 0;
      console.log("[migrate] starting media migration to R2...");
      for (const { table, col } of targets) {
        let localRows: any[] = [];
        try { localRows = await db.all(`SELECT DISTINCT ${col} AS u FROM ${table} WHERE ${col} LIKE '/uploads/%'`); }
        catch (e) { console.error(`[migrate] scan ${table} failed`, e); continue; }
        for (const row of localRows) {
          const localUrl: string = row.u;
          const filename = localUrl.replace("/uploads/", "");
          const localPath = path.join(uploadDir, filename);
          const ext = path.extname(filename).toLowerCase();
          const mime = extMime[ext] || "application/octet-stream";
          try {
            if (!doneKeys.has(filename)) {
              if (!fs.existsSync(localPath)) { missing++; continue; }
              if (mime.startsWith("image/") && mime !== "image/gif") await shrinkImageOnDisk(localPath, mime);
              const body = await fs.promises.readFile(localPath);
              await r2Client!.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET as string, Key: filename, Body: body, ContentType: mime }));
              doneKeys.add(filename);
            }
            await db.query(`UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2`, [`${base}/${filename}`, localUrl]);
            rowsUpdated++;
            if (rowsUpdated % 200 === 0) console.log(`[migrate] progress: ${rowsUpdated} rows, ${doneKeys.size} files uploaded`);
          } catch (e: any) { failed++; console.error(`[migrate] ${filename} failed:`, e?.message || e); }
        }
      }
      console.log(`[migrate] DONE — rowsUpdated=${rowsUpdated} filesUploaded=${doneKeys.size} missingFiles=${missing} failed=${failed}`);
    })().catch((e) => console.error("[migrate] fatal", e));
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

      // A single client in a bad socket state (e.g. half-closed) can throw here.
      // Uncaught, that would abort forEach and silently skip every client that
      // comes after it in iteration order for this broadcast.
      try {
        client.send(JSON.stringify(data));
      } catch (err) {
        console.error("broadcast: failed to send to a client, skipping it", err);
      }
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

  // Browser push to a single user (e.g. the employee a task is assigned to).
  const sendPushToUser = async (userId: number, payload: any) => {
    try {
      const subs = await db.all(`SELECT subscription FROM push_subscriptions WHERE user_id = $1`, [userId]);
      for (const row of subs) {
        const sub = JSON.parse(row.subscription);
        webpush.sendNotification(sub, JSON.stringify(payload)).catch((err: any) => {
          if (err.statusCode === 410 || err.statusCode === 404) db.query("DELETE FROM push_subscriptions WHERE subscription = $1", [row.subscription]);
        });
      }
    } catch (error) {
      console.error("Error sending push to user:", error);
    }
  };

  // Ping any @mentioned employee in a chat message (in-app toast + browser push),
  // never the sender. For groups, pass memberIds to restrict to actual members.
  const notifyMentions = async (comment: string | null, senderId: number, senderName: string, opts: { titleAr: string; titleEn: string; data?: any; memberIds?: number[] }) => {
    try {
      if (!comment) return;
      const names = [...new Set((comment.match(/@([\w-]+)/g) || []).map((m) => m.slice(1).toLowerCase()))];
      if (!names.length) return;
      let users = await db.all(`SELECT id, username FROM users WHERE LOWER(username) = ANY($1) AND is_active = 1`, [names]) as any[];
      users = users.filter((u) => u.id !== senderId);
      if (opts.memberIds) users = users.filter((u) => opts.memberIds!.includes(u.id));
      if (!users.length) return;
      const preview = `${senderName}: ${comment.slice(0, 80)}`;
      for (const u of users) {
        broadcast({ type: "NOTIFICATION", notificationType: "SYSTEM_ACTION", title_en: opts.titleEn, title_ar: opts.titleAr, message_en: preview, message_ar: preview, user_id: u.id });
        sendPushToUser(u.id, { title: opts.titleAr, body: preview, tag: "mention", data: opts.data || { type: "CHAT_MENTION" } });
      }
    } catch (e) { console.error("notifyMentions failed", e); }
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
    // "Complain Team" is a clone of "Call Center": it inherits Call Center's
    // access, so any endpoint that permits Call Center also permits it.
    const effectiveRole = (req.user.role_name === 'Complain Team' && !roles.includes('Complain Team'))
      ? 'Call Center' : req.user.role_name;
    if (!roles.includes(effectiveRole)) {
      console.warn(`Access denied for user ${req.user.username}. Role ${req.user.role_name} not in ${roles.join(", ")}`);
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };

  // ===================== Technical Task Log ("Task" page) =====================
  // Self-contained: its own table (activity_logs) + config lists. Touches nothing else.
  const TASK_ROLES = ["Technical Team", "Technical Back Office", "Manager", "Super Visor", "Operation Manager"];
  const TASK_ADMIN_ROLES = ["Manager", "Super Visor", "Operation Manager"];

  // Dropdown lists for the form (activities + statuses).
  app.get("/api/task-config", authenticate, authorize(TASK_ROLES), async (_req, res) => {
    const activities = await db.all("SELECT id, name FROM tech_activity ORDER BY sort_order, name");
    const statuses = await db.all("SELECT id, name, counts_time FROM cc_status ORDER BY sort_order, id");
    res.json({ activities, statuses });
  });

  // Create one technical-task log. Date + agent are set automatically here.
  app.post("/api/task-logs", authenticate, authorize(TASK_ROLES), async (req, res) => {
    const user = (req as any).user;
    const activity_type = (req.body.activity_type || '').trim();
    const status = (req.body.status || '').trim();
    const durationSeconds = Math.round(Number(req.body.duration_seconds));
    const brand_id = req.body.brand_id ? Number(req.body.brand_id) : null;
    const notes = (req.body.notes || '').trim() || null;
    if (!activity_type || !status) return res.status(400).json({ error: "Task type and status are required" });
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return res.status(400).json({ error: "Time spent must be greater than 0" });
    const ins = await db.query(
      `INSERT INTO activity_logs (log_type, department, activity_type, status, duration_seconds, brand_id, notes, agent_id, agent_name)
       VALUES ('technical', 'Technical', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [activity_type, status, durationSeconds, brand_id, notes, user.id, user.username]
    );
    res.json({ id: ins.rows[0].id, success: true });
  });

  // Reused filter builder: non-admins only ever see their own logs.
  const taskFilters = (req: any) => {
    const user = req.user;
    const isAdmin = TASK_ADMIN_ROLES.includes(user.role_name);
    const conds: string[] = [];
    const params: any[] = [];
    if (!isAdmin) { params.push(user.id); conds.push(`al.agent_id = $${params.length}`); }
    else if (req.query.agent_id) { params.push(Number(req.query.agent_id)); conds.push(`al.agent_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); conds.push(`al.status = $${params.length}`); }
    if (req.query.activity_type) { params.push(req.query.activity_type); conds.push(`al.activity_type = $${params.length}`); }
    if (req.query.date) { params.push(req.query.date); conds.push(`(al.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date = $${params.length}`); }
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`(al.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= $${params.length}`); }
    if (req.query.date_to) { params.push(req.query.date_to); conds.push(`(al.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date <= $${params.length}`); }
    return { isAdmin, where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
  };

  // List logs (All / Team Logs section).
  app.get("/api/task-logs", authenticate, authorize(TASK_ROLES), async (req, res) => {
    const { where, params } = taskFilters(req);
    const pageSize = 20;
    const page = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * pageSize;
    const totalRow = await db.get(`SELECT COUNT(*)::int AS n FROM activity_logs al ${where}`, params);
    const rows = await db.all(
      `SELECT al.id, al.activity_type, al.status, al.duration_seconds, al.notes, al.agent_name, al.created_at, b.name AS brand_name
       FROM activity_logs al LEFT JOIN brands b ON al.brand_id = b.id
       ${where} ORDER BY al.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
    res.json({ logs: rows, total: (totalRow?.n ?? 0), page, pageSize });
  });

  // Dashboard aggregates: totals, productive time (counts_time statuses only),
  // tasks-by-status, tasks-by-activity, and per-agent (admins).
  app.get("/api/task-logs/summary", authenticate, authorize(TASK_ROLES), async (req, res) => {
    const { isAdmin, where, params } = taskFilters(req);
    const totals = await db.get(`
      SELECT COUNT(*)::int AS total_tasks,
        COALESCE(SUM(al.duration_seconds) FILTER (WHERE cs.counts_time), 0)::bigint AS productive_seconds,
        COALESCE(SUM(al.duration_seconds), 0)::bigint AS total_seconds
      FROM activity_logs al LEFT JOIN cc_status cs ON cs.name = al.status ${where}`, params);
    const byStatus = await db.all(`SELECT al.status, COUNT(*)::int AS count FROM activity_logs al ${where} GROUP BY al.status ORDER BY count DESC`, params);
    const byActivity = await db.all(`SELECT al.activity_type, COUNT(*)::int AS count, COALESCE(SUM(al.duration_seconds),0)::bigint AS seconds FROM activity_logs al ${where} GROUP BY al.activity_type ORDER BY count DESC`, params);
    const byAgent = isAdmin ? await db.all(`
      SELECT al.agent_name, COUNT(*)::int AS tasks,
        COALESCE(SUM(al.duration_seconds) FILTER (WHERE cs.counts_time),0)::bigint AS productive_seconds
      FROM activity_logs al LEFT JOIN cc_status cs ON cs.name = al.status ${where}
      GROUP BY al.agent_name ORDER BY productive_seconds DESC`, params) : [];
    res.json({ totals, byStatus, byActivity, byAgent });
  });

  // Distinct employees who have logged tasks — powers the Team Logs employee filter.
  app.get("/api/task-logs/agents", authenticate, authorize(TASK_ADMIN_ROLES), async (_req, res) => {
    const rows = await db.all("SELECT DISTINCT agent_id AS id, agent_name AS name FROM activity_logs ORDER BY agent_name");
    res.json(rows);
  });

  // Transfers & releases the agent performed (Overview handoffs panel). Non-admins
  // see their own; admins see everyone (or one agent via ?agent_id). For a transfer,
  // to_name = the next holder of the same ticket right after this row was handed off.
  app.get("/api/task-logs/handoffs", authenticate, authorize(TASK_ROLES), async (req, res) => {
    const user = (req as any).user;
    const isAdmin = TASK_ADMIN_ROLES.includes(user.role_name);
    const conds: string[] = ["ta.status IN ('transferred','released')"];
    const params: any[] = [];
    if (!isAdmin) { params.push(user.id); conds.push(`ta.assigned_to = $${params.length}`); }
    else if (req.query.agent_id) { params.push(Number(req.query.agent_id)); conds.push(`ta.assigned_to = $${params.length}`); }
    if (req.query.date) { params.push(req.query.date); conds.push(`(ta.done_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date = $${params.length}`); }
    const rows = await db.all(`
      SELECT ta.id, ta.ticket_type, ta.ticket_id, ta.status, ta.done_at,
        u.username AS by_name, b.name AS brand_name,
        (SELECT u2.username FROM ticket_assignments n JOIN users u2 ON u2.id = n.assigned_to
         WHERE n.ticket_type = ta.ticket_type AND n.ticket_id = ta.ticket_id
           AND n.id <> ta.id AND n.assigned_at >= ta.done_at
         ORDER BY n.assigned_at ASC LIMIT 1) AS to_name
      FROM ticket_assignments ta
      JOIN users u ON u.id = ta.assigned_to
      LEFT JOIN brands b ON b.id = ta.brand_id
      WHERE ${conds.join(' AND ')}
      ORDER BY ta.done_at DESC LIMIT 200`, params);
    res.json({
      transfers: rows.filter((r: any) => r.status === 'transferred'),
      releases: rows.filter((r: any) => r.status === 'released'),
    });
  });

  // Edit a task log's status + time (owner, or admin for anyone) — e.g. Open → Completed.
  app.patch("/api/task-logs/:id", authenticate, authorize(TASK_ROLES), async (req, res) => {
    const user = (req as any).user;
    const isAdmin = TASK_ADMIN_ROLES.includes(user.role_name);
    const id = Number(req.params.id);
    const status = (req.body.status || '').trim();
    const durationSeconds = Math.round(Number(req.body.duration_seconds));
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    if (!status) return res.status(400).json({ error: "Status is required" });
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return res.status(400).json({ error: "Time spent must be greater than 0" });
    const log = await db.get("SELECT id, agent_id FROM activity_logs WHERE id = $1", [id]) as any;
    if (!log) return res.status(404).json({ error: "Log not found" });
    if (!isAdmin && log.agent_id !== user.id) return res.status(403).json({ error: "You can only edit your own logs" });
    const st = await db.get("SELECT 1 FROM cc_status WHERE name = $1", [status]);
    if (!st) return res.status(400).json({ error: "Unknown status" });
    await db.query("UPDATE activity_logs SET status = $1, duration_seconds = $2 WHERE id = $3", [status, durationSeconds, id]);
    res.json({ success: true });
  });

  // Weekly shift-hours grid: per-agent per-day (Sun..Sat of the given week) time + count.
  app.get("/api/task-logs/weekly", authenticate, authorize(TASK_ROLES), async (req, res) => {
    const user = (req as any).user;
    const isAdmin = TASK_ADMIN_ROLES.includes(user.role_name);
    const weekStart = String(req.query.week_start || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: "week_start (YYYY-MM-DD) required" });
    const conds = [
      `(al.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= $1::date`,
      `(al.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date <= $1::date + 6`,
    ];
    const params: any[] = [weekStart];
    if (!isAdmin) { params.push(user.id); conds.push(`al.agent_id = $${params.length}`); }
    const rows = await db.all(`
      SELECT al.agent_name,
        (al.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date::text AS day,
        COALESCE(SUM(al.duration_seconds), 0)::int AS seconds,
        COUNT(*)::int AS cnt
      FROM activity_logs al
      WHERE ${conds.join(' AND ')}
      GROUP BY al.agent_name, day`, params);
    res.json(rows);
  });

  // ===================== Assigned Tasks (Assign / My Tasks / Tracker) =====================
  // Manager assigns to a Technical Back Office employee; on completion the logged
  // time also writes an activity_logs row so it counts in productivity. Self-contained.
  const ASSIGN_MANAGER_ROLES = ["Manager"];
  const ASSIGNEE_ROLE = "Technical Back Office";

  // ---- Shift flag (self-service). Pool claiming + auto-assignment depend on it. ----
  app.get("/api/shift/me", authenticate, async (req, res) => {
    const u = (req as any).user;
    res.json({ on_shift: !!u.on_shift, on_shift_at: u.on_shift_at || null });
  });
  app.post("/api/shift", authenticate, async (req, res) => {
    const u = (req as any).user;
    const on = !!req.body.on_shift;
    await db.query(`UPDATE users SET on_shift = $1, on_shift_at = CASE WHEN $1 THEN CURRENT_TIMESTAMP ELSE on_shift_at END WHERE id = $2`, [on, u.id]);
    res.json({ success: true, on_shift: on });
  });

  // ---- Recurring templates -> one instance per matching Kuwait day (lazy, no cron) ----
  // Idempotent: the uniq_template_day index means a concurrent call can't double-create.
  const ensureTodayInstances = async () => {
    try {
      const now = await db.get(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date::text AS d,
        EXTRACT(DOW FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait'))::int AS dow`) as any;
      const templates = await db.all(`SELECT * FROM task_templates WHERE active = true`) as any[];
      for (const t of templates) {
        if (t.recurrence === 'days') {
          const days = String(t.days || '').split(',').filter(Boolean).map(Number);
          if (!days.includes(Number(now.dow))) continue;
        }
        const exists = await db.get(`SELECT 1 FROM assigned_tasks WHERE template_id = $1 AND task_date = $2`, [t.id, now.d]);
        if (exists) continue;
        // 'auto' -> least-loaded On-Shift agent; nobody On Shift -> fall back to the pool.
        let assignee: any = null;
        if (t.assign_mode === 'auto') {
          assignee = await db.get(`
            SELECT u.id, u.username FROM users u
            JOIN roles r ON u.role_id = r.id
            LEFT JOIN assigned_tasks a ON a.assigned_to = u.id AND a.status <> 'Completed'
            WHERE r.name = $1 AND u.is_active = 1 AND u.on_shift = true
            GROUP BY u.id, u.username ORDER BY COUNT(a.id) ASC, u.id ASC LIMIT 1`, [ASSIGNEE_ROLE]) as any;
        }
        try {
          await db.query(`
            INSERT INTO assigned_tasks (title, description, assigned_by, assigned_by_name, assigned_to, assigned_to_name,
              department, task_type, template_id, task_date, priority, due_date, status, require_time_entry, seen)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,
              (($10 || ' ' || COALESCE($12,'23:59'))::timestamp AT TIME ZONE 'Asia/Kuwait'), $13, $14, false)`,
            [t.title, t.description, t.created_by, t.created_by_name || 'System', assignee?.id || null, assignee?.username || null,
             ASSIGNEE_ROLE, t.task_type, t.id, now.d, t.priority, t.due_time, assignee ? 'New' : 'Available', t.require_time_entry !== false]);
          if (assignee) {
            broadcast({ type: "ASSIGNED_TASKS_UPDATED", user_id: assignee.id });
            sendPushToUser(assignee.id, { title: "مهمة جديدة مُعيّنة لك", body: t.title, tag: "assigned-task", data: { type: "ASSIGNED_TASK" } });
          } else {
            broadcast({ type: "ASSIGNED_TASKS_UPDATED" });
          }
        } catch (e) { /* uniq_template_day -> another request generated it first */ }
      }
    } catch (e) { console.error("ensureTodayInstances failed", e); }
  };

  app.get("/api/task-templates", authenticate, authorize(ASSIGN_MANAGER_ROLES), async (_req, res) => {
    const rows = await db.all(`SELECT * FROM task_templates ORDER BY active DESC, id DESC`);
    res.json(rows);
  });

  const parseTemplateBody = (body: any, prev?: any) => {
    const title = (body.title ?? prev?.title ?? '').trim();
    const recurrence = body.recurrence === 'days' ? 'days' : 'daily';
    const days = recurrence === 'days'
      ? (Array.isArray(body.days) ? body.days.map((d: any) => Number(d)).filter((d: number) => d >= 0 && d <= 6).join(',') : (prev?.days || ''))
      : null;
    const priority = ['High', 'Medium', 'Low'].includes(body.priority) ? body.priority : (prev?.priority || 'Medium');
    const assign_mode = body.assign_mode === 'auto' ? 'auto' : 'pool';
    const due_time = /^\d{1,2}:\d{2}$/.test(body.due_time || '') ? body.due_time : (prev?.due_time || '17:00');
    return {
      title, recurrence, days, priority, assign_mode, due_time,
      description: (body.description ?? prev?.description ?? '')?.trim() || null,
      task_type: (body.task_type ?? prev?.task_type ?? '')?.trim() || null,
      require_time_entry: body.require_time_entry !== false,
    };
  };

  app.post("/api/task-templates", authenticate, authorize(ASSIGN_MANAGER_ROLES), async (req, res) => {
    const user = (req as any).user;
    const t = parseTemplateBody(req.body);
    if (!t.title) return res.status(400).json({ error: "Title is required" });
    if (t.recurrence === 'days' && !t.days) return res.status(400).json({ error: "Pick at least one day" });
    const ins = await db.query(`
      INSERT INTO task_templates (title, description, department, task_type, recurrence, days, due_time, priority, assign_mode, require_time_entry, active, created_by, created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12) RETURNING id`,
      [t.title, t.description, ASSIGNEE_ROLE, t.task_type, t.recurrence, t.days, t.due_time, t.priority, t.assign_mode, t.require_time_entry, user.id, user.username]);
    await ensureTodayInstances();
    res.json({ id: ins.rows[0].id, success: true });
  });

  app.patch("/api/task-templates/:id", authenticate, authorize(ASSIGN_MANAGER_ROLES), async (req, res) => {
    const id = Number(req.params.id);
    const prev = await db.get(`SELECT * FROM task_templates WHERE id = $1`, [id]) as any;
    if (!prev) return res.status(404).json({ error: "Template not found" });
    // Active-only payload = the on/off switch in the list.
    if (typeof req.body.active === 'boolean' && Object.keys(req.body).length === 1) {
      await db.query(`UPDATE task_templates SET active = $1 WHERE id = $2`, [req.body.active, id]);
      return res.json({ success: true });
    }
    const t = parseTemplateBody(req.body, prev);
    if (!t.title) return res.status(400).json({ error: "Title is required" });
    if (t.recurrence === 'days' && !t.days) return res.status(400).json({ error: "Pick at least one day" });
    await db.query(`
      UPDATE task_templates SET title=$1, description=$2, task_type=$3, recurrence=$4, days=$5, due_time=$6,
        priority=$7, assign_mode=$8, require_time_entry=$9, active=$10 WHERE id=$11`,
      [t.title, t.description, t.task_type, t.recurrence, t.days, t.due_time, t.priority, t.assign_mode, t.require_time_entry,
       typeof req.body.active === 'boolean' ? req.body.active : prev.active, id]);
    res.json({ success: true });
  });

  app.delete("/api/task-templates/:id", authenticate, authorize(ASSIGN_MANAGER_ROLES), async (req, res) => {
    await db.query(`DELETE FROM task_templates WHERE id = $1`, [Number(req.params.id)]);
    res.json({ success: true });
  });

  // Pool: today's unclaimed instances. Any On-Shift TBO agent can take one.
  app.get("/api/assigned-tasks/available", authenticate, async (_req, res) => {
    await ensureTodayInstances();
    const rows = await db.all(`SELECT * FROM assigned_tasks WHERE status = 'Available' AND assigned_to IS NULL ORDER BY COALESCE(due_date, created_at) ASC`);
    res.json(rows);
  });

  // Claim: atomic (WHERE status='Available') so two agents can't take the same task.
  app.post("/api/assigned-tasks/:id/claim", authenticate, async (req, res) => {
    const user = (req as any).user;
    if (user.role_name !== ASSIGNEE_ROLE) return res.status(403).json({ error: "Only Technical Back Office can claim tasks" });
    if (!user.on_shift) return res.status(400).json({ error: "You must be On Shift to claim a task" });
    const claimed = await db.get(`
      UPDATE assigned_tasks SET assigned_to = $1, assigned_to_name = $2, status = 'New', seen = true, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND status = 'Available' AND assigned_to IS NULL RETURNING id`, [user.id, user.username, Number(req.params.id)]) as any;
    if (!claimed) return res.status(409).json({ error: "Task was already taken by another agent" });
    broadcast({ type: "ASSIGNED_TASKS_UPDATED" });
    res.json({ success: true });
  });

  app.get("/api/assigned-tasks/assignees", authenticate, authorize(ASSIGN_MANAGER_ROLES), async (_req, res) => {
    const rows = await db.all(`SELECT u.id, u.username FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = $1 AND u.is_active = 1 ORDER BY u.username`, [ASSIGNEE_ROLE]);
    res.json(rows);
  });

  app.post("/api/assigned-tasks", authenticate, authorize(ASSIGN_MANAGER_ROLES), async (req, res) => {
    const user = (req as any).user;
    const title = (req.body.title || '').trim();
    const description = (req.body.description || '').trim() || null;
    const assignedTo = Number(req.body.assigned_to);
    const priority = ['High', 'Medium', 'Low'].includes(req.body.priority) ? req.body.priority : 'Medium';
    const dueDate = req.body.due_date || null;
    const requireTime = req.body.require_time_entry !== false;
    const taskType = (req.body.task_type || '').trim() || null;
    if (!title && !taskType) return res.status(400).json({ error: "Provide a title or a task type" });
    if (!Number.isFinite(assignedTo)) return res.status(400).json({ error: "Assignee is required" });
    const target = await db.get(`SELECT u.id, u.username, r.name AS role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1`, [assignedTo]) as any;
    if (!target || target.role !== ASSIGNEE_ROLE) return res.status(400).json({ error: "Assignee must be a Technical Back Office employee" });
    const ins = await db.query(`
      INSERT INTO assigned_tasks (title, description, assigned_by, assigned_by_name, assigned_to, assigned_to_name, department, task_type, priority, due_date, require_time_entry)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [title, description, user.id, user.username, target.id, target.username, ASSIGNEE_ROLE, taskType, priority, dueDate, requireTime]);
    const notifyBody = title || taskType || 'مهمة مُعيّنة لك';
    broadcast({ type: "ASSIGNED_TASKS_UPDATED", user_id: target.id });
    broadcast({ type: "NOTIFICATION", notificationType: "SYSTEM_ACTION", title_en: "New task assigned", title_ar: "مهمة جديدة مُعيّنة لك", message_en: notifyBody, message_ar: notifyBody, user_id: target.id });
    sendPushToUser(target.id, { title: "مهمة جديدة مُعيّنة لك", body: notifyBody, tag: "assigned-task", data: { type: "ASSIGNED_TASK" } });
    res.json({ id: ins.rows[0].id, success: true });
  });

  app.get("/api/assigned-tasks/mine", authenticate, async (req, res) => {
    const user = (req as any).user;
    await ensureTodayInstances();
    const rows = await db.all(`SELECT * FROM assigned_tasks WHERE assigned_to = $1 ORDER BY (status='Completed'), COALESCE(due_date, created_at) ASC`, [user.id]);
    res.json(rows);
  });

  app.post("/api/assigned-tasks/seen", authenticate, async (req, res) => {
    const user = (req as any).user;
    await db.query(`UPDATE assigned_tasks SET seen = true WHERE assigned_to = $1 AND seen = false`, [user.id]);
    res.json({ success: true });
  });

  app.patch("/api/assigned-tasks/:id/status", authenticate, async (req, res) => {
    const user = (req as any).user;
    const id = Number(req.params.id);
    const status = req.body.status;
    if (!['New', 'In Progress', 'Completed'].includes(status)) return res.status(400).json({ error: "Invalid status" });
    const t = await db.get(`SELECT * FROM assigned_tasks WHERE id = $1`, [id]) as any;
    if (!t) return res.status(404).json({ error: "Task not found" });
    if (t.assigned_to !== user.id) return res.status(403).json({ error: "Not your task" });
    if (status === 'Completed') {
      const minutes = Math.round(Number(req.body.minutes) || 0);
      const note = (req.body.note || '').trim() || null;
      if (t.require_time_entry && minutes <= 0) return res.status(400).json({ error: "Time (minutes > 0) is required to complete this task" });
      const durationSeconds = minutes > 0 ? minutes * 60 : 0;
      await db.query(`UPDATE assigned_tasks SET status='Completed', completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, duration_seconds=$1, note=$2, seen=true WHERE id=$3`, [durationSeconds, note, id]);
      if (durationSeconds > 0) {
        await db.query(`INSERT INTO activity_logs (log_type, department, activity_type, status, duration_seconds, notes, agent_id, agent_name) VALUES ('technical','Technical',$1,'Completed',$2,$3,$4,$5)`, [t.task_type || 'Assigned Task', durationSeconds, t.title, user.id, user.username]);
      }
    } else {
      await db.query(`UPDATE assigned_tasks SET status=$1, updated_at=CURRENT_TIMESTAMP, seen=true WHERE id=$2`, [status, id]);
    }
    broadcast({ type: "ASSIGNED_TASKS_UPDATED" });
    res.json({ success: true });
  });

  app.get("/api/assigned-tasks", authenticate, authorize(ASSIGN_MANAGER_ROLES), async (_req, res) => {
    await ensureTodayInstances();
    const rows = await db.all(`SELECT * FROM assigned_tasks ORDER BY (status='Completed'), COALESCE(due_date, created_at) ASC`);
    res.json(rows);
  });

  app.patch("/api/assigned-tasks/:id", authenticate, authorize(ASSIGN_MANAGER_ROLES), async (req, res) => {
    const id = Number(req.params.id);
    const exists = await db.get(`SELECT id FROM assigned_tasks WHERE id = $1`, [id]) as any;
    if (!exists) return res.status(404).json({ error: "Task not found" });
    const title = (req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: "Title is required" });
    const description = (req.body.description || '').trim() || null;
    const priority = ['High', 'Medium', 'Low'].includes(req.body.priority) ? req.body.priority : 'Medium';
    const dueDate = req.body.due_date || null;
    const assignedTo = Number(req.body.assigned_to);
    const taskType = (req.body.task_type || '').trim() || null;
    const target = await db.get(`SELECT u.id, u.username, r.name AS role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1`, [assignedTo]) as any;
    if (!target || target.role !== ASSIGNEE_ROLE) return res.status(400).json({ error: "Assignee must be a Technical Back Office employee" });
    await db.query(`UPDATE assigned_tasks SET title=$1, description=$2, assigned_to=$3, assigned_to_name=$4, task_type=$5, priority=$6, due_date=$7, updated_at=CURRENT_TIMESTAMP WHERE id=$8`, [title, description, target.id, target.username, taskType, priority, dueDate, id]);
    broadcast({ type: "ASSIGNED_TASKS_UPDATED", user_id: target.id });
    res.json({ success: true });
  });

  app.delete("/api/assigned-tasks/:id", authenticate, authorize(ASSIGN_MANAGER_ROLES), async (req, res) => {
    await db.query(`DELETE FROM assigned_tasks WHERE id = $1`, [Number(req.params.id)]);
    broadcast({ type: "ASSIGNED_TASKS_UPDATED" });
    res.json({ success: true });
  });
  // =================== end Assigned Tasks ===================

  // Config editing (managers only) — add/remove activities and statuses.
  app.post("/api/task-config/activity", authenticate, authorize(TASK_ADMIN_ROLES), async (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: "Name required" });
    await db.query("INSERT INTO tech_activity (name, sort_order) VALUES ($1, (SELECT COALESCE(MAX(sort_order),0)+1 FROM tech_activity)) ON CONFLICT (name) DO NOTHING", [name]);
    res.json({ success: true });
  });
  app.delete("/api/task-config/activity/:id", authenticate, authorize(TASK_ADMIN_ROLES), async (req, res) => {
    await db.query("DELETE FROM tech_activity WHERE id = $1", [Number(req.params.id)]);
    res.json({ success: true });
  });
  app.post("/api/task-config/status", authenticate, authorize(TASK_ADMIN_ROLES), async (req, res) => {
    const name = (req.body.name || '').trim();
    const counts_time = !!req.body.counts_time;
    if (!name) return res.status(400).json({ error: "Name required" });
    await db.query("INSERT INTO cc_status (name, counts_time, sort_order) VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order),0)+1 FROM cc_status)) ON CONFLICT (name) DO NOTHING", [name, counts_time]);
    res.json({ success: true });
  });
  app.delete("/api/task-config/status/:id", authenticate, authorize(TASK_ADMIN_ROLES), async (req, res) => {
    await db.query("DELETE FROM cc_status WHERE id = $1", [Number(req.params.id)]);
    res.json({ success: true });
  });
  // =================== end Technical Task Log ===================

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

    // Batch-resolve a list of requests: parse JSON, map brand/branch names from
    // the in-memory maps, and fetch ALL product names in one query (instead of
    // two queries per request — the old N+1 that made this page slow).
    const resolveAll = async (requests: any[]) => {
      const allIds = new Set<number>();
      const parsed = requests.map((r) => {
        let data: any = {};
        try { data = JSON.parse(r.data); } catch { data = {}; }
        if (r.type === 'hide_unhide' && Array.isArray(data.product_ids)) {
          data.product_ids.forEach((id: number) => allIds.add(id));
        }
        return { r, data };
      });

      const nameById: Record<string, { product_id: number, name: string }> = {};
      if (allIds.size > 0) {
        const productNameFieldId = await getProductNameFieldId();
        const ids = Array.from(allIds);
        const placeholders = ids.map((_, i) => `$${i + 2}`).join(',');
        const rows = await db.all(`
          SELECT fv.product_id, fv.value as name
          FROM product_field_values fv
          WHERE fv.field_id = $1 AND fv.product_id IN (${placeholders})
        `, [productNameFieldId, ...ids]) as { product_id: number, name: string }[];
        for (const row of rows) nameById[String(row.product_id)] = { product_id: row.product_id, name: row.name };
      }

      return parsed.map(({ r, data }) => {
        if (r.type === 'hide_unhide') {
          if (data.brand_id) data.brand_name = brandsMap[String(data.brand_id)] || 'Unknown';
          else if (r.requester_brand_id) data.brand_name = brandsMap[String(r.requester_brand_id)] || data.brand_name;

          if (data.branch_id) data.branch_name = branchesMap[String(data.branch_id)] || 'Unknown';
          else if (r.requester_branch_id) data.branch_name = branchesMap[String(r.requester_branch_id)] || 'All Branches';
          else data.branch_name = 'All Branches';

          if (Array.isArray(data.product_ids) && data.product_ids.length > 0) {
            data.resolved_products = data.product_ids.map((id: number) => nameById[String(id)]).filter(Boolean);
          }
        }
        return { ...r, data };
      });
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
      const parsedRequests = await resolveAll(requests);
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
      SELECT pr.*, u.username, u.brand_id AS requester_brand_id, u.branch_id AS requester_branch_id, p.username as processor_name
      FROM pending_requests pr
      JOIN users u ON pr.user_id = u.id
      LEFT JOIN users p ON pr.processed_by = p.id
      ${whereSection}
      ORDER BY pr.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const requests = await db.all(query, [...params, limitNum, offset]);
    const parsedRequests = await resolveAll(requests);
    
    res.json({
      data: parsedRequests,
      total,
      page: Number(page),
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum)
    });
  });

  app.post("/api/pending-requests", authenticate, async (req, res) => {
    try {
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
    } catch (error) {
      console.error("Error creating pending request:", error);
      res.status(500).json({ error: "Failed to create request" });
    }
  });

  // Shared core of "approve": performs the hide/unhide/busy recording (the same
  // hidden_items / hide_history / busy_period writes + broadcasts as always) and
  // marks the request Approved. Reused by the classic approve endpoint and by
  // the new ticket "Done" flow. processorUserId = the office agent performing it.
  const applyPendingRequest = async (request: any, processorUserId: number) => {
    const data = JSON.parse(request.data);
    {
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
              // Credit the AGENT who processed the request (so it shows in their
              // KPI); keep the original requester recorded in the payload.
              await logAction(processorUserId, "UNHIDE", "products", item.product_id, {
                product_name: item.product_name || 'Unknown Product',
                brand_name: item.brand_name || 'Unknown Brand',
                branch: item.branch_name || 'All Branches',
                brand_id: item.brand_id,
                branch_id: item.branch_id,
                requested_by: request.user_id
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
              await logAction(processorUserId, "HIDE", "products", productId, {
                product_name: product?.name || 'Unknown Product',
                brand_name: brand?.name || 'Unknown Brand',
                branch: branch.name,
                brand_id: data.brand_id,
                branch_id: branch.id,
                reason: data.reason,
                responsible_party: data.responsible_party,
                requested_by: request.user_id
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

            await logAction(processorUserId, "HIDE", "products", productId, {
              product_name: product?.name || 'Unknown Product',
              brand_name: brand?.name || 'Unknown Brand',
              branch: branch?.name || 'Unknown Branch',
              brand_id: data.brand_id,
              branch_id: data.branch_id,
              reason: data.reason,
              responsible_party: data.responsible_party,
              requested_by: request.user_id
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

          // Only close a record that is still open. If it was already reopened
          // (e.g. handled elsewhere before this reopen ticket was completed),
          // skip so we never overwrite the real end_time and inflate duration.
          await db.query(`
            UPDATE busy_period_records
            SET end_time = $1, total_duration = $2, total_duration_minutes = $3
            WHERE id = $4 AND (end_time IS NULL OR end_time = '')
          `, [end_time, total_duration, total_duration_minutes, data.id]);

          await logAction(processorUserId, "BUSY_UPDATE", "busy_period_records", Number(data.id), null, {
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
      
      await db.query("UPDATE pending_requests SET status = 'Approved', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [processorUserId, request.id]);
      broadcast({ type: "PENDING_REQUEST_UPDATED" });
    }
  };

  // Classic Approve/Reject close the request, so any ticket-workflow hold on it
  // must be settled too (same principle as the chat-reply sync): the approver's
  // OWN hold becomes done + a logged task; anyone else's hold is released —
  // otherwise it stays "in progress" forever with no credit (seen in prod:
  // request approved from the details modal while another agent held it).
  const settleAssignmentsOnProcess = async (request: any, processorUserId: number, processorName: string, credit: boolean) => {
    try {
      if (credit) {
        const won = await db.get(`
          UPDATE ticket_assignments SET status = 'done', done_at = CURRENT_TIMESTAMP, done_by = $1,
            duration_seconds = GREATEST(1, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - assigned_at))::int)
          WHERE ticket_type = $2 AND ticket_id = $3 AND status = 'in_progress' AND assigned_to = $1
          RETURNING id, duration_seconds, brand_id`, [processorUserId, request.type, request.id]) as any;
        if (won) {
          let data: any = {}; try { data = JSON.parse(request.data); } catch {}
          const ins = await db.query(`
            INSERT INTO activity_logs (log_type, department, activity_type, status, duration_seconds, brand_id, notes, agent_id, agent_name)
            VALUES ('technical', 'Technical', $1, 'Completed', $2, $3, $4, $5, $6) RETURNING id`,
            [ticketActivity(request.type, data), Math.max(1, Number(won.duration_seconds) || 1), won.brand_id,
             `Ticket #${request.id} (${request.type})`, processorUserId, processorName]);
          await db.query("UPDATE ticket_assignments SET task_log_id = $1 WHERE id = $2", [ins.rows[0].id, won.id]);
        }
      }
      const released = await db.query(`
        UPDATE ticket_assignments SET status = 'released', done_at = CURRENT_TIMESTAMP
        WHERE ticket_type = $1 AND ticket_id = $2 AND status = 'in_progress'`, [request.type, request.id]);
      if ((released.rowCount || 0) > 0 || credit) broadcast({ type: "TICKETS_UPDATED" });
    } catch (e) { console.error("settleAssignmentsOnProcess failed", e); }
  };

  app.post("/api/pending-requests/:id/approve", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    const request = await db.get("SELECT * FROM pending_requests WHERE id = $1", [req.params.id]) as any;
    if (!request || request.status !== 'Pending') return res.status(400).json({ error: "Invalid request" });
    try {
      await applyPendingRequest(request, (req as any).user.id);
      await settleAssignmentsOnProcess(request, (req as any).user.id, (req as any).user.username, true);
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
    // A rejected request is closed — release any workflow hold on it (no credit).
    if (request) await settleAssignmentsOnProcess(request, (req as any).user.id, (req as any).user.username, false);

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

  // ===== Ticket workflow: pick -> do work -> done, single assignment ==========
  // An agent PICKS a hide/busy/chat ticket (locked to them), does the work on
  // the aggregators, then marks DONE — which records the action (hide/busy via
  // applyPendingRequest) and auto-logs a task (duration = done - picked).
  // Lightweight: single-row indexed reads/writes, no polling, WebSocket refresh.
  const TICKET_WORK_ROLES = ["Technical Back Office", "Manager", "Super Visor", "Operation Manager"];
  const TICKET_TYPES = ['hide_unhide', 'busy_branch', 'chat'];
  const ticketActivity = (ticketType: string, data: any): string => {
    if (ticketType === 'chat') return 'Invoice Chat';
    if (ticketType === 'busy_branch') return data?.action === 'OPEN' ? 'Open Branch' : 'Busy Branch';
    return data?.action === 'UNHIDE' ? 'Unhide Item' : 'Hide Item';
  };
  // Resolve a ticket's brand/branch + whether it's still open (claimable).
  const getTicketMeta = async (ticketType: string, ticketId: number) => {
    if (ticketType === 'chat') {
      const m = await db.get("SELECT brand_id, branch_id, sender_role, resolved_at, cleared_at FROM branch_messages WHERE id = $1", [ticketId]) as any;
      if (!m || m.sender_role !== 'Restaurants') return null;
      // Per-message: open (claimable / a valid hold) while it hasn't been
      // individually handled — not dismissed (resolved_at), not marked done
      // (cleared_at), not liked. Matches the tickets-list rule, so a held ticket
      // is only auto-released once THAT message is actually handled.
      const liked = await db.get("SELECT 1 FROM message_reactions mr WHERE mr.message_type = 'branch' AND mr.message_id = $1 LIMIT 1", [ticketId]);
      const open = m.resolved_at == null && m.cleared_at == null && !liked;
      return { open, brand_id: m.brand_id ?? null, branch_id: m.branch_id ?? null, data: null };
    }
    const r = await db.get("SELECT status, data FROM pending_requests WHERE id = $1 AND type = $2", [ticketId, ticketType]) as any;
    if (!r) return null;
    let data: any = {}; try { data = JSON.parse(r.data); } catch {}
    const brand_id = typeof data.brand_id === 'number' ? data.brand_id : null;
    const branch_id = typeof data.branch_id === 'number' ? data.branch_id : null;
    return { open: r.status === 'Pending', brand_id, branch_id, data };
  };

  // Current agent's active ticket + who holds every active ticket (for badging).
  app.get("/api/tickets/state", authenticate, authorize(TICKET_WORK_ROLES), async (req, res) => {
    try {
      const uid = (req as any).user.id;
      const mine = await db.get(`
        SELECT id, ticket_type, ticket_id, assigned_at,
          EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - assigned_at))::int AS elapsed_seconds
        FROM ticket_assignments WHERE assigned_to = $1 AND status = 'in_progress' LIMIT 1`, [uid]);
      const active = await db.all(`
        SELECT ta.ticket_type, ta.ticket_id, ta.assigned_to, u.username AS assigned_to_name
        FROM ticket_assignments ta JOIN users u ON u.id = ta.assigned_to
        WHERE ta.status = 'in_progress'`);
      res.json({ mine: mine || null, active });
    } catch (e) {
      console.error("tickets/state error:", e);
      res.status(500).json({ error: "Failed to load ticket state" });
    }
  });

  // PICK a ticket (atomic single-claim + one-per-agent).
  app.post("/api/tickets/claim", authenticate, authorize(TICKET_WORK_ROLES), async (req, res) => {
    const user = (req as any).user;
    const ticket_type = String(req.body.ticket_type || '');
    const ticket_id = Number(req.body.ticket_id);
    if (!TICKET_TYPES.includes(ticket_type) || !Number.isFinite(ticket_id)) return res.status(400).json({ error: "Invalid ticket" });
    try {
      // Block only if the agent already holds a ticket that's STILL open. If their
      // held ticket was resolved elsewhere (e.g. replied on the chat page, so the
      // assignment was left stuck in_progress), auto-release it so they're never
      // blocked and can pick again.
      const held = await db.get("SELECT id, ticket_type, ticket_id FROM ticket_assignments WHERE assigned_to = $1 AND status = 'in_progress' LIMIT 1", [user.id]) as any;
      if (held) {
        const heldMeta = await getTicketMeta(held.ticket_type, held.ticket_id);
        if (heldMeta && heldMeta.open) return res.status(409).json({ error: "Finish or transfer your current ticket first" });
        await db.query("UPDATE ticket_assignments SET status = 'released', done_at = CURRENT_TIMESTAMP WHERE id = $1", [held.id]);
      }
      const meta = await getTicketMeta(ticket_type, ticket_id);
      if (!meta) return res.status(404).json({ error: "Ticket not found" });
      if (!meta.open) return res.status(409).json({ error: "Ticket is no longer available" });
      try {
        await db.query(`
          INSERT INTO ticket_assignments (ticket_type, ticket_id, assigned_to, brand_id, branch_id)
          VALUES ($1, $2, $3, $4, $5)`, [ticket_type, ticket_id, user.id, meta.brand_id, meta.branch_id]);
      } catch (e: any) {
        // uniq_ticket_active violation → someone claimed it a moment ago.
        return res.status(409).json({ error: "Ticket was just taken by another agent" });
      }
      // Notify the store it's being handled (in-app only — no push, to stay light).
      broadcast({
        type: "NOTIFICATION", notificationType: "SYSTEM_ACTION",
        title_en: "Request in progress", title_ar: "طلبك قيد التنفيذ",
        message_en: `Your request is being handled by ${user.username}`,
        message_ar: `يتم العمل على طلبك بواسطة ${user.username}`,
        ...(meta.brand_id ? { brand_id: meta.brand_id } : {}),
        ...(meta.branch_id ? { branch_id: meta.branch_id } : {}),
        role_target: ["Restaurants"],
      });
      broadcast({ type: "TICKETS_UPDATED" });
      res.json({ success: true });
    } catch (e) {
      console.error("tickets/claim error:", e);
      res.status(500).json({ error: "Failed to claim ticket" });
    }
  });

  // MARK DONE: record the action (hide/busy) + auto-log the task.
  app.post("/api/tickets/done", authenticate, authorize(TICKET_WORK_ROLES), async (req, res) => {
    const user = (req as any).user;
    const isAdmin = TASK_ADMIN_ROLES.includes(user.role_name);
    const ticket_type = String(req.body.ticket_type || '');
    const ticket_id = Number(req.body.ticket_id);
    if (!TICKET_TYPES.includes(ticket_type) || !Number.isFinite(ticket_id)) return res.status(400).json({ error: "Invalid ticket" });
    try {
      const a = await db.get(`
        SELECT id, assigned_to, brand_id, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - assigned_at))::int AS secs
        FROM ticket_assignments WHERE ticket_type = $1 AND ticket_id = $2 AND status = 'in_progress'`, [ticket_type, ticket_id]) as any;
      if (!a) {
        // Chat tickets can be auto-completed by the reply itself (the branch-chat
        // POST closes the sender's hold). The Send & Done button then calls this
        // endpoint a moment later — treat that as already done, not an error.
        if (ticket_type === 'chat') {
          const prev = await db.get(`
            SELECT 1 FROM ticket_assignments
            WHERE ticket_type = 'chat' AND ticket_id = $1 AND status IN ('done','released')
              AND (assigned_to = $2 OR done_by = $2)
            ORDER BY id DESC LIMIT 1`, [ticket_id, user.id]);
          if (prev) return res.json({ success: true, already: true });
        }
        return res.status(404).json({ error: "No active assignment for this ticket" });
      }
      if (a.assigned_to !== user.id && !isAdmin) return res.status(403).json({ error: "This ticket is assigned to another agent" });

      let data: any = {};
      // For hide/busy: run the same recording the classic approve does.
      if (ticket_type !== 'chat') {
        const request = await db.get("SELECT * FROM pending_requests WHERE id = $1", [ticket_id]) as any;
        if (request) {
          try { data = JSON.parse(request.data); } catch {}
          if (request.status === 'Pending') await applyPendingRequest(request, user.id);
        }
      }
      // Atomic claim of the completion: only the caller that flips in_progress →
      // done logs the task, so a concurrent auto-complete (chat reply) can never
      // produce a duplicate activity_logs row.
      const won = await db.get(`
        UPDATE ticket_assignments SET status = 'done', done_at = CURRENT_TIMESTAMP, done_by = $1,
          duration_seconds = GREATEST(1, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - assigned_at))::int)
        WHERE id = $2 AND status = 'in_progress'
        RETURNING id, duration_seconds`, [user.id, a.id]) as any;
      if (!won) return res.json({ success: true, already: true });
      // Per-message clear: mark ONLY this chat message handled, so the store's
      // other pending messages stay as tickets.
      if (ticket_type === 'chat') {
        await db.query("UPDATE branch_messages SET cleared_at = CURRENT_TIMESTAMP WHERE id = $1 AND cleared_at IS NULL", [ticket_id]);
      }
      const durationSeconds = Math.max(1, Number(won.duration_seconds) || 1);
      const activity = ticketActivity(ticket_type, data);
      const ins = await db.query(`
        INSERT INTO activity_logs (log_type, department, activity_type, status, duration_seconds, brand_id, notes, agent_id, agent_name)
        VALUES ('technical', 'Technical', $1, 'Completed', $2, $3, $4, $5, $6) RETURNING id`,
        [activity, durationSeconds, a.brand_id, `Ticket #${ticket_id} (${ticket_type})`, user.id, user.username]);
      await db.query("UPDATE ticket_assignments SET task_log_id = $1 WHERE id = $2", [ins.rows[0].id, won.id]);
      broadcast({ type: "TICKETS_UPDATED" });
      broadcast({ type: "PENDING_REQUEST_UPDATED" });
      res.json({ success: true, duration_seconds: durationSeconds });
    } catch (e) {
      console.error("tickets/done error:", e);
      res.status(500).json({ error: "Failed to mark done" });
    }
  });

  // TRANSFER to another agent (fresh timer; whoever marks Done gets the task).
  app.post("/api/tickets/transfer", authenticate, authorize(TICKET_WORK_ROLES), async (req, res) => {
    const user = (req as any).user;
    const isAdmin = TASK_ADMIN_ROLES.includes(user.role_name);
    const ticket_type = String(req.body.ticket_type || '');
    const ticket_id = Number(req.body.ticket_id);
    const to_agent_id = Number(req.body.to_agent_id);
    if (!TICKET_TYPES.includes(ticket_type) || !Number.isFinite(ticket_id) || !Number.isFinite(to_agent_id)) return res.status(400).json({ error: "Invalid input" });
    try {
      const a = await db.get("SELECT * FROM ticket_assignments WHERE ticket_type = $1 AND ticket_id = $2 AND status = 'in_progress'", [ticket_type, ticket_id]) as any;
      if (!a) return res.status(404).json({ error: "No active assignment" });
      if (a.assigned_to !== user.id && !isAdmin) return res.status(403).json({ error: "Only the holder or a supervisor can transfer" });
      if (to_agent_id === a.assigned_to) return res.status(400).json({ error: "Already assigned to that agent" });
      const target = await db.get("SELECT u.id, r.name AS role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1", [to_agent_id]) as any;
      if (!target || !TICKET_WORK_ROLES.includes(target.role)) return res.status(400).json({ error: "Target is not a technical agent" });
      const targetBusy = await db.get("SELECT 1 FROM ticket_assignments WHERE assigned_to = $1 AND status = 'in_progress' LIMIT 1", [to_agent_id]);
      if (targetBusy) return res.status(409).json({ error: "That agent already has an active ticket" });
      await db.query("UPDATE ticket_assignments SET status = 'transferred', done_at = CURRENT_TIMESTAMP WHERE id = $1", [a.id]);
      await db.query(`INSERT INTO ticket_assignments (ticket_type, ticket_id, assigned_to, brand_id, branch_id) VALUES ($1, $2, $3, $4, $5)`,
        [ticket_type, ticket_id, to_agent_id, a.brand_id, a.branch_id]);
      broadcast({ type: "TICKETS_UPDATED" });
      res.json({ success: true });
    } catch (e) {
      console.error("tickets/transfer error:", e);
      res.status(500).json({ error: "Failed to transfer" });
    }
  });

  // RELEASE back to the pool (the holder, or a supervisor for a stuck ticket).
  app.post("/api/tickets/release", authenticate, authorize(TICKET_WORK_ROLES), async (req, res) => {
    const user = (req as any).user;
    const isAdmin = TASK_ADMIN_ROLES.includes(user.role_name);
    const ticket_type = String(req.body.ticket_type || '');
    const ticket_id = Number(req.body.ticket_id);
    if (!TICKET_TYPES.includes(ticket_type) || !Number.isFinite(ticket_id)) return res.status(400).json({ error: "Invalid ticket" });
    try {
      const a = await db.get("SELECT id, assigned_to FROM ticket_assignments WHERE ticket_type = $1 AND ticket_id = $2 AND status = 'in_progress'", [ticket_type, ticket_id]) as any;
      if (!a) return res.status(404).json({ error: "No active assignment" });
      if (a.assigned_to !== user.id && !isAdmin) return res.status(403).json({ error: "Only the holder or a supervisor can release" });
      await db.query("UPDATE ticket_assignments SET status = 'released', done_at = CURRENT_TIMESTAMP WHERE id = $1", [a.id]);
      broadcast({ type: "TICKETS_UPDATED" });
      res.json({ success: true });
    } catch (e) {
      console.error("tickets/release error:", e);
      res.status(500).json({ error: "Failed to release" });
    }
  });

  // Technical agents (for the transfer dropdown).
  app.get("/api/tickets/agents", authenticate, authorize(TICKET_WORK_ROLES), async (_req, res) => {
    try {
      const rows = await db.all(`
        SELECT u.id, u.username FROM users u JOIN roles r ON u.role_id = r.id
        WHERE r.name = 'Technical Back Office' AND u.is_active = 1 ORDER BY u.username`);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: "Failed to load agents" });
    }
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
  try { await db.exec("ALTER TABLE branch_messages ADD COLUMN status TEXT DEFAULT 'pending'"); } catch (e) {}
  try { await db.exec("ALTER TABLE branch_messages ADD COLUMN status_by INTEGER"); } catch (e) {}
  try { await db.exec("ALTER TABLE branch_messages ADD COLUMN status_at TIMESTAMP"); } catch (e) {}
  try { await db.exec("ALTER TABLE branch_messages ADD COLUMN reply_to_id INTEGER"); } catch (e) {}
  try { await db.exec("ALTER TABLE branch_messages ADD COLUMN resolved_at TIMESTAMP"); } catch (e) {}
  try { await db.exec("ALTER TABLE assigned_tasks ADD COLUMN task_type TEXT"); } catch (e) {}
  // Recurring-task support on an already-deployed assigned_tasks table.
  try { await db.exec("ALTER TABLE assigned_tasks ADD COLUMN template_id INTEGER"); } catch (e) {}
  try { await db.exec("ALTER TABLE assigned_tasks ADD COLUMN task_date DATE"); } catch (e) {}
  // Pool tasks have no assignee until claimed.
  try { await db.exec("ALTER TABLE assigned_tasks ALTER COLUMN assigned_to DROP NOT NULL"); } catch (e) {}
  try { await db.exec("ALTER TABLE assigned_tasks ALTER COLUMN assigned_to_name DROP NOT NULL"); } catch (e) {}
  try { await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uniq_template_day ON assigned_tasks(template_id, task_date) WHERE template_id IS NOT NULL"); } catch (e) {}
  // Self-service shift flag — drives Pool claiming + auto-assignment.
  try { await db.exec("ALTER TABLE users ADD COLUMN on_shift BOOLEAN DEFAULT false"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN on_shift_at TIMESTAMP"); } catch (e) {}
  try { await db.exec("ALTER TABLE branch_messages ADD COLUMN resolved_by INTEGER"); } catch (e) {}
  try { await db.exec("ALTER TABLE branch_messages ADD COLUMN resolve_reason TEXT"); } catch (e) {}
  // Per-message ticket clearing: a restaurant message leaves the tickets list
  // only when INDIVIDUALLY handled (marked done, dismissed, or liked) — NOT when
  // any office reply appears (which used to clear a store's whole backlog at
  // once). `cleared_at` is set when its ticket is marked done. The ADD COLUMN
  // succeeds exactly once (first deploy) → run a ONE-TIME backfill freezing all
  // already-answered historical messages as cleared, so switching to per-message
  // doesn't resurrect thousands of old tickets. (Runs only inside this try, so a
  // later generic reply can never re-trigger the office-after backfill.)
  try {
    await db.exec("ALTER TABLE branch_messages ADD COLUMN cleared_at TIMESTAMP");
    await db.exec(`UPDATE branch_messages bm SET cleared_at = CURRENT_TIMESTAMP
      WHERE bm.sender_role = 'Restaurants' AND bm.cleared_at IS NULL AND bm.resolved_at IS NULL
        AND EXISTS (SELECT 1 FROM branch_messages o
          WHERE o.branch_id = bm.branch_id AND o.sender_role <> 'Restaurants' AND o.created_at > bm.created_at)`);
    console.log("branch_messages.cleared_at added + one-time backfill done");
  } catch (e) { /* column already exists — backfill already ran once */ }
  try { await db.exec("CREATE INDEX IF NOT EXISTS idx_bm_open_ticket ON branch_messages (branch_id) WHERE sender_role='Restaurants' AND resolved_at IS NULL AND cleared_at IS NULL"); } catch (e) {}
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
            role_target: ["Call Center", "Complain Team", "Restaurants"],
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
            role_target: ["Call Center", "Complain Team", "Restaurants", "Manager", "Super Visor"]
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

  app.post("/api/late-orders", authenticate, authorize(["Call Center", "Restaurants", "Technical Back Office", "Operation Manager"]), upload.array('attachments', 6), shrinkUploads, async (req, res) => {
    try {
      const { brand_id, branch_id, customer_name, customer_phone, order_id, platform, call_center_message, case_type, technical_type, dedication_time, dynamic_values } = req.body;
      
      // Support multiple attachments. Keep attachment_url/type = the first file
      // for backward compatibility with existing single-attachment records/code.
      const files = (req.files as Express.Multer.File[]) || [];
      const attachment_url = files[0] ? ((files[0] as any).publicUrl || `/uploads/${files[0].filename}`) : null;
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
          [requestId, (f as any).publicUrl || `/uploads/${f.filename}`, f.mimetype]
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
        ? ["Technical Back Office", "Call Center", "Complain Team", "Manager", "Super Visor", "Operation Manager"]
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
   try {
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
    if (user.role_name === 'Call Center' || user.role_name === 'Complain Team') {
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
      if (user.role_name === 'Call Center' || user.role_name === 'Complain Team' || user.role_name === 'Technical Back Office') {
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
   } catch (error) {
     console.error("Error fetching late orders:", error);
     res.status(500).json({ error: "Failed to fetch late orders" });
   }
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
          ? ["Technical Back Office", "Call Center", "Complain Team", "Manager", "Super Visor", "Operation Manager"]
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
      
      const token = jwt.sign(userData, JWT_SECRET, { expiresIn: "400d", algorithm: "HS256" });
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
    try {
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
    } catch (error) {
      console.error("Error fetching brands:", error);
      res.status(500).json({ error: "Failed to fetch brands" });
    }
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
    try {
      await db.query("DELETE FROM brands WHERE id = $1", [req.params.id]);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting brand:", error);
      res.status(500).json({ error: "Failed to delete brand" });
    }
  });

  // Dynamic Fields Routes
  app.get("/api/fields", authenticate, async (req, res) => {
    try {
      const fields = await db.all("SELECT * FROM dynamic_fields ORDER BY field_order ASC");
      const options = await db.all("SELECT * FROM field_options");

      const fieldsWithOptions = fields.map(field => ({
        ...field,
        options: options.filter(opt => opt.field_id === field.id)
      }));

      res.json({ fields: fieldsWithOptions, options });
    } catch (error) {
      console.error("Error fetching fields:", error);
      res.status(500).json({ error: "Failed to fetch fields" });
    }
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
    try {
      await db.query("DELETE FROM field_options WHERE id = $1", [req.params.id]);
      broadcast({ type: 'FIELDS_UPDATED' });
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting field option:", error);
      res.status(500).json({ error: "Failed to delete field option" });
    }
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
    try {
      const { value_en, value_ar, price } = req.body;
      const fieldId = req.params.id;
      const result = await db.query("INSERT INTO field_options (field_id, value_en, value_ar, price) VALUES ($1, $2, $3, $4) RETURNING id", [fieldId, value_en, value_ar, price || 0]);
      broadcast({ type: 'FIELDS_UPDATED' });
      res.json({ id: result.rows[0].id });
    } catch (error) {
      console.error("Error creating field option:", error);
      res.status(500).json({ error: "Failed to create field option" });
    }
  });

  // Products Routes
  app.get("/api/products", authenticate, async (req, res) => {
   try {
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
   } catch (error) {
     console.error("Error fetching products:", error);
     res.status(500).json({ error: "Failed to fetch products" });
   }
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
    // Read the snake_case body the client actually sends (product_code /
    // modifier_groups). Reading camelCase here left them undefined, so `code`
    // hit its NOT NULL constraint and every PLU save 500'd.
    const { product_code, modifier_groups } = req.body;
    const productId = req.params.id;

    try {
      await db.transaction(async (client) => {
        // 1. Product Code — only when a real PLU was entered (skip empty so it
        //    can't violate the NOT NULL column).
        if (product_code != null && String(product_code).trim() !== '') {
          const existingProductCode = await db.get("SELECT id FROM product_codes WHERE product_id = $1", [productId]);
          if (existingProductCode) {
            await client.query("UPDATE product_codes SET code = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE product_id = $3", [product_code, (req as any).user.id, productId]);
          } else {
            await client.query("INSERT INTO product_codes (product_id, code, updated_by) VALUES ($1, $2, $3)", [productId, product_code, (req as any).user.id]);
          }
        }

        // 2. Modifier Groups and Options Codes
        if (modifier_groups && Array.isArray(modifier_groups)) {
          for (const group of modifier_groups) {
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
      await logAction((req as any).user.id, "UPDATE_CODES", "products", Number(productId), null, { product_code, modifier_groups });
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

    // Batch-load multi-brand / multi-branch assignments in two queries instead
    // of two queries per user (avoids N+1). Output shape is unchanged.
    const brandRows = await db.all(`
      SELECT ub.user_id, b.id, b.name
      FROM user_brands ub JOIN brands b ON ub.brand_id = b.id
      ORDER BY ub.user_id, b.id
    `) as { user_id: number, id: number, name: string }[];

    const branchRows = await db.all(`
      SELECT ub.user_id, b.id, b.name
      FROM user_branches ub JOIN branches b ON ub.branch_id = b.id
      ORDER BY ub.user_id, b.id
    `) as { user_id: number, id: number, name: string }[];

    const groupByUser = (rows: { user_id: number, id: number, name: string }[]) => {
      const map = new Map<number, { ids: number[], names: string[] }>();
      for (const row of rows) {
        let entry = map.get(row.user_id);
        if (!entry) { entry = { ids: [], names: [] }; map.set(row.user_id, entry); }
        entry.ids.push(row.id);
        entry.names.push(row.name);
      }
      return map;
    };

    const brandsByUser = groupByUser(brandRows);
    const branchesByUser = groupByUser(branchRows);

    const usersWithDetails = users.map((user) => {
      const brands = brandsByUser.get(user.id) || { ids: [], names: [] };
      const branches = branchesByUser.get(user.id) || { ids: [], names: [] };
      return {
        ...user,
        brand_ids: brands.ids,
        brand_names: brands.names,
        branch_ids: branches.ids,
        branch_names: branches.names,
      };
    });

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
   try {
    const user = (req as any).user;
    const restriction = await getBrandRestriction(user);
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

    // Restaurants accounts are scoped to a single branch everywhere else in the
    // app (e.g. late-orders). getBrandRestriction() only narrows by brand, so
    // without this a branch account could see hide/unhide history for every
    // other branch under the same brand. Records with no branch_id (an
    // "all branches" hide) still apply to this branch, so those stay visible.
    if (user.role_name === 'Restaurants' && user.branch_id) {
      filteredLogs = filteredLogs.filter(log => {
        try {
          const data = JSON.parse(log.new_value || log.old_value || '{}');
          if (data.branch_id === undefined || data.branch_id === null) return true;
          return Number(data.branch_id) === Number(user.branch_id);
        } catch (e) {
          return true;
        }
      });
    }

    res.json(filteredLogs);
   } catch (error) {
     console.error("Error fetching audit logs:", error);
     res.status(500).json({ error: "Failed to fetch audit logs" });
   }
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
          // Some HIDE logs (e.g. from the pending-request approval path) store their
          // payload in old_value instead of new_value. Falling back here mirrors every
          // read site's `new_value || old_value` pattern — without it, editing one of
          // those records wipes product_name/brand_name/branch from new_value forever.
          try { data = JSON.parse(hideLog.new_value || hideLog.old_value || '{}'); } catch (e) { data = {}; }
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

      // Managers/Super Visors restricted to specific brands (via user_brands)
      // could otherwise edit a hidden item into/out of a brand they don't have
      // access to, since brand_id/branch_id here come straight from the request
      // body with no server-side check. Unrestricted accounts (the common case)
      // are unaffected — getBrandRestriction() returns null for them.
      const restriction = await getBrandRestriction((req as any).user);
      if (restriction && brand_id) {
        const targetBrand = await db.get("SELECT name FROM brands WHERE id = $1", [brand_id]) as any;
        const brandName = targetBrand?.name;
        const allowed = !!brandName && (restriction.type === 'include'
          ? restriction.brands.includes(brandName)
          : !restriction.brands.includes(brandName));
        if (!allowed) {
          return res.status(403).json({ error: "You do not have permission to edit hidden items for this brand" });
        }
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
        role_target: ["Manager", "Super Visor", "Area Manager", "Call Center", "Complain Team"]
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
        // Pair by numeric branch_id (reliable); the branch NAME can differ between
        // the hide and unhide logs and used to leave unhidden items as "still
        // hidden". Fall back to the name for older logs that predate branch_id.
        const key = `${productId}-${data.branch_id ?? branch}`;

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

  // Hidden-item ids already covered by an open (Pending) unhide request. The Unhide
  // view uses this to badge those items and block re-requesting the same item.
  app.get("/api/hidden-items/pending-unhide", authenticate, async (_req, res) => {
    const rows = await db.all(`
      SELECT data::jsonb->'ids' AS ids FROM pending_requests
      WHERE type = 'hide_unhide' AND status = 'Pending' AND data::jsonb->>'action' = 'UNHIDE'
    `);
    const idSet = new Set<number>();
    for (const row of rows as any[]) {
      for (const id of (row.ids || [])) idSet.add(Number(id));
    }
    res.json({ ids: Array.from(idSet) });
  });

  app.post("/api/hidden-items/bulk-unhide", authenticate, authorize(["Technical Back Office", "Manager", "Super Visor", "Restaurants", "Area Manager", "Operation Manager"]), async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Invalid IDs" });
    }

    if ((req as any).user.role_name === 'Restaurants' || (req as any).user.role_name === 'Area Manager') {
      const productNameFieldId = await getProductNameFieldId();
      try {
        const outcome = await db.transaction(async (client) => {
          // Serialize this user's rapid submits so the duplicate check below can't
          // be raced by a double-click firing two requests at the same instant.
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`unhide_request_${(req as any).user.id}`]);

          // Drop ids already covered by an open (Pending) unhide request.
          const pendingRows = await client.query(`
            SELECT data::jsonb->'ids' AS ids FROM pending_requests
            WHERE type = 'hide_unhide' AND status = 'Pending' AND data::jsonb->>'action' = 'UNHIDE'
          `);
          const alreadyPending = new Set<number>();
          for (const row of pendingRows.rows) {
            for (const pid of (row.ids || [])) alreadyPending.add(Number(pid));
          }
          const newIds = (ids as any[]).filter((id) => !alreadyPending.has(Number(id)));
          if (newIds.length === 0) throw new Error("DUPLICATE_REQUEST");

          const resolvedProducts = (await client.query(`
            SELECT hi.id as hidden_item_id, hi.product_id, fv.value as name
            FROM hidden_items hi
            LEFT JOIN product_field_values fv ON hi.product_id = fv.product_id AND fv.field_id = $1
            WHERE hi.id IN (${newIds.map((_, i) => `$${i + 2}`).join(',')})
          `, [productNameFieldId, ...newIds])).rows;

          const inserted = await client.query(`
            INSERT INTO pending_requests (user_id, type, data, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
          `, [
            (req as any).user.id,
            'hide_unhide',
            JSON.stringify({ action: 'UNHIDE', ids: newIds, resolved_products: resolvedProducts }),
            getCurrentKuwaitTime(),
            getCurrentKuwaitTime()
          ]);
          return { id: inserted.rows[0].id, created: newIds.length, skipped: (ids as any[]).length - newIds.length };
        });

        broadcast({ type: "PENDING_REQUEST_CREATED" });
        broadcast({ type: "HIDDEN_ITEMS_UPDATED" });
        const branchName = req.body.branch_name || "Unknown Branch";
        sendSystemNotification(
          "New Bulk Hide Request",
          "طلب إخفاء متعدد جديد",
          `New bulk hide request received from ${branchName}`,
          `طلب إخفاء متعدد جديد مستلم من ${branchName}`,
          ["Technical Back Office"]
        );
        return res.json({ id: outcome.id, pending: true, created: outcome.created, skipped: outcome.skipped });
      } catch (err: any) {
        if (err.message === "DUPLICATE_REQUEST") {
          return res.status(409).json({ error: "DUPLICATE_REQUEST", message: "A pending unhide request already exists for the selected item(s)." });
        }
        console.error("bulk-unhide request failed", err);
        return res.status(500).json({ error: "Failed to submit unhide request" });
      }
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

    // Real browser push so office monitors are alerted (with the OS sound) that
    // a branch went busy, even if the app isn't open/focused. Busy events are
    // infrequent, so this won't recreate the chat-style flood.
    sendPushToRoles(
      ["Technical Back Office", "Manager", "Super Visor", "Operation Manager"],
      {
        title: "Branch Busy",
        body: `Branch ${branch} (${brand}) is now Busy.`,
        tag: `busy-start-${result.rows[0].id}`,
        data: { type: "BUSY_BRANCH", recordId: result.rows[0].id, url: "/" },
      }
    ).catch(e => console.error("busy push failed", e));

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
      if (user.role_name === 'Call Center' || user.role_name === 'Complain Team' || user.role_name === 'Restaurants') {
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
      const newReason = (req.body.reason_category ?? record.reason_category);
      const newResponsible = (req.body.responsible_party ?? record.responsible_party);
      await db.query(`
        UPDATE busy_period_records
        SET start_time = $1, end_time = $2, total_duration = $3, total_duration_minutes = $4,
            reason_category = $5, responsible_party = $6
        WHERE id = $7
      `, [newStart, newEnd, dur, durMin || 0, newReason, newResponsible, id]);

      await logAction(user.id, "BUSY_EDIT", "busy_period_records", Number(id),
        { start_time: record.start_time, end_time: record.end_time, total_duration: record.total_duration, reason_category: record.reason_category, responsible_party: record.responsible_party },
        { start_time: newStart, end_time: newEnd, total_duration: dur, reason_category: newReason, responsible_party: newResponsible });

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

        // Real browser push so office staff are alerted (with the OS
        // notification sound) even when the app is closed or in the background.
        // Fires once per record — alarm_triggered is set above, so no spam.
        await sendPushToRoles(
          ["Technical Back Office", "Manager", "Super Visor", "Operation Manager"],
          {
            title: "Busy Timer Expired",
            body: `${record.branch} (${record.brand}) has exceeded its busy time — action needed.`,
            tag: `busy-timer-${record.id}`,
            requireInteraction: true,
            data: { type: "BUSY_TIMER", recordId: record.id, url: "/" },
          }
        );

        // Turn the expiry into a COUNTED task: create an "Open Branch" reopen
        // request (identical shape to a restaurant-submitted OPEN request) so an
        // agent picks it, reopens the store, and gets credited via the ticket
        // workflow — instead of just an alarm nobody is accountable for.
        // Deduped per branch (advisory lock) so we never stack two pending
        // reopen requests for the same branch. Best-effort: a failure here must
        // not stop the alarm loop, so it's wrapped and swallowed.
        try {
          let created = false;
          await db.transaction(async (client) => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`busy_branch_open_${String(record.branch).trim().toUpperCase()}`]);
            const existing = await client.query(`
              SELECT id FROM pending_requests
              WHERE type = 'busy_branch' AND status = 'Pending'
                AND UPPER(data::jsonb->>'action') = 'OPEN'
                AND TRIM(UPPER(data::jsonb->>'branch')) = TRIM(UPPER($1))
            `, [record.branch]);
            if (existing.rows.length === 0) {
              await client.query(`
                INSERT INTO pending_requests (user_id, type, data, status)
                VALUES ($1, $2, $3, $4)
              `, [record.user_id, 'busy_branch', JSON.stringify({ ...record, action: 'OPEN', auto_reopen: true }), 'Pending']);
              created = true;
            }
          });
          if (created) broadcast({ type: "PENDING_REQUEST_UPDATED" });
        } catch (reopenErr) {
          console.error(`[Timer] Failed to create reopen request for record ${record.id}:`, reopenErr);
        }
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


  app.get("/api/reports/brand-hides-today", authenticate, async (req, res) => {
    const { brand_id } = req.query;
    let query = `
      SELECT
        b.name as brand_name,
        COUNT(DISTINCT hh.product_id) as today_count
      FROM brands b
      LEFT JOIN branches br ON br.brand_id = b.id
      LEFT JOIN hide_history hh ON hh.branch_id = br.id 
        AND hh.action = 'HIDE'
        AND (hh.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date
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
    }
    if (brand_id) {
      conditions.push("b.id = $" + (params.length + 1));
      params.push(brand_id);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " GROUP BY b.id, b.name ORDER BY today_count DESC, b.name ASC";
    
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

  // Drill-down: one branch's busy minutes split PER BRAND (same date filters).
  app.get("/api/reports/branch-busy-by-brand", authenticate, async (req, res) => {
    const branchName = String(req.query.branch_name || '');
    if (!branchName) return res.status(400).json({ error: "branch_name is required" });
    const user = (req as any).user;
    if (user.role_name === 'Area Manager') {
      const branchIds = await getBranchRestriction(user);
      const allowed = branchIds && branchIds.length
        ? (await db.all(`SELECT name FROM branches WHERE id IN (${branchIds.map((_, i) => `$${i + 1}`).join(',')})`, branchIds)).map((b: any) => b.name)
        : [];
      if (!allowed.includes(branchName)) return res.json([]);
    }
    const { period, startDate, endDate } = req.query as any;
    const conditions: string[] = ["branch = $1"];
    const params: any[] = [branchName];
    if (startDate) { conditions.push(`(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= $${params.length + 1}`); params.push(startDate); }
    if (endDate) { conditions.push(`(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date <= $${params.length + 1}`); params.push(endDate); }
    if (!startDate && !endDate) {
      if (period === 'today') conditions.push("(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date");
      else if (period === 'week') conditions.push("(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '7 days'");
      else if (period === 'month') conditions.push("(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '30 days'");
    }
    const rows = await db.all(`
      SELECT COALESCE(NULLIF(brand, ''), '—') AS brand,
        COALESCE(SUM(total_duration_minutes), 0)::int AS total_minutes,
        COUNT(*)::int AS total_instances
      FROM busy_period_records WHERE ${conditions.join(' AND ')}
      GROUP BY brand ORDER BY total_minutes DESC`, params);
    res.json(rows);
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

  // Brand-wise variant of team-performance: same filters (date range + role +
  // user + brand/branch), but one row per BRAND with metrics summed across all
  // processors. Read-only; the request's brand comes from the JSON payload.
  app.get("/api/reports/team-performance-by-brand", authenticate, authorize(["Manager", "Super Visor", "Operation Manager", "Technical Back Office", "Call Center", "Technical Team", "Coding Team", "Marketing Team"]), async (req, res) => {
    try {
      const reqUser = (req as any).user;
      let { startDate, endDate, brand_id, branch_id, role, user_id, period } = req.query as any;

      const managerRoles = ["Manager", "Super Visor", "Operation Manager"];
      if (!managerRoles.includes(reqUser.role_name)) user_id = String(reqUser.id);

      const params: any[] = [];
      const conditions: string[] = ["pr.status <> 'Pending'", "pr.processed_by IS NOT NULL"];

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

      // Derive the brand per request: HIDE requests store brand_name/brand in
      // their payload; UNHIDE requests don't (they carry product ids), so fall
      // back to the product's brand via resolved_products. Anything still
      // unresolved (e.g. the product was later deleted) stays 'Unknown'.
      // Guarded so a non-array resolved_products or non-numeric id can't error.
      const derivedBrand = `COALESCE(
        NULLIF(pr.data::jsonb->>'brand_name',''),
        NULLIF(pr.data::jsonb->>'brand',''),
        (SELECT b.name
           FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(pr.data::jsonb->'resolved_products')='array'
                  THEN pr.data::jsonb->'resolved_products' ELSE '[]'::jsonb END
           ) rp
           JOIN products p ON p.id = CASE WHEN rp->>'product_id' ~ '^[0-9]+$' THEN (rp->>'product_id')::int END
           JOIN brands b ON b.id = p.brand_id
           LIMIT 1),
        'Unknown'
      )`;
      const rows = await db.all(`
        SELECT brand,
          COUNT(*)::int AS processed,
          COUNT(*) FILTER (WHERE status='Approved')::int AS approved,
          COUNT(*) FILTER (WHERE status='Rejected')::int AS rejected,
          ROUND(AVG(resp_min))::int AS avg_resp_min,
          ROUND(MAX(resp_min))::int AS max_resp_min
        FROM (
          SELECT ${derivedBrand} AS brand,
            pr.status AS status,
            EXTRACT(EPOCH FROM (pr.updated_at - pr.created_at))/60 AS resp_min
          FROM pending_requests pr
          JOIN users pu ON pr.processed_by = pu.id
          JOIN roles pr_role ON pu.role_id = pr_role.id
          WHERE ${conditions.join(' AND ')}
        ) t
        GROUP BY brand
        ORDER BY processed DESC
      `, params);

      res.json(rows);
    } catch (error) {
      console.error("Error fetching team-performance-by-brand:", error);
      res.status(500).json({ error: "Failed to fetch brand performance" });
    }
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

  // ---- Technical Team KPIs (Manager / Super Visor only) --------------------
  // Monthly scorecard for Technical Back Office agents. Three KPIs per agent:
  //   FTR    – auto: pooled speed of tickets + chat replies vs the month target
  //            score = min(100, target / avg_speed).  "—" when no activity.
  //   SLA    – manual per-agent %, entered by admin/supervisor.
  //   Rating – manual, one value /5 for the month, shared by all agents.
  // All read-only against existing data for FTR; manual values live in their own
  // tables. `month` is 'YYYY-MM' (calendar month, Kuwait local time).
  const TECH_KPI_ROLES = ["Manager", "Super Visor"];
  const monthOr = (m: any): string => {
    const s = String(m || "");
    return /^\d{4}-\d{2}$/.test(s) ? s : "";
  };

  app.get("/api/reports/technical-kpi", authenticate, authorize(TECH_KPI_ROLES), async (req, res) => {
    try {
      const month = monthOr(req.query.month);
      if (!month) return res.status(400).json({ error: "month (YYYY-MM) is required" });

      const monthCfg = await db.get(
        "SELECT ftr_target_min, rating FROM technical_kpi_month WHERE period_month = $1", [month]
      ) as any;
      const ftrTarget = monthCfg?.ftr_target_min != null ? Number(monthCfg.ftr_target_min) : null;
      const rating = monthCfg?.rating != null ? Number(monthCfg.rating) : null;

      // Per Technical Back Office agent: pooled ticket + chat-reply speed for the
      // month. Kuwait-local month bucket via to_char on the shifted timestamp.
      const rows = await db.all(`
        WITH tbo AS (
          SELECT u.id, u.username
          FROM users u JOIN roles r ON u.role_id = r.id
          WHERE r.name = 'Technical Back Office'
        ),
        tk AS (
          SELECT pr.processed_by AS uid,
            COUNT(*)::int AS cnt,
            SUM(EXTRACT(EPOCH FROM (pr.updated_at - pr.created_at)) / 60) AS mins
          FROM pending_requests pr
          WHERE pr.status <> 'Pending' AND pr.processed_by IS NOT NULL
            AND to_char((pr.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait'), 'YYYY-MM') = $1
          GROUP BY pr.processed_by
        ),
        -- Chat "reply" = the FIRST office message posted after a restaurant
        -- message (matches how the ticket system clears an "awaiting reply"),
        -- credited to that office sender. Counts plain replies too, not only
        -- quote-replies. Excludes restaurant messages that were dismissed or
        -- liked (those weren't answered by a reply message).
        office AS (
          SELECT o.id, o.branch_id, o.sender_id, o.created_at,
            LAG(o.created_at) OVER (PARTITION BY o.branch_id ORDER BY o.created_at) AS prev_office_at
          FROM branch_messages o WHERE o.sender_role <> 'Restaurants'
        ),
        ch AS (
          SELECT om.sender_id AS uid,
            COUNT(rm.id)::int AS cnt,
            SUM(EXTRACT(EPOCH FROM (om.created_at - rm.created_at)) / 60) AS mins
          FROM office om
          JOIN branch_messages rm ON rm.branch_id = om.branch_id AND rm.sender_role = 'Restaurants'
            AND rm.resolved_at IS NULL
            AND rm.created_at < om.created_at
            AND (om.prev_office_at IS NULL OR rm.created_at > om.prev_office_at)
            AND NOT EXISTS (SELECT 1 FROM message_reactions mr WHERE mr.message_type = 'branch' AND mr.message_id = rm.id)
          WHERE to_char((om.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait'), 'YYYY-MM') = $1
          GROUP BY om.sender_id
        )
        SELECT tbo.id AS user_id, tbo.username,
          COALESCE(tk.cnt, 0) AS tickets,
          COALESCE(ch.cnt, 0) AS chats,
          (COALESCE(tk.cnt, 0) + COALESCE(ch.cnt, 0))::int AS total_count,
          (COALESCE(tk.mins, 0) + COALESCE(ch.mins, 0)) AS total_minutes,
          sla.sla AS sla
        FROM tbo
        LEFT JOIN tk ON tk.uid = tbo.id
        LEFT JOIN ch ON ch.uid = tbo.id
        LEFT JOIN technical_kpi_sla sla ON sla.user_id = tbo.id AND sla.period_month = $1
        ORDER BY tbo.username ASC
      `, [month]) as any[];

      const agents = rows.map((r) => {
        const totalCount = Number(r.total_count) || 0;
        const avgSpeed = totalCount > 0 ? Number(r.total_minutes) / totalCount : null;
        let ftr_pct: number | null = null;
        if (avgSpeed != null && ftrTarget != null && ftrTarget > 0) {
          ftr_pct = avgSpeed <= 0 ? 100 : Math.min(100, Math.round((ftrTarget / avgSpeed) * 100));
        }
        return {
          user_id: r.user_id,
          username: r.username,
          tickets: Number(r.tickets) || 0,
          chats: Number(r.chats) || 0,
          total_count: totalCount,
          avg_speed_min: avgSpeed != null ? Math.round(avgSpeed * 10) / 10 : null,
          ftr_pct,
          sla: r.sla != null ? Number(r.sla) : null,
          rating,
        };
      });

      res.json({ month, ftr_target_min: ftrTarget, rating, agents });
    } catch (error) {
      console.error("Error fetching technical-kpi:", error);
      res.status(500).json({ error: "Failed to fetch technical KPIs" });
    }
  });

  // Save the month-level values (FTR target + shared Rating).
  app.put("/api/reports/technical-kpi/month", authenticate, authorize(TECH_KPI_ROLES), async (req, res) => {
    try {
      const month = monthOr(req.body.month);
      if (!month) return res.status(400).json({ error: "month (YYYY-MM) is required" });
      const target = (req.body.ftr_target_min === '' || req.body.ftr_target_min == null) ? null : Number(req.body.ftr_target_min);
      const rating = (req.body.rating === '' || req.body.rating == null) ? null : Number(req.body.rating);
      if (rating != null && (rating < 0 || rating > 5)) return res.status(400).json({ error: "rating must be 0-5" });
      if (target != null && target < 0) return res.status(400).json({ error: "target must be >= 0" });
      await db.query(`
        INSERT INTO technical_kpi_month (period_month, ftr_target_min, rating, updated_by, updated_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (period_month) DO UPDATE
          SET ftr_target_min = EXCLUDED.ftr_target_min, rating = EXCLUDED.rating,
              updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
      `, [month, target, rating, (req as any).user.id]);
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving technical-kpi month:", error);
      res.status(500).json({ error: "Failed to save month values" });
    }
  });

  // Save one agent's SLA for the month.
  app.put("/api/reports/technical-kpi/sla", authenticate, authorize(TECH_KPI_ROLES), async (req, res) => {
    try {
      const month = monthOr(req.body.month);
      const userId = Number(req.body.user_id);
      if (!month || !userId) return res.status(400).json({ error: "month and user_id are required" });
      const sla = (req.body.sla === '' || req.body.sla == null) ? null : Number(req.body.sla);
      if (sla != null && (sla < 0 || sla > 100)) return res.status(400).json({ error: "sla must be 0-100" });
      await db.query(`
        INSERT INTO technical_kpi_sla (period_month, user_id, sla, updated_by, updated_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (period_month, user_id) DO UPDATE
          SET sla = EXCLUDED.sla, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
      `, [month, userId, sla, (req as any).user.id]);
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving technical-kpi sla:", error);
      res.status(500).json({ error: "Failed to save SLA" });
    }
  });

  // ---- Branch Chat (invoice photos + comments between a branch and the office) ----
  const CHAT_ROLES = ["Restaurants", "Technical Back Office", "Call Center", "Complain Team", "Manager", "Super Visor", "Operation Manager", "Area Manager"];
  const CHAT_OFFICE_ROLES = ["Technical Back Office", "Call Center", "Complain Team", "Manager", "Super Visor", "Operation Manager", "Area Manager"];
  // Per-branch throttle (ms of last chat push per branch) so message bursts send
  // at most one browser push per branch per minute — no flooding, no drowning out
  // the busy alarms. The in-app unread badge still updates on every message.
  const lastChatPushAt = new Map<number, number>();

  // Lightweight user list for @mention autocomplete in chat (any chat participant).
  app.get("/api/chat-users", authenticate, authorize(CHAT_ROLES), async (_req, res) => {
    const users = await db.all(`
      SELECT u.id, u.username, r.name AS role_name
      FROM users u LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.is_active = 1
      ORDER BY u.username
    `);
    res.json(users);
  });

  app.post("/api/branch-chat", authenticate, authorize(CHAT_ROLES), upload.single('image'), shrinkUploads, async (req, res) => {
    const user = (req as any).user;
    const fromRestaurant = user.role_name === 'Restaurants';
    let branch_id = fromRestaurant ? user.branch_id : req.body.branch_id;
    const comment = (req.body.comment || '').trim() || null;
    const image_url = req.file ? ((req.file as any).publicUrl || `/uploads/${req.file.filename}`) : null;
    const image_type = req.file ? req.file.mimetype : null;

    if (!branch_id) return res.status(400).json({ error: "branch_id required" });
    if (!comment && !image_url) return res.status(400).json({ error: "Message is empty" });

    const branch = await db.get("SELECT id, brand_id, name FROM branches WHERE id = $1", [branch_id]) as any;
    if (!branch) return res.status(404).json({ error: "Branch not found" });

    // Brand-restricted office users (e.g. Area Manager) may only send to their brand.
    if (!fromRestaurant) {
      const allowed = await getAllowedBrandIds(user);
      if (allowed !== null && !allowed.includes(branch.brand_id)) return res.status(403).json({ error: "Not allowed for this brand" });
    }

    // Quoted reply: only honor an id that belongs to this same branch thread.
    let reply_to_id: number | null = req.body.reply_to_id ? Number(req.body.reply_to_id) : null;
    if (reply_to_id) {
      const parent = await db.get("SELECT id FROM branch_messages WHERE id = $1 AND branch_id = $2", [reply_to_id, branch.id]) as any;
      if (!parent) reply_to_id = null;
    }

    const ins = await db.query(`
      INSERT INTO branch_messages (brand_id, branch_id, sender_id, sender_role, comment, image_url, image_type, reply_to_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at
    `, [branch.brand_id, branch.id, user.id, user.role_name, comment, image_url, image_type, reply_to_id]);

    // Respond immediately; notifications/push run after (don't block the sender).
    res.json({ id: ins.rows[0].id });

    // Replying = reading: mark THIS sender as having read the thread up to now, so a
    // reply sent from the Requests Branch "Send & Done" (without opening the chat)
    // clears their own unread badge for this branch — not just when they open it.
    try {
      await db.query(`
        INSERT INTO branch_reads (user_id, branch_id, last_read_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, branch_id) DO UPDATE SET last_read_at = CURRENT_TIMESTAMP
      `, [user.id, branch.id]);
    } catch (e) { console.error("branch-chat sender read-mark failed", e); }

    // Every message updates the in-app unread badge instantly.
    try {
      broadcast({ type: "BRANCH_CHAT_UPDATED", branch_id: branch.id });
    } catch (e) { console.error("branch-chat unread-badge broadcast failed", e); }

    // Ticket workflow sync (per-message): completing a ticket must clear ONLY
    // the specific message it was for — never a store's whole backlog. If the
    // office sender is holding a chat ticket on THIS branch, this reply completes
    // it: mark the hold done, set that message's cleared_at (so only that ticket
    // leaves the list), and auto-log the task. Atomic (WHERE status='in_progress')
    // so a concurrent /api/tickets/done can't double-log. Other agents' holds and
    // the store's other pending messages are deliberately left untouched.
    if (!fromRestaurant) {
      try {
        const doneRow = await db.get(`
          UPDATE ticket_assignments ta
          SET status = 'done', done_at = CURRENT_TIMESTAMP, done_by = $1,
              duration_seconds = GREATEST(1, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ta.assigned_at))::int)
          WHERE ta.status = 'in_progress' AND ta.ticket_type = 'chat' AND ta.assigned_to = $1
            AND EXISTS (SELECT 1 FROM branch_messages rm WHERE rm.id = ta.ticket_id AND rm.branch_id = $2)
          RETURNING ta.id, ta.ticket_id, ta.duration_seconds, ta.brand_id
        `, [user.id, branch.id]) as any;
        if (doneRow) {
          await db.query("UPDATE branch_messages SET cleared_at = CURRENT_TIMESTAMP WHERE id = $1 AND cleared_at IS NULL", [doneRow.ticket_id]);
          const taskIns = await db.query(`
            INSERT INTO activity_logs (log_type, department, activity_type, status, duration_seconds, brand_id, notes, agent_id, agent_name)
            VALUES ('technical', 'Technical', 'Invoice Chat', 'Completed', $1, $2, $3, $4, $5) RETURNING id`,
            [Math.max(1, Number(doneRow.duration_seconds) || 1), doneRow.brand_id, `Ticket #${doneRow.ticket_id} (chat)`, user.id, user.username]);
          await db.query("UPDATE ticket_assignments SET task_log_id = $1 WHERE id = $2", [taskIns.rows[0].id, doneRow.id]);
          broadcast({ type: "TICKETS_UPDATED" });
        }
      } catch (e) { console.error("branch-chat ticket sync failed", e); }
    }

    // @mention notifications: ping any mentioned employee (in-app + push), not the sender.
    await notifyMentions(comment, user.id, user.username, {
      titleAr: `تم ذكرك في شات ${branch.name}`, titleEn: `You were mentioned in ${branch.name} chat`,
      data: { type: "CHAT_MENTION", branch_id: branch.id },
    });

    // Throttled browser push: at most ONE push per branch per minute, so bursts
    // of messages can't flood the pipeline (the reason chat push was disabled) or
    // drown out busy alarms. Only the OTHER side is notified (never the sender).
    try {
      const now = Date.now();
      const key = Number(branch.id);
      if (now - (lastChatPushAt.get(key) || 0) > 60000) {
        lastChatPushAt.set(key, now);
        const preview = comment ? (comment.length > 60 ? comment.slice(0, 60) + '…' : comment) : '📷 Photo';
        if (fromRestaurant) {
          // Restaurant messaged the office → alert the office chat team.
          sendPushToRoles(CHAT_OFFICE_ROLES, {
            title: `New chat · ${branch.name}`,
            body: preview,
            tag: `chat-${branch.id}`,
            data: { type: "BRANCH_CHAT", branch_id: branch.id, url: `/?chat=${branch.id}` },
          }).catch(e => console.error("chat push (office) failed", e));
        } else {
          // Office messaged the branch → alert that branch's restaurant only.
          sendPushToRoles(["Restaurants"], {
            title: "New chat message",
            body: preview,
            tag: `chat-${branch.id}`,
            data: { type: "BRANCH_CHAT", branch_id: branch.id, url: `/?chat=${branch.id}` },
          }, branch.id).catch(e => console.error("chat push (restaurant) failed", e));
        }
      }
    } catch (e) { console.error("chat push throttle failed", e); }
  });

  app.get("/api/branch-chat", authenticate, authorize(CHAT_ROLES), async (req, res) => {
    const user = (req as any).user;
    const branch_id = user.role_name === 'Restaurants' ? user.branch_id : (req.query.branch_id as string);
    if (!branch_id) return res.json([]);
    // "peek" is a cache-warming read (prefetch): return messages only, with NO
    // read-marking, so warming a thread's cache never clears its unread badge.
    const peek = req.query.peek === '1';

    // Office users with a brand restriction can only open their brand's threads.
    if (user.role_name !== 'Restaurants') {
      const allowed = await getAllowedBrandIds(user);
      if (allowed !== null) {
        const br = await db.get("SELECT brand_id FROM branches WHERE id = $1", [branch_id]) as any;
        if (!br || !allowed.includes(br.brand_id)) return res.status(403).json({ error: "Not allowed for this brand" });
      }
    }

    const msgs = await db.all(`
      WITH lo AS (
        SELECT MAX(created_at) AS t FROM branch_messages
        WHERE branch_id = $1 AND sender_role <> 'Restaurants'
      )
      SELECT bm.id, bm.branch_id, bm.sender_id, bm.sender_role, bm.comment, bm.image_url, bm.image_type,
             bm.status, bm.status_at, su.username AS status_by_name, bm.created_at, bm.read_at, u.username,
             bm.reply_to_id, ru.username AS reply_username, rm.comment AS reply_comment,
             (rm.image_url IS NOT NULL) AS reply_has_image, rm.sender_role AS reply_sender_role,
             bm.resolved_at, bm.resolve_reason, reu.username AS resolved_by_name,
             (bm.sender_role = 'Restaurants' AND (
                (lo.t IS NOT NULL AND bm.created_at < lo.t)
                OR EXISTS (SELECT 1 FROM message_reactions lmr WHERE lmr.message_type = 'branch' AND lmr.message_id = bm.id)
             )) AS answered,
             (SELECT COUNT(*) FROM message_reactions mr WHERE mr.message_type = 'branch' AND mr.message_id = bm.id)::int AS like_count,
             EXISTS (SELECT 1 FROM message_reactions mr WHERE mr.message_type = 'branch' AND mr.message_id = bm.id AND mr.user_id = $2) AS liked_by_me,
             (SELECT string_agg(lu.username, ', ' ORDER BY mr.created_at) FROM message_reactions mr JOIN users lu ON lu.id = mr.user_id WHERE mr.message_type = 'branch' AND mr.message_id = bm.id) AS liked_by
      FROM branch_messages bm
      CROSS JOIN lo
      JOIN users u ON bm.sender_id = u.id
      LEFT JOIN users su ON bm.status_by = su.id
      LEFT JOIN branch_messages rm ON bm.reply_to_id = rm.id
      LEFT JOIN users ru ON rm.sender_id = ru.id
      LEFT JOIN users reu ON bm.resolved_by = reu.id
      WHERE bm.branch_id = $1 ORDER BY bm.created_at ASC
    `, [branch_id, user.id]);

    // Send the conversation to the client immediately, then do the read-marking
    // writes AFTER responding so the chat paints without waiting on two DB writes.
    // A "peek" (prefetch) request skips read-marking entirely.
    res.json(msgs);
    if (peek) return;

    const isRestaurant = user.role_name === 'Restaurants';
    try {
      // Mark the OTHER side's messages as read for this viewer.
      const readResult = await db.query(`
        UPDATE branch_messages SET read_at = CURRENT_TIMESTAMP
        WHERE branch_id = $1 AND read_at IS NULL
          AND sender_role ${isRestaurant ? "<>" : "="} 'Restaurants'
      `, [branch_id]);

      // Per-user read state: record that THIS user has now seen everything in this
      // branch up to now. This drives each user's OWN unread badge, independent of
      // whoever else on the team has or hasn't opened the thread.
      await db.query(`
        INSERT INTO branch_reads (user_id, branch_id, last_read_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, branch_id) DO UPDATE SET last_read_at = CURRENT_TIMESTAMP
      `, [user.id, branch_id]);

      // Only when this read actually flipped rows null->now, tell the other side
      // live so their "Seen" receipt updates instantly (the guard also prevents
      // re-read broadcast loops, since a repeat read affects 0 rows).
      if ((readResult.rowCount ?? 0) > 0) {
        broadcast({ type: 'BRANCH_CHAT_READ', branch_id: Number(branch_id), by: isRestaurant ? 'restaurant' : 'office' });
      }
    } catch (e) { console.error("branch-chat read-mark failed", e); }
  });

  app.get("/api/branch-chat/threads", authenticate, authorize(CHAT_OFFICE_ROLES), async (req, res) => {
    const userId = (req as any).user.id;
    const allowed = await getAllowedBrandIds((req as any).user);
    const params: any[] = [userId];
    let brandFilter = '';
    if (allowed !== null) {
      if (allowed.length === 0) return res.json([]);
      params.push(allowed);
      brandFilter = `AND bm.brand_id = ANY($2)`;
    }
    // Per-user unread: a restaurant message is unread for THIS user until they open
    // the branch (which bumps their branch_reads.last_read_at). Users with no marker
    // yet fall back to their own join date so pre-existing chatter isn't counted.
    const threads = await db.all(`
      WITH agg AS (
        SELECT bm.branch_id, bm.brand_id,
          MAX(bm.created_at) AS last_at,
          COUNT(*) FILTER (
            WHERE bm.sender_role = 'Restaurants'
              AND bm.created_at > COALESCE(brd.last_read_at, (SELECT created_at FROM users WHERE id = $1))
          )::int AS unread
        FROM branch_messages bm
        LEFT JOIN branch_reads brd ON brd.branch_id = bm.branch_id AND brd.user_id = $1
        WHERE 1=1 ${brandFilter}
        GROUP BY bm.branch_id, bm.brand_id
      ),
      last_msg AS (
        SELECT DISTINCT ON (bm.branch_id) bm.branch_id,
          bm.comment AS last_comment, (bm.image_url IS NOT NULL) AS last_has_image, bm.sender_role AS last_sender_role
        FROM branch_messages bm WHERE 1=1 ${brandFilter} ORDER BY bm.branch_id, bm.created_at DESC, bm.id DESC
      )
      SELECT a.branch_id, b.name AS brand_name, br.name AS branch_name,
        a.last_at, a.unread, lm.last_comment, lm.last_has_image, lm.last_sender_role
      FROM agg a
      JOIN branches br ON a.branch_id = br.id
      JOIN brands b ON a.brand_id = b.id
      LEFT JOIN last_msg lm ON lm.branch_id = a.branch_id
      ORDER BY a.last_at DESC
    `, params);
    res.json(threads);
  });

  // Open "tickets": restaurant messages not yet replied to by the office. A
  // ticket clears as soon as any office-side message is posted after it.
  // Read-only — does not touch pending_requests or any existing data.
  app.get("/api/branch-chat/tickets", authenticate, authorize(CHAT_OFFICE_ROLES), async (req, res) => {
    const allowed = await getAllowedBrandIds((req as any).user);
    const params: any[] = [];
    let brandCond = '';
    if (allowed !== null) {
      if (allowed.length === 0) return res.json([]);
      params.push(allowed);
      brandCond = ` AND bm.brand_id = ANY($1)`;
    }
    // One ticket PER MESSAGE: a restaurant message stays a ticket until it is
    // individually handled — dismissed (resolved_at), marked done (cleared_at),
    // or liked. A generic office reply no longer clears a store's other pending
    // messages (that was the "mark one done → the rest vanish" bug).
    const rows = await db.all(`
      SELECT bm.id, bm.brand_id, bm.branch_id, bm.comment, bm.image_url, bm.created_at, bm.sender_id,
        b.name AS brand_name, br.name AS branch_name, u.username
      FROM branch_messages bm
      JOIN brands b ON bm.brand_id = b.id
      JOIN branches br ON bm.branch_id = br.id
      JOIN users u ON bm.sender_id = u.id
      WHERE bm.sender_role = 'Restaurants'
        AND bm.resolved_at IS NULL
        AND bm.cleared_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM message_reactions mr WHERE mr.message_type = 'branch' AND mr.message_id = bm.id)${brandCond}
      ORDER BY bm.created_at DESC
    `, params);
    res.json(rows);
  });

  // On-demand ticket context: the last N messages of a branch's chat thread
  // (both store + office), so an agent can click "History" on an ambiguous
  // ticket (e.g. "please follow up") and see what the store means — without
  // leaving the Requests tab. Read-only, office-only, brand-scoped, capped.
  app.get("/api/branch-chat/:branchId/recent", authenticate, authorize(CHAT_OFFICE_ROLES), async (req, res) => {
    try {
      const branchId = Number(req.params.branchId);
      if (!Number.isFinite(branchId)) return res.status(400).json({ error: "Invalid branch" });
      const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
      const branch = await db.get("SELECT id, brand_id FROM branches WHERE id = $1", [branchId]) as any;
      if (!branch) return res.status(404).json({ error: "Branch not found" });
      // Brand-restricted office users can only see their own brands.
      const allowed = await getAllowedBrandIds((req as any).user);
      if (allowed !== null && !allowed.includes(branch.brand_id)) return res.status(403).json({ error: "Not allowed for this brand" });

      const rows = await db.all(`
        SELECT bm.id, bm.sender_role, bm.comment, bm.image_url, bm.created_at, bm.reply_to_id,
          u.username,
          rm.comment AS reply_comment, rm.image_url AS reply_image_url, ru.username AS reply_username
        FROM branch_messages bm
        JOIN users u ON u.id = bm.sender_id
        LEFT JOIN branch_messages rm ON rm.id = bm.reply_to_id
        LEFT JOIN users ru ON ru.id = rm.sender_id
        WHERE bm.branch_id = $1
        ORDER BY bm.created_at DESC
        LIMIT $2
      `, [branchId, limit]);
      // Return oldest→newest so the UI can render the thread top-to-bottom.
      res.json(rows.reverse());
    } catch (e) {
      console.error("branch-chat recent error:", e);
      res.status(500).json({ error: "Failed to load history" });
    }
  });

  // Office dismisses a restaurant message (clears the ticket without replying).
  app.post("/api/branch-chat/:id/resolve", authenticate, authorize(CHAT_OFFICE_ROLES), async (req, res) => {
    const user = (req as any).user;
    const reason = (req.body?.reason || '').trim() || null;
    const msg = await db.get("SELECT id, branch_id, brand_id, sender_role FROM branch_messages WHERE id = $1", [req.params.id]) as any;
    if (!msg) return res.status(404).json({ error: "Message not found" });
    if (msg.sender_role !== 'Restaurants') return res.status(400).json({ error: "Only restaurant messages can be dismissed" });

    const allowedR = await getAllowedBrandIds(user);
    if (allowedR !== null && !allowedR.includes(msg.brand_id)) return res.status(403).json({ error: "Not allowed for this brand" });

    await db.query(
      "UPDATE branch_messages SET resolved_at = CURRENT_TIMESTAMP, resolved_by = $1, resolve_reason = $2 WHERE id = $3",
      [user.id, reason, msg.id]
    );
    // Dismissing clears the ticket — release any agent's in-progress hold on it too.
    const rel = await db.query(`UPDATE ticket_assignments SET status = 'released', done_at = CURRENT_TIMESTAMP WHERE ticket_type = 'chat' AND ticket_id = $1 AND status = 'in_progress'`, [msg.id]);
    broadcast({ type: "BRANCH_CHAT_UPDATED", branch_id: msg.branch_id });
    if ((rel.rowCount || 0) > 0) broadcast({ type: "TICKETS_UPDATED" });
    res.json({ success: true });
  });

  // The recipient (opposite side of the sender) approves/rejects a message.
  app.put("/api/branch-chat/:id/status", authenticate, authorize(CHAT_ROLES), async (req, res) => {
    const user = (req as any).user;
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: "Invalid status" });

    const msg = await db.get("SELECT bm.*, b.name AS brand_name, br.name AS branch_name FROM branch_messages bm JOIN brands b ON bm.brand_id=b.id JOIN branches br ON bm.branch_id=br.id WHERE bm.id = $1", [req.params.id]) as any;
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const isRestaurant = user.role_name === 'Restaurants';
    // Only the OPPOSITE side may act, and a restaurant only on its own branch.
    const senderIsRestaurant = msg.sender_role === 'Restaurants';
    if (isRestaurant) {
      if (senderIsRestaurant || msg.branch_id !== user.branch_id) return res.status(403).json({ error: "Not allowed" });
    } else {
      if (!senderIsRestaurant) return res.status(403).json({ error: "Not allowed" });
      const allowedS = await getAllowedBrandIds(user);
      if (allowedS !== null && !allowedS.includes(msg.brand_id)) return res.status(403).json({ error: "Not allowed for this brand" });
    }

    await db.query("UPDATE branch_messages SET status = $1, status_by = $2, status_at = CURRENT_TIMESTAMP WHERE id = $3", [status, user.id, msg.id]);

    // Notify the original sender of the decision.
    try {
      const label = `${msg.brand_name} · ${msg.branch_name}`;
      const verb = status === 'approved' ? 'approved' : 'rejected';
      broadcast({
        type: "NOTIFICATION",
        notificationType: "CALL_CENTER",
        title_en: `Message ${verb}`,
        title_ar: status === 'approved' ? 'تمت الموافقة على الرسالة' : 'تم رفض الرسالة',
        message_en: `${label} — ${user.username} ${verb} your message`,
        message_ar: `${label} — ${user.username} ${status === 'approved' ? 'وافق على رسالتك' : 'رفض رسالتك'}`,
        user_id: msg.sender_id,
        chat_branch_id: msg.branch_id,
      });
      broadcast({ type: "BRANCH_CHAT_UPDATED", branch_id: msg.branch_id });
    } catch (e) { console.error("status notify failed", e); }

    res.json({ success: true });
  });

  // Full chat log for Excel export (Manager-level). One row per message; a
  // "reply" is a message whose immediately-preceding thread message is from the
  // opposite side, so response_minutes = this message - the message it replied to.
  app.get("/api/branch-chat/export", authenticate, authorize(["Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    const rows = await db.all(`
      WITH ordered AS (
        SELECT bm.id, bm.branch_id, bm.created_at, bm.comment, bm.image_url, bm.status, bm.sender_role,
          b.name AS brand_name, br.name AS branch_name, u.username,
          CASE WHEN bm.sender_role = 'Restaurants' THEN 0 ELSE 1 END AS side,
          LAG(bm.created_at) OVER w AS prev_at,
          LAG(CASE WHEN bm.sender_role = 'Restaurants' THEN 0 ELSE 1 END) OVER w AS prev_side,
          LAG(u.username) OVER w AS prev_user
        FROM branch_messages bm
        JOIN brands b ON bm.brand_id = b.id
        JOIN branches br ON bm.branch_id = br.id
        JOIN users u ON bm.sender_id = u.id
        WINDOW w AS (PARTITION BY bm.branch_id ORDER BY bm.created_at, bm.id)
      )
      SELECT brand_name, branch_name, created_at, username, sender_role,
        comment, (image_url IS NOT NULL) AS has_image, status,
        CASE WHEN prev_side IS NOT NULL AND prev_side <> side THEN prev_user END AS replied_to,
        CASE WHEN prev_side IS NOT NULL AND prev_side <> side
             THEN ROUND(EXTRACT(EPOCH FROM (created_at - prev_at)) / 60)::int END AS response_minutes
      FROM ordered
      ORDER BY brand_name, branch_name, created_at
    `);
    res.json(rows);
  });

  // Monthly operations report as ONE professional Excel: Hide, Busy, and Chat
  // first-response — each on its own sheet. Query: ?year=YYYY&month=M (1-12);
  // defaults to the current month. Admins only (unrestricted roles).
  app.get("/api/reports/monthly-export", authenticate, authorize(["Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    try {
      const nowD = new Date();
      const year = parseInt(req.query.year as string) || nowD.getFullYear();
      const month = parseInt(req.query.month as string) || (nowD.getMonth() + 1);
      const pad = (n: number) => String(n).padStart(2, "0");
      const start = `${year}-${pad(month)}-01`;
      const end = `${month === 12 ? year + 1 : year}-${pad(month === 12 ? 1 : month + 1)}-01`;

      // Hide & Busy requests. Restaurant comes from the requester's branch
      // (unhide-request JSON has no branch name), falling back to the data JSON.
      const reqRows = await db.all(`
        SELECT pr.type,
          COALESCE(rbr.name, pr.data::jsonb->>'brand_name', pr.data::jsonb->>'brand', '') AS brand,
          COALESCE(rb.name, pr.data::jsonb->>'branch_name', pr.data::jsonb->>'branch', 'All Branches') AS restaurant,
          UPPER(COALESCE(pr.data::jsonb->>'action', '')) AS action,
          ru.username AS requested_by,
          pr.created_at AS requested_at,
          CASE WHEN pr.status <> 'Pending' THEN pr.updated_at END AS processed_at,
          CASE WHEN pr.status <> 'Pending' THEN ROUND(EXTRACT(EPOCH FROM (pr.updated_at - pr.created_at)) / 60)::int END AS response_minutes,
          pr.status,
          pu.username AS processed_by
        FROM pending_requests pr
        LEFT JOIN users ru ON pr.user_id = ru.id
        LEFT JOIN branches rb ON ru.branch_id = rb.id
        LEFT JOIN brands rbr ON ru.brand_id = rbr.id
        LEFT JOIN users pu ON pr.processed_by = pu.id
        WHERE pr.created_at >= $1 AND pr.created_at < $2
        ORDER BY pr.created_at
      `, [start, end]);

      // Chat first-response: each restaurant message immediately answered by an
      // office reply (side flip), with the minutes between them.
      const chatRows = await db.all(`
        WITH ordered AS (
          SELECT bm.branch_id, bm.created_at, bm.sender_role, bm.status, bm.comment,
            b.name AS brand_name, br.name AS branch_name, u.username,
            CASE WHEN bm.sender_role = 'Restaurants' THEN 0 ELSE 1 END AS side,
            LAG(bm.created_at) OVER w AS prev_at,
            LAG(CASE WHEN bm.sender_role = 'Restaurants' THEN 0 ELSE 1 END) OVER w AS prev_side,
            LAG(bm.comment) OVER w AS prev_comment
          FROM branch_messages bm
          JOIN brands b ON bm.brand_id = b.id
          JOIN branches br ON bm.branch_id = br.id
          JOIN users u ON bm.sender_id = u.id
          WINDOW w AS (PARTITION BY bm.branch_id ORDER BY bm.created_at, bm.id)
        )
        SELECT brand_name, branch_name, prev_at AS message_at, prev_comment AS message,
          created_at AS first_reply_at, username AS replied_by, status,
          ROUND(EXTRACT(EPOCH FROM (created_at - prev_at)) / 60)::int AS first_response_minutes
        FROM ordered
        WHERE prev_side = 0 AND side = 1 AND prev_at >= $1 AND prev_at < $2
        ORDER BY brand_name, branch_name, message_at
      `, [start, end]);

      // pg returns naive timestamps parsed as UTC; format the UTC parts so the
      // stored (Kuwait) value is shown as-is, with no timezone double-shift.
      const fmt = (d: any) => {
        if (!d) return "";
        const dt = new Date(d);
        return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
      };
      const typeLabel = (t: string, action: string) =>
        t === "busy_branch" ? (action === "OPEN" ? "Open (Unbusy)" : "Busy")
        : (action === "UNHIDE" ? "Unhide" : "Hide");
      const reqRow = (r: any) => ({
        "Restaurant": r.restaurant, "Brand": r.brand, "Type": typeLabel(r.type, r.action),
        "Requested By": r.requested_by || "", "Requested At": fmt(r.requested_at),
        "Approved/Processed At": fmt(r.processed_at), "Response Time (min)": r.response_minutes ?? "",
        "Status": r.status, "Processed By": r.processed_by || "",
      });

      const wb = XLSX.utils.book_new();
      const addSheet = (name: string, rows: any[], headers: string[]) => {
        const data = rows.length ? rows : [Object.fromEntries(headers.map((h) => [h, ""]))];
        const ws = XLSX.utils.json_to_sheet(data, { header: headers });
        ws["!cols"] = headers.map((h) => ({ wch: Math.max(16, h.length + 2) }));
        XLSX.utils.book_append_sheet(wb, ws, name);
      };
      const reqHeaders = ["Restaurant", "Brand", "Type", "Requested By", "Requested At", "Approved/Processed At", "Response Time (min)", "Status", "Processed By"];
      addSheet("Hide Requests", reqRows.filter((r: any) => r.type === "hide_unhide").map(reqRow), reqHeaders);
      addSheet("Busy Requests", reqRows.filter((r: any) => r.type === "busy_branch").map(reqRow), reqHeaders);
      addSheet("Chat Requests", chatRows.map((r: any) => ({
        "Restaurant": r.branch_name, "Brand": r.brand_name, "Message": r.message || "",
        "Message At": fmt(r.message_at), "First Reply At": fmt(r.first_reply_at),
        "First Response Time (min)": r.first_response_minutes ?? "", "Replied By": r.replied_by || "", "Status": r.status || "",
      })), ["Restaurant", "Brand", "Message", "Message At", "First Reply At", "First Response Time (min)", "Replied By", "Status"]);

      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="Swish-Report-${monthName}-${year}.xlsx"`);
      res.send(buf);
    } catch (e) {
      console.error("monthly-export failed", e);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  // ===== Group chat (admin-created, member-scoped, multi-user) =====
  const GROUP_ADMIN_ROLES = ["Manager"]; // only admins can create groups

  // Create a group: name + member user ids. The creator is always a member.
  app.post("/api/chat-groups", authenticate, authorize(GROUP_ADMIN_ROLES), async (req, res) => {
    const creatorId = (req as any).user.id;
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: "Group name required" });
    const raw = Array.isArray(req.body.member_ids) ? req.body.member_ids : [];
    const memberIds: number[] = Array.from(new Set(raw.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0)));
    if (!memberIds.includes(creatorId)) memberIds.push(creatorId);
    try {
      const group = await db.transaction(async (client) => {
        const g = await client.query(`INSERT INTO chat_groups (name, created_by) VALUES ($1, $2) RETURNING id, name, created_at`, [name, creatorId]);
        const gid = g.rows[0].id;
        for (const uid of memberIds) {
          await client.query(`INSERT INTO chat_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [gid, uid]);
        }
        return g.rows[0];
      });
      broadcast({ type: "GROUP_UPDATED", group_id: group.id });
      res.json(group);
    } catch (e) {
      console.error("create group failed", e);
      res.status(500).json({ error: "Failed to create group" });
    }
  });

  // List a group's members (any member, or an admin).
  app.get("/api/chat-groups/:id/members", authenticate, async (req, res) => {
    const userId = (req as any).user.id;
    const groupId = Number(req.params.id);
    const isAdmin = GROUP_ADMIN_ROLES.includes((req as any).user.role_name);
    const member = await db.get(`SELECT 1 FROM chat_group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);
    if (!member && !isAdmin) return res.status(403).json({ error: "Not a member of this group" });
    const rows = await db.all(`
      SELECT u.id, u.username, r.name AS role_name
      FROM chat_group_members m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE m.group_id = $1
      ORDER BY u.username
    `, [groupId]);
    res.json(rows);
  });

  // Update a group's membership (admin only): reconcile to exactly member_ids.
  // The acting admin is always kept a member to avoid locking themselves out.
  app.put("/api/chat-groups/:id/members", authenticate, authorize(GROUP_ADMIN_ROLES), async (req, res) => {
    const actorId = (req as any).user.id;
    const groupId = Number(req.params.id);
    const group = await db.get(`SELECT id FROM chat_groups WHERE id = $1`, [groupId]);
    if (!group) return res.status(404).json({ error: "Group not found" });
    const raw = Array.isArray(req.body.member_ids) ? req.body.member_ids : [];
    const memberIds: number[] = Array.from(new Set(raw.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0)));
    if (!memberIds.includes(actorId)) memberIds.push(actorId);
    try {
      await db.transaction(async (client) => {
        // Remove anyone no longer selected...
        const placeholders = memberIds.map((_, i) => `$${i + 2}`).join(',');
        await client.query(`DELETE FROM chat_group_members WHERE group_id = $1 AND user_id NOT IN (${placeholders})`, [groupId, ...memberIds]);
        // ...and add the newly selected (existing rows are a no-op).
        for (const uid of memberIds) {
          await client.query(`INSERT INTO chat_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [groupId, uid]);
        }
      });
      broadcast({ type: "GROUP_UPDATED", group_id: groupId });
      res.json({ success: true, count: memberIds.length });
    } catch (e) {
      console.error("update group members failed", e);
      res.status(500).json({ error: "Failed to update members" });
    }
  });

  // Groups the current user is a member of, with a last-message preview.
  app.get("/api/chat-groups", authenticate, async (req, res) => {
    const userId = (req as any).user.id;
    const groups = await db.all(`
      SELECT g.id, g.name, g.created_at,
        lm.last_comment, lm.last_has_image, lm.last_at
      FROM chat_groups g
      JOIN chat_group_members m ON m.group_id = g.id AND m.user_id = $1
      LEFT JOIN LATERAL (
        SELECT comment AS last_comment, (image_url IS NOT NULL) AS last_has_image, created_at AS last_at
        FROM group_messages gm WHERE gm.group_id = g.id ORDER BY created_at DESC, id DESC LIMIT 1
      ) lm ON true
      ORDER BY COALESCE(lm.last_at, g.created_at) DESC
    `, [userId]);
    res.json(groups);
  });

  // Messages in a group (members only).
  app.get("/api/chat-groups/:id/messages", authenticate, async (req, res) => {
    const userId = (req as any).user.id;
    const groupId = req.params.id;
    const member = await db.get(`SELECT 1 FROM chat_group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);
    if (!member) return res.status(403).json({ error: "Not a member of this group" });
    const msgs = await db.all(`
      SELECT gm.id, gm.group_id, gm.sender_id, gm.comment, gm.image_url, gm.image_type, gm.created_at,
        u.username, r.name AS sender_role, gm.reply_to_id,
        ru.username AS reply_username, rm.comment AS reply_comment, (rm.image_url IS NOT NULL) AS reply_has_image,
        (SELECT COUNT(*) FROM message_reactions mr WHERE mr.message_type = 'group' AND mr.message_id = gm.id)::int AS like_count,
        EXISTS (SELECT 1 FROM message_reactions mr WHERE mr.message_type = 'group' AND mr.message_id = gm.id AND mr.user_id = $2) AS liked_by_me,
        (SELECT string_agg(lu.username, ', ' ORDER BY mr.created_at) FROM message_reactions mr JOIN users lu ON lu.id = mr.user_id WHERE mr.message_type = 'group' AND mr.message_id = gm.id) AS liked_by
      FROM group_messages gm
      JOIN users u ON gm.sender_id = u.id
      LEFT JOIN roles r ON u.role_id = r.id
      LEFT JOIN group_messages rm ON gm.reply_to_id = rm.id
      LEFT JOIN users ru ON rm.sender_id = ru.id
      WHERE gm.group_id = $1 ORDER BY gm.created_at ASC
    `, [groupId, userId]);
    res.json(msgs);
  });

  // Post a message to a group (members only). Optional image upload.
  app.post("/api/chat-groups/:id/messages", authenticate, upload.single('image'), shrinkUploads, async (req, res) => {
    const userId = (req as any).user.id;
    const groupId = req.params.id;
    const member = await db.get(`SELECT 1 FROM chat_group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);
    if (!member) return res.status(403).json({ error: "Not a member of this group" });
    const comment = (req.body.comment || '').trim() || null;
    const image_url = req.file ? ((req.file as any).publicUrl || `/uploads/${req.file.filename}`) : null;
    const image_type = req.file ? req.file.mimetype : null;
    if (!comment && !image_url) return res.status(400).json({ error: "Message is empty" });
    // Quoted reply: only honor an id that belongs to this same group.
    let reply_to_id: number | null = req.body.reply_to_id ? Number(req.body.reply_to_id) : null;
    if (reply_to_id) {
      const parent = await db.get(`SELECT id FROM group_messages WHERE id = $1 AND group_id = $2`, [reply_to_id, groupId]);
      if (!parent) reply_to_id = null;
    }
    const ins = await db.query(`
      INSERT INTO group_messages (group_id, sender_id, comment, image_url, image_type, reply_to_id)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, [groupId, userId, comment, image_url, image_type, reply_to_id]);
    res.json({ id: ins.rows[0].id });
    try { broadcast({ type: "GROUP_UPDATED", group_id: Number(groupId) }); } catch (e) { console.error("group broadcast failed", e); }
    try {
      const grp = await db.get(`SELECT name FROM chat_groups WHERE id = $1`, [groupId]) as any;
      const members = await db.all(`SELECT user_id FROM chat_group_members WHERE group_id = $1`, [groupId]);
      await notifyMentions(comment, userId, (req as any).user.username, {
        titleAr: `تم ذكرك في مجموعة ${grp?.name || ''}`, titleEn: `You were mentioned in ${grp?.name || 'a group'}`,
        data: { type: "CHAT_MENTION", group_id: Number(groupId) }, memberIds: members.map((m: any) => m.user_id),
      });
    } catch (e) { console.error("group mention notify failed", e); }
  });

  // Toggle a 👍 like on a message (branch or group). One like per user per message.
  app.post("/api/reactions/toggle", authenticate, async (req, res) => {
    const userId = (req as any).user.id;
    const messageType = req.body.message_type;
    const messageId = Number(req.body.message_id);
    if ((messageType !== 'branch' && messageType !== 'group') || !messageId) {
      return res.status(400).json({ error: "message_type ('branch'|'group') and message_id required" });
    }
    const existing = await db.get(`SELECT 1 FROM message_reactions WHERE message_type = $1 AND message_id = $2 AND user_id = $3`, [messageType, messageId, userId]);
    if (existing) {
      await db.query(`DELETE FROM message_reactions WHERE message_type = $1 AND message_id = $2 AND user_id = $3`, [messageType, messageId, userId]);
    } else {
      await db.query(`INSERT INTO message_reactions (message_type, message_id, user_id, emoji) VALUES ($1, $2, $3, '👍') ON CONFLICT DO NOTHING`, [messageType, messageId, userId]);
      // A 👍 clears the ticket (counts as answered) — so also release any agent's
      // in-progress hold on that message, else the assignment stays stuck.
      if (messageType === 'branch') {
        const rel = await db.query(`UPDATE ticket_assignments SET status = 'released', done_at = CURRENT_TIMESTAMP WHERE ticket_type = 'chat' AND ticket_id = $1 AND status = 'in_progress'`, [messageId]);
        if ((rel.rowCount || 0) > 0) broadcast({ type: "TICKETS_UPDATED" });
      }
    }
    res.json({ liked: !existing });
    // Tell the thread's viewers to refresh so the like count updates live.
    try {
      if (messageType === 'branch') {
        const m = await db.get(`SELECT branch_id FROM branch_messages WHERE id = $1`, [messageId]) as any;
        if (m) broadcast({ type: "BRANCH_CHAT_UPDATED", branch_id: m.branch_id });
      } else {
        const m = await db.get(`SELECT group_id FROM group_messages WHERE id = $1`, [messageId]) as any;
        if (m) broadcast({ type: "GROUP_UPDATED", group_id: m.group_id });
      }
    } catch (e) { console.error("reaction broadcast failed", e); }
  });

  // Per-employee chat reply performance (replies sent + avg reply minutes).
  // Shared filter builder for chat KPI queries (brand/branch + role + user + date).
  const buildChatFilters = (q: any, reqUser: any, msgAlias: string, senderCol: string, dateCol: string) => {
    let { startDate, endDate, brand_id, branch_id, role, user_id, period } = q;
    const managerRoles = ["Manager", "Super Visor", "Operation Manager"];
    if (!managerRoles.includes(reqUser.role_name)) user_id = String(reqUser.id);
    const hasUser = user_id && user_id !== 'all';
    const conds: string[] = [];
    const params: any[] = [];
    if (brand_id) { conds.push(`${msgAlias}.brand_id = $${params.length + 1}`); params.push(brand_id); }
    if (branch_id) { conds.push(`${msgAlias}.branch_id = $${params.length + 1}`); params.push(branch_id); }
    if (role && role !== 'all') { conds.push(`ro.name = $${params.length + 1}`); params.push(role); }
    else if (!hasUser) { conds.push(`ro.name <> 'Restaurants'`); }
    if (hasUser) { conds.push(`${senderCol} = $${params.length + 1}`); params.push(user_id); }
    const d = `(${dateCol} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait')::date`;
    const today = "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date";
    if (startDate) { conds.push(`${d} >= $${params.length + 1}`); params.push(startDate); }
    if (endDate) { conds.push(`${d} <= $${params.length + 1}`); params.push(endDate); }
    if (!startDate && !endDate) {
      if (period === 'today') conds.push(`${d} = ${today}`);
      else if (period === 'week') conds.push(`${d} >= ${today} - INTERVAL '7 days'`);
      else if (period === 'month') conds.push(`${d} >= ${today} - INTERVAL '30 days'`);
    }
    return { conds, params };
  };

  const CHAT_KPI_ROLES = ["Manager", "Super Visor", "Operation Manager", "Technical Back Office", "Call Center", "Complain Team", "Technical Team", "Coding Team", "Marketing Team"];

  app.get("/api/reports/chat-target", authenticate, async (_req, res) => {
    const row = await db.get("SELECT value FROM performance_targets WHERE metric = 'chat_reply_min'") as any;
    res.json({ reply_min: row?.value != null ? Number(row.value) : null });
  });

  app.put("/api/reports/chat-target", authenticate, authorize(["Manager", "Super Visor", "Operation Manager"]), async (req, res) => {
    const { reply_min } = req.body;
    const val = (reply_min === '' || reply_min == null) ? null : Number(reply_min);
    await db.query(`
      INSERT INTO performance_targets (metric, value, updated_by, updated_at)
      VALUES ('chat_reply_min', $1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (metric) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
    `, [val, (req as any).user.id]);
    res.json({ success: true });
  });

  // Definition B: a "reply" is an office message that explicitly replies (reply_to_id)
  // to a restaurant message. Per employee: count, avg/median/max minutes,
  // within-target, and dismissals (handled without replying).
  app.get("/api/reports/chat-performance", authenticate, authorize(CHAT_KPI_ROLES), async (req, res) => {
    const reqUser = (req as any).user;

    const tRow = await db.get("SELECT value FROM performance_targets WHERE metric = 'chat_reply_min'") as any;
    const target = tRow?.value != null ? Number(tRow.value) : null;

    // Replies — a "reply" is the FIRST office message after a restaurant
    // message (matches how the ticket queue clears), credited to that office
    // sender. Counts plain replies too, not just quote-replies; excludes
    // dismissed + liked restaurant messages. buildChatFilters conditions apply
    // to the office message (aliased bm) and its role (ro).
    const rf = buildChatFilters(req.query, reqUser, 'bm', 'bm.sender_id', 'bm.created_at');
    const replyConds = [...rf.conds];
    const replyParams = [...rf.params];
    let withinSelect = `, NULL::int AS within_target`;
    if (target != null) { replyParams.push(target); withinSelect = `, COUNT(*) FILTER (WHERE r.resp_min <= $${replyParams.length})::int AS within_target`; }

    const replyRows = await db.all(`
      WITH office AS (
        SELECT o.id, o.brand_id, o.branch_id, o.sender_id, o.created_at,
          LAG(o.created_at) OVER (PARTITION BY o.branch_id ORDER BY o.created_at) AS prev_office_at
        FROM branch_messages o WHERE o.sender_role <> 'Restaurants'
      ),
      r AS (
        SELECT u.id AS uid, u.username,
          EXTRACT(EPOCH FROM (bm.created_at - rm.created_at)) / 60 AS resp_min
        FROM office bm
        JOIN branch_messages rm ON rm.branch_id = bm.branch_id AND rm.sender_role = 'Restaurants'
          AND rm.resolved_at IS NULL
          AND rm.created_at < bm.created_at
          AND (bm.prev_office_at IS NULL OR rm.created_at > bm.prev_office_at)
          AND NOT EXISTS (SELECT 1 FROM message_reactions mr WHERE mr.message_type = 'branch' AND mr.message_id = rm.id)
        JOIN users u ON bm.sender_id = u.id
        JOIN roles ro ON u.role_id = ro.id
        WHERE ${replyConds.length ? replyConds.join(' AND ') : 'TRUE'}
      )
      SELECT r.uid AS user_id, r.username,
        COUNT(*)::int AS replies,
        ROUND(AVG(r.resp_min))::int AS avg_reply_min,
        ROUND(MAX(r.resp_min))::int AS max_reply_min,
        ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.resp_min))::int AS median_reply_min
        ${withinSelect}
      FROM r GROUP BY r.uid, r.username
    `, replyParams) as any[];

    // Dismissals (handled without replying)
    const df = buildChatFilters(req.query, reqUser, 'bm', 'bm.resolved_by', 'bm.resolved_at');
    const dismissConds = [...df.conds, `bm.resolved_at IS NOT NULL`];
    const dismissRows = await db.all(`
      SELECT u.id AS user_id, u.username, COUNT(*)::int AS dismissals
      FROM branch_messages bm
      JOIN users u ON bm.resolved_by = u.id
      JOIN roles ro ON u.role_id = ro.id
      WHERE ${dismissConds.join(' AND ')}
      GROUP BY u.id, u.username
    `, df.params) as any[];

    const map = new Map<number, any>();
    for (const r of replyRows) map.set(r.user_id, { ...r, dismissals: 0 });
    for (const d of dismissRows) {
      const e = map.get(d.user_id);
      if (e) e.dismissals = d.dismissals;
      else map.set(d.user_id, { user_id: d.user_id, username: d.username, replies: 0, avg_reply_min: null, median_reply_min: null, max_reply_min: null, within_target: null, dismissals: d.dismissals });
    }
    const result = Array.from(map.values()).sort((a, b) => (b.replies - a.replies) || (b.dismissals - a.dismissals));
    res.json(result);
  });

  // Brand-wise variant of chat-performance: same filters (via buildChatFilters),
  // but one row per BRAND with reply metrics + dismissals summed across all
  // office staff. Read-only; groups on the message's brand.
  app.get("/api/reports/chat-performance-by-brand", authenticate, authorize(CHAT_KPI_ROLES), async (req, res) => {
    try {
      const reqUser = (req as any).user;

      const tRow = await db.get("SELECT value FROM performance_targets WHERE metric = 'chat_reply_min'") as any;
      const target = tRow?.value != null ? Number(tRow.value) : null;

      // Replies — first office message after a restaurant message (see the
      // per-user chat-performance for the full rationale), grouped by brand.
      const rf = buildChatFilters(req.query, reqUser, 'bm', 'bm.sender_id', 'bm.created_at');
      const replyConds = [...rf.conds];
      const replyParams = [...rf.params];
      let withinSelect = `, NULL::int AS within_target`;
      if (target != null) { replyParams.push(target); withinSelect = `, COUNT(*) FILTER (WHERE r.resp_min <= $${replyParams.length})::int AS within_target`; }

      const replyRows = await db.all(`
        WITH office AS (
          SELECT o.id, o.brand_id, o.branch_id, o.sender_id, o.created_at,
            LAG(o.created_at) OVER (PARTITION BY o.branch_id ORDER BY o.created_at) AS prev_office_at
          FROM branch_messages o WHERE o.sender_role <> 'Restaurants'
        ),
        r AS (
          SELECT b.name AS brand,
            EXTRACT(EPOCH FROM (bm.created_at - rm.created_at)) / 60 AS resp_min
          FROM office bm
          JOIN branch_messages rm ON rm.branch_id = bm.branch_id AND rm.sender_role = 'Restaurants'
            AND rm.resolved_at IS NULL
            AND rm.created_at < bm.created_at
            AND (bm.prev_office_at IS NULL OR rm.created_at > bm.prev_office_at)
            AND NOT EXISTS (SELECT 1 FROM message_reactions mr WHERE mr.message_type = 'branch' AND mr.message_id = rm.id)
          JOIN users u ON bm.sender_id = u.id
          JOIN roles ro ON u.role_id = ro.id
          JOIN brands b ON bm.brand_id = b.id
          WHERE ${replyConds.length ? replyConds.join(' AND ') : 'TRUE'}
        )
        SELECT r.brand,
          COUNT(*)::int AS replies,
          ROUND(AVG(r.resp_min))::int AS avg_reply_min,
          ROUND(MAX(r.resp_min))::int AS max_reply_min,
          ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.resp_min))::int AS median_reply_min
          ${withinSelect}
        FROM r GROUP BY r.brand
      `, replyParams) as any[];

      // Dismissals (handled without replying)
      const df = buildChatFilters(req.query, reqUser, 'bm', 'bm.resolved_by', 'bm.resolved_at');
      const dismissConds = [...df.conds, `bm.resolved_at IS NOT NULL`];
      const dismissRows = await db.all(`
        SELECT b.name AS brand, COUNT(*)::int AS dismissals
        FROM branch_messages bm
        JOIN users u ON bm.resolved_by = u.id
        JOIN roles ro ON u.role_id = ro.id
        JOIN brands b ON bm.brand_id = b.id
        WHERE ${dismissConds.join(' AND ')}
        GROUP BY b.name
      `, df.params) as any[];

      const map = new Map<string, any>();
      for (const r of replyRows) map.set(r.brand, { ...r, dismissals: 0 });
      for (const d of dismissRows) {
        const e = map.get(d.brand);
        if (e) e.dismissals = d.dismissals;
        else map.set(d.brand, { brand: d.brand, replies: 0, avg_reply_min: null, median_reply_min: null, max_reply_min: null, within_target: null, dismissals: d.dismissals });
      }
      const result = Array.from(map.values()).sort((a, b) => (b.replies - a.replies) || (b.dismissals - a.dismissals));
      res.json(result);
    } catch (error) {
      console.error("Error fetching chat-performance-by-brand:", error);
      res.status(500).json({ error: "Failed to fetch brand chat performance" });
    }
  });

  // Drill-down: every explicit reply (with timestamps + gap) for the filtered scope.
  app.get("/api/reports/chat-reply-log", authenticate, authorize(CHAT_KPI_ROLES), async (req, res) => {
    const reqUser = (req as any).user;
    const f = buildChatFilters(req.query, reqUser, 'bm', 'bm.sender_id', 'bm.created_at');
    const conds = [...f.conds, `bm.sender_role <> 'Restaurants'`, `rm.sender_role = 'Restaurants'`];
    const rows = await db.all(`
      SELECT b.name AS brand_name, br.name AS branch_name,
        ou.username AS original_username, rm.comment AS original_comment, (rm.image_url IS NOT NULL) AS original_has_image, rm.created_at AS original_at,
        u.username AS reply_username, bm.comment AS reply_comment, (bm.image_url IS NOT NULL) AS reply_has_image, bm.created_at AS reply_at,
        ROUND(EXTRACT(EPOCH FROM (bm.created_at - rm.created_at)) / 60)::int AS response_minutes
      FROM branch_messages bm
      JOIN branch_messages rm ON bm.reply_to_id = rm.id
      JOIN users u ON bm.sender_id = u.id
      JOIN roles ro ON u.role_id = ro.id
      JOIN users ou ON rm.sender_id = ou.id
      JOIN brands b ON bm.brand_id = b.id
      JOIN branches br ON bm.branch_id = br.id
      WHERE ${conds.join(' AND ')}
      ORDER BY bm.created_at DESC
      LIMIT 300
    `, f.params) as any[];
    res.json(rows);
  });

  // Drill-down: the restaurant messages an employee dismissed (handled w/o reply).
  app.get("/api/reports/chat-dismiss-log", authenticate, authorize(CHAT_KPI_ROLES), async (req, res) => {
    const reqUser = (req as any).user;
    const f = buildChatFilters(req.query, reqUser, 'bm', 'bm.resolved_by', 'bm.resolved_at');
    const conds = [...f.conds, `bm.resolved_at IS NOT NULL`, `bm.sender_role = 'Restaurants'`];
    const rows = await db.all(`
      SELECT b.name AS brand_name, br.name AS branch_name,
        ou.username AS sender_username, bm.comment, (bm.image_url IS NOT NULL) AS has_image, bm.created_at AS sent_at,
        bm.resolved_at, bm.resolve_reason, reu.username AS resolved_by_name
      FROM branch_messages bm
      JOIN users reu ON bm.resolved_by = reu.id
      JOIN roles ro ON reu.role_id = ro.id
      JOIN users ou ON bm.sender_id = ou.id
      JOIN brands b ON bm.brand_id = b.id
      JOIN branches br ON bm.branch_id = br.id
      WHERE ${conds.join(' AND ')}
      ORDER BY bm.resolved_at DESC
      LIMIT 300
    `, f.params) as any[];
    res.json(rows);
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
  app.use("/uploads", authenticate, express.static(uploadDir, {
    setHeaders: (res) => {
      // Auth-gated + immutable (unique filenames) → cache privately in the
      // browser for 30 days so images aren't re-downloaded on every revisit.
      res.setHeader("Cache-Control", "private, max-age=2592000, immutable");
    },
  }));
  
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
