

const fs = require("fs");
const path = require("path");
const core = require("@actions/core");
const github = require("@actions/github");



const HISTORY_FILE = process.env.CI_GUARD_HISTORY_PATH || "./ci-guard-data/history.json";
const MAX_HISTORY_ENTRIES = 50;      
const BASELINE_WINDOW = 10;           
const REGRESSION_THRESHOLD_PCT = 15;  



function loadHistory(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.runs) ? parsed : { runs: [] };
  } catch (err) {
    // No history yet (first run ever) — start fresh
    return { runs: [] };
  }
}

function saveHistory(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}


async function getCurrentRunDuration(octokit, owner, repo, runId) {
  const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  let totalSeconds = 0;
  const jobBreakdown = [];

  for (const job of data.jobs) {
    if (!job.started_at || !job.completed_at) continue; 
    const start = new Date(job.started_at).getTime();
    const end = new Date(job.completed_at).getTime();
    const seconds = Math.round((end - start) / 1000);
    totalSeconds += seconds;
    jobBreakdown.push({ name: job.name, seconds });
  }

  return { totalSeconds, jobBreakdown };
}

function computeBaseline(runs, branch) {

  const relevant = runs.filter((r) => r.branch === branch).slice(-BASELINE_WINDOW);

  if (relevant.length === 0) return null;

  const avg =
    relevant.reduce((sum, r) => sum + r.totalSeconds, 0) / relevant.length;

  return Math.round(avg);
}



async function run() {
  try {
    const token = core.getInput("github-token", { required: true });
    const octokit = github.getOctokit(token);
    const { context } = github;

    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const runId = context.runId;


    const currentBranch =
      context.payload.pull_request?.base?.ref || context.ref.replace("refs/heads/", "");

    core.info(`Fetching job durations for run ${runId}...`);
    const { totalSeconds, jobBreakdown } = await getCurrentRunDuration(
      octokit,
      owner,
      repo,
      runId
    );

    if (totalSeconds === 0) {
      core.warning("No completed jobs found yet — skipping regression analysis.");
      core.setOutput("has_data", "false");
      return;
    }

    core.info(`Total duration this run: ${totalSeconds}s`);


    const history = loadHistory(HISTORY_FILE);
    const baselineSeconds = computeBaseline(history.runs, currentBranch);

    let percentChange = null;
    let isRegression = false;

    if (baselineSeconds !== null && baselineSeconds > 0) {
      percentChange = ((totalSeconds - baselineSeconds) / baselineSeconds) * 100;
      isRegression = percentChange >= REGRESSION_THRESHOLD_PCT;
    }

    history.runs.push({
      runId,
      branch: currentBranch,
      sha: context.sha,
      totalSeconds,
      jobBreakdown,
      timestamp: new Date().toISOString(),
    });


    if (history.runs.length > MAX_HISTORY_ENTRIES) {
      history.runs = history.runs.slice(-MAX_HISTORY_ENTRIES);
    }

    saveHistory(HISTORY_FILE, history);
    core.info(`History saved to ${HISTORY_FILE} (${history.runs.length} runs tracked)`);

    core.setOutput("has_data", "true");
    core.setOutput("current_seconds", String(totalSeconds));
    core.setOutput("baseline_seconds", baselineSeconds !== null ? String(baselineSeconds) : "");
    core.setOutput("percent_change", percentChange !== null ? percentChange.toFixed(1) : "");
    core.setOutput("is_regression", String(isRegression));
    core.setOutput("job_breakdown", JSON.stringify(jobBreakdown));
    core.setOutput("recent_runs", JSON.stringify(history.runs.slice(-BASELINE_WINDOW)));
  } catch (err) {
    core.setFailed(`ci-guard analyze step failed: ${err.message}`);
  }
}

run();