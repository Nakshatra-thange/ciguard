
const core = require("@actions/core");
const github = require("@actions/github");


const COMMENT_MARKER = "<!-- ci-guard-comment -->";


function fmtDuration(totalSeconds) {
  const s = Math.round(totalSeconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

function verdictLine(isRegression, percentChange) {
  if (percentChange === null || percentChange === "") {
    return "ℹ️ **No baseline yet** — this is one of the first tracked runs on this branch.";
  }
  const pct = parseFloat(percentChange);
  if (isRegression) {
    return `Regression detected — this run is **${pct.toFixed(1)}% slower** than baseline.`;
  }
  if (pct <= -10) {
    return `*Nice speedup! This run is **${Math.abs(pct).toFixed(1)}% faster** than baseline.`;
  }
  return `Within normal range (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs baseline).`;
}

// ---- SVG sparkline --------------------------------------------------------

// Renders a minimal inline SVG line chart of recent run durations.
// GitHub renders SVG fine inside Markdown via <img src="data:image/svg+xml..."/>
function renderSparklineSVG(recentRuns, currentSeconds) {
  const points = recentRuns.map((r) => r.totalSeconds).concat([currentSeconds]);

  const width = 480;
  const height = 100;
  const padding = 10;

  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;

  const stepX = (width - padding * 2) / Math.max(points.length - 1, 1);

  const coords = points.map((val, i) => {
    const x = padding + i * stepX;
    const y = height - padding - ((val - min) / range) * (height - padding * 2);
    return [x, y];
  });

  const pathD = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");


  const lastVal = points[points.length - 1];
  let lastColor = "#6b7280"; // gray
  if (lastVal === max && points.length > 1) lastColor = "#ef4444"; // red
  if (lastVal === min && points.length > 1) lastColor = "#22c55e"; // green

  const [lastX, lastY] = coords[coords.length - 1];

  const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#0d1117" rx="6"/>
  <path d="${pathD}" fill="none" stroke="#58a6ff" stroke-width="2"/>
  <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" fill="${lastColor}"/>
</svg>`.trim();

  const base64 = Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
}



function renderJobTable(jobBreakdown) {
  if (!jobBreakdown || jobBreakdown.length === 0) return "";
  const rows = jobBreakdown
    .map((j) => `| ${j.name} | ${fmtDuration(j.seconds)} |`)
    .join("\n");
  return `\n<details>\n<summary>Per-job breakdown</summary>\n\n| Job | Duration |\n|---|---|\n${rows}\n\n</details>\n`;
}



async function run() {
  try {
    const token = core.getInput("github-token", { required: true });
    const octokit = github.getOctokit(token);
    const { context } = github;

    const hasData = core.getInput("has_data");
    if (hasData !== "true") {
      core.info("No data from analyze step — skipping comment.");
      return;
    }

    const currentSeconds = parseFloat(core.getInput("current_seconds"));
    const baselineSeconds = core.getInput("baseline_seconds");
    const percentChange = core.getInput("percent_change");
    const isRegression = core.getInput("is_regression") === "true";
    const jobBreakdown = JSON.parse(core.getInput("job_breakdown") || "[]");
    const recentRuns = JSON.parse(core.getInput("recent_runs") || "[]");


    const prNumber = await resolvePRNumber(octokit, context);
    if (!prNumber) {
      core.info("Could not resolve a PR for this run — skipping comment.");
      return;
    }

    const sparklineUrl = renderSparklineSVG(recentRuns, currentSeconds);

    const body = `${COMMENT_MARKER}
### 🛡️ CI Guard — Build Time Report

| Metric | Value |
|---|---|
| Current run | **${fmtDuration(currentSeconds)}** |
| Baseline (avg of last ${recentRuns.length} runs) | ${baselineSeconds ? fmtDuration(parseFloat(baselineSeconds)) : "—"} |
| Change | ${percentChange ? `${percentChange}%` : "—"} |

${verdictLine(isRegression, percentChange)}

![trend](${sparklineUrl})
${renderJobTable(jobBreakdown)}
<sub>Tracked by ci-guard · updates automatically on new commits</sub>`;

    const owner = context.repo.owner;
    const repo = context.repo.repo;

    // Find existing ci-guard comment on this PR, if any
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });

    const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));

    if (existing) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
      core.info(`Updated existing comment #${existing.id} on PR #${prNumber}`);
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
      core.info(`Created new comment on PR #${prNumber}`);
    }
  } catch (err) {
    core.setFailed(`ci-guard comment step failed: ${err.message}`);
  }
}


async function resolvePRNumber(octokit, context) {
  const workflowRun = context.payload.workflow_run;
  if (!workflowRun) return null;


  if (workflowRun.pull_requests && workflowRun.pull_requests.length > 0) {
    return workflowRun.pull_requests[0].number;
  }


  const { data: prs } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
    owner: context.repo.owner,
    repo: context.repo.repo,
    commit_sha: workflowRun.head_sha,
  });

  return prs.length > 0 ? prs[0].number : null;
}

module.exports = { run, renderSparklineSVG, verdictLine, fmtDuration };

run();