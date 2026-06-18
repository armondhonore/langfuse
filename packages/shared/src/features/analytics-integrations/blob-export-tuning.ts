// Per-project blob-export tuning, persisted as a nullable JSON column
// (`BlobStorageIntegration.exportTuning`) and set via the DB directly for now
// (no UI/tRPC write path yet). Validated and resolved at job time.
//
// This is a client-safe file (no logger / server imports) so a future settings
// UI can reuse the schema for write-validation. The read-side resolver does NOT
// log — it returns a `warnings` array so the (server-side) caller can log
// without pulling a server logger into this module.
//
// Several overlapping feature sets share this module — extend, don't fork:
//   - LFE-10402: `rawPassthrough` (stream ClickHouse JSONEachRow bytes straight
//     to gzip → upload) and `gzipLevel` (zlib deflate level for compressed
//     exports).
//   - LFE-10394: upload tuning (`partSizeBytes` / `maxConcurrentParts` /
//     `maxPartAttempts`) + `skipEnrichment`.
// Unknown keys are stripped (zod default) so a key written by a newer writer is
// harmless to an older worker.

import { z } from "zod";

// Minimum ClickHouse version for safe raw passthrough. The passthrough relies on
// ClickHouse's mid-stream exception tagging (the `x-clickhouse-exception-tag`
// response header + end-of-stream marker) so the client errors the stream when a
// query fails after a 200 response. That mechanism only exists in ClickHouse
// >= 25.11. On older servers a query that fails mid-stream is NOT detected and
// the passthrough can silently upload a truncated/garbage object — so operators
// MUST NOT enable `rawPassthrough` on self-hosted ClickHouse below this version.
// Langfuse Cloud runs a newer ClickHouse, so this only affects self-hosters.
export const RAW_PASSTHROUGH_MIN_CLICKHOUSE_VERSION = "25.11";

// Bounds applied by the resolver (clamp) and the write schema (reject).
//
// NOTE on the original ranges — keep visible for orientation and future revert:
//   - maxConcurrentParts: env `LANGFUSE_S3_UPLOAD_MAX_CONCURRENT_PARTS` is 1–10
//     (default 3). Deliberately WIDENED to 1–32 here for per-project
//     experimentation. Restore `max: 10` to return to env parity.
//   - maxPartAttempts: env `LANGFUSE_S3_UPLOAD_MAX_PART_ATTEMPTS` is 1–10
//     (default 3). UNCHANGED.
//   - partSizeBytes: previously hardcoded to 100 MiB. S3 multipart limits are a
//     5 MiB minimum and 5 GiB maximum per part; we allow that full range.
export const BLOB_EXPORT_TUNING_BOUNDS = {
  partSizeBytes: { min: 5 * 1024 * 1024, max: 5 * 1024 * 1024 * 1024 },
  maxConcurrentParts: { min: 1, max: 32 },
  maxPartAttempts: { min: 1, max: 10 },
} as const;

// Default part size when the column does not specify one. Matches the value
// that was previously hardcoded in handleBlobStorageIntegrationProjectJob.ts.
export const DEFAULT_BLOB_EXPORT_PART_SIZE_BYTES = 100 * 1024 * 1024; // 100 MiB

export const BlobExportTuningSchema = z.object({
  // LFE-10402 raw-passthrough export path: stream ClickHouse JSONEachRow row text
  // straight to gzip → upload, skipping the per-row JS parse/enrich/serialize
  // pipeline. Only honored for JSONL exports of the observations / events
  // tables; ignored (with a warning) otherwise. Drops the model price columns.
  //
  // EXPERIMENTAL + self-hosting caveat: requires ClickHouse
  // >= RAW_PASSTHROUGH_MIN_CLICKHOUSE_VERSION (see above) for mid-stream failure
  // detection. Do not enable on older self-hosted ClickHouse.
  rawPassthrough: z.boolean().optional(),
  // LFE-10402 gzip tuning: zlib deflate level for compressed exports. Lower
  // levels trade output size for markedly less worker CPU. Only honored when the
  // integration has compression enabled. zlib accepts 0 (store) through 9 (max);
  // absent / out-of-range falls back to the zlib default (6).
  gzipLevel: z.number().int().min(0).max(9).optional(),
  // LFE-10394 upload tuning. Out-of-range values are REJECTED here (write path)
  // but CLAMPED by the read-side resolver.
  partSizeBytes: z
    .number()
    .int()
    .min(BLOB_EXPORT_TUNING_BOUNDS.partSizeBytes.min)
    .max(BLOB_EXPORT_TUNING_BOUNDS.partSizeBytes.max)
    .optional(),
  maxConcurrentParts: z
    .number()
    .int()
    .min(BLOB_EXPORT_TUNING_BOUNDS.maxConcurrentParts.min)
    .max(BLOB_EXPORT_TUNING_BOUNDS.maxConcurrentParts.max)
    .optional(),
  maxPartAttempts: z
    .number()
    .int()
    .min(BLOB_EXPORT_TUNING_BOUNDS.maxPartAttempts.min)
    .max(BLOB_EXPORT_TUNING_BOUNDS.maxPartAttempts.max)
    .optional(),
  skipEnrichment: z.boolean().optional(),
});

