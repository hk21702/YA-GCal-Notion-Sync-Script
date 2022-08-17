const NAME_NOTION = "Name";
const DATE_NOTION = "Date";
const TAGS_NOTION = "Tags";
const DESCRIPTION_NOTION = "Description";

const EVENT_ID_NOTION = "Event ID";
const CALENDAR_NAME_NOTION = "Calendar";
const CALENDAR_ID_NOTION = "Calendar ID";
const LAST_SYNC_NOTION = "Last Sync";

const ARCHIVE_CANCELLED_EVENTS = false;
const DELETE_CANCELLED_EVENTS = true;
const MOVED_EVENTS_CANCELLED = true;

const CANCELLED_TAG_NAME = "Cancelled/Removed";

function main() {
  parseNotionProperties();

  if (DELETE_CANCELLED_EVENTS) {
    deleteCancelledEvents();
  }

  for (var c_name of Object.keys(CALENDAR_IDS)) {
    logSyncedEvents(c_name, false);
  }
}

function logSyncedEvents(c_name, fullSync) {
  let properties = PropertiesService.getUserProperties();
  let options = {
    maxResults: 20,
  };
  options.singleEvents = true; // allow recurring events
  let syncToken = properties.getProperty("syncToken");
  if (syncToken && !fullSync) {
    options.syncToken = syncToken;
  } else {
    // Sync events up to thirty days in the past.
    options.timeMin = getRelativeDate(-30, 0).toISOString();
  }

  // Retrieve events one page at a time.
  let events;
  let pageToken;
  do {
    try {
      options.pageToken = pageToken;
      events = Calendar.Events.list(CALENDAR_IDS[c_name], options);
    } catch (e) {
      // Check to see if the sync token was invalidated by the server;
      // if so, perform a full sync instead.
      if (
        e.message === "Sync token is no longer valid, a full sync is required."
      ) {
        properties.deleteProperty("syncToken");
        logSyncedEvents(CALENDAR_IDS[c_name], true);
        return;
      } else {
        throw new Error(e.message);
      }
    }

    events["c_name"] = c_name;

    if (events.items && events.items.length > 0) {
      console.log("Parsing new events. %s", c_name);
      parseEvents(events);
    } else {
      console.log("No events found. %s", c_name);
    }

    pageToken = events.nextPageToken;
  } while (pageToken);

  properties.setProperty("syncToken", events.nextSyncToken);
}

/**
 * Determine if gcal events need to be updated, removed, or added to the database
 */
function parseEvents(events) {
  for (let i = 0; i < events.items.length; i++) {
    let event = events.items[i];
    event["c_name"] = events["c_name"];
    if (event.status === "cancelled") {
      console.log("Event id %s was cancelled.", event.id);
      // Remove the event from the database
      handleEventCancelled(event);
    } else {
      let start;
      let end;
      if (event.start.date) {
        // All-day event.
        start = new Date(event.start.date);
        end = new Date(event.end.date);
        console.log(
          "%s (%s -- %s)",
          event.summary,
          start.toLocaleDateString(),
          end.toLocaleDateString()
        );
      } else {
        // Events that don't last all day; they have defined start times.
        start = event.start.dateTime;
        end = event.end.dateTime;
        console.log("%s (%s)", event.summary, start.toLocaleString());
      }
      page_response = getPageId(event);
      if (page_response) {
        console.log("Database page exists already. Attempting update.");
        updateDatabaseEntry(
          event,
          page_response.id,
          typeof page_response.properties[TAGS_NOTION] === "undefined"
            ? []
            : page_response.properties[TAGS_NOTION].options
        );
      } else {
        console.log("Creating database entry.");
        createDatabaseEntry(event);
      }
    }
  }
}

/**
 * Update database entry with new event information
 */
function updateDatabaseEntry(event, page_id, existing_tags = []) {
  const url = "https://api.notion.com/v1/pages/" + page_id;
  let payload = {};
  payload["properties"] = convertToNotionProperty(event, existing_tags);

  if (ARCHIVE_CANCELLED_EVENTS && event.status === "cancelled") {
    console.log("Archiving cancelled event.");
    payload["archived"] = true;
  }

  const responseData = notionFetch(url, payload, "PATCH");
}

/**
 * Create a new database entry for the event
 */
function createDatabaseEntry(event) {
  const url = "https://api.notion.com/v1/pages";
  let payload = {};

  payload["parent"] = {
    type: "database_id",
    database_id: DATABASE_ID,
  };

  payload["properties"] = convertToNotionProperty(event);

  const responseData = notionFetch(url, payload, "POST");
}

