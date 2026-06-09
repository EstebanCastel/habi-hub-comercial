import { BigQuery } from '@google-cloud/bigquery';

const DEFAULT_PROJECT = process.env.BQ_PROJECT || 'papyrus-data';

// In-memory cache: Map<md5Hash, {data, expiry}>
const cache = new Map<string, { data: Record<string, unknown>[]; expiry: number }>();
const CACHE_TTL = 7200 * 1000; // 2 hours in ms
const CACHE_MAX = 500;

let client: InstanceType<typeof BigQuery> | null = null;

function getClient(): InstanceType<typeof BigQuery> {
  if (!client) {
    const raw = process.env.GOOGLE_CREDENTIALS;
    if (raw) {
      const creds = JSON.parse(raw);
      if (creds.type === 'authorized_user') {
        // OAuth2 user credentials (ADC style)
        // BigQuery client accepts these via the credentials option
        client = new BigQuery({
          projectId: DEFAULT_PROJECT,
          credentials: {
            client_email: creds.account || '',
            private_key: '',
          },
          // For authorized_user, we pass the full credential as-is
          // The BigQuery client will use the refresh token
        });
        // Actually, for authorized_user we need to use a different approach
        // Write to a temp file and use GOOGLE_APPLICATION_CREDENTIALS
        const fs = require('fs');
        const path = require('path');
        const tmpFile = path.join(process.env.TMPDIR || '/tmp', 'gcp-creds.json');
        fs.writeFileSync(tmpFile, raw);
        process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpFile;
        client = new BigQuery({ projectId: DEFAULT_PROJECT });
      } else {
        // Service account credentials
        client = new BigQuery({ projectId: DEFAULT_PROJECT, credentials: creds });
      }
    } else {
      // Fall back to ADC (local dev with gcloud auth)
      client = new BigQuery({ projectId: DEFAULT_PROJECT });
    }
  }
  return client;
}

function hashKey(sql: string): string {
  // Simple hash for cache key
  let hash = 0;
  for (let i = 0; i < sql.length; i++) {
    const char = sql.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

export async function query(sql: string, useCache = true): Promise<Record<string, unknown>[]> {
  const key = hashKey(sql);
  
  if (useCache) {
    const cached = cache.get(key);
    if (cached && cached.expiry > Date.now()) {
      return cached.data;
    }
  }

  const bq = getClient();
  const [job] = await bq.createQueryJob({ query: sql });
  const [rows] = await job.getQueryResults();
  
  // Convert dates to ISO strings for JSON serialization
  const data = rows.map((row: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v && typeof v === 'object' && 'value' in (v as Record<string,unknown>) && typeof (v as Record<string,unknown>).value === 'string') {
        out[k] = (v as Record<string,unknown>).value;
      } else if (v instanceof Date) {
        out[k] = v.toISOString();
      } else if (v && typeof v === 'object' && typeof (v as {toISOString?:()=>string}).toISOString === 'function') {
        out[k] = (v as {toISOString:()=>string}).toISOString();
      } else {
        out[k] = v;
      }
    }
    return out;
  });

  if (useCache) {
    if (cache.size >= CACHE_MAX) {
      // Evict oldest entries
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
    cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
  }
  
  return data;
}

export function cacheClear(): number {
  const n = cache.size;
  cache.clear();
  return n;
}