export type BlobExportTuning = z.infer<typeof BlobExportTuningSchema>;

// Env/default values the resolver falls back to when a numeric upload knob is
// absent or invalid.
export interface BlobExportTuningDefaults {
  partSizeBytes: number;
  maxConcurrentParts: number;
  maxPartAttempts: number;
}

export type ResolvedBlobExportTuning = {
  rawPassthrough: boolean;
  // undefined => use the zlib default (6); a concrete 0-9 otherwise.
  gzipLevel: number | undefined;
  partSizeBytes: number;
  maxConcurrentParts: number;
  maxPartAttempts: number;
  skipEnrichment: boolean;
};

export interface ResolveBlobExportTuningResult {
  resolved: ResolvedBlobExportTuning;
  warnings: string[];
}

type Bound = { min: number; max: number };

function resolveNumber(
  field: string,
  value: unknown,
  bound: Bound,
  fallback: number,
  warnings: string[],
): number {
  if (value === undefined) return fallback; // absent → default, silent
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(
      `${field}: expected a finite number, got ${JSON.stringify(value)}; using default ${fallback}`,
    );
    return fallback;
  }
  // Separate the two corrections so the warning text is accurate: a non-integer
  // within bounds was rounded (not out of range), while a value outside the
  // bounds was clamped. Reporting both as "out of range" would mislead an
  // operator reading the log into thinking an in-range float was rejected.
  const rounded = Math.round(value);
  const clamped = Math.min(bound.max, Math.max(bound.min, rounded));
  if (rounded !== value) {
    warnings.push(
      `${field}: ${value} is not an integer; rounded to ${rounded}`,
    );
  }
  if (clamped !== rounded) {
    warnings.push(
      `${field}: ${rounded} out of range [${bound.min}, ${bound.max}]; clamped to ${clamped}`,
    );
  }
  return clamped;
}

function resolveBoolean(
  field: string,
  value: unknown,
  warnings: string[],
): boolean {
  if (value === undefined) return false; // absent → false, silent
  if (typeof value !== "boolean") {
    warnings.push(
      `${field}: expected a boolean, got ${JSON.stringify(value)}; using default false`,
    );
    return false;
  }
  return value;
}

// gzipLevel uses clamp-to-DEFAULT (not clamp-to-bound): an out-of-range level is
// dropped so the zlib default (6) applies, rather than silently snapping to 0/9.
function resolveGzipLevel(
  value: unknown,
  warnings: string[],
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 9
  ) {
    return value;
  }
  warnings.push(
    `gzipLevel: ${JSON.stringify(value)} out of range (expected integer 0-9); using zlib default`,
  );
  return undefined;
}

/**
 * Read-side resolver for the `exportTuning` JSON column. Never throws.
 *
 * Semantics (LFE-10394 grilling + LFE-10402 rawPassthrough/gzipLevel):
 *   - null / undefined / non-object   → all defaults (non-object is warned).
 *   - upload knob numeric out of range → CLAMPED to the bound (warned).
 *   - gzipLevel out of range           → dropped → zlib default (warned).
 *   - field of the wrong type / NaN    → default (warned).
 *   - absent field                     → default (silent).
 *
 * The caller is expected to log each returned warning.
 */
export function resolveBlobExportTuning(
  raw: unknown,
  defaults: BlobExportTuningDefaults,
): ResolveBlobExportTuningResult {
  const warnings: string[] = [];

  const fallback: ResolvedBlobExportTuning = {
    rawPassthrough: false,
    gzipLevel: undefined,
    partSizeBytes: defaults.partSizeBytes,
    maxConcurrentParts: defaults.maxConcurrentParts,
    maxPartAttempts: defaults.maxPartAttempts,
    skipEnrichment: false,
  };

  if (raw === null || raw === undefined) {
    return { resolved: fallback, warnings };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(
      `exportTuning: expected an object, got ${JSON.stringify(raw)}; using defaults`,
    );
    return { resolved: fallback, warnings };
  }

  const obj = raw as Record<string, unknown>;

  return {
    resolved: {
      rawPassthrough: resolveBoolean(
        "rawPassthrough",
        obj.rawPassthrough,
        warnings,
      ),
      gzipLevel: resolveGzipLevel(obj.gzipLevel, warnings),
      partSizeBytes: resolveNumber(
        "partSizeBytes",
        obj.partSizeBytes,
        BLOB_EXPORT_TUNING_BOUNDS.partSizeBytes,
        defaults.partSizeBytes,
        warnings,
      ),
      maxConcurrentParts: resolveNumber(
        "maxConcurrentParts",
        obj.maxConcurrentParts,
        BLOB_EXPORT_TUNING_BOUNDS.maxConcurrentParts,
        defaults.maxConcurrentParts,
        warnings,
      ),
      maxPartAttempts: resolveNumber(
        "maxPartAttempts",
        obj.maxPartAttempts,
        BLOB_EXPORT_TUNING_BOUNDS.maxPartAttempts,
        defaults.maxPartAttempts,
        warnings,
      ),
      skipEnrichment: resolveBoolean(
        "skipEnrichment",
        obj.skipEnrichment,
        warnings,
      ),
    },
    warnings,
  };
}
