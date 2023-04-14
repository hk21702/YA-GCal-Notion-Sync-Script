const NAME_NOTION = "Name";
const DATE_NOTION = "Date";
const TAGS_NOTION = "Tags";
const LOCATION_NOTION = "Location";
const DESCRIPTION_NOTION = "Description";

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

function main() {
  parseNotionProperties();

  if (DELETE_CANCELLED_EVENTS) {
    deleteCancelledEvents();
  }

  let modified_eIds = syncToGCal();

  modified_eIds = IGNORE_RECENTLY_PUSHED ? modified_eIds : new Set();

  for (var c_name of Object.keys(CALENDAR_IDS)) {
    syncFromGCal(c_name, false, modified_eIds);
  }
}

/**
 * Syncs all calendars from google calendar to Notion using a full sync.
 *
 * -- Will discard the old page token and generate a new one. --
 * -- Will reset time min and time max to use the the current time as origin time --
 **/
function fullSync() {
  parseNotionProperties();

  console.log(
    "Preforming full sync. Page token, time min, and time max will be reset."
  );

  for (var c_name of Object.keys(CALENDAR_IDS)) {
    syncFromGCal(c_name, true, new Set());
  }
}

/**
 * Sync to google calendar from Notion
 * @returns {Set[String]} - Array of event IDs that were modified through event creation
 */
function syncToGCal() {
  console.log("[+GC] Syncing to Google Calendar.");
  // Get 100 pages in order of when they were last edited.
  const url = getDatabaseURL();
  const payload = {
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    filter: {
      property: TAGS_NOTION,
      multi_select: {
        does_not_contain: IGNORE_SYNC_TAG_NAME,
      },
    },
  };
  const response_data = notionFetch(url, payload, "POST");

  let modified_eIds = new Set();

  for (let i = 0; i < response_data.results.length; i++) {
    let result = response_data.results[i];

    if (!isPageUpdatedRecently(result)) {
      continue;
    }

    let event = convertToGCalEvent(result);

    if (!event) {
      console.log(
        "[+GC] Skipping page %s because it is not in the correct format and or is missing required information.",
        result.id
      );
      continue;
    }

    let calendar_id = result.properties[CALENDAR_ID_NOTION].select;
    calendar_id = calendar_id ? calendar_id.name : null;

    let calendar_name = result.properties[CALENDAR_NAME_NOTION].select;
    calendar_name = calendar_name ? calendar_name.name : null;

    if (CALENDAR_IDS[calendar_name] && calendar_id && event.id) {
      if (calendar_id === CALENDAR_IDS[calendar_name]) {
        // Update event in original calendar.
        console.log("[+GC] Updating event %s in %s.", event.id, calendar_name);
        pushEventUpdate(event, event.id, calendar_id);

        continue;
      }
      // Event being moved to a new calendar - delete from old calendar and then create using calendar name
      let modified_eId;
      if (
        deleteEvent(event.id, calendar_id) &&
        (modified_eId = createEvent(result, event, calendar_name))
      ) {
        console.log("[+GC] Event %s moved to %s.", event.id, calendar_name);
        modified_eIds.add(modified_eId);

        continue;
      }

      console.log(
        "[+GC] Event %s failed to move to %s.",
        event.id,
        calendar_name
      );

      continue;
    }

    if (CALENDAR_IDS[calendar_name]) {
      // attempt to create using calendar name
      let modified_eId;
      if ((modified_eId = createEvent(result, event, calendar_name))) {
        console.log("[+GC] Event created in %s.", calendar_name);
        modified_eIds.add(modified_eId);
      }
      continue;
    }
    // Calendar name not found in dictonary. Abort.
    console.log(
      "[+GC] Calendar name %s not found in dictionary. Aborting sync.",
      calendar_name
    );
  }
  return modified_eIds;
}

