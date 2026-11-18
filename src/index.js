// === GLOBAL VARIABLES ===
const props = ["DTSTART", "DTEND", "RECURRENCE-ID", "EXDATE", "RDATE", "DUE"];
const dscr = "DESCRIPTION";

// === HELPERS === 
const txtEscape = t => t
  .replace(/\\/g, "\\\\")
  .replace(/;/g, "\\;")
  .replace(/,/g, "\\,")
  .replace(/\r?\n/g, "\\n");

const txtUnescape = t => t
  .replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N") ? "\n" : c);

const htmlToTxt = h => h
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<li[^>]*>/gi, "\n• ")
  .replace(/<\/(p|div|ul|ol|h[1-6])>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
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
    var TZ;
    lines.forEach(l => {
      // Skip empty lines.
      if(!l) return;

      // Get calendar timezone
      if(l.startsWith("X-WR-TIMEZONE")) {
        TZ = l.split(/[:]/)[1];
      }

      // Convert DESCRIPTION into Outlook compatible format
      if(l.startsWith(dscr)) {
        const dscrTxt = l.slice(l.indexOf(":") + 1);
        linesNew.push(fold(dscr + ":" + txtEscape(htmlToTxt((txtUnescape(dscrTxt))))));
        linesNew.push(fold("X-ALT-DESC;FMTTYPE=text/html:" + dscrTxt));
        return;
      }

      // Modify properties containing times.
      if(props.some(p => l.startsWith(p + ":"))) {

        // Get property [0] (separated by ':') and times [1]+ (separated by ',').
        const comps = l.split(/[:,]/);

        // Convert each time into desired timezone string in proper format.
        const times = comps.slice(1).map(t => {
          if(t.endsWith('Z')) return t.slice(0, -1)
          else return t;
        });

        // Push newly modified line to the modified iCalendar array.
        linesNew.push(fold(comps[0] + ";TZID=" + TZ + ":" + times.join(",")));
        return;
      }

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