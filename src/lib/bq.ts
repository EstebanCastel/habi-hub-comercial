import { BigQuery } from '@google-cloud/bigquery';

const DEFAULT_PROJECT = process.env.BQ_PROJECT || 'papyrus-data';

// In-memory cache: Map<md5Hash, {data, expiry}>
const cache = new Map<string, { data: Record<string, unknown>[]; expiry: number }>();
const CACHE_TTL = 7200 * 1000; // 2 hours in ms
const CACHE_MAX = 500;

let client: InstanceType<typeof BigQuery> | null = null;

function getClient(): InstanceType<typeof BigQuery> {
  if (!client) {
    // Support GOOGLE_APPLICATION_CREDENTIALS env var (file path)
    // or GOOGLE_CREDENTIALS env var (JSON string, for Vercel)
    const credentials = process.env.GOOGLE_CREDENTIALS
      ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
      : undefined;
    client = new BigQuery({ projectId: DEFAULT_PROJECT, credentials });
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