/**
 * Syncs from google calendar to Notion
 * @param {String} c_name Calendar name
 * @param {Boolean} fullSync Whenever or not to discard the old page token
 * @param {Set[String]} ignored_eIds Event IDs to not act on.
 */
function syncFromGCal(c_name, fullSync, ignored_eIds) {
  console.log("[+ND] Syncing from Google Calendar: %s", c_name);
  let properties = PropertiesService.getUserProperties();
  let options = {
    maxResults: 100,
    singleEvents: true, // allow recurring events
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
        syncFromGCal(CALENDAR_IDS[c_name], true, ignored_eIds);
        return;
      } else {
        throw new Error(e.message);
      }
    }

    events["c_name"] = c_name;

    if (events.items && events.items.length === 0) {
      console.log("[+ND] No events found. %s", c_name);
      return;
    }
    console.log("[+ND] Parsing new events. %s", c_name);
    parseEvents(events, ignored_eIds);

    pageToken = events.nextPageToken;
  } while (pageToken);

  properties.setProperty("syncToken", events.nextSyncToken);
}

/**
 * Determine if gcal events need to be updated, removed, or added to the database
 * @param {CalendarEvent[]} events Google calendar events
 * @param {Set[String]} ignored_eIds Event IDs to not act on.
 */
function parseEvents(events, ignored_eIds) {
  let requests = [];
  for (let i = 0; i < events.items.length; i++) {
    let event = events.items[i];
    event["c_name"] = events["c_name"];
    if (ignored_eIds.has(event.id)) {
      console.log("[+ND] Ignoring event %s", event.id);
      continue;
    }
    if (event.status === "cancelled") {
      console.log("[+ND] Event %s was cancelled.", event.id);
      // Remove the event from the database
      handleEventCancelled(event);
      continue;
    }
    let start;
    let end;

    if (event.start.date) {
      // All-day event.
      start = new Date(event.start.date);
      end = new Date(event.end.date);
      console.log(
        "[+ND] Event found %s %s (%s -- %s)",
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
        "[+ND] Event found %s %s (%s)",
        event.id,
        event.summary,
        start.toLocaleString()
      );
    }
    let page_response = getPageFromEvent(event);

    if (page_response) {
      console.log(
        "[+ND] Event %s database page %s exists already. Attempting update.",
        event.id,
        page_response.id
      );
      let tags = page_response.properties[TAGS_NOTION].multi_select;
      requests.push(
        updateDatabaseEntry(event, page_response.id, tags || [])
      );

      continue;
    }
    console.log("[+ND] Creating database entry.");

    try {
      requests.push(createDatabaseEntry(event));
    } catch (err) {
      if ((err instanceof InvalidEventError) && SKIP_BAD_EVENTS) {
        console.log(
          "[+ND] Skipping creation of event %s due to invalid properties.",
          event.id
        );

        continue;
      }

      throw err;
    }
  }
  console.log("[+ND] Finished parsing page. Sending batch request.");

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
 * Update database entry with new event information
 * @param {CalendarEvent} event Modified Google calendar event
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
function pushDatabaseUpdate(
  properties,
  page_id,
  archive = false,
  multi = false
) {
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
  const url = getDatabaseURL();
  let payload = {
    filter: {
      and: [{ property: EVENT_ID_NOTION, rich_text: { equals: event.id } }],
    },
  };

  if (on_before_date) {
    payload["filter"]["and"].push({
      property: LAST_SYNC_NOTION,
      date: { on_or_before: new Date().toISOString(on_before_date) },
    });
  }

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
 * @deprecated This is not used anymore due to Notion API change on Aug 31, 2022, but kept for reference.
 * @param {Object} result
 * @param {String} property - notion property name key
 * @returns {Object} request response object
 */
function getPageProperty(result, property) {
  console.log("Warning. Using deprecated function getPageProperty.");
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
  let properties = getBaseNotionProperties(event.id, event.c_name);

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
 * @returns {Object} - GCal event object Return False if required properties not found
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
 * Parses Notion information from project properties and declares them into global variables
 */
function parseNotionProperties() {
  let properties = PropertiesService.getScriptProperties();
  NOTION_TOKEN = properties.getProperty("NOTION_TOKEN");

  let reURLInformation =
    /^(([^@:\/\s]+):\/?)?\/?(([^@:\/\s]+)(:([^@:\/\s]+))?@)?([^@:\/\s]+)(:(\d+))?(((\/\w+)*\/)([\w\-\.]+[^#?\s]*)?(.*)?(#[\w\-]+)?)?$/;

  let database_url = properties
    .getProperty("DATABASE_ID")
    .match(reURLInformation);
  DATABASE_ID = database_url[13];
}

/**
 * Get notion page ID of corresponding gCal event. Returns null if no page found.
 * @param {CalendarEvent} event - Modiffied gCal event object
 */
function getPageId(event) {
  const url = getDatabaseURL();
  const payload = {
    filter: {
      and: [
        { property: EVENT_ID_NOTION, rich_text: { equals: event.id } },
        {
          property: TAGS_NOTION,
          multi_select: {
            does_not_contain: IGNORE_SYNC_TAG_NAME,
          },
        },
      ],
    },
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
 * @param {CalendarEvent} event - Modiffied gCal event object
 */
function handleEventCancelled(event) {
  const page_id = getPageId(event);

  if (page_id) {
    updateDatabaseEntry(event, page_id, [], false);
  } else {
    console.log("Event %s not found in Notion database. Skipping.", event.id);
  }
}

/** Delete events marked as cancelled in gcal */
function deleteCancelledEvents() {
  console.log("[-GCal] Deleting cancel tagged events from GCal");
  const url = getDatabaseURL();
  const payload = {
    filter: {
      property: TAGS_NOTION,
      multi_select: {
        contains: CANCELLED_TAG_NAME,
        does_not_contain: IGNORE_SYNC_TAG_NAME,
      },
    },
  };
  const response_data = notionFetch(url, payload, "POST");

  for (let i = 0; i < response_data.results.length; i++) {
    let result = response_data.results[i];

    if (isPageUpdatedRecently(result)) {
      try {
        let event_id = result.properties[EVENT_ID_NOTION].rich_text;
        let calendar_id = result.properties[CALENDAR_ID_NOTION].select.name;

        event_id = flattenRichText(event_id);

        deleteEvent(event_id, calendar_id);
      } catch (e) {
        if (e instanceof TypeError) {
          console.log("[-GCal] Error. Page missing calendar id or event ID");
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

/** Delete event from Google calendar
 * @param {String} event_id - Event id to delete
 * @param {String} calendar_id - Calendar id to delete event from
 * @returns {Boolean} - True if event was deleted, false if not
 */
function deleteEvent(event_id, calendar_id) {
  console.log("Deleting event %s from gCal %s", event_id, calendar_id);
  try {
    let calendar = CalendarApp.getCalendarById(calendar_id);
    calendar.getEventById(event_id).deleteEvent();
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

/** Create event to Google calendar. Return event ID if successful
 * @param {Object} page - Page object from Notion database
 * @param {Object} event - Event object for gCal
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
  try {
    let new_event = event.all_day
      ? calendar.createAllDayEvent(...options)
      : calendar.createEvent(...options);

    new_event_id = new_event.getId().split("@")[0];
  } catch (e) {
    console.log("Failed to push new event to GCal. %s", e);
    return false;
  }

  if (!new_event_id) {
    console.log("Event %s not created in gCal.", event.summary);
    return false;
  }

  let properties = getBaseNotionProperties(new_event_id, calendar_name);
  pushDatabaseUpdate(properties, page.id);
  return new_event_id;
}

/** Update Google calendar event
 * @param {CalendarEvent} event - Modified event object for gCal
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
    console.log("Failed to push event update to GCal. %s", e);
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
