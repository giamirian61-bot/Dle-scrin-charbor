import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutBucketCorsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

const BUCKET = process.env.BUCKET || "";
const ENDPOINT = process.env.BUCKET_ENDPOINT || "";
const REGION = process.env.BUCKET_REGION || "auto";
const ACCESS_KEY_ID = process.env.BUCKET_ACCESS_KEY_ID || "";
const SECRET_ACCESS_KEY = process.env.BUCKET_SECRET_ACCESS_KEY || "";

const configured = Boolean(
  BUCKET && ENDPOINT && ACCESS_KEY_ID && SECRET_ACCESS_KEY
);

const s3 = configured
  ? new S3Client({
      region: REGION || "auto",
      endpoint: ENDPOINT,
      credentials: {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY
      }
    })
  : null;

export function bucketConfigured() {
  return configured;
}

function requireBucket() {
  if (!configured || !s3) throw new Error("bucket_not_configured");
}

export async function ensureBucketCors(origin) {
  requireBucket();
  await s3.send(new PutBucketCorsCommand({
    Bucket: BUCKET,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: [origin],
        AllowedMethods: ["POST","PUT","GET","HEAD"],
        AllowedHeaders: ["*"],
        ExposeHeaders: ["ETag"],
        MaxAgeSeconds: 3000
      }]
    }
  }));
  return true;
}

export async function createVideoUploadPost({ key, contentType, maxBytes }) {
  requireBucket();
  const safeType = String(contentType || "video/mp4").startsWith("video/")
    ? String(contentType)
    : "video/mp4";

  return createPresignedPost(s3, {
    Bucket: BUCKET,
    Key: key,
    Expires: 3600,
    Fields: {
      "Content-Type": safeType
    },
    Conditions: [
      ["content-length-range", 1, Number(maxBytes)],
      ["starts-with", "$Content-Type", "video/"]
    ]
  });
}

export async function createBucketReadUrl(key, expiresIn=3600) {
  requireBucket();
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn }
  );
}

export async function headBucketObject(key) {
  requireBucket();
  const out = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  return {
    size: Number(out.ContentLength || 0),
    contentType: out.ContentType || null,
    etag: out.ETag || null,
    lastModified: out.LastModified ? out.LastModified.toISOString() : null
  };
}

export async function deleteBucketObject(key) {
  requireBucket();
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  return true;
}


export async function startMultipartUpload({ key, contentType }) {
  requireBucket();
  const out = await s3.send(new CreateMultipartUploadCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: String(contentType || "video/mp4")
  }));
  if (!out.UploadId) throw new Error("multipart_upload_id_missing");
  return { uploadId: out.UploadId };
}

export async function createMultipartPartUrl({ key, uploadId, partNumber, expiresIn=3600 }) {
  requireBucket();
  if (!uploadId) throw new Error("multipart_upload_id_missing");
  const n = Number(partNumber);
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error("invalid_part_number");
  return getSignedUrl(
    s3,
    new UploadPartCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      PartNumber: n
    }),
    { expiresIn }
  );
}

export async function uploadMultipartPart({ key, uploadId, partNumber, body }) {
  requireBucket();
  if (!uploadId) throw new Error("multipart_upload_id_missing");
  const n = Number(partNumber);
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error("invalid_part_number");
  if (!body || !body.length) throw new Error("empty_multipart_part");
  const out = await s3.send(new UploadPartCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: n,
    Body: body
  }));
  if (!out.ETag) throw new Error("multipart_etag_missing");
  return { ETag: out.ETag, PartNumber: n };
}

export async function listMultipartParts({ key, uploadId }) {
  requireBucket();
  if (!uploadId) throw new Error("multipart_upload_id_missing");
  const out = await s3.send(new ListPartsCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    MaxParts: 1000
  }));
  const parts = Array.isArray(out.Parts) ? out.Parts : [];
  return {
    parts:parts.map(p => ({
      partNumber:Number(p.PartNumber || 0),
      size:Number(p.Size || 0),
      etag:p.ETag || null,
      lastModified:p.LastModified ? p.LastModified.toISOString() : null
    })),
    isTruncated:Boolean(out.IsTruncated)
  };
}

export async function completeMultipartUpload({ key, uploadId, parts }) {
  requireBucket();
  const normalized = (parts || []).map(p => ({
    PartNumber: Number(p.PartNumber),
    ETag: String(p.ETag || "")
  })).sort((a,b) => a.PartNumber - b.PartNumber);

  if (!normalized.length || normalized.some(p => !Number.isInteger(p.PartNumber) || p.PartNumber < 1 || !p.ETag)) {
    throw new Error("invalid_multipart_parts");
  }

  return s3.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: normalized }
  }));
}

export async function abortMultipartUpload({ key, uploadId }) {
  requireBucket();
  if (!uploadId) return false;
  await s3.send(new AbortMultipartUploadCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId
  }));
  return true;
}
