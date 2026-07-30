import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStore, PutObjectOptions } from './object-store.js';

/**
 * The production {@link ObjectStore}: Cloudflare R2 over its S3-compatible API.
 *
 * R2 is not provisioned yet — the brief's "R2 already provisioned" was corrected to Open
 * Item 10, a setup task. This code is therefore complete and typed but is only wired in
 * when the R2 environment is present (see the engine entrypoint); with no R2 config the
 * engine boots with the media pipeline disabled rather than failing on an absent bucket.
 *
 * Uploads go through `@aws-sdk/lib-storage`'s `Upload`, which performs a MULTIPART upload
 * for anything past one part and streams each part as it is read. A full object is never
 * held in memory — the property acceptance criterion 2 asserts (50 MB in, < 20 MB RSS
 * growth). `region: 'auto'` and path-style addressing are R2's requirements, not S3's.
 */
export interface R2Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Part size for multipart uploads. R2's minimum is 5 MiB; default matches. */
  readonly partSizeBytes?: number | undefined;
}

const MIN_PART_SIZE = 5 * 1024 * 1024;

export function createR2ObjectStore(config: R2Config): ObjectStore {
  const clientConfig: S3ClientConfig = {
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // R2 serves buckets as a path segment on the account endpoint, not as a virtual host.
    forcePathStyle: true,
  };
  const client = new S3Client(clientConfig);
  const partSize = Math.max(config.partSizeBytes ?? MIN_PART_SIZE, MIN_PART_SIZE);

  return {
    async put(key: string, body: Readable, options?: PutObjectOptions): Promise<void> {
      const upload = new Upload({
        client,
        params: {
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ...(options?.contentType !== undefined ? { ContentType: options.contentType } : {}),
          ...(options?.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
        },
        partSize,
        queueSize: 4,
        // On any failure, abort the multipart upload so R2 does not retain orphaned parts
        // that would otherwise accrue storage cost with no completed object.
        leavePartsOnError: false,
      });
      await upload.done();
    },

    presignGet(key: string, ttlSeconds: number): Promise<string> {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn: ttlSeconds,
      });
    },

    async delete(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
