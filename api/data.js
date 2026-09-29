// /api/data — shared-data sync endpoint for the Malawi app.
// GET  -> returns the current shared db.json content (or {} if none yet)
// POST -> overwrites the shared db.json content with the request body
//
// Storage: a JSON file committed to a separate "data" branch of this same
// GitHub repo (kept off "main" so syncs never trigger a site rebuild).
// Requires one Vercel project environment variable: GH_TOKEN (a GitHub
// Personal Access Token with `repo` scope, or a fine-grained token scoped to
// just this repository's Contents permission). Nothing else is secret, so
// everything else is a plain constant below.

const GH_OWNER = process.env.GH_OWNER || "mas-dotcom";
const GH_REPO = process.env.GH_REPO || "malawi";
const GH_BRANCH = process.env.GH_BRANCH || "data";
const GH_PATH = process.env.GH_PATH || "data/db.json";
const GH_TOKEN = process.env.GH_TOKEN || "";

const API_BASE = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`;

async function ghGetFile() {
  const r = await fetch(`${API_BASE}?ref=${encodeURIComponent(GH_BRANCH)}`, {
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (r.status === 404) return { sha: null, content: null };
  if (!r.ok) throw new Error(`GitHub GET ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const content = Buffer.from(j.content, "base64").toString("utf-8");
  return { sha: j.sha, content };
}

async function ghPutFile(newContent, sha) {
  const body = {
    message: "sync: update shared data",
    content: Buffer.from(newContent, "utf-8").toString("base64"),
    branch: GH_BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await fetch(API_BASE, {
    method: "PUT",
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${r.status}: ${await r.text()}`);
  return r.json();
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (!GH_TOKEN) {
    res.status(503).json({
      error:
        "Sync isn't configured yet: the GH_TOKEN environment variable is missing on this Vercel project.",
    });
    return;
  }
  try {
    if (req.method === "GET") {
      const { content } = await ghGetFile();
      res.setHeader("Cache-Control", "no-store");
      res.status(200).send(content == null ? "{}" : content);
      return;
    }
    if (req.method === "POST") {
      let bodyStr;
      if (req.body && typeof req.body === "object") bodyStr = JSON.stringify(req.body);
      else if (typeof req.body === "string" && req.body.length) bodyStr = req.body;
      else bodyStr = await readRawBody(req);
      if (!bodyStr) {
        res.status(400).json({ error: "Empty body." });
        return;
      }
      // parse+restringify to validate JSON before committing
      JSON.parse(bodyStr);
      let sha = null;
      try {
        sha = (await ghGetFile()).sha;
      } catch (e) {}
      try {
        await ghPutFile(bodyStr, sha);
      } catch (e) {
        // sha race (someone else wrote in between) — refetch once and retry
        const retrySha = (await ghGetFile()).sha;
        await ghPutFile(bodyStr, retrySha);
      }
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
