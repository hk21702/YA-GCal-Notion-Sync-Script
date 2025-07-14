const NAME_NOTION = "Name";
const DATE_NOTION = "Date";
const TAGS_NOTION = "Tags";
const LOCATION_NOTION = "Location";
const DESCRIPTION_NOTION = "Description";

// DON'T CHANGE ANY OF THESE PROPERTIES
const EVENT_ID_NOTION = "Event ID";
const CALENDAR_NAME_NOTION = "Calendar";
const CALENDAR_ID_NOTION = "Calendar ID";
const LAST_SYNC_NOTION = "Last Sync";

const ARCHIVE_CANCELLED_EVENTS = true;
const DELETE_CANCELLED_EVENTS = true;
const IGNORE_RECENTLY_PUSHED = true;
const SKIP_BAD_EVENTS = true;

const CANCELLED_TAG_NAME = "Cancelled/Removed";
const IGNORE_SYNC_TAG_NAME = "Ignore Sync";

// Relative to the time of last full sync in days.
const RELATIVE_MAX_DAY = 1825; // 5 years
const RELATIVE_MIN_DAY = 30;

// For syncing with multiple Notion databases, the script properties containing database URLs must end with this string.
const DATABASE_URL_PROPERTY_SUFFIX = "DATABASE_URL"

// List of Notion databases (represented as their corresponding script properties) that should NOT check for updates from Google Calendar,
// i.e. updates can only go from Notion to Google Calendar but not the other way around.
const DATABASES_IGNORING_GCAL_UPDATES = ["IGNORED_DATABASE_URL"];

// The ID of the Notion DB that is currently being synced, set in `parseNotionProperties()`.
// This is also stored as a `Tag` in all GCal events using the `GCAL_DB_TAG_KEY` to indicate which DB they belong to.
let DATABASE_ID;
const GCAL_DB_TAG_KEY = "NotionDB";

function main() {
  databases = retrieveDatabaseURLs();

  // this loop contains all the code for syncing one particular database, so repeat it for each database
  for (const db of databases) {
    // update the global var indicating which database is being synced
    console.log(`\nProcessing database with property key '${db}'`);

    // set up the program to focus on this db
    parseNotionProperties(db);

    if (DELETE_CANCELLED_EVENTS) {
      deleteCancelledEvents();
    }

    // Sync from Notion to GCal
    let modified_eIds = syncToGCal();

    modified_eIds = IGNORE_RECENTLY_PUSHED ? modified_eIds : new Set();

    // Sync from GCal to Notion, unless this database disables this functionality
    if (DATABASES_IGNORING_GCAL_UPDATES.includes(db)) {
      console.log(`Ignoring calendar sync from GCal to Notion for database '${db}' because it has been specifically ignored`);
    } else {
      for (const cal_name of Object.keys(CALENDAR_IDS)) {
        syncFromGCal(cal_name, false, modified_eIds);
      }
    }

    console.log(`Finished processing database with property key '${db}'`);
  } // end of main processing loop
}

/**
 * Syncs all calendars from Google Calendar to Notion using a full sync.
 *
 * -- Will discard the old page token and generate a new one. --
 * -- Will reset time min and time max to use the the current time as origin time --
 **/
function fullSync() {
  console.log("Preforming full sync. Page token, time min, and time max will be reset.");

  databases = retrieveDatabaseURLs();

  // this loop contains all the code for syncing one particular database, so repeat it for each database
  for (const db of databases) {
    // update the global var indicating which database is being synced
    console.log(`\nProcessing database with property key '${db}'`);
  
    // set up the program to focus on this db
    parseNotionProperties(db);

    // Sync from GCal to Notion, unless this database disables this functionality
    if (DATABASES_IGNORING_GCAL_UPDATES.includes(db)) {
      console.log(`Ignoring calendar sync from GCal to Notion for database '${db}' because it has been specifically ignored`);
    } else {
      for (const cal_name of Object.keys(CALENDAR_IDS)) {
        syncFromGCal(cal_name, true, new Set());
      }
    }
    
    console.log(`Finished processing database with property key '${db}'`);
  } // end of main processing loop
}

