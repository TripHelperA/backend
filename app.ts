import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RouteAppStack } from './lib/route-app-stack';

const app = new cdk.App();

new RouteAppStack(app, 'RouteAppStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'eu-north-1'
  },
  description: 'route backend -'
});

app.synth();
