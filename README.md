# Yet Another Two Way Notion-Google Calendar Sync Script

A script to sync events between Google calendar and a Notion database.

## Features!

- Google App Script based
  - Script hosted by Google
  - Trigger the scripts automatically with triggers
    - Time Intervals
    - GCal Updates
  - Logs that are saved and can be looked at later
- Sync both from Google Calendar, and from Notion
  - Creation
  - Updates
    - Changing calendars from Notion
  - Deletions
- Multi-calendar support
- Support for recurring Events (Only available by setting through GCal)
- No Notion formulas
- Flexible property names
  - Can be modified easily in the code
- Support for all day events, multi day events and scheduled events
- Ignore sync tag
  - Marks a page such that the script will ignore that event entirely when syncing in either direction

## For setup instructions and FAQ, please go to the [wiki!](https://github.com/hk21702/YA-GCal-Notion-Sync-Script/wiki)

## Known limitations/Bugs

- Sync from Notion sometimes doesn't register when the page was recently updated by GCal
  - Caused by lack of precision in Notion's last edited timestamp
- Will only check 100 most recently edited pages in database
  - Caused by Notion API limit
- Rich text (bolding, italics, etc.) used in the description will be overwritten to plain text after syncing.
- Doesn't seem to work with auto-generated calendars such as Birthdays. Might be a limitation of GCal API. See https://github.com/hk21702/YA-GCal-Notion-Sync-Script/issues/3
