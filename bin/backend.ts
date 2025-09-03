#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
//import { BackendStack } from "../lib/backend-stack";
import { storageStackConfig } from "./config";
import { StorageStack } from "../lib/storage-stack";

const app = new cdk.App();
new StorageStack(app, "StorageStack", storageStackConfig);
