import { getAverageRadius, constructRegion, isTooFarAway, distanceBetween, rectangleFromCenterCorner } from "./coordinates.js";
import { getBestPlace, rankPlaces } from "./rankings.js"
import { getSuggestedGoogle } from "./suggestPlaces.js"
import { findWeights, updateMetrics, decrement_i } from "./metrics.js"

export async function outputPlaces(startingPlace, endPlace, routeMetrics, userPrompt, userHistory)
{   
    //Input (startingPlace={"lat": 0, "long": 0}, endPlace{"lat": 200, "lat": 0}, routeMetrics={"dis_w": 4, "ai_w": 6, "stationCount": 4}, static userPrompt, static userHistory)
    //Note: At the end of the process(after the route has been decided with additions etc.) update userHistory

    const initialCount = routeMetrics["stationCount"]

    console.log("Aimed stationCounts: " + initialCount)

    const initialDistance = distanceBetween(startingPlace["lat"], startingPlace["long"], endPlace["lat"], endPlace["long"])
    

    const metricsWeights = await findWeights(userPrompt, {debug:true})

    for(var i = 0; i < 8; i++){
        console.log(metricsWeights[i])
    }

    //Power of the weightMetrics to be evaluated, this will affect best place choice
    const powConstant = 1.5

    //Key id for the places
    var keyFrom = 1

    //Prevent confusion
    var startingPoint = startingPlace

    //Mock treshold for braking out of the loop
    var maximalLoopCount = 2*initialCount <= 23 ? 2*initialCount : 23
    var trackMaximalCount = 0

    var stationCount = routeMetrics["stationCount"]
    var dis_weight = routeMetrics["dis_w"]
    var ai_weight = routeMetrics["ai_w"]

    //In order to not get stuck
    var enlargeSearchRad = false
    var newRadii = 0

    //For use in the update_i function. 
    //averageRadius in kilometers
    var averageRadius = getAverageRadius(startingPoint, endPlace, stationCount)

    console.log("Average radius: " + averageRadius)

    //allSuggestedPool same as suggestedPlacesPool form-wise
    var allSuggestedPool = {}
    var chosenPlaces = {}

    for(var i = 0; i < stationCount; i++){
        console.log("Loop iteration: " + (trackMaximalCount + 1))

        //--- Decrement i if endPlace is too far away: IMPORTANT
        var lat, long, radius
        [lat, long, radius] = constructRegion(startingPoint, endPlace, initialCount - i)
        if(!enlargeSearchRad){
            newRadii = radius
        }
        /*
        if(radius > 50){
            radius = 50
            newRadii = radius
        }
        */
        if(enlargeSearchRad){
            newRadii += radius
            /*
            if(newRadii < 50){
                radius = newRadii
            }
            else{
                radius = 50
            }
            */
        }
        //Determine the rectangle
        var recradius = 
            distanceBetween(startingPoint["lat"], startingPoint["long"], lat, long) > radius ?
            radius : distanceBetween(startingPoint["lat"], startingPoint["long"], lat, long);
        const rects = rectangleFromCenterCorner(lat, long, recradius - 1);


        //console.log("StartingPoint for constructRegion (lat, long): ("+ startingPoint["lang"] + ", " + startingPoint["long"] + ")")
        console.log("(lat, long, radius): (" + lat + ", " + long + ", " + radius + ")")

        //--- Call to Google Places API
        // suggestedPlacesPool: List of places with each having tuples in the form (x, y, id).
        // id points to the further information regarding this place.
        // lat and long are the coordinates.

        //suggestedPlacesPool = {"id": {"lat": 10, "long": 5} , ...}
        //--> append to suggestedPlacesPool other keys: "reviews": ["review1", "review2", "review3"], "name": "name", "google_place_id": String
        /*
        {
            "1": {
                "lat": 55.6721542,
                "long": 12.5609317,
                "reviews": ["review1", "review2", "review3"],
                "name": "Frk. Barners Kælder",
                "google_place_id": "ChIJ1bukuQxTUkYRU0tfe4KIpoo"
            },
            ...
        }
        */
        var suggestedPlacesPool
        var keyFromNext
        [suggestedPlacesPool, keyFromNext] = await getSuggestedGoogle(rects, lat, long, radius - 2, userPrompt, keyFrom) 

        //--- Rank places using Amazon Bedrock
        //suggestedPlacesMetrics = {"id": [lat, long, {"romantic": 9, ...}, false, "google_place_id"]}
        var suggestedPlacesMetrics = await rankPlaces(suggestedPlacesPool, userPrompt) 

        //--- Choose one place for route
        //placeId --> Works like a key for the place
        //placeCoor --> Lattitude and longitude of the place in the form of {"lat": _, "long": _}
        var placeId, placeCoor 
        [placeId, placeCoor] = getBestPlace(powConstant, dis_weight, ai_weight, endPlace, initialDistance, suggestedPlacesMetrics, metricsWeights, userHistory)

        //Append to chosenPlaces
        chosenPlaces[placeId] = placeCoor

        if(distanceBetween(placeCoor["lat"], placeCoor["long"], endPlace["lat"], endPlace["long"])
            >= distanceBetween(startingPoint["lat"], startingPoint["long"], endPlace["lat"], endPlace["long"]) - 1){
            console.log("Invalid place chosen, widening the search...")
            if(i != 0){
                i = i - 1
            }
            enlargeSearchRad = true
            continue;
        }
        else{
            allSuggestedPool = {...allSuggestedPool, ...suggestedPlacesMetrics} //Append to allSuggestedPool
            keyFrom = keyFromNext
            enlargeSearchRad = false
        }

        //Do we keep searching
        if(i == stationCount-1 && isTooFarAway(placeCoor, endPlace, averageRadius))
        {
            //lean_ai: boolean value. False for this condition because we prioritize distance
            //dis_weight, ai_weight: weights to be updated
            // Idea fo future: If wanted, we can use getAverageRadius function to decleare new radius from now on
            [dis_weight, ai_weight] = updateMetrics(dis_weight, ai_weight, false)
            i -= decrement_i(placeCoor, endPlace, averageRadius) 
        }

        if(trackMaximalCount > maximalLoopCount)
        {
            console.log("Breaked out of route founder due to too many iterations!!!")
            break
        }
        //Increment for breaking condition
        trackMaximalCount++
        console.log("Chosen placeId for the loop: " + placeId)
        console.log("(latitude, longitude) for the chosen place: (" + placeCoor["lat"] + ", " + placeCoor["long"] + ")\n")

        startingPoint=placeCoor
    }

    for(var key_ in chosenPlaces){
        allSuggestedPool[key_][3] = true //isOnTheRoute = true
    }

    //Return the desired values, which are our routing places and places for further recommendation
    return [chosenPlaces, allSuggestedPool]
    //Return value is in this form --> [ recommended={"id": {"lat": 1, "long": 2}, ...}, allSuggestedPool={"id": {"lat": 10, "long": 5} , ...} ]
}