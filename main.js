const NAME_NOTION = "Name";
const DATE_NOTION = "Date";
const TAGS_NOTION = "Tags";
const DESCRIPTION_NOTION = "Description";

const EVENT_ID_NOTION = "Event ID";
const CALENDAR_NAME_NOTION = "Calendar";
const CALENDAR_ID_NOTION = "Calendar ID";
const LAST_SYNC_NOTION = "Last Sync";

const ARCHIVE_CANCELLED_EVENTS = true;
const DELETE_CANCELLED_EVENTS = true;
const MOVED_EVENTS_CANCELLED = true;

const CANCELLED_TAG_NAME = "Cancelled/Removed";

const DEFAULT_TZ = "America/New_York";

function main() {
  parseNotionProperties();

  if (DELETE_CANCELLED_EVENTS) {
    deleteCancelledEvents();
  }

  for (var c_name of Object.keys(CALENDAR_IDS)) {
    logSyncedEvents(c_name, false);
  }

  syncToGCal();
}

/**
 * Sync to google calendar from Notion
 */
function syncToGCal() {
  console.log("Syncing to Google Calendar.");
  // Get 100 pages in order of when they were last edited.
  const url = getDatabaseURL();
  const payload = {
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  };
  const response_data = notionFetch(url, payload, "POST");

  for (let i = 0; i < response_data.results.length; i++) {
    let result = response_data.results[i];

    if (isPageUpdatedRecently(result)) {
      let event = convertToGCalEvent(result);

      let calendar_id = getPageProperty(result, CALENDAR_ID_NOTION).select;
      calendar_id = calendar_id ? calendar_id.name : null;

      let calendar_name = getPageProperty(result, CALENDAR_NAME_NOTION).select;
      calendar_name = calendar_name ? calendar_name.name : null;

      let event_id = flattenRichText(getPageProperty(result, EVENT_ID_NOTION));

      if (CALENDAR_IDS[calendar_name] && calendar_id && event_id) {
        if (calendar_id === CALENDAR_IDS[calendar_name]) {
          // Update event in original calendar.
        } else {
          // Event being moved to a new calendar - delete from old calendar and then create using calendar name
          deleteEvent(event_id, calendar_id);
          createEvent(result, event, calendar_name);
        }
      } else if (CALENDAR_IDS[calendar_name]) {
        // attempt to create using calendar name
        createEvent(result, event, calendar_name);
      } else {
        // Calendar name not found in dictonary. Abort.
        console.log(
          "Calendar name %s not found in dictionary. Aborting sync.",
          calendar_name
        );
      }
    }
  }
}

function logSyncedEvents(c_name, fullSync) {
  let properties = PropertiesService.getUserProperties();
  let options = {
    maxResults: 20,
    singleEvents: true, // allow recurring events
  };
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

    if (events.items && events.items.length === 0) {
      console.log("No events found. %s", c_name);
      return;
    }
    console.log("Parsing new events. %s", c_name);
    parseEvents(events);

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
      console.log("Event %s was cancelled.", event.id);
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
          "Event %s %s (%s -- %s)",
          event.id,
          event.summary,
          start.toLocaleDateString(),
          end.toLocaleDateString()
        );
      } else {
        // Events that don't last all day; they have defined start times.
        start = event.start.dateTime;
        end = event.end.dateTime;
        console.log(
          "Event %s %s (%s)",
          event.id,
          event.summary,
          start.toLocaleString()
        );
      }
      let page_response = getPageFromEvent(event);
      if (page_response) {
        console.log(
          "Event %s database page %s exists already. Attempting update.",
          event.id,
          page_response.id
        );
        let tags = getPageProperty(page_response, TAGS_NOTION).select;
        updateDatabaseEntry(event, page_response.id, tags ? tags : []);
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
  let properties = convertToNotionProperty(event, existing_tags);
  let archive = ARCHIVE_CANCELLED_EVENTS && event.status === "cancelled";

  pushDatabaseUpdate(properties, page_id, archive);
}

function pushDatabaseUpdate(properties, page_id, archive = false) {
  const url = "https://api.notion.com/v1/pages/" + page_id;
  let payload = {};
  payload["properties"] = properties;
  payload["archived"] = archive;

  if (archive) {
    console.log("Archiving cancelled event.");
  }

  const response_data = notionFetch(url, payload, "PATCH");
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

  const response_data = notionFetch(url, payload, "POST");
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

  const response_data = notionFetch(url, payload, "POST");

  if (response_data.results.length > 0) {
    if (response_data.results.length > 1) {
      console.log(
        "Found multiple entries with event id %s. This should not happen. Only considering index zero entry.",
        event.id
      );
    }

    return response_data.results[0];
  }
  return false;
}

/**
 * Retrieve notion page using page id
 * @param {String} page_id
 * @returns {Object} request response object
 */
function getPageProperty(result, property) {
  let page_id = result.id;
  let property_id = result.properties[property].id;
  const url =
    "https://api.notion.com/v1/pages/" + page_id + "/properties/" + property_id;
  return notionFetch(url, null, "GET");
}

/**
 * Interact with notion API
 * @param {String} url - url to send request to
 * @param {Object} payload_dict - payload to send with request
 * @param {String} method - method to use for request
 * @returns {Object} request response object
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
    const response_data = JSON.parse(response.getContentText());
    if (response_data.length == 0) {
      throw new Error(
        "No data returned from Notion API. Check your Notion token."
      );
    }
    return response_data;
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
  let properties = getBaseNotionProperties(event.id, event.c_name);

  properties[DESCRIPTION_NOTION] = {
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

    properties[DATE_NOTION] = {
      type: "date",
      date: {
        start: start_time,
        end: end_time,
      },
    };

    properties[NAME_NOTION] = {
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
    properties[TAGS_NOTION] = { multi_select: existing_tags };

    properties[TAGS_NOTION].multi_select.push({
      name: CANCELLED_TAG_NAME,
    });
  }

  return properties;
}

/**
 * Return base notion JSON property object including generation time
 * @param {String} event_id - event id
 * @param {String} calendar_name - calendar key name
 * @returns {Object} - base notion property object
 *  */
