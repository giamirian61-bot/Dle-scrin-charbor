import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutBucketCorsCommand
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
