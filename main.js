const NAME_NOTION = "Name";
const DATE_NOTION = "Date";
const TAGS_NOTION = "Tags";
const DESCRIPTION_NOTION = "Description";

const DELETION_NOTION = "Cleanup";

const EVENT_ID_NOTION = "Event ID";
const ON_GCAL_NOTION = "On GCal?";
const CALENDAR_ID_NOTION = "Calendar ID";
const LAST_SYNC_NOTION = "Last Sync";

const ARCHIVE_CANCELLED_EVENTS = false;

const CANCELLED_TAG_NAME = "Cancelled/Removed";
const CANCELLED_TAG_COLOR = "red";

function main() {
  parseNotionProperties();
  for (const [c_name, c_id] of Object.entries(CALENDAR_IDS)) {
    logSyncedEvents(c_name, c_id, false);
  }
}

function logSyncedEvents(calendar_name, calendar_id, fullSync) {
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
      events = Calendar.Events.list(calendar_id, options);
    } catch (e) {
      // Check to see if the sync token was invalidated by the server;
      // if so, perform a full sync instead.
      if (
        e.message === "Sync token is no longer valid, a full sync is required."
      ) {
        properties.deleteProperty("syncToken");
        logSyncedEvents(calendar_id, true);
        return;
      } else {
        throw new Error(e.message);
      }
    }

    if (events.items && events.items.length > 0) {
      console.log("Parsing new events. %s", calendar_name);
      parseEvents(events);
    } else {
      console.log("No events found. %s", calendar_name);
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
      page_response = getExistingPage(event);
      if (page_response) {
        console.log("Database event exists but requires update.");
        updateDatabaseEntry(
          event,
          page_response.id,
          typeof page_response.properties[TAGS_NOTION] === "undefined"
            ? []
            : x.options
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

  const responseData = notionFetch(url, payload, "GET");
}

/**
 * Determine if a page exists for the event, and the page needs to be updated. Returns page response if found.
 * @param {String} event
 * @returns {}
 */
function getExistingPage(event) {
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
 * Interact with notion API
 * @param {*} url
 * @param {*} payload
 * @param {*} method
 * @returns
 */

function notionFetch(url, payload, method = "POST") {
  // UrlFetchApp is sync even if async is specified
  const response = UrlFetchApp.fetch(url, {
    method: method,
    headers: getNotionHeaders(),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

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
    [ON_GCAL_NOTION]: {
      type: "checkbox",
      checkbox: true,
    },
    /**CALENDAR_ID_NOTION: {
      rich_text: [
        {
          text: {
            content: gCal_calendarId[i],
          },
        },
      ],
    },
    CALENDAR: {
      select: {
        name: gCal_calendarName[i],
      },
    }, */
  };

  if (event.description) {
    property[DESCRIPTION_NOTION] = {
      type: "rich_text",
      rich_text: [
        {
          text: {
            content: event.description,
          },
        },
      ],
    };
  } else {
    property[DESCRIPTION_NOTION] = {
      type: "rich_text",
      rich_text: [
        {
          text: {
            content: "",
          },
        },
      ],
    };
  }
  if (event.start) {
    let start_time;
    let end_time;

    if (event.start.date) {
      // All-day event.
      start_time = event.start.date;
      end_time = new Date(event.end.date);
      end_time = end_time.toLocaleDateString("en-ca");
      console.log(start_time, end_time);
      // Offset by 1 day to get end date.
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

    if (event.summary) {
      property[NAME_NOTION] = {
        type: "title",
        title: [
          {
            type: "text",
            text: {
              content: event.summary,
            },
          },
        ],
      };
    }
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
  } else if (!ARCHIVE_CANCELLED_EVENTS) {
    createDatabaseEntry(event);
  } else {
    console.log(
      "Event %s not found in Notion database. Archive is enabled. Skipping.",
      event.id
    );
  }
}

/** Update database structure */
function updateDatabaseStructure() {
  const url = getDatabaseURL();
  const response = notionFetch(url, {}, "GET");

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
