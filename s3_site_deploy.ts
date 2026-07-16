/**
 * Swamp extension model for deploying a static site to AWS S3.
 *
 * Walks the repository root, uploads changed/new files to S3, and deletes
 * any stale S3 objects not present in the current deployment. Unchanged files
 * are skipped via MD5/ETag comparison.
 *
 * Paths starting with `.` or `_` are always excluded. Swamp-managed directories
 * (`extensions`, `models`, `workflows`, `vaults`) are always excluded. Pass
 * additional top-level paths via the `skipPaths` global argument.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@3.600.0";
import { contentType } from "jsr:@std/media-types@1";
import { crypto as stdCrypto } from "jsr:@std/crypto@1";

const GlobalArgsSchema = z.object({
  bucket: z.string().describe("S3 bucket name to deploy to"),
  region: z.string().default("us-east-1").describe(
    "AWS region for the S3 bucket",
  ),
  accessKeyId: z.string().meta({ sensitive: true }).default("").describe(
    "AWS access key ID — use a vault expression, e.g. ${{ vault.get(my-vault, AWS_ACCESS_KEY_ID) }}",
  ),
  secretAccessKey: z.string().meta({ sensitive: true }).default("").describe(
    "AWS secret access key — use a vault expression, e.g. ${{ vault.get(my-vault, AWS_SECRET_ACCESS_KEY) }}",
  ),
  skipPaths: z.array(z.string()).default([]).describe(
    "Additional top-level paths to exclude from deployment (e.g. ['CLAUDE.md', 'Makefile', 'docs']). Paths starting with '.' or '_' are always skipped.",
  ),
});

const DeploymentSchema = z.object({
  filesUploaded: z.number(),
  filesSkipped: z.number(),
  deletedFiles: z.number(),
  deployedAt: z.string(),
  bucket: z.string(),
});

// Swamp-managed directories that are never part of a site deployment
const BUILTIN_SKIP_PATHS = new Set([
  "extensions",
  "models",
  "workflows",
  "vaults",
  "manifest.yaml",
]);

function shouldSkip(
  relativePath: string,
  extraSkipPaths: Set<string>,
): boolean {
  const parts = relativePath.split("/");
  for (const part of parts) {
    if (part.startsWith(".") || part.startsWith("_")) return true;
  }
  return BUILTIN_SKIP_PATHS.has(parts[0]) || extraSkipPaths.has(parts[0]);
}

async function* walkFiles(
  baseDir: string,
  extraSkipPaths: Set<string>,
  currentDir: string = baseDir,
): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(currentDir)) {
    const fullPath = `${currentDir}/${entry.name}`;
    const relativePath = fullPath.slice(baseDir.length + 1);
    if (shouldSkip(relativePath, extraSkipPaths)) continue;
    if (entry.isDirectory) {
      yield* walkFiles(baseDir, extraSkipPaths, fullPath);
    } else if (entry.isFile) {
      yield relativePath;
    }
  }
}

async function md5Hex(data: Uint8Array): Promise<string> {
  const buf = await stdCrypto.subtle.digest("MD5", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Swamp model definition for S3 static site deployment. */
export const model = {
  type: "@mgreten/aws/s3-site-deploy",
  version: "2026.07.16.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    deployment: {
      description: "Deployment result metadata",
      schema: DeploymentSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    deploy: {
      description:
        "Upload changed/new site files to S3 and remove stale objects from the bucket",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          repoDir: string;
          writeResource: (
            specName: string,
            instanceName: string,
            data: unknown,
          ) => Promise<unknown>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            debug: (msg: string, props?: Record<string, unknown>) => void;
            warning: (msg: string, props?: Record<string, unknown>) => void;
            error: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { bucket, region, accessKeyId, secretAccessKey, skipPaths } =
          context.globalArgs;
        const repoDir = context.repoDir;
        const extraSkipPaths = new Set(skipPaths);

        context.logger.info("Starting deploy to {bucket} in {region}", {
          bucket,
          region,
        });

        const credentials = accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined;

        const s3 = new S3Client({ region, credentials });

        // 1. List all current S3 objects and their ETags upfront
        const remoteObjects = new Map<string, string>(); // key -> md5 etag
        let continuationToken: string | undefined;
        do {
          const listResult = await s3.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              ContinuationToken: continuationToken,
            }),
          );
          for (const obj of listResult.Contents ?? []) {
            if (obj.Key && obj.ETag) {
              remoteObjects.set(obj.Key, obj.ETag.replace(/"/g, ""));
            }
          }
          continuationToken = listResult.IsTruncated
            ? listResult.NextContinuationToken
            : undefined;
        } while (continuationToken);

        context.logger.info("Found {count} existing objects in {bucket}", {
          count: remoteObjects.size,
          bucket,
        });

        // 2. Walk local files, upload only changed or new files
        const localKeys = new Set<string>();
        let filesUploaded = 0;
        let filesSkipped = 0;

        for await (const relativePath of walkFiles(repoDir, extraSkipPaths)) {
          const key = relativePath;
          const fullPath = `${repoDir}/${relativePath}`;
          localKeys.add(key);

          const fileContent = await Deno.readFile(fullPath);
          const localMd5 = await md5Hex(fileContent);
          const remoteMd5 = remoteObjects.get(key);

          if (remoteMd5 === localMd5) {
            context.logger.debug("Skipping unchanged {key}", { key });
            filesSkipped++;
            continue;
          }

          const mimeType = contentType(relativePath) ??
            "application/octet-stream";
          const cacheControl = relativePath.endsWith(".html")
            ? "no-cache"
            : "public, max-age=86400";

          context.logger.debug(
            remoteMd5 ? "Updating {key}" : "Uploading {key}",
            { key, contentType },
          );

          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: fileContent,
              ContentType: mimeType,
              CacheControl: cacheControl,
            }),
          );

          filesUploaded++;
        }

        context.logger.info(
          "Uploaded {filesUploaded} files, skipped {filesSkipped} unchanged",
          { filesUploaded, filesSkipped },
        );

        // 3. Delete stale S3 objects not in local set
        const staleKeys = [...remoteObjects.keys()].filter(
          (key) => !localKeys.has(key),
        );

        if (staleKeys.length > 0) {
          context.logger.info(
            "Deleting {count} stale objects from {bucket}",
            { count: staleKeys.length, bucket },
          );
          const chunkSize = 1000;
          for (let i = 0; i < staleKeys.length; i += chunkSize) {
            const chunk = staleKeys.slice(i, i + chunkSize);
            await s3.send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: {
                  Objects: chunk.map((Key) => ({ Key })),
                  Quiet: true,
                },
              }),
            );
          }
        }

        const deletedFiles = staleKeys.length;
        const deployedAt = new Date().toISOString();

        context.logger.info(
          "Deploy complete: {filesUploaded} uploaded, {filesSkipped} unchanged, {deletedFiles} deleted",
          { filesUploaded, filesSkipped, deletedFiles, bucket, deployedAt },
        );

        const handle = await context.writeResource("deployment", "current", {
          filesUploaded,
          filesSkipped,
          deletedFiles,
          deployedAt,
          bucket,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