function getBaseNotionProperties(event_id, calendar_name) {
  return {
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
            content: event_id, //use ICal uid?
          },
        },
      ],
    },
    [CALENDAR_ID_NOTION]: {
      select: {
        name: CALENDAR_IDS[calendar_name],
      },
    },
    [CALENDAR_NAME_NOTION]: {
      select: {
        name: calendar_name,
      },
    },
  };
}

/**
 * Return GCal event object based on page properties
 * @param {Object} page_result - Notion page result object
 * @returns {Object} - GCal event object
 */
function convertToGCalEvent(page_result) {
  let e_id = getPageProperty(page_result, EVENT_ID_NOTION).results;
  e_id = flattenRichText(e_id);

  let e_summary = getPageProperty(page_result, NAME_NOTION).results;

  e_summary = e_summary[0].title.plain_text;

  let e_description = getPageProperty(page_result, DESCRIPTION_NOTION).results;
  e_description = flattenRichText(e_description);

  let dates = getPageProperty(page_result, DATE_NOTION);
  if (dates.date.start && dates.date.start.search(/([A-Z])/g) === -1) {
    dates.date.start += "T00:00:00";
  }
  if (dates.date.end && dates.date.end.search(/([A-Z])/g) === -1) {
    dates.date.end += "T00:00:00";
  }

  let event = {
    ...(e_id && { id: e_id }),
    ...(e_summary && { summary: e_summary }),
    ...(e_description && { description: e_description }),
    ...(dates.date.start && { start: dates.date.start }),
    ...(dates.date.end && { end: dates.date.end }),
  };

  event.time_zone = dates.date.time_zone || DEFAULT_TZ;

  return event;
}

/**
 * Parses Notion information from project properties and declares them into global variables
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
 * Get notion page ID of corresponding gCal event. Returns null if no page found.
 * @param {Object} event - gCal event object
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
        "Found multiple entries with event id %s. This should not happen. Only processing index zero entry.",
        event.id
      );
    }

    return response_data.results[0].id;
  }
  return null;
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
        name: CANCELLED_TAG_NAME,
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
      let event_id = getPageProperty(result, EVENT_ID_NOTION).results;
      let calendar_id = getPageProperty(result, CALENDAR_ID_NOTION).select.name;

      event_id = flattenRichText(event_id);

      deleteEvent(event_id, calendar_id);
    }
  }
}

/** Delete event from Google calendar
 * @param {String} event_id - Event id to delete
 * @param {String} calendar_id - Calendar id to delete event from
 * @returns {Boolean} - True if event was deleted, false if not
 */
async function deleteEvent(event_id, calendar_id) {
  console.log("Deleting event %s from gCal %s", event_id, calendar_id);
  try {
    let calendar = CalendarApp.getCalendarById(calendar_id);
    await calendar.getEventById(event_id).deleteEvent();
    return true;
  } catch (e) {
    console.log(e);
    return false;
  }
}

/** Determine if a page result has been updated recently
 * @param {Object} page_result - Page result from Notion database
 * @return {Boolean} - True if page has been updated recently, false otherwise
 * */
function isPageUpdatedRecently(page_result) {
  let last_sync_date = getPageProperty(page_result, LAST_SYNC_NOTION);

  last_sync_date = last_sync_date.date ? last_sync_date.date.start : 0;

  return new Date(last_sync_date) < new Date(page_result.last_edited_time);
}

/**
 * Flattens rich text properties into a singular string.
 * @param {Object} rich_text - Rich text property to flatten
 * @return {String} - Flattened rich text
 * */
function flattenRichText(rich_text_result) {
  let plain_text = "";
  for (let i = 0; i < rich_text_result.length; i++) {
    plain_text += rich_text_result[i].rich_text.plain_text;
  }
  return plain_text;
}

/** Create Google calendar event
 * @param {Object} page - Page result object from Notion database
 * @param {Object} event - Event object for gCal
 * @param {string} calendar_name - Name of calendar to create event in
 */
function createEvent(page, event, calendar_name) {
  pushEvent(event, CALENDAR_IDS[calendar_name]).then((new_event_id) => {
    if (!new_event_id) {
      console.log("Event %s not created in gCal.", event.summary);
      return;
    }

    let properties = getBaseNotionProperties(new_event_id, calendar_name);
    pushDatabaseUpdate(properties, page.id);
  });
}

/** Push event to Google calendar. Return event ID if successful
 * @param {Object} event - Event object for gCal
 * @param {string} calendar_id - ID of calendar to push event to
 * @return {string} - Event ID if successful, false otherwise
 */
async function pushEvent(event, calendar_id) {
  event.summary = event.summary || "";
  event.description = event.description || "";

  let options = [
    event.summary,
    new Date(event.start),
    ...(event.end ? [new Date(event.end)] : []),
    { description: event.description },
  ];

  let calendar = CalendarApp.getCalendarById(calendar_id);
  try {
    let new_event = await calendar.createAllDayEvent(...options);
    return new_event.getId().split("@")[0];
  } catch (e) {
    console.log("Failed to push new event to GCal. %s", e);
    return false;
  }
}
