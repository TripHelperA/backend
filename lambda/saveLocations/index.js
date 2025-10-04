const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");

const ddbDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  console.log("saveLocations event:", JSON.stringify(event, null, 2));

  const { title, description, sharable, locations } = event.arguments.input;
  const routesTable = process.env.ROUTES_TABLE;
  const usersTable = process.env.USER_TABLE;
  const userId = event.identity?.sub || "test-user";

  if (!title || !Array.isArray(locations)) {
    throw new Error("Invalid input: title and locations are required");
  }

  try {
    // Generate new routeId using uuid
    const routeId = `route-${uuidv4()}`;
    const now = new Date().toISOString();

    const processedLocations = locations.map(({ placeId, isOnTheRoute }) => ({
      placeId,
      isOnTheRoute,
    }));

    const newRoute = {
      routeId,
      userId,
      title,
      description: description || "",
      sharable: sharable || "false",
      locations:processedLocations,
      createdAt: now,
      updatedAt: now,
    };

    // Save new route to Routes table
    await ddbDoc.send(
      new PutCommand({
        TableName: routesTable,
        Item: newRoute,
        ConditionExpression: "attribute_not_exists(routeId)", // prevents overwriting
      })
    );

    // Add routeId to user's routeIds array
    try {
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
    } catch (updateError) {
      console.warn("Failed to update user's route list:", updateError);
    }

    // Return route info to client
    return {
      routeId,
      locations: processedLocations,
    };
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      throw new Error("A route with this ID already exists");
    }
    console.error("Error saving new route:", error);
    throw new Error("Failed to save route");
  }
};