/**
 * Retrieves the URLs for each database stored in the script properties whose keys end with `DATABASE_URL_PROPERTY_SUFFIX`
 * @returns {String[]} - Array of database URLs
 */
function retrieveDatabaseURLs() {
  const properties = PropertiesService.getScriptProperties();
  const databases = [];
  for (const key of properties.getKeys()) {
    if (key.endsWith(DATABASE_URL_PROPERTY_SUFFIX)) {
      console.log(`Found database with property key '${key}'`);
      databases.push(key);
    }
  }
  return databases;
}

/**
 * Syncs to Google Calendar from Notion
 * @returns {Set[String]} - Array of GCal event IDs that were modified
 */
function syncToGCal() {
  console.log("[+GCal] Syncing to Google Calendar.");

  // Get 100 pages in order of when they were last edited.
  const payload = {
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    filter: {
      property: TAGS_NOTION,
      multi_select: {
        does_not_contain: IGNORE_SYNC_TAG_NAME,
      },
    },
  };
  const response_data = notionFetch(getDatabaseURL(), payload, "POST");

  let modified_eIds = new Set();

  for (let i = 0; i < response_data.results.length; i++) {
    let result = response_data.results[i];

    // Skip pages that haven't been updated since the last sync
    if (!isPageUpdatedRecently(result)) {
      continue;
    }

    let event = convertToGCalEvent(result);

    if (!event) {
      console.log(`[+GC] Skipping database entry "${flattenRichText(result.properties[NAME_NOTION].title) || result.id}" because it does not contain a date property.`);
      continue;
    }

    let calendar_id = result.properties[CALENDAR_ID_NOTION].select;
    calendar_id = calendar_id ? calendar_id.name : null;

    let calendar_name = result.properties[CALENDAR_NAME_NOTION].select;
    calendar_name = calendar_name ? calendar_name.name : DEFAULT_CALENDAR_NAME;

    // Check if the event already exists in GCal
    if (CALENDAR_IDS[calendar_name] && calendar_id && event.id) {
      if (calendar_id === CALENDAR_IDS[calendar_name]) {
        // Update event in original calendar.
        console.log(`[+GC] Updating event "${event.summary}" (ID ${event.id}) in calendar "${calendar_name}".`);
        pushEventUpdate(event, event.id, calendar_id);

        continue;
      }

      // Event being moved to a new calendar - delete from old calendar and then create using calendar name
      let deleteSuccess = deleteEvent(event.id, calendar_id)
      let modified_eId = createEvent(result, event, calendar_name)

      if (deleteSuccess && modified_eId != false) {
        console.log(`[+GC] Event "${event.summary}" (ID ${event.id}) moved to calendar "${calendar_name}".`);
        modified_eIds.add(modified_eId);

        continue;
      }

      console.log(`[+GC] Failed to move event "${event.summary}" (ID ${event.id}) to calendar "${calendar_name}".`);
      continue;
    }

    // Try to create the event in GCal based on the Notion calendar name field
    if (CALENDAR_IDS[calendar_name]) {
      let modified_eId = createEvent(result, event, calendar_name)
      if (modified_eId != false) {
        modified_eIds.add(modified_eId);
        console.log(`[+GC] Event "${event.summary}" (ID ${modified_eId}) created in calendar "${calendar_name}".`);
      }
      continue;
    }
    
    console.log(`[+GC] Calendar name "${calendar_name}" not found in dictionary. No action taken.`);
  }

  if (modified_eIds.size == 0) {
    console.log(`[+GCal] No GCal events needed to be modified or created.`);
    return modified_eIds
  }

  return modified_eIds;
}

/**
 * Syncs from Google Calendar to Notion
 * @param {String} cal_name Calendar name
 * @param {Boolean} fullSync Whenever or not to discard the old page token
 * @param {Set[String]} ignored_eIds Event IDs to not act on.
 */
