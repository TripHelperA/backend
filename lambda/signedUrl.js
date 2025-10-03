const AWS = require("aws-sdk");

const s3 = new AWS.S3();

exports.handler = async (event) => {
  console.log("Event:", JSON.stringify(event, null, 2));

  const { type, id, mode } = event.arguments || {};
  const bucket = process.env.IMAGES_BUCKET;

  if (!bucket) {
    throw new Error("IMAGES_BUCKET env var not set");
  }
  if (!type || !id || !mode) {
    throw new Error("Missing required arguments: type, id, mode");
  }

  // decide key based on type
  let key;
  if (type === "user") {
    key = `users/${id}/profile.jpg`;
  } else if (type === "route") {
    key = `routes/${id}/cover.jpg`;
  } else {
    throw new Error("Invalid type. Must be 'user' or 'route'");
  }

  // generate signed URL
  let url;
  if (mode === "upload") {
    url = await s3.getSignedUrlPromise("putObject", {
      Bucket: bucket,
      Key: key,
      Expires: 300,
      ContentType: "image/jpeg", 
    });
  } else if (mode === "download") {
    url = await s3.getSignedUrlPromise("getObject", {
      Bucket: bucket,
      Key: key,
      Expires: 300,
    });
  } else {
    throw new Error("Invalid mode. Must be 'upload' or 'download'");
  }

  return { url, key };
};
