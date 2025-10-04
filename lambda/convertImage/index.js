const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const sharp = require("sharp");
const s3 = new S3Client();

exports.handler = async (event) => {
  console.log("Event:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key);

    // only process .png files
    if (!key.endsWith(".png") && !key.endsWith(".tmp.png")) continue;

    const targetKey = key.replace(/\.tmp\.png$|\.png$/, ".jpg");

    try {
      const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const imageBuffer = await streamToBuffer(Body);

      const converted = await sharp(imageBuffer).jpeg({ quality: 90 }).toBuffer();

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: targetKey,
          Body: converted,
          ContentType: "image/jpeg",
        })
      );

      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
      console.log(`✅ Converted ${key} → ${targetKey}`);
    } catch (err) {
      console.error(`❌ Failed to convert ${key}`, err);
    }
  }
};

const streamToBuffer = async (stream) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
};
