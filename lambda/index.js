const { DynamoDB } = require("aws-sdk");
const https = require("https");

const ddb = new DynamoDB.DocumentClient();

/**
 * Promisified GET request using Node.js's native 'https' module.
 */
function httpsGet(url) {
    const urlParts = new URL(url);

    const options = {
        hostname: urlParts.hostname,
        path: urlParts.pathname + urlParts.search,
        method: 'GET',
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';

            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`HTTP status code ${res.statusCode} for ${url}`));
            }

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error("Failed to parse JSON response."));
                }
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.end();
    });
}

exports.handler = async function(event) {
    console.log("Event:", JSON.stringify(event, null, 2));

    const userId = event.identity?.sub || "test-user";
    const routesTable = process.env.ROUTES_TABLE;
    const usersTable = process.env.USER_TABLE;
    const googleApiKey = process.env.GOOGLE_API_KEY;

    // Call Google Places API using native 'https' module
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=40.748817,-73.985428&radius=1500&type=restaurant&key=${googleApiKey}`;
    
    const responseData = await httpsGet(url); 
    
    const place = responseData.results?.[0] || { name: "Unknown Place" }; 

    // ❌ REPLACED UUID GENERATION WITH HARDCODED STRING
    const routeId = "TEST-BUILD-ROUTE-ID-12345"; 

    const newRoute = {
        routeId,
        userId,
        title: place.name,
        description: "Created via mainLogic Lambda (TEST BUILD)",
        sharable: true,
        locations: [place.name],
        createdAt: new Date().toISOString(),
    };

    // Insert into RoutesTable
    await ddb.put({
        TableName: routesTable,
        Item: newRoute,
    }).promise();

    // Append routeId to user's routeIds list
    await ddb.update({
        TableName: usersTable,
        Key: { userId },
        UpdateExpression: "SET routeIds = list_append(if_not_exists(routeIds, :empty), :r)",
        ExpressionAttributeValues: {
            ":r": [routeId],
            ":empty": [],
        },
    }).promise();

    return [routeId, "BANA BAGIRMA"];
};