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

## Setup Instructions

### Notion API/Integration Setup

TODO. For now just look up how to do this. There are lots of tutorials out there and its fast and simple. Remember, NEVER share your integration key! You will need it later in the setup process though.

### Database

Set up your database with the following properties. You may add additional properties or reorder them, but the ones shown are required.

![Database Image](https://github.com/hk21702/YA-GCal-Notion-Sync-Script/blob/main/images/database.png?raw=true)

| Name  | Date | Tags         | Calendar | Description | Event ID | Calendar ID | Last Sync |
| ----- | ---- | ------------ | -------- | ----------- | -------- | ----------- | --------- |
| Title | Date | Multi-select | Select   | Text        | Text     | Select      | Date      |

The listed property names are the default names. You may change them, but these modification needs to also be applied to the constants at the top of the script.

Share your database with the Notion Integration you set up earlier!

**_Do not touch the values under Event ID, Calendar ID, or Last Sync._**

If you'd like, add the Tag `Cancelled/Removed` to _Tags_ such that you may delete events from Notion. The color does not matter. This can also be changed to a different name if as long as you modify the global variable in the main script.

### Google Apps Script Setup

Go to [Google Apps Scripts](https://script.google.com/home/start) and create a new project.

#### Scripts

Copy the contents of `main.js` and `calendarIds.js` from this Github repository into separate files within your project. Naming your file is not required but is recommended!

#### Adding the Calendar Service

In the editor view which you should still be in currently, click the plus button next to **Services**. Then, in the popup, set the identifier field to ```Calendar``` or just search for the Google Calendar service. Then go ahead and click **add** on the popup and the calendar service should be added to the project.

#### Setting up your keys

Go into your project settings within Apps Script by clicking the cogwheel icon on the left side of the screen.

At the bottom, you will see a Script Properties section with the button **Edit script properties**. Click this once. Then click the button **Add script property** twice. Two new lines of text fields should show up.

Now to set up the database ID. Set one of the **Property** fields to `DATABASE_ID` and set its corresponding **Value** to the **LINK/URL** of the database that you wish to use. There is no need to extract the database ID itself from the link.

Next we'll add the Notion integration token. Set the **Property** field to `NOTION_TOKEN`. Set its corresponding **_Value_** to the Notion Internal Integration Token we got from earlier. If you have multiple integrations for some reason, this must be the integration you shared the database with.

Click the **Save script properties** button once you're all done to save!

Your end result should look something like this.

![Script Keys Image](https://github.com/hk21702/YA-GCal-Notion-Sync-Script/blob/main/images/script_keys.png?raw=true)

#### Adding Calendars

By default, the script will only sync with your primary google calendar. If you wish to add more, or ignore the primary calendar, you will need to modify the calendarIds.js file. You will need to add the calendar's iCal ID as well as an arbitrary name you want to call it.

#### Triggers

Triggers is an Apps Script feature that allows for the script to be ran automatically based on a variety of events. Triggers can be set to activate at a certain time, every x amount of time, whenever your Google Calendar is updated, and more!

Click the **clock** icon on the left side of the screen to get to the triggers page. Then add a trigger with settings of your choosing. ***The function to be run should be set to ```main```***

You can have multiple triggers. It is recommended that you have one based on a time interval of your choosing, and another based on your Google calendars being updated. 

To set up the calendar update trigger, set the **event source** to be ```From calendar``` and fill out the **owner email field**.

To set up interval based triggers, set the **event source** to ```Time-driven```. Pick anything for the type of time based trigger though it should probably be set to something like every 15 minutes.

#### First Run
Once you got to this point in the process, you should be all done with the setup! It is recommended that you manually trigger the script once though so you can give your script access to GCal. Go back to the main script by clicking the button on the left hand side that looks like ```< >``` labeled editor. Make sure that the script being shown is the big main one. Then, ensure that the drop down menu next to the Run and Debug buttons is set to ```main```. Then, you can click **Run** or **Debug** to run the script! On your first run, the script will ask you to give access to GCal. A popup should come up asking you to sign in, give access, and all that. Do as its told and allow the script to access GCal.

## Known limitations/Bugs

- Sync from Notion sometimes doesn't register when the page was recently updated by GCal
  - Caused by lack of precision in Notion's last edited timestamp
- Will only check 100 most recently edited pages in database
  - Caused by Notion API limit
- Rich text (bolding, italics, etc.) used in the description will be overwritten to plain text after syncing.
