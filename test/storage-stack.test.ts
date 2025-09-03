import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as StorageStack from "../lib/storage-stack";
import { storageStackConfig } from "../bin/config";

const app = new cdk.App();
const stack = new StorageStack.StorageStack(
  app,
  "MyTestStack",
  storageStackConfig
);
const template = Template.fromStack(stack);

test("KMS Key Created", () => {
  template.hasResourceProperties("AWS::KMS::Key", {
    Description: storageStackConfig.kms.desc,
  });
});

test("KMS Alias Created", () => {
  template.hasResourceProperties("AWS::KMS::Alias", {
    AliasName: storageStackConfig.kms.alias,
  });
});

test("S3 Bucket Created", () => {
  template.hasResourceProperties("AWS::S3::Bucket", {
    BucketName: storageStackConfig.s3.name,
    VersioningConfiguration: {
      Status: "Enabled",
    },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: "aws:kms",
          },
        },
      ],
    },
  });
});

test("DynamoDB Users Table Created", () => {
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: storageStackConfig.dynamoDB.userTable.name,
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: [
      {
        AttributeName: storageStackConfig.dynamoDB.userTable.partitionKey,
        KeyType: "HASH",
      },
      {
        AttributeName: storageStackConfig.dynamoDB.userTable.sortingKey,
        KeyType: "RANGE",
      },
    ],
  });
});
