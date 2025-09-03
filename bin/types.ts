import { StackProps } from "aws-cdk-lib";

export interface SecondaryIndexes {
  indexName: string;
  partitionKeyName: string;
  sortingKey: string;
}
interface DynamoDBTable {
  name: string;
  partitionKey: string;
  sortingKey: string;
  secondaryIndexes: SecondaryIndexes[];
}
export interface StorageStackProps extends StackProps {
  kms: {
    alias: string;
    desc: string;
  };
  s3: {
    name: string;
  };
  dynamoDB: {
    userTable: DynamoDBTable;
  };
}
