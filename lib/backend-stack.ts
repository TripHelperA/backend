import * as cdk from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import {
  CognitoUserPoolsAuthorizer,
  LambdaIntegration,
  RestApi,
  MethodOptions,
  AuthorizationType,
} from "aws-cdk-lib/aws-apigateway";
import { UserPool, CfnUserPoolGroup } from "aws-cdk-lib/aws-cognito";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { join } from "path";

export class BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // outputs:
    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
    });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
    });
  }
}
