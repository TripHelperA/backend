import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";
import { Construct } from "constructs";

export class RouteAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // cognito user pool for authentication
    const userPool = new cognito.UserPool(this, "RouteAppUserPool", {
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
        username: true,
      },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    });

    // user pool client
    const userPoolClient = new cognito.UserPoolClient(
      this,
      "RouteAppUserPoolClient",
      {
        userPool,
        authFlows: { userPassword: true, userSrp: true },
        generateSecret: false,
      }
    );

    // identity Pool
    const identityPool = new cognito.CfnIdentityPool(
      this,
      "RouteAppIdentityPool",
      {
        allowUnauthenticatedIdentities: false,
        cognitoIdentityProviders: [
          {
            clientId: userPoolClient.userPoolClientId,
            providerName: userPool.userPoolProviderName,
          },
        ],
      }
    );

    // users
    const usersTable = new dynamodb.Table(this, "UsersTable", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // routes
    const routesTable = new dynamodb.Table(this, "RoutesTable", {
      partitionKey: { name: "routeId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // adding GSI for userId -> routes
    routesTable.addGlobalSecondaryIndex({
      indexName: "UserIdIndex",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "routeId", type: dynamodb.AttributeType.STRING },
    });

    // sync cognito w dynamodb
    const postConfirmationFn = new lambda.Function(this, "PostConfirmationFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
        const ddb = new DynamoDBClient({});

        exports.handler = async (event) => {
          console.log("PostConfirmation event:", JSON.stringify(event));
          const userId = event.request.userAttributes.sub; // Cognito "sub"
          const email = event.request.userAttributes.email;
          const firstName = event.request.userAttributes.given_name || "";
          const familyName = event.request.userAttributes.family_name || "";

          try {
            await ddb.send(new PutItemCommand({
              TableName: process.env.USERS_TABLE,
              Item: {
                userId: { S: userId },
                email: { S: email },
                firstName: { S: firstName },
                familyName: { S: familyName },
                routeIds: { L: [] }
              }
            }));
          } catch (err) {
            console.error("Error writing to DynamoDB", err);
          }

          // MUST return event
          return event;
        };
      `),
      environment: {
        USERS_TABLE: usersTable.tableName,
      },
    });

    // granting lambda write access to DynamoDB
    usersTable.grantWriteData(postConfirmationFn);

    // adding Lambda as PostConfirmation trigger
    userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      postConfirmationFn
    );

    // graphql
    const api = new appsync.GraphqlApi(this, "RouteAppApi", {
      name: "RouteAppAPI",
      schema: appsync.SchemaFile.fromAsset("schema.graphql"), // this randomly started causing errors, may need to change to a definition
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
      },
    });

    // data Source
    const usersDataSource = api.addDynamoDbDataSource(
      "UsersDataSource",
      usersTable
    );
    const routesDataSource = api.addDynamoDbDataSource(
      "RoutesDataSource",
      routesTable
    );

    // queries
    usersDataSource.createResolver("GetUserResolver", {
      typeName: "Query",
      fieldName: "getUser",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        {
          "version": "2017-02-28",
          "operation": "GetItem",
          "key": {
            "userId": $util.dynamodb.toDynamoDBJson($ctx.args.userId)
          }
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        $util.toJson($ctx.result)
      `),
    });

    usersDataSource.createResolver("CreateUserResolver", {
      typeName: "Mutation",
      fieldName: "createUser",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        {
          "version": "2017-02-28",
          "operation": "PutItem",
          "key": {
            "userId": $util.dynamodb.toDynamoDBJson($ctx.identity.sub)
          },
          "attributeValues": {
            "firstName": $util.dynamodb.toDynamoDBJson($ctx.args.input.firstName),
            "familyName": $util.dynamodb.toDynamoDBJson($ctx.args.input.familyName),
            "routeIds": { "L": [] }
          }
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        $util.toJson($ctx.result)
      `),
    });

    routesDataSource.createResolver("GetUserRoutesResolver", {
      typeName: "Query",
      fieldName: "getUserRoutes",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        {
          "version": "2017-02-28",
          "operation": "Query",
          "index": "UserIdIndex",
          "query": {
            "expression": "userId = :userId",
            "expressionValues": {
              ":userId": $util.dynamodb.toDynamoDBJson($ctx.args.userId)
            }
          }
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        $util.toJson($ctx.result.items)
      `),
    });

    routesDataSource.createResolver("GetRouteResolver", {
      typeName: "Query",
      fieldName: "getRoute",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        {
          "version": "2017-02-28",
          "operation": "GetItem",
          "key": {
            "userId": $util.dynamodb.toDynamoDBJson($ctx.identity.sub),
            "routeId": $util.dynamodb.toDynamoDBJson($ctx.args.routeId)
          }
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        $util.toJson($ctx.result)
      `),
    });

    // mutations
    routesDataSource.createResolver("CreateRouteResolver", {
      typeName: "Mutation",
      fieldName: "createRoute",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        #set($routeId = $util.autoId())
        {
          "version": "2017-02-28",
          "operation": "PutItem",
          "key": {
            "routeId": $util.dynamodb.toDynamoDBJson($routeId)
          },
          "attributeValues": {
            "userId": $util.dynamodb.toDynamoDBJson($ctx.identity.sub),
            "title": $util.dynamodb.toDynamoDBJson($ctx.args.input.title),
            "description": $util.dynamodb.toDynamoDBJson($ctx.args.input.description),
            "sharable": $util.dynamodb.toDynamoDBJson($ctx.args.input.sharable),
            "locations": $util.dynamodb.toDynamoDBJson($ctx.args.input.locations),
            "createdAt": $util.dynamodb.toDynamoDBJson($util.time.nowISO8601())
          }
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        $util.toJson($ctx.result)
      `),
    });

    routesDataSource.createResolver("UpdateRouteResolver", {
      typeName: "Mutation",
      fieldName: "updateRoute",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        {
          "version": "2017-02-28",
          "operation": "UpdateItem",
          "key": {
            "userId": $util.dynamodb.toDynamoDBJson($ctx.identity.sub),
            "routeId": $util.dynamodb.toDynamoDBJson($ctx.args.routeId)
          },
          "update": {
            "expression": "SET #title = :title, #description = :description, #sharable = :sharable, #locations = :locations, #updatedAt = :updatedAt",
            "expressionNames": {
              "#title": "title",
              "#description": "description",
              "#sharable": "sharable",
              "#locations": "locations",
              "#updatedAt": "updatedAt"
            },
            "expressionValues": {
              ":title": $util.dynamodb.toDynamoDBJson($ctx.args.input.title),
              ":description": $util.dynamodb.toDynamoDBJson($ctx.args.input.description),
              ":sharable": $util.dynamodb.toDynamoDBJson($ctx.args.input.sharable),
              ":locations": $util.dynamodb.toDynamoDBJson($ctx.args.input.locations),
              ":updatedAt": $util.dynamodb.toDynamoDBJson($util.time.nowISO8601())
            }
          }
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        $util.toJson($ctx.result)
      `),
    });

    routesDataSource.createResolver("DeleteRouteResolver", {
      typeName: "Mutation",
      fieldName: "deleteRoute",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        {
          "version": "2017-02-28",
          "operation": "DeleteItem",
          "key": {
            "userId": $util.dynamodb.toDynamoDBJson($ctx.identity.sub),
            "routeId": $util.dynamodb.toDynamoDBJson($ctx.args.routeId)
          }
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        $util.toJson($ctx.result)
      `),
    });

    // IAM Role for authenticated users
    const authenticatedRole = new iam.Role(this, "AuthenticatedRole", {
      assumedBy: new iam.FederatedPrincipal("cognito-identity.amazonaws.com", {
        StringEquals: {
          "cognito-identity.amazonaws.com:aud": identityPool.ref,
        },
        "ForAnyValue:StringLike": {
          "cognito-identity.amazonaws.com:amr": "authenticated",
        },
      }),
    });

    // attaching policy to authenticated role
    authenticatedRole.attachInlinePolicy(
      new iam.Policy(this, "AuthenticatedPolicy", {
        statements: [
          new iam.PolicyStatement({
            actions: ["appsync:GraphQL"],
            resources: [api.arn + "/*"],
          }),
        ],
      })
    );

    // attaching roles to identity pool
    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      "IdentityPoolRoleAttachment",
      {
        identityPoolId: identityPool.ref,
        roles: { authenticated: authenticatedRole.roleArn },
      }
    );
    const mainLogicLambda = new lambda.Function(this, "MainLogicLambda", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda")),
      environment: {
        USER_TABLE: usersTable.tableName,
        ROUTES_TABLE: routesTable.tableName,
        GOOGLE_API_KEY: "<Your-api-key-here>", // use Secrets Manager for production
      },
    });

    // Grant Lambda permissions
    usersTable.grantReadWriteData(mainLogicLambda);
    routesTable.grantReadWriteData(mainLogicLambda);

    mainLogicLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"], // restrict in production
      })
    );

    // Add Lambda as AppSync data source
    const mainLambdaDataSource = api.addLambdaDataSource(
      "MainLambdaDataSource",
      mainLogicLambda
    );

    // Attach resolver to GraphQL mutation
    mainLambdaDataSource.createResolver("MainLogicRequestResolver", {
      typeName: "Mutation",
      fieldName: "mainLogicRequest",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
    {
      "version": "2018-05-29",
      "operation": "Invoke",
      "payload": {
        "arguments": $util.toJson($ctx.arguments),
        "identity": $util.toJson($ctx.identity)
      }
    }
  `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
    $util.toJson($ctx.result)
  `),
    });

    // outputs for configs etc
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "IdentityPoolId", { value: identityPool.ref });
    new cdk.CfnOutput(this, "GraphQLAPIURL", { value: api.graphqlUrl });
    new cdk.CfnOutput(this, "Region", { value: this.region });
  }
}
