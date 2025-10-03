// index.js (CJS)
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");
const { outputPlaces } = require("./routeFunc");

const ddbDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async function (event) {
  console.log("Event:", JSON.stringify(event, null, 2));

  const userId = event.identity?.sub || "test-user";
  const routesTable = process.env.ROUTES_TABLE;
  const usersTable = process.env.USER_TABLE;
  const input = event.arguments.input;
  try {
    const routeId = `route-${uuidv4()}`;

    // Call your planner
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
      [5, 5, 5, 5, 5, 5, 5, 5]
    );
    var locations = [];
    // var locationsKey = [];
    // locationsKey.push(...Object.keys(allSuggestedPool).sort((a, b) => a - b));
    for(var key in allSuggestedPool){
        locations.push({"isOnTheRoute":allSuggestedPool[key][3], "placeId":allSuggestedPool[key][4]})
    }

    const newRoute = {
      routeId,
      userId,
      title: input.title,
      description: "",
      sharable: "false", 
      locations: locations, // array of strings
      createdAt: new Date().toISOString(),
    };

    // Put route
    await ddbDoc.send(
      new PutCommand({
        TableName: routesTable,
        Item: newRoute,
      })
    );

    // Append to user.routeIds (list_append equivalent)
    await ddbDoc.send(
      new UpdateCommand({
        TableName: usersTable,
        Key: { userId },
        UpdateExpression:
          "SET routeIds = list_append(if_not_exists(routeIds, :empty), :r)",
        ExpressionAttributeValues: {
          ":r": [routeId],
          ":empty": [],
        },
      })
    );

    return routeId;
  } catch (error) {
    console.error("Route generation failed:", error.message);
    // This will send the error message back to the GraphQL client.
    return error("Route generation failed:", error.message);
  }
};