function syncFromGCal(cal_name, fullSync, ignored_eIds) {
  console.log(`[+ND] Syncing from Google Calendar: "${cal_name}".`);
  let properties = PropertiesService.getUserProperties();
  let options = {
    maxResults: 100,
    singleEvents: true, // Allow recurring events
  };
  let syncToken = properties.getProperty("syncToken");

  if (syncToken && !fullSync) {
    options.syncToken = syncToken;
  } else {
    // Sync events up to thirty days in the past.
    options.timeMin = getRelativeDate(-RELATIVE_MIN_DAY, 0).toISOString();
    // Sync events up to x days in the future.
    options.timeMax = getRelativeDate(RELATIVE_MAX_DAY, 0).toISOString();
  }

  // Retrieve events one page at a time.
  let events;
  let pageToken;
  let calendar = CalendarApp.getCalendarById(CALENDAR_IDS[cal_name]);
  do {
    try {
      options.pageToken = pageToken;
      events = Calendar.Events.list(CALENDAR_IDS[cal_name], options);

      // Only look at events corresponding to the current DB.
      // This is kinda scuffed because we want to use the web API for the sync token functionality,
      // but we need the Apps Script API to get real CalendarEvent objects to check the DB tag.
      events.items = events.items.filter((e) => calendar.getEventById(e.id).getTag(GCAL_DB_TAG_KEY) == DATABASE_ID);
    } catch (e) {
      // Check to see if the sync token was invalidated by the server;
      // if so, perform a full sync instead.
      if (
        e.message === "Sync token is no longer valid, a full sync is required." || e.message === "API call to calendar.events.list failed with error: Sync token is no longer valid, a full sync is required."
      ) {
        properties.deleteProperty("syncToken");
        syncFromGCal(CALENDAR_IDS[cal_name], true, ignored_eIds);
        return;
      } else {
        throw e;
      }
    }

    events["cal_name"] = cal_name;

    if (events.items && events.items.length === 0) {
      console.log(`[+ND] No relevant events found in calendar "${cal_name}".`);
      return;
    }
    console.log(`[+ND] Parsing new events in calendar "${cal_name}".`);
    parseEvents(events, ignored_eIds);

    pageToken = events.nextPageToken;
  } while (pageToken);

  properties.setProperty("syncToken", events.nextSyncToken);
}

/**
 * Determine if GCal events need to be updated, removed, or added to the database
 * @param {CalendarEvent[]} events Google Calendar events
 * @param {Set[String]} ignored_eIds Event IDs to not act on.
 */
function parseEvents(events, ignored_eIds) {
  let requests = [];

  for (let i = 0; i < events.items.length; i++) {
    let event = events.items[i];

    // When an event is deleted in GCal, it is still included in this array, but the summary (title) isn't defined.
    // It also has `event.status` = "cancelled", but that might happen in other situations too
    if (typeof event.summary === "undefined") {
      continue;
    }

    event["cal_name"] = events["cal_name"];

    if (ignored_eIds.has(event.id)) {
      console.log(`[+ND] Ignoring event "${event.summary}" (ID ${event.id}).`);
      continue;
    }
    if (event.status === "cancelled") {
      // Remove the event from the database
      console.log(`[+ND] Event "${event.summary}" (ID ${event.id}) was cancelled.`);
      handleEventCancelled(event);
      continue;
    }

    let start;
    let end;
    if (event.start.date) {
      // All-day event.
      start = new Date(event.start.date);
      end = new Date(event.end.date);
      console.log(`[+ND] Event found: "${event.summary}" (ID ${event.id}), (${start.toLocaleDateString()} -- ${end.toLocaleDateString()})`);
    } else {
      // Events that don't last all day; they have defined start times.
      start = event.start.dateTime;
      end = event.end.dateTime;
      console.log(`[+ND] Event found: "${event.summary}" (ID ${event.id}), (${start.toLocaleString()})`);
    }
    let page_response = getPageFromEvent(event);

    if (page_response) {
      console.log(`[+ND] Event "${event.summary}" (ID ${event.id}) database page ${page_response.id} exists already. Attempting update.`);
      let tags = page_response.properties[TAGS_NOTION].multi_select;
      requests.push(
        updateDatabaseEntry(event, page_response.id, tags || [], false)
      );

      continue;
    }
    console.log("[+ND] Creating database entry.");

    try {
      requests.push(createDatabaseEntry(event));
    } catch (e) {
      if ((e instanceof InvalidEventError) && SKIP_BAD_EVENTS) {
        console.log(`[+ND] Skipping creation of event "${event.summary}" (ID ${event.id}) due to invalid properties.`);
        continue;
      }

      throw e;
    }
  }
  console.log(`[+ND] Finished parsing page. Sending batch request for ${requests.length} database entries.`);

  const responses = UrlFetchApp.fetchAll(requests);

  for (let i = 0; i < responses.length; i++) {
    let response = responses[i];
    if (response.getResponseCode() === 401) {
      throw new Error("[+ND] Notion token is invalid.");
    } else if (response.getResponseCode() === 404) {
      throw new Error("[+ND] Notion page not found.");
    } else if (response.getResponseCode() === 403) {
      throw new Error("[+ND] Notion page is private.");
    } else if (response.getResponseCode() !== 200) {
      throw new Error(response.getContentText());
    }
  }
}

