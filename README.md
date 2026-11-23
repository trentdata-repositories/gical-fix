# Google iCalendar Subscribe Fix
gical-fix is a thin middleware intended to be run on a worker of some kind (we use Cloudflare). Its purpose is to convert the simple HTML that Google Calendar exports in its ICS files in the `DESCRIPTION` fields, which become unreadable when imported into / subscribed to by other clients such as Outlook and iCloud Calendar.

We host the generated ICS files on a separate repository for security purposes, as a PAT is required by the worker to commit to the calendar repository.

## Overview of how gical-fix works
1. A deployed worker fetches a public URL leading to an ICS file (e.g. DATA Events: https://calendar.google.com/calendar/ical/c_91123c3fa558dcd581cc78e8cdd0ddf3aade6bb9eb63494ca8e9e0f30d6275a8%40group.calendar.google.com/public/basic.ics).
2. If the source is in HTML, we strip the HTML and provide a plaintext description of the event / `VEVENT` for clients such as iCloud Calendar that cannot read HTML. We then copy the HTML description into an `X-ALT-DESC` field to be properly interpreted as HTML by clients such as Outlook Calendar.
3. If the source is not in HTML, we provide the basic plaintext description to both generated ICS files.

## Planned features / roadmap
- [ ] Attached files will be added to the `DESCRIPTION` field of `VEVENT`s containing `ATTACH` fields so that files / links can be viewed by subscribed clients.
- [ ] The ability to disable either the plaintext / iCloud Calendar generation and / or the HTML calendar generation for those who do not wish to have it enabled for whatever reason.
- [ ] A guide on how to deploy a Cloudflare worker using this repository yourself.

## Variables to define in worker
- `ICS_URL`: The URL of the public ICS file that your worker will convert into compatible formats.
- `GITHUB_TOKEN` (**STORE AS SECRET**): Your PAT with access to your chosen repository.
- `REPO_API`: The API endpoint for your worker to communicate with (e.g. `https://api.github.com/repos/trentdata-repositories/icalendar-host-page`).
- `REPO_BRANCH`: The specific branch to commit to on the repository specified by your `REPO_API` value.
- `OUTPUT_KEY`: The file name of the HTML-formatted ICS file (typically used for Outlook clients).
- `OUTPUT_KEY_APPLE`: The file name of the generic (non-HTML) formatted ICS file (typically used for iCloud Calendar, but also applies to all clients that cannot read HTML `DESCRIPTION` fields).
- `SOURCE_HTML` (Boolean): Whether the source ICS file defined by `ICS_URL` has a `DESCRIPTION` field formatted in HTML (when `false`, both HTML and regular / iCloud ICS files will be identical).