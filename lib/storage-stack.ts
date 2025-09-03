import * as cdk from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { SecondaryIndexes, StorageStackProps } from "../bin/types";
import { NagSuppressions } from "cdk-nag";

export class StorageStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    //Encryption key
    const key = new kms.Key(this, "Key", {
      description: props.kms.desc,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, //IMPORTANT: Change when going to prod as when the stack is deleted the keys will deteled as well. DO: REATIN
    });

    new kms.Alias(this, "keyAlias", {
      targetKey: key,
      aliasName: props.kms.alias,
    });

    //s3 Bucket
    const bucket = new s3.Bucket(this, "Bucket", {
      bucketName: props.s3.name,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      versioned: true, // CHANGE: if we dont want versioning
      //enforceSSL: true,  IDK how this would help its a security measure tho
      removalPolicy: cdk.RemovalPolicy.DESTROY, //IMPORTANT: Change when going to prod as when the stack is deleted the keys will deteled as well. DO: REATIN
    });

    //UserTable
    const userTable = new ddb.Table(this, "Users", {
      tableName: props.dynamoDB.userTable.name,
      partitionKey: {
        name: props.dynamoDB.userTable.partitionKey,
        type: ddb.AttributeType.STRING,
      },
      sortKey: {
        name: props.dynamoDB.userTable.sortingKey,
        type: ddb.AttributeType.STRING,
      },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      encryption: ddb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      removalPolicy: cdk.RemovalPolicy.DESTROY, //IMPORTANT: Change when going to prod as when the stack is deleted the keys will deteled as well. DO: REATIN
    });

    props.dynamoDB.userTable.secondaryIndexes.map(
      (secondaryIndex: SecondaryIndexes) => {
        userTable.addGlobalSecondaryIndex({
          indexName: secondaryIndex.indexName,
          partitionKey: {
            name: secondaryIndex.partitionKeyName,
            type: ddb.AttributeType.STRING,
          },
          sortKey: {
            name: secondaryIndex.sortingKey,
            type: ddb.AttributeType.STRING,
          },
        });
      }
    );

    // CDK NAG SUPPRESSIONS
    NagSuppressions.addResourceSuppressions(
      [userTable],
      [
        {
          id: "AwsSolutions-DDB3",
          reason: "No point in time recovery needed at this point.",
        },
      ]
    );
    NagSuppressions.addResourceSuppressions(
      bucket,
      [
        { id: "AwsSolutions-S1", reason: "Logging not required in dev/test." },
        {
          id: "AwsSolutions-S10",
          reason: "SSL enforcement handled at app level.",
        },
      ],
      true
    );
  }
}