/**
 * Update a database entry with new event information from a Google Calendar event
 * @param {CalendarEvent} event Modified Google Calendar event
 * @param {String} page_id Page ID of database entry
 * @param {String[]} existing_tags Existing tags of the page to keep.
 * @param {Boolean} multi Whenever or not the update is meant for a multi-fetch
 * @returns {*} request object if multi is true, fetch response if multi is false
 */
function updateDatabaseEntry(event, page_id, existing_tags = [], multi = true) {
  let properties = convertToNotionProperty(event, existing_tags);
  let archive = ARCHIVE_CANCELLED_EVENTS && event.status === "cancelled";

  return pushDatabaseUpdate(properties, page_id, archive, multi);
}

/**
 * Push update to notion database for page
 * @param {Object} properties
 * @param {String} page_id page id to update
 * @param {Boolean} archive whenever or not to archive the page
 * @param {Boolean} multi whenever or not to use single fetch, or return options for fetchAll
 * @returns {*} request object if multi, otherwise URL fetch response
 */
function pushDatabaseUpdate(properties, page_id, archive = false, multi = false) {
  const url = "https://api.notion.com/v1/pages/" + page_id;
  let payload = {};
  payload["properties"] = properties;
  payload["archived"] = archive;

  if (archive) {
    console.log("Archiving cancelled event.");
  }

  let options = {
    method: "PATCH",
    headers: getNotionHeaders(),
    muteHttpExceptions: true,
    payload: JSON.stringify(payload),
  };

  if (multi) {
    options["url"] = url;
    return options;
  }

  return UrlFetchApp.fetch(url, options);
}

/**
 * Create a new database entry for the event
 * @param {CalendarEvent} event modified GCal event object
 * @returns {*} request object
 */
function createDatabaseEntry(event) {
  const url = "https://api.notion.com/v1/pages";
  let payload = {};

  payload["parent"] = {
    type: "database_id",
    database_id: DATABASE_ID,
  };

  payload["properties"] = convertToNotionProperty(event);

  if (!checkNotionProperty(payload["properties"])) {
    throw new InvalidEventError("Invalid Notion property structure");
  }

  let options = {
    url: url,
    method: "POST",
    headers: getNotionHeaders(),
    muteHttpExceptions: true,
    payload: JSON.stringify(payload),
  };
  return options;
}

/**
 * Checks if the properties are valid for Notion
 *
 * @param {*} properties Properties object to check
 * @returns false if invalid, true if valid
 */
function checkNotionProperty(properties) {
  // Check if description is too long
  if (properties[DESCRIPTION_NOTION].rich_text[0].text.content.length > 2000) {
    console.log("Event description is too long.");
    return false;
  }

  return true;
}

/**
 * Determine if a page exists for the event, and the page needs to be updated. Returns page response if found.
 * @param {CalendarEvent} event
 * @param {string|undefined} on_before_date Max value of last sync date to consider. If Null or not provided, will not restrict. Default is null.
 * @returns {*} Page response if found.
 */