/**
 * Determine if a page exists for the event, and the page needs to be updated. Returns page response if found.
 * @param {String} event
 * @returns {}
 */
function getPageFromEvent(event) {
  const url = getDatabaseURL();
  const payload = {
    filter: {
      and: [
        { property: EVENT_ID_NOTION, rich_text: { equals: event.id } },
        {
          property: LAST_SYNC_NOTION,
          date: { before: new Date().toISOString(event.updated) },
        },
      ],
    },
  };

  const responseData = notionFetch(url, payload, "POST");

  if (responseData.results.length > 0) {
    if (responseData.results.length > 1) {
      console.log(
        "Found multiple entries with event id %s. This should not happen. Only considering index zero entry.",
        event.id
      );
    }

    return responseData.results[0];
  }
  return false;
}

/**
 * Retrieve notion page using page id
 * @param {String} page_id
 * @returns {}
 */
function getPageProperty(page_id, property_id) {
  const url =
    "https://api.notion.com/v1/pages/" + page_id + "/properties/" + property_id;
  const responseData = notionFetch(url, null, "GET");
  return responseData;
}

/**
 * Interact with notion API
 * @param {*} url
 * @param {*} payload_dict
 * @param {*} method
 * @returns
 */
function notionFetch(url, payload_dict, method = "POST") {
  // UrlFetchApp is sync even if async is specified
  let options = {
    method: method,
    headers: getNotionHeaders(),
    muteHttpExceptions: true,
    ...(payload_dict && { payload: JSON.stringify(payload_dict) }),
  };

  const response = UrlFetchApp.fetch(url, options);

  if (response.getResponseCode() === 200) {
    const responseData = JSON.parse(response.getContentText());
    if (responseData.length == 0) {
      throw new Error(
        "No data returned from Notion API. Check your Notion token."
      );
    }
    return responseData;
  } else if (response.getResponseCode() === 401) {
    throw new Error("Notion token is invalid.");
  } else {
    throw new Error(response.getContentText());
  }
}

function getNotionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    Accept: "application/json",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
}

