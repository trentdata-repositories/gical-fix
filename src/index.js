// === HELPERS === 
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
async function write(env, path, pathApple, calendarNew, calendarNewApple) {
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

  const tree = await repo("POST", "/git/trees", {
    tree: [
      {
        path: path,
        mode: "100644",
        type: "blob",
        content: calendarNew
      },
      {
        path: pathApple,
        mode: "100644",
        type: "blob",
        content: calendarNewApple
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

function gcalHtmlToPlain(html) {
  return html
    .replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N") ? "\n" : c)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      text = text.replace(/<[^>]+>/g, "").trim();
      return (!text || text === href) ? href : `${text} (${href})`;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
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

    // --- Preliminary iCalendar screening
    var attachments = [];
    lines.forEach(l => {
      if(!l) return;

      // Grab attachments
      if(l.startsWith("ATTACH")) {
        const match = l.match(/^ATTACH(;[^:]+)*:((?:[a-zA-Z][a-zA-Z0-9+.-]*):\/\/?.*)$/);
        if(!match) return;

        const fileName = l.match(/;FILENAME="?([^";]+)"?/i)?.[1] ?? null;
        attachments.push([fileName, match[2]])
      }
    });

    // --- Convert to compatible formats
    let linesNew = [], linesNewApple = [];
    if(!env.SOURCE_HTML || env.SOURCE_HTML === "false") {
      linesNew = lines.filter(Boolean).map(l => fold(l));
      linesNewApple = linesNew;

    } else {
      lines.forEach(l => {

        // Skip empty lines.
        if(!l) return;

        // Copy DESCRIPTION into X-ALT-DESC for Outlook clients
        if(l.startsWith("DESCRIPTION")) {
          const description = l.slice(l.indexOf(":") + 1);
          linesNew.push(fold("DESCRIPTION:" + description));
          linesNew.push(fold("X-ALT-DESC;FMTTYPE=text/html:" + description));
          linesNewApple.push(fold("DESCRIPTION:" + gcalHtmlToPlain(description)))
          return;
        }

        const foldedLine = fold(l);
        linesNew.push(foldedLine);
        linesNewApple.push(foldedLine);
      });
    }

    // Overwrite the old file in repo.
    try {
      await write(
        env,
        env.OUTPUT_KEY,
        env.OUTPUT_KEY_APPLE,
        linesNew.join("\r\n") + "\r\n",
        linesNewApple.join("\r\n") + "\r\n"
      );
    }
    catch (e) {
      console.error("Failed to write to repository!\n", e);
    }
  },
};