function getPageFromEvent(event, on_before_date = null) {
  let payload = {
    filter: {
      and: [
        {
          property: EVENT_ID_NOTION,
          rich_text: {
            equals: event.id
          }
        },
      ],
    },
  };

  if (on_before_date) {
    payload["filter"]["and"].push({
      property: LAST_SYNC_NOTION,
      date: { on_or_before: new Date(on_before_date).toISOString() },
    });
  }

  const response_data = notionFetch(getDatabaseURL(), payload, "POST");

  if (response_data.results.length > 0) {
    if (response_data.results.length > 1) {
      console.log(`Found multiple entries with event id ${event.id}. This should not happen. Only processing index zero entry.`);
    }

    return response_data.results[0];
  }
  return false;
}

/**
 * Retrieve notion page using page id
 * @deprecated This is not used anymore due to Notion API change on Aug 31, 2022, but kept for reference.
 * @param {Object} result
 * @param {String} property - notion property name key
 * @returns {Object} request response object
 */
function getPageProperty(result, property) {
  console.warn("Using deprecated function getPageProperty.");
  let page_id = result.id;
  try {
    let property_id = result.properties[property].id;

    const url =
      "https://api.notion.com/v1/pages/" +
      page_id +
      "/properties/" +
      property_id;
    return notionFetch(url, null, "GET");
  } catch (e) {
    throw new Error(
      `Error trying to get page property ${property} from page ${page_id}. Ensure that the database is setup correctly! EM: ${e.message}`
    );
  }
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
 * @param {CalendarEvent} event modified GCal event object
 * @param {String[]} existing_tags - existing tags to add to event
 * @returns {Object} notion property object
 */
function convertToNotionProperty(event, existing_tags = []) {
  let properties = getBaseNotionProperties(event.id, event.cal_name);

  properties[DESCRIPTION_NOTION] = {
    type: "rich_text",
    rich_text: [
      {
        text: {
          content: event.description || "",
        },
      },
    ],
  };

  properties[LOCATION_NOTION] = {
    type: "rich_text",
    rich_text: [
      {
        text: {
          content: event.location || "",
        },
      },
    ],
  };

  if (event.start) {
    let start_time;
    let end_time;

    if (event.start.date) {
      // All-day event.
      start_time = new Date(event.start.date);
      end_time = new Date(event.end.date);

      // Offset timezone
      start_time.setTime(
        start_time.getTime() + start_time.getTimezoneOffset() * 60 * 1000
      );
      end_time.setTime(
        end_time.getTime() + end_time.getTimezoneOffset() * 60 * 1000
      );

      // Offset by 1 day to get end date.
      end_time.setDate(end_time.getDate() - 1);

      start_time = start_time.toISOString().split("T")[0];
      end_time = end_time.toISOString().split("T")[0];

      end_time = start_time == end_time ? null : end_time;
    } else {
      // Events that don't last all day; they have defined start times.
      start_time = event.start.dateTime;
      end_time = event.end.dateTime;
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
            content: event.summary || "",
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
 * @returns {Object} - GCal event object, or false if the date property is not found
 */
function convertToGCalEvent(page_result) {
  let e_id = page_result.properties[EVENT_ID_NOTION].rich_text;
  e_id = flattenRichText(e_id);

  let e_summary = page_result.properties[NAME_NOTION].title;
  e_summary = flattenRichText(e_summary);

  let e_description = page_result.properties[DESCRIPTION_NOTION].rich_text;
  e_description = flattenRichText(e_description);

  let e_location = page_result.properties[LOCATION_NOTION].rich_text;
  e_location = flattenRichText(e_location);

  let dates = page_result.properties[DATE_NOTION];

  if (dates.date) {
    let all_day = dates.date.end === null;

    if (dates.date.start && dates.date.start.search(/([A-Z])/g) === -1) {
      dates.date.start += "T00:00:00";
      all_day = true;
    } else if (
      !dates.date.end &&
      dates.date.start &&
      dates.date.start.search(/([A-Z])/g) !== -1
    ) {
      all_day = false;
      let default_end = new Date(dates.date.start);
      default_end.setMinutes(default_end.getMinutes() + 30);

      dates.date.end = default_end.toISOString();
    } else if (dates.date.end && dates.date.end.search(/([A-Z])/g) === -1) {
      dates.date.end += "T00:00:00";
      all_day = true;
    }

    let event = {
      ...(e_id && { id: e_id }),
      ...(e_summary && { summary: e_summary }),
      ...(e_description && { description: e_description }),
      ...(e_location && { location: e_location }),
      ...(dates.date.start && { start: dates.date.start }),
      ...(dates.date.end && { end: dates.date.end }),
      all_day: all_day,
    };

    return event;
  } else {
    return false;
  }
}

/**
 * Parses Notion information from project properties and declares them into global variables.
 * @param {String} database_key - The key for the Property storing the current database's URL
 */
function parseNotionProperties(database_key) {
  let properties = PropertiesService.getScriptProperties();
  NOTION_TOKEN = properties.getProperty("NOTION_TOKEN");

  let reURLInformation =
    /^(([^@:\/\s]+):\/?)?\/?(([^@:\/\s]+)(:([^@:\/\s]+))?@)?([^@:\/\s]+)(:(\d+))?(((\/\w+)*\/)([\w\-\.]+[^#?\s]*)?(.*)?(#[\w\-]+)?)?$/;

  let database_url = properties.getProperty(database_key).match(reURLInformation);
  DATABASE_ID = database_url[13];
}

/**
 * Get notion page ID of corresponding GCal event. Returns null if no page found.
 * @param {CalendarEvent} event - Modified GCal event object
 */
function getPageId(event) {
  const payload = {
    filter: {
      and: [
        {
          property: EVENT_ID_NOTION,
          rich_text: {
            equals: event.id 
          }
        },
        {
          property: TAGS_NOTION,
          multi_select: {
            does_not_contain: IGNORE_SYNC_TAG_NAME
          }
        },
      ],
    },
  };

  const response_data = notionFetch(getDatabaseURL(), payload, "POST");

  if (response_data.results.length > 0) {
    if (response_data.results.length > 1) {
      console.log(`Found multiple entries with event id ${event.id}. This should not happen. Only processing index zero entry.`);
    }

    return response_data.results[0].id;
  }
  return null;
}

/**
 * Deals with event cancelled from GCal side
 * @param {CalendarEvent} event - Modified GCal event object
 */
function handleEventCancelled(event) {
  const page_id = getPageId(event);

  if (page_id) {
    updateDatabaseEntry(event, page_id, [], false);
  } else {
    console.log(`Event "${event.summary}" (ID ${event.id}) not found in Notion database. Skipping.`);
  }
}

/**
 * Delete events marked as cancelled in GCal
 */
function deleteCancelledEvents() {
  console.log("[-GCal] Deleting cancel tagged events from GCal");
  const payload = {
    filter: {
      property: TAGS_NOTION,
      multi_select: {
        contains: CANCELLED_TAG_NAME,
        does_not_contain: IGNORE_SYNC_TAG_NAME,
      },
    },
  };

  const response_data = notionFetch(getDatabaseURL(), payload, "POST");

  for (let i = 0; i < response_data.results.length; i++) {
    let result = response_data.results[i];

    let event_id = result.properties[EVENT_ID_NOTION].rich_text;
    event_id = flattenRichText(event_id);

    if (isPageUpdatedRecently(result) && event_id) {
      try {
        let calendar_id = result.properties[CALENDAR_ID_NOTION].select.name;

        console.log(`[-GCal] Deleting event "${flattenRichText(result.properties[NAME_NOTION].title)}" (ID ${event_id}) from GCal because it is marked as cancelled in Notion.`);
        deleteEvent(event_id, calendar_id);
      } catch (e) {
        if (e instanceof TypeError) {
          console.error("[-GCal] Error. Page missing calendar ID or event ID.", e);
        } else {
          throw e;
        }

      } finally {
        ARCHIVE_CANCELLED_EVENTS
          ? pushDatabaseUpdate([], result.id, true)
          : null;
      }
    }
  }
}

/** Delete event from Google Calendar
 * @param {String} event_id - Event id to delete
 * @param {String} calendar_id - Calendar id to delete event from
 * @returns {Boolean} - True if event was deleted, false if not
 */
function deleteEvent(event_id, calendar_id) {
  console.log(`Deleting event with ID ${event_id} from Google Calendar "${calendar_id}".`);
  try {
    let calendar = CalendarApp.getCalendarById(calendar_id);
    calendar.getEventById(event_id).deleteEvent();
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

/**
 * Determine if a page result has been updated since the last recorded sync
 * @param {Object} page_result - Page result from Notion database
 * @return {Boolean} - True if page has been updated recently, false otherwise
 */
function isPageUpdatedRecently(page_result) {
  let last_sync_date = page_result.properties[LAST_SYNC_NOTION];
  last_sync_date = last_sync_date.date ? last_sync_date.date.start : 0;

  return new Date(last_sync_date) < new Date(page_result.last_edited_time);
}

/**
 * Flattens rich text properties into a singular string.
 * @param {Object} rich_text_result - Rich text property to flatten
 * @return {String} - Flattened rich text
 * */
function flattenRichText(rich_text_result) {
  let plain_text = "";
  for (let i = 0; i < rich_text_result.length; i++) {
    plain_text += rich_text_result[i].rich_text
      ? rich_text_result[i].rich_text.plain_text
      : rich_text_result[i].plain_text;
  }
  return plain_text;
}

/**
 * Create event to Google Calendar. Return event ID if successful.
 * @param {Object} page - Page object from Notion database
 * @param {Object} event - Event object for GCal
 * @param {String} calendar_name - name of calendar to push event to
 * @return {String} - Event ID if successful, false otherwise
 */
function createEvent(page, event, calendar_name) {
  event.summary = event.summary || "";
  event.description = event.description || "";
  event.location = event.location || "";

  let calendar_id = CALENDAR_IDS[calendar_name];
  let options = [event.summary, new Date(event.start)];

  if (event.end && event.all_day) {
    // add and shift
    let shifted_date = new Date(event.end);
    shifted_date.setDate(shifted_date.getDate() + 1);
    options.push(shifted_date);
  } else if (event.end) {
    options.push(new Date(event.end));
  }

  options.push({ description: event.description, location: event.location });

  let calendar = CalendarApp.getCalendarById(calendar_id);
  let new_event_id;
  try {
    let new_event = event.all_day
      ? calendar.createAllDayEvent(...options)
      : calendar.createEvent(...options);

    new_event_id = new_event.getId().split("@")[0];

    if (!new_event_id) {
      console.log(`Event "${event.summary}" not created in GCal.`);
      return false;
    }

    // Set a tag indicating which Notion DB this event belongs to
    new_event.setTag(GCAL_DB_TAG_KEY, DATABASE_ID);
  } catch (e) {
    console.error("Failed to push new event to GCal.", e);
    return false;
  }

  let properties = getBaseNotionProperties(new_event_id, calendar_name);
  pushDatabaseUpdate(properties, page.id);
  return new_event_id;
}

/**
 * Update a Google Calendar event
 * @param {CalendarEvent} event - Modified event object for GCal
 * @param {String} page_id - Page ID of Notion page to update
 * @param {String} calendar_id - Calendar ID of calendar to update event from
 * @return {Boolean} True if successful, false otherwise
 */
function pushEventUpdate(event, event_id, calendar_id) {
  event.summary = event.summary || "";
  event.description = event.description || "";
  event.location = event.location || "";

  try {
    let calendar = CalendarApp.getCalendarById(calendar_id);
    let cal_event = calendar.getEventById(event_id);

    cal_event.setDescription(event.description);
    cal_event.setTitle(event.summary);
    cal_event.setLocation(event.location);

    if (event.end && event.all_day) {
      // all day, multi day
      let shifted_date = new Date(event.end);
      shifted_date.setDate(shifted_date.getDate() + 2);
      cal_event.setAllDayDates(new Date(event.start), shifted_date);
    } else if (event.all_day) {
      // all day, single day
      cal_event.setAllDayDate(new Date(event.start));
    } else {
      // not all day
      cal_event.setTime(new Date(event.start), new Date(event.end) || null);
    }
    return true;
  } catch (e) {
    console.error("Failed to push event update to GCal.", e);
    return false;
  }
}

/**
 * Error thrown when an event is invalid and cannot be
 * pushed to either Google Calendar or Notion.
 */
class InvalidEventError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidEventError";
  }
}