function getDatabaseURL() {
  return `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
}

function getNotionParent() {
  return {
    database_id: DATABASE_ID,
  };
}

function getRelativeDate(daysOffset, hour) {
  let date = new Date();
  date.setDate(date.getDate() + daysOffset);
  date.setHours(hour);
  date.setMinutes(0);
  date.setSeconds(0);
  date.setMilliseconds(0);
  return date;
}

/**
 * Return notion JSON property object based on event data
 */
function convertToNotionProperty(event, existing_tags = []) {
  let property = {
    [LAST_SYNC_NOTION]: {
      type: "date",
      date: {
        start: new Date().toISOString(),
      },
    },
    [EVENT_ID_NOTION]: {
      type: "rich_text",
      rich_text: [
        {
          text: {
            content: event.id, //use ICal uid?
          },
        },
      ],
    },
    [CALENDAR_ID_NOTION]: {
      select: {
        name: CALENDAR_IDS[event.c_name],
      },
    },
    [CALENDAR_NAME_NOTION]: {
      select: {
        name: event.c_name,
      },
    },
  };

  property[DESCRIPTION_NOTION] = {
    type: "rich_text",
    rich_text: [
      {
        text: {
          content: event.description ? event.description : "",
        },
      },
    ],
  };

  if (event.start) {
    let start_time;
    let end_time;

    if (event.start.date) {
      // All-day event.
      start_time = event.start.date;
      end_time = new Date(event.end.date);
      end_time = end_time.toLocaleDateString("en-ca");
      // Offset by 1 day to get end date.

      end_time = start_time === end_time ? null : end_time;
    } else {
      // Events that don't last all day; they have defined start times.
      start_time = new Date(event.start.dateTime);
      end_time = new Date(event.end.dateTime);
    }

    property[DATE_NOTION] = {
      type: "date",
      date: {
        start: start_time,
        end: end_time,
      },
    };

    property[NAME_NOTION] = {
      type: "title",
      title: [
        {
          type: "text",
          text: {
            content: event.summary ? event.summary : "",
          },
        },
      ],
    };
  }

  if (event.status === "cancelled") {
    property[TAGS_NOTION] = { multi_select: existing_tags };

    property[TAGS_NOTION].multi_select.push({
      name: CANCELLED_TAG_NAME,
    });
  }

  return property;
}

/**
 * Return GCal event object based on page properties
 */
function convertToGCalEvent(page_result) {
  let e_id = getPageProperty(
    page_result.id,
    page_result.properties[EVENT_ID_NOTION].id
  );
  e_id = e_id.results[0].rich_text.plain_text;

  let e_summary = getPageProperty(
    page_result.id,
    page_result.properties[NAME_NOTION].id
  );

  e_summary = e_summary.results[0].rich_text.plain_text;

  let e_description = getPageProperty(
    page_result.id,
    page_result.properties[DESCRIPTION_NOTION].id
  );
  e_description = e_description.results[0].rich_text.plain_text;

  let dates = getPageProperty(
    page_result.id,
    page_result.properties[DATE_NOTION].id
  );

  let event = {
    ...(e_id && { id: e_id }),
    ...(e_summary && { summary: e_summary }),
    ...(e_description && { description: e_description }),
  };

  //event["start"] = {"dateTime": };
  //event["end"] = {"dateTime": };
}

/**
 * Parses Notion information from project properties
 */
function parseNotionProperties() {
  let properties = PropertiesService.getScriptProperties();
  NOTION_TOKEN = properties.getProperty("NOTION_TOKEN");

  let reURLInformation = new RegExp(
    [
      "^(https?:)//", // protocol
      "(([^:/?#]*)(?::([0-9]+))?)", // host (hostname and port)
      "(/{0,1}[^?#]*)", // pathname
      "(\\?[^#]*|)", // search
      "(#.*|)$", // hash
    ].join("")
  );

  let database_url = properties
    .getProperty("DATABASE_ID")
    .match(reURLInformation);
  DATABASE_ID = database_url[5].split("/")[1];
}

/**
 * Get page ID of corresponding iCal id
 */
function getPageId(event) {
  const url = getDatabaseURL();
  const payload = {
    filter: { property: EVENT_ID_NOTION, rich_text: { equals: event.id } },
  };

  const response_data = notionFetch(url, payload, "POST");

  if (response_data.results.length > 0) {
    if (response_data.results.length > 1) {
      console.log(
        "Found multiple entries with event id %s. This should not happen. Only considering index zero entry.",
        event.id
      );
    }

    return response_data.results[0].id;
  }
  return false;
}

/**
 * Deals with event cancelled from gCal side
 */
function handleEventCancelled(event) {
  const page_id = getPageId(event);

  if (page_id) {
    updateDatabaseEntry(event, page_id);
  } else {
    console.log("Event %s not found in Notion database. Skipping.", event.id);
  }
}

/** Update database structure */
function updateDatabaseStructure() {
  const url = getDatabaseURL();
  const response = notionFetch(url, null, "GET");

  if (response.properties[TAGS_NOTION]) {
    if (response.properties[TAGS_NOTION].type === "multi_select") {
      let properties = response.properties;
      properties[TAGS_NOTION].multi_select.options.append({
        name: "Cancelled/Removed",
        color: "red",
      });
    }
  } else {
    console.log("Database creation to be implemented");
  }

  notionFetch(url, payload, "POST");
}

/** Delete events marked as cancelled in gcal */
async function deleteCancelledEvents() {
  const url = getDatabaseURL();
  const payload = {
    filter: {
      property: TAGS_NOTION,
      multi_select: { contains: CANCELLED_TAG_NAME },
    },
  };
  const response_data = notionFetch(url, payload, "POST");

  for (let i = 0; i < response_data.results.length; i++) {
    let result = response_data.results[i];

    if (isPageUpdatedRecently(result)) {
      console.log("Deleting event %s from gCal", event_id);

      try {
        let calendar = CalendarApp.getCalendarById(calendar_id);
        await calendar.getEventById(event_id).deleteEvent();
      } catch (e) {
        console.log(e);
        continue;
      }
    }
  }
}

/** Determine if a page result has been updated recently
 * @param {Object} page_result - Page result from Notion database
 * @return {Boolean} - True if page has been updated recently, false otherwise
 * */
function isPageUpdatedRecently(page_result) {
  let last_sync_date = getPageProperty(
    page_result.id,
    page_result.properties[LAST_SYNC_NOTION].id
  );

  let calendar_id = getPageProperty(
    page_result.id,
    page_result.properties[CALENDAR_ID_NOTION].id
  );

  calendar_id = calendar_id.select.name;

  let event_id = getPageProperty(
    page_result.id,
    page_result.properties[EVENT_ID_NOTION].id
  );

  event_id = event_id.results[0].rich_text.plain_text;

  return (
    new Date(last_sync_date.date.start) < new Date(page_result.last_edited_time)
  );
}
