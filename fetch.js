fs = require("fs");
const https = require("https");
process = require("process");
require("dotenv").config();

const GITHUB_TOKEN = process.env.REACT_APP_GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const USE_GITHUB_DATA = process.env.USE_GITHUB_DATA;
const MEDIUM_USERNAME = process.env.MEDIUM_USERNAME;

const ERR = {
  noUserName:
    "Github Username was found to be undefined. Please set all relevant environment variables.",
  requestFailed:
    "The request to GitHub didn't succeed. Check if GitHub token in your .env file is correct.",
  requestFailedMedium:
    "The request to Medium didn't succeed. Check if Medium username in your .env file is correct."
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function httpsGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let body = "";
      res.on("data", d => (body += d));
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function httpsPost(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let body = "";
      res.on("data", d => (body += d));
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── REST fallback: fetch top public repos and shape them into the GraphQL schema ──
async function fetchPublicReposAsFallback(username) {
  console.log(
    `  ↳ pinnedItems empty — falling back to REST API for public repos`
  );
  const options = {
    hostname: "api.github.com",
    path: `/users/${username}/repos?type=public&sort=updated&per_page=6`,
    port: 443,
    method: "GET",
    headers: {
      "User-Agent": "Node",
      Accept: "application/vnd.github+json",
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
    }
  };

  const { statusCode, body } = await httpsGet(options);
  if (statusCode !== 200) {
    console.error(`  ✖ REST API returned ${statusCode}`);
    return [];
  }

  const repos = JSON.parse(body);
  // Shape into the pinnedItems edge format the React component expects
  return repos
    .filter(r => !r.fork)
    .slice(0, 6)
    .map(r => ({
      node: {
        name: r.name,
        description: r.description || "",
        forkCount: r.forks_count,
        stargazers: { totalCount: r.stargazers_count },
        url: r.html_url,
        id: String(r.id),
        diskUsage: r.size,
        primaryLanguage: r.language
          ? { name: r.language, color: languageColor(r.language) }
          : null
      }
    }));
}

// Basic language → colour mapping (GitHub colours)
function languageColor(lang) {
  const colors = {
    JavaScript: "#f1e05a",
    TypeScript: "#3178c6",
    Python: "#3572A5",
    Dart: "#00B4AB",
    Kotlin: "#A97BFF",
    Java: "#b07219",
    "C++": "#f34b7d",
    C: "#555555",
    Swift: "#F05138",
    Go: "#00ADD8",
    Rust: "#dea584",
    Ruby: "#701516",
    PHP: "#4F5D95",
    HTML: "#e34c26",
    CSS: "#563d7c",
    Shell: "#89e051"
  };
  return colors[lang] || "#8b949e";
}

// ── Main GitHub fetch ─────────────────────────────────────────────────────────

// Extract username from portfolio.js if not in env
let resolvedUsername = GITHUB_USERNAME;
if (!resolvedUsername) {
  try {
    const portfolioContent = fs.readFileSync("./src/portfolio.js", "utf8");
    const match = portfolioContent.match(/github:\s*["']https:\/\/github\.com\/([^"'\s/]+)/);
    if (match && match[1]) {
      resolvedUsername = match[1].trim();
      console.log(`Extracted GITHUB_USERNAME from portfolio.js: ${resolvedUsername}`);
    }
  } catch (e) {
    console.error("Failed to extract GITHUB_USERNAME from portfolio.js:", e);
  }
}

async function fetchGithubProfileREST(username) {
  console.log(`  ↳ Fetching profile info for ${username} via REST API`);
  const options = {
    hostname: "api.github.com",
    path: `/users/${username}`,
    port: 443,
    method: "GET",
    headers: {
      "User-Agent": "Node",
      Accept: "application/vnd.github+json",
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
    }
  };
  const { statusCode, body } = await httpsGet(options);
  if (statusCode !== 200) {
    console.error(`  ✖ REST Profile API returned ${statusCode}: ${body}`);
    return null;
  }
  return JSON.parse(body);
}

if (USE_GITHUB_DATA === "true" || resolvedUsername) {
  const username = resolvedUsername || "benardelia";

  (async () => {
    try {
      if (!GITHUB_TOKEN) {
        console.log(`No REACT_APP_GITHUB_TOKEN found. Using public REST API for ${username}...`);
        const profile = await fetchGithubProfileREST(username);
        if (!profile) {
          throw new Error("Failed to fetch user profile via REST API");
        }
        const repos = await fetchPublicReposAsFallback(username);
        const parsed = {
          data: {
            user: {
              name: profile.name || profile.login,
              bio: profile.bio || "",
              avatarUrl: profile.avatar_url,
              location: profile.location || "",
              pinnedItems: {
                totalCount: repos.length,
                edges: repos
              }
            }
          }
        };
        fs.writeFileSync("./public/profile.json", JSON.stringify(parsed, null, 2));
        console.log("saved file to public/profile.json (via REST API)");
        return;
      }

      console.log(`Fetching profile data for ${username} via GraphQL API`);

      const graphqlPayload = JSON.stringify({
        query: `
{
  user(login:"${username}") {
    name
    bio
    avatarUrl
    location
    pinnedItems(first: 6, types: [REPOSITORY]) {
      totalCount
      edges {
        node {
          ... on Repository {
            name
            description
            forkCount
            stargazers {
              totalCount
            }
            url
            id
            diskUsage
            primaryLanguage {
              name
              color
            }
          }
        }
      }
    }
  }
}
`
      });

      const graphqlOptions = {
        hostname: "api.github.com",
        path: "/graphql",
        port: 443,
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "User-Agent": "Node"
        }
      };

      const { statusCode, body } = await httpsPost(graphqlOptions, graphqlPayload);
      console.log(`GraphQL response statusCode: ${statusCode}`);

      if (statusCode !== 200) {
        throw new Error(ERR.requestFailed);
      }

      const parsed = JSON.parse(body);

      // If no pinned items, fall back to public repos via REST
      if (
        parsed.data &&
        parsed.data.user &&
        parsed.data.user.pinnedItems.totalCount === 0
      ) {
        const fallbackEdges = await fetchPublicReposAsFallback(username);
        parsed.data.user.pinnedItems.edges = fallbackEdges;
        parsed.data.user.pinnedItems.totalCount = fallbackEdges.length;
        console.log(
          `  ✔ Loaded ${fallbackEdges.length} public repos as fallback`
        );
      }

      fs.writeFileSync("./public/profile.json", JSON.stringify(parsed, null, 2));
      console.log("saved file to public/profile.json");
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  })();
}

// ── Medium fetch ──────────────────────────────────────────────────────────────
if (MEDIUM_USERNAME !== undefined) {
  console.log(`Fetching Medium blogs data for ${MEDIUM_USERNAME}`);
  const options = {
    hostname: "api.rss2json.com",
    path: `/v1/api.json?rss_url=https://medium.com/feed/@${MEDIUM_USERNAME}`,
    port: 443,
    method: "GET"
  };

  (async () => {
    try {
      const { statusCode, body } = await httpsGet(options);
      console.log(`statusCode: ${statusCode}`);
      if (statusCode !== 200) {
        throw new Error(ERR.requestFailedMedium);
      }
      fs.writeFile("./public/blogs.json", body, function (err) {
        if (err) return console.log(err);
        console.log("saved file to public/blogs.json");
      });
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  })();
}
