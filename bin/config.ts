import { StorageStackProps } from "./types";

export const storageStackConfig: StorageStackProps = {
  kms: {
    alias: "alias/app-key",
    desc: "EncryptionKey for App",
  },
  s3: {
    name: "user-images-bucket",
  },
  dynamoDB: {
    userTable: {
      name: "userTable",
      partitionKey: "account_id",
      sortingKey: "account_name",
      secondaryIndexes: [
        {
          indexName: "email_index",
          partitionKeyName: "account_email",
          sortingKey: "account_id",
        },
      ],
    },
  },
};
