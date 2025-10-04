// index.js (CJS)
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");
const { outputPlaces } = require("./routeFunc");

const ddbDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async function (event) {
  console.log("Event:", JSON.stringify(event, null, 2));

  const userId = event.identity?.sub || "test-user";
  const usersTable = process.env.USER_TABLE;
  const input = event.arguments.input;
  try {

    const userResult = await ddbDoc.send(
      new GetCommand({
        TableName: usersTable,
        Key: { userId },
        ProjectionExpression: "userMetrics",
      })
    );

    const userMetrics = userResult.Item?.userMetrics || [5,5,5,5,5,5,5,5]; 
    // If outputPlaces returns [chosenPlaces, allSuggestedPool], destructure it:
    var chosenPlaces, allSuggestedPool;
    [chosenPlaces, allSuggestedPool] = await outputPlaces(
      {
        lat: input.startingPlace.latitude,
        long: input.startingPlace.longitude,
      },
      { lat: input.endPlace.latitude, long: input.endPlace.longitude },
      { dis_w: 200, ai_w: 1, stationCount: input.stopCount },
      input.userInput,
      userMetrics
    );

    var locations = [];
    // var locationsKey = [];
    // locationsKey.push(...Object.keys(allSuggestedPool).sort((a, b) => a - b));
    for(var key in allSuggestedPool){
        locations.push({"latitude":allSuggestedPool[key][0],"longitude":allSuggestedPool[key][1],"isOnTheRoute":allSuggestedPool[key][3], "placeId":allSuggestedPool[key][4]})
    }
    return locations;
  } catch (error) {
    console.error("Route generation failed:", error.message);
    // This will send the error message back to the GraphQL client.
    throw new Error(`Route generation failed: ${error.message}`);
  }
};
