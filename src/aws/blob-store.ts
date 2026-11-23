// Where the SQLite files live: an S3 bucket, written with optimistic concurrency (S3 conditional
// writes). The interface is small so the store's logic can be tested against MemoryBlobStore.
import {
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

export type GetResult =
  | { status: "ok"; body: Uint8Array; etag: string }
  | { status: "not-modified" }
  | { status: "missing" };

/** Another writer got there first: the object's ETag is no longer the one this write was based on. */
export class WriteConflict extends Error {
  constructor(key: string) {
    super(`conditional write to ${key} lost: the object changed since it was read`);
    this.name = "WriteConflict";
  }
}

export interface BlobStore {
  /** `ifNoneMatch` is the ETag we already hold; a match returns not-modified without a body. */
  get(key: string, ifNoneMatch?: string): Promise<GetResult>;
  /**
   * `ifMatch`: write only if the object still has this ETag. `null`: write only if the object does
   * not exist yet. Throws WriteConflict otherwise. Returns the new ETag.
   */
  put(key: string, body: Uint8Array, ifMatch: string | null): Promise<string>;
  copy(fromKey: string, toKey: string): Promise<void>;
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof S3ServiceException) return err.$metadata.httpStatusCode;
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

export class S3BlobStore implements BlobStore {
  constructor(
    private readonly bucket: string,
    private readonly s3 = new S3Client({}),
  ) {}

  async get(key: string, ifNoneMatch?: string): Promise<GetResult> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, IfNoneMatch: ifNoneMatch }));
      const body = await res.Body!.transformToByteArray();
      return { status: "ok", body, etag: res.ETag! };
    } catch (err) {
      const status = statusOf(err);
      if (status === 304) return { status: "not-modified" };
      if (status === 404) return { status: "missing" };
      throw err;
    }
  }

  async put(key: string, body: Uint8Array, ifMatch: string | null): Promise<string> {
    try {
      const res = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: "application/vnd.sqlite3",
          ...(ifMatch === null ? { IfNoneMatch: "*" } : { IfMatch: ifMatch }),
        }),
      );
      return res.ETag!;
    } catch (err) {
      // 412: precondition failed. 409: a concurrent conditional write to the same key is in flight.
      const status = statusOf(err);
      if (status === 412 || status === 409) throw new WriteConflict(key);
      throw err;
    }
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: toKey, CopySource: `${this.bucket}/${fromKey}` }));
  }
}

/** In-memory BlobStore with the same conditional-write semantics, for tests. */
export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { body: Uint8Array; etag: string }>();
  private seq = 0;
  puts = 0;

  async get(key: string, ifNoneMatch?: string): Promise<GetResult> {
    const o = this.objects.get(key);
    if (!o) return { status: "missing" };
    if (ifNoneMatch && ifNoneMatch === o.etag) return { status: "not-modified" };
    return { status: "ok", body: new Uint8Array(o.body), etag: o.etag };
  }

  async put(key: string, body: Uint8Array, ifMatch: string | null): Promise<string> {
    const o = this.objects.get(key);
    if (ifMatch === null ? o !== undefined : o?.etag !== ifMatch) throw new WriteConflict(key);
    const etag = `"m${++this.seq}"`;
    this.objects.set(key, { body: new Uint8Array(body), etag });
    this.puts += 1;
    return etag;
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    const o = this.objects.get(fromKey);
    if (!o) throw new Error(`no such key ${fromKey}`);
    this.objects.set(toKey, { body: new Uint8Array(o.body), etag: `"m${++this.seq}"` });
  }
}
