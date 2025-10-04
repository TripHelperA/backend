import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

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

    routesTable.addGlobalSecondaryIndex({
      indexName: "SharableIndex",
      partitionKey: { name: "sharable", type: dynamodb.AttributeType.STRING }, // This WIlll only be "true" or "false"
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING }, // optional, for sorting
      projectionType: dynamodb.ProjectionType.ALL, // returns all attributes
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
                routeIds: { L: [] },
                userMetrics: { L: [
                  { N: "4" }, { N: "4" }, { N: "4" }, { N: "4" },
                  { N: "4" }, { N: "4" }, { N: "4" }, { N: "4" }
                ]}
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
            "routeIds": { "L": [] },
            "userMetrics": { L: [
                  { N: "4" }, { N: "4" }, { N: "4" }, { N: "4" },
                  { N: "4" }, { N: "4" }, { N: "4" }, { N: "4" }
                ]}
              }
          }
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        $util.toJson($ctx.result)
      `),
    });

    usersDataSource.createResolver("UpdateUserMetricsResolver", {
      typeName: "Mutation",
      fieldName: "updateUserMetrics",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
    {
      "version": "2017-02-28",
      "operation": "UpdateItem",
      "key": {
        "userId": $util.dynamodb.toDynamoDBJson($ctx.identity.sub)
      },
      "update": {
        "expression": "SET userMetrics = :metrics",
        "expressionValues": {
          ":metrics": $util.dynamodb.toDynamoDBJson($ctx.args.metrics)
        }
      }
    }
  `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
    $util.toJson($ctx.result.userMetrics)
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
            "routeId": $util.dynamodb.toDynamoDBJson($ctx.args.routeId)
          }
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        $util.toJson($ctx.result)
      `),
    });


    // mutations
    // CLient should pass true or false into sharable
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
          "routeId": $util.dynamodb.toDynamoDBJson($ctx.args.routeId)
        },
        "condition": {
          "expression": "userId = :uid",
          "expressionValues": {
            ":uid": $util.dynamodb.toDynamoDBJson($ctx.identity.sub)
          }
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
            "routeId": $util.dynamodb.toDynamoDBJson($ctx.args.routeId)
          },
          "condition": {
            "expression": "userId = :uid",
            "expressionValues": {
              ":uid": $util.dynamodb.toDynamoDBJson($ctx.identity.sub)
            }
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

    // Main Logic Lambda
    const mainLogicLambda = new NodejsFunction(this, "MainLogicLambda", {
      entry: path.join(__dirname, "../lambda/mainLogic/index.js"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(120), // increase from default 3

      environment: {
        USER_TABLE: usersTable.tableName,
        ROUTES_TABLE: routesTable.tableName,
        GOOGLE_API_KEY:
          process.env.GOOGLE_MAPS_API_KEY ||
          "AIzaSyBZ3bwDQu5yNFh-Wbqes9baKYuwpvK8SVo", //FIXME: use aws secret manager
      },
      bundling: {
        externalModules: ["aws-sdk"],
        minify: true,
        sourceMap: true,
      },
    });

    mainLogicLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream", // include if you'll stream responses
        ],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/*`],
      })
    );
    // s3 bucket for images
    const imagesBucket = new s3.Bucket(this, "RouteAppImagesBucket", {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // allow authenticated users to upload/get images
    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [
          imagesBucket.arnForObjects(
            "users/${cognito-identity.amazonaws.com:sub}/*"
          ),
          imagesBucket.arnForObjects("routes/*"),
        ],
      })
    );

    // Grant Lambda permissions
    usersTable.grantReadWriteData(mainLogicLambda);
    routesTable.grantReadWriteData(mainLogicLambda);

    const signedUrlLambda = new NodejsFunction(this, "SignedUrlLambda", {
      entry: path.join(__dirname, "../lambda/signedUrl/index.js"),
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      environment: {
        IMAGES_BUCKET: imagesBucket.bucketName,
      },
      bundling: {
        externalModules: ["aws-sdk"],
        minify: true,
        sourceMap: true,
      },
    });

    // allow Lambda to put objects into S3
    imagesBucket.grantReadWrite(signedUrlLambda);

    const signedUrlDataSource = api.addLambdaDataSource(
      "SignedUrlDataSource",
      signedUrlLambda
    );

    // lambda for converting PNG → JPG
    const convertLambda = new NodejsFunction(this, "ConvertToJpgLambda", {
      entry: path.join(__dirname, "../lambda/convertImage/index.js"),
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      bundling: {
        externalModules: ["aws-sdk"],
      },
    });

    imagesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(convertLambda),
      { suffix: ".png" }
    );

    // permissions
    imagesBucket.grantReadWrite(convertLambda);

    signedUrlDataSource.createResolver("GenerateSignedUrlResolver", {
      typeName: "Mutation",
      fieldName: "generateSignedUrl",
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

    // AppSync data source & resolver
    const mainLambdaDataSource = api.addLambdaDataSource(
      "MainLambdaDataSource",
      mainLogicLambda
    );

    mainLambdaDataSource.createResolver("MainLogicRequestResolver", {
      typeName: "Query",
      fieldName: "mainLogicRequest",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    //Get PLace Info Lambda
    const getPlaceInfoLambda = new NodejsFunction(this, "GetPlaceInfoLambda", {
      entry: path.join(__dirname, "../lambda/getPlaceInfo/index.js"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: {
        GOOGLE_API_KEY:
          process.env.GOOGLE_MAPS_API_KEY ||
          "AIzaSyBZ3bwDQu5yNFh-Wbqes9baKYuwpvK8SVo", //FIXME: use aws secret manager
      },
      bundling: {
        externalModules: ["aws-sdk"],
        minify: true,
        sourceMap: true,
      },
    });

    // AppSync data source & resolver
    const placeInfoDataSource = api.addLambdaDataSource(
      "PlaceInfoDataSource",
      getPlaceInfoLambda
    );
    placeInfoDataSource.createResolver("GetPlaceInfoResolver", {
      typeName: "Query",
      fieldName: "getPlaceInfo",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });
    // Lambda function for getting Place ID
    const getPlaceIdLambda = new NodejsFunction(this, "GetPlaceIdLambda", {
      entry: path.join(__dirname, "../lambda/getPlaceId/index.js"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: {
        GOOGLE_API_KEY:
          process.env.GOOGLE_MAPS_API_KEY ||
          "AIzaSyBZ3bwDQu5yNFh-Wbqes9baKYuwpvK8SVo", //FIXME:
      },
      bundling: {
        externalModules: ["aws-sdk"],
        minify: true,
        sourceMap: true,
      },
    });

    // AppSync data source and resolver for getPlaceID
    const placeIdDataSource = api.addLambdaDataSource(
      "PlaceIdDataSource",
      getPlaceIdLambda
    );
    placeIdDataSource.createResolver("GetPlaceIdResolver", {
      typeName: "Query",
      fieldName: "getPlaceID",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    const saveLocationsLambda = new NodejsFunction(
      this,
      "SaveLocationsLambda",
      {
        entry: path.join(__dirname, "../lambda/saveLocations/index.js"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        environment: {
          ROUTES_TABLE: routesTable.tableName,
        },
        bundling: {
          externalModules: ["aws-sdk"],
          minify: true,
        },
      }
    );

    // Permissions
    routesTable.grantReadWriteData(saveLocationsLambda);

    // AppSync Data Source
    const saveLocationsDS = api.addLambdaDataSource(
      "SaveLocationsDataSource",
      saveLocationsLambda
    );

    routesDataSource.createResolver("GetAllRoutesSharableResolver", {
      typeName: "Query",
      fieldName: "getAllRoutes",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        {
          "version": "2017-02-28",
          "operation": "Query",
          "index": "SharableIndex",
          "query": {
            "expression": "sharable = :trueVal",
            "expressionValues": {
              ":trueVal": $util.dynamodb.toDynamoDBJson("true")
            }
          },
          "scanIndexForward": false
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        $util.toJson($ctx.result.items)
      `),
    });

    saveLocationsDS.createResolver("SaveLocationsResolver", {
      typeName: "Mutation",
      fieldName: "saveLocations",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // outputs for configs etc
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "IdentityPoolId", { value: identityPool.ref });
    new cdk.CfnOutput(this, "GraphQLAPIURL", { value: api.graphqlUrl });
    new cdk.CfnOutput(this, "Region", { value: this.region });
    new cdk.CfnOutput(this, "GraphQLAPIID", { value: api.apiId });
  }
}
