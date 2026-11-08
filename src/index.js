// === IMPORTS ===
import { Temporal } from '@js-temporal/polyfill';

// === GLOBAL VARIABLES ===
const props = ["DTSTART", "DTEND", "RECURRENCE-ID", "EXDATE", "RDATE", "DUE"];

// === HELPER FUNCTIONS === 
/* --- Fold Lines w/ 75+ Octets (RFC 5545 §3.1)
 * Long lines greater than 75 octets will be moved to the next line w/ a
 * leading space character as per the RFC-defined format.
 */
const encoder = new TextEncoder();
function fold(l) {

  // If the line does not need to be folded, do nothing.
  if (encoder.encode(l).length <= 75) return l;

  const parts = [];
  let cur = "", size = 0, limit = 75;
  [...l].forEach(ch => {
    const n = encoder.encode(ch).length;

    // If next character would be over the line limit, push this segment and push this character to next line.
    if(size + n > limit) {
      parts.push(cur);
      cur = ch;
      size = n;
      limit = 74; // Continuation lines start with a leading space.
    }

    // Iterate to next character otherwise.
    else {
      cur += ch;
      size += n;
    }
  });

  // Push folded line
  parts.push(cur);
  return parts.join("\r\n ");
}

/* --- Write to Remote Repository */
async function write(env, path, content) {
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "ics-worker",
    Accept: "application/vnd.github+json"
  };

  const repo = async(method, url, body) => {
    const r = await fetch(env.REPO_API + url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    if(!r.ok)
      throw new Error("The method \"" + method + "\" at " + url + " failed!\n" + r.status);

    return r.json();
  }

  const cur = await fetch(`${env.REPO_API}/contents/${path}?ref=${env.REPO_BRANCH}`, {
    headers: {
      ...headers,
      Accept: "application/vnd.github.raw+json"
    }
  });

  if(cur.ok && (await cur.text()) === content) {
    console.log("Calendar has not changed, skipping commit...");
    return;
  }

  const tree = await repo("POST", "/git/trees", {
    tree: [
      {
        path,
        mode: "100644",
        type: "blob",
        content
      },
      {
        path: ".nojekyll",
        mode: "100644",
        type: "blob",
        content: ""
      }
    ]
  });

  const commit = await repo("POST", "/git/commits", {
    message: "calendar update",
    tree: tree.sha,
    parents: []
  });

  await repo("PATCH", `/git/refs/heads/${env.REPO_BRANCH}`, {
    sha: commit.sha,
    force: true
  })

  console.log("New calendar was committed: " + commit.sha);
}

// === TIME TRIGGERED EVENT ===
export default {
  async scheduled(event, env, ctx) {

    // --- Grab VTIMEZONE iCalendar file
    let vtz;
    try {
      const r = await fetch(env.TZ_URL + env.TZ);
        
      if(!r.ok)
        throw new Error("HTTP error! Status: " + r.status);

      const cal = (await r.text()).replace(/\r?\n[ \t]/g, "");
      const match = cal.match(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/);

      if(!match)
        throw new Error("Returned File has no VTIMEZONE in response!\n" + cal);

      vtz = match[0].split(/\r?\n/);

    }
    catch(e) {
      console.error("Fetch failed:", e)
      return;
    }

    // --- Grab iCalendar
    let lines;
    try {
      const r = await fetch(env.ICS_URL);

      if(!r.ok)
        throw new Error('HTTP error! Status: ' + r.status);

      const cal = (await r.text()).replace(/\r?\n[ \t]/g, "");
      lines = cal.split(/\r?\n/);
      if (lines[0] !== "BEGIN:VCALENDAR")
        throw new Error("Returned File is Not Valid iCalendar!\n" + cal);

    // Log an error and exit to process to keep old healthy file when iCalendar cannot be fetched.
    }
    catch(e) {
      console.error("Fetch failed:", e)
      return;
    }

    // --- Convert iCalendar Times
    const linesNew = [];
    lines.forEach(l => {
      // Skip empty lines.
      if(!l) return;

      // Modify properties containing times.
      if(props.some(p => l.startsWith(p + ":"))) {

        // Get property [0] (separated by ':') and times [1]+ (separated by ',').
        try {
          const comps = l.split(/[:,]/);

          // Convert each time into desired timezone string in proper format.
          const times = comps.slice(1).map(t => {
            return Temporal.Instant.from(t)
              .toZonedDateTimeISO(env.TZ)
              .toPlainDateTime()
              .toString({ smallestUnit: 'second' })
              .replaceAll(/[:-]/g, "");
          });

          // Push newly modified line to the modified iCalendar array.
          linesNew.push(fold(comps[0] + ";TZID=" + env.TZ + ":" + times.join(",")));
          return;

        // Catch time conversion errors. Typically when time does not end in 'Z'. Default to leaving the line.
        }
        catch(e) { console.error('Time conversion error:', e); }
      }

      // Place VTIMEZONE in the iCalendar.
      else if("END:VCALENDAR" === l) linesNew.push(...vtz); // Add VTIMEZONE block (not present in Google Calendar iCalendar files).
      linesNew.push(fold(l));
    });

    // Join all new iCalendar files into one string for writing to file in repo.
    const calNew = linesNew.join("\r\n") + "\r\n";

    // Overwrite the old file in repo.
    try {
      await write(env, env.OUTPUT_KEY, calNew);
    }
    catch (e) {
      console.error("Failed to write to repository!\n", e);
    }
  },
};