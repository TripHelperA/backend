const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({ region: process.env.AWS_REGION });


exports.handler = async (event) => {
  console.log("Event:", JSON.stringify(event, null, 2));

  const { type, id, mode } = event.arguments || {};
  const bucket = process.env.IMAGES_BUCKET;

  if (!bucket) throw new Error("IMAGES_BUCKET env var not set");
  if (!type || !id || !mode) throw new Error("Missing required arguments: type, id, mode");

  // always enforce .jpg
  let key;
  if (type === "user") {
    key = `users/${id}/profile.jpg`;
  } else if (type === "route") {
    key = `routes/${id}/cover.jpg`;
  } else {
    throw new Error("Invalid type. Must be 'user' or 'route'");
  }

  let url;
  if (mode === "upload") {
  url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: "image/jpeg",
  }), { expiresIn: 300 });
} else if (mode === "download") {
  url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentType: "image/jpeg",
  }), { expiresIn: 300 });
}
 else {
    throw new Error("Invalid mode. Must be 'upload' or 'download'");
  }

  return { url, key };
};
