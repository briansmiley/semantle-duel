// Bug reports and ideas: POST /feedback, from the "report a bug" link on every page.
// Each report is written to the data volume first (DATA_DIR/feedback/<id>.json); only then is the sender
// answered. After that it is passed on to whichever of these is set up, and the file notes where it went:
// - FEEDBACK_WEBHOOK: a Discord webhook URL; the report is posted to its channel.
// - LINEAR_API_KEY (a personal API key): an issue is filed in LINEAR_TEAM (a team key, default SMI), in
//   LINEAR_PROJECT (by name, default "Semantle Duel") if it exists, labelled Bug or Feature if the team has one.

import { writeFile, rename, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export const MAX_TEXT = 2000;
const RATE_MAX = 6, RATE_WINDOW_MS = 60_000; // per address
const PATIENCE_MS = 10_000; // per call out to Discord or Linear

export function feedback({ dir, env = process.env }) {
  const webhook = env.FEEDBACK_WEBHOOK || null;
  const linear = env.LINEAR_API_KEY ? { key: env.LINEAR_API_KEY, team: env.LINEAR_TEAM || "SMI", project: env.LINEAR_PROJECT || "Semantle Duel" } : null;
  const ready = mkdir(dir, { recursive: true });
  const recent = new Map(); // address -> times

  const keep = async (r) => {
    await ready;
    const file = `${dir}/${r.id}.json`;
    await writeFile(`${file}.tmp`, JSON.stringify(r, null, 1));
    await rename(`${file}.tmp`, file);
  };

  const call = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(PATIENCE_MS) });

  // ---- Linear
  const gql = async (query, variables) => {
    const res = await call("https://api.linear.app/graphql", { method: "POST", headers: { "content-type": "application/json", authorization: linear.key }, body: JSON.stringify({ query, variables }) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.data || body.errors?.length) throw new Error(`Linear: ${body?.errors?.[0]?.message ?? res.status}`);
    return body.data;
  };
  let where = null; // Promise<{teamId, projectId, labels: {bug, idea}}>, looked up once
  const lookup = () => (where ??= (async () => {
    const d = await gql(
      `query($key: String!, $project: String!) {
        teams(filter: { key: { eq: $key } }, first: 1) { nodes { id } }
        projects(filter: { name: { eqIgnoreCase: $project } }, first: 1) { nodes { id } }
        issueLabels(filter: { name: { in: ["Bug", "Feature"] } }, first: 20) { nodes { id name team { key } } }
      }`,
      { key: linear.team.toUpperCase(), project: linear.project },
    );
    const teamId = d.teams.nodes[0]?.id;
    if (!teamId) throw new Error(`Linear: no team ${linear.team}`);
    // a team's own label wins over a workspace-wide one of the same name
    const label = (name) => (d.issueLabels.nodes.find((l) => l.name === name && l.team?.key === linear.team.toUpperCase()) ?? d.issueLabels.nodes.find((l) => l.name === name && !l.team))?.id;
    return { teamId, projectId: d.projects.nodes[0]?.id, labels: { bug: label("Bug"), idea: label("Feature") } };
  })().catch((e) => ((where = null), Promise.reject(e))));

  const toLinear = async (r) => {
    const { teamId, projectId, labels } = await lookup();
    const input = { teamId, title: `[FEEDBACK] ${r.title}`, description: describe(r, "markdown") };
    if (projectId) input.projectId = projectId;
    if (labels[r.kind]) input.labelIds = [labels[r.kind]];
    const d = await gql(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier url } } }`, { input });
    return d.issueCreate.issue;
  };

  // ---- Discord
  const toDiscord = async (r, issue) => {
    const res = await call(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "semantle duel",
        allowed_mentions: { parse: [] },
        embeds: [{
          title: `${r.kind === "bug" ? "🐞" : "💡"} ${r.title}`.slice(0, 256),
          description: r.text.slice(0, 4000),
          color: r.kind === "bug" ? 0xd4471f : 0xd98b2b,
          fields: [
            ...(r.name ? [{ name: "From", value: r.name, inline: true }] : []),
            ...(r.context.duel ? [{ name: "Duel", value: `#${r.context.number} · ${r.context.duel} · ${r.context.status}`, inline: true }] : []),
            ...(issue ? [{ name: "Linear", value: `[${issue.identifier}](${issue.url})`, inline: true }] : []),
            { name: "Where", value: "```\n" + describe(r, "plain").slice(0, 1000) + "\n```" },
          ],
          timestamp: new Date(r.at).toISOString(),
        }],
      }),
    });
    if (!res.ok) throw new Error(`Discord: ${res.status}`);
  };

  const pass = async (r) => {
    const issue = linear ? await toLinear(r).catch((e) => (console.error("feedback", r.id, e.message), null)) : null;
    const discord = webhook ? await toDiscord(r, issue).then(() => true, (e) => (console.error("feedback", r.id, e.message), false)) : null;
    await keep({ ...r, sent: { linear: issue, discord } }).catch((e) => console.error("feedback", r.id, e));
  };

  /** Handle a POST /feedback body. Returns [status, json]. */
  return async function receive(msg, address, now = Date.now()) {
    const times = (recent.get(address) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (times.length >= RATE_MAX) return [429, { error: "that's a lot of reports; try again in a minute" }];
    recent.set(address, [...times, now]);
    if (recent.size > 5000) recent.clear();

    const text = String(msg.text ?? "").trim().slice(0, MAX_TEXT);
    if (!text) return [400, { error: "say what happened" }];
    const c = typeof msg.context === "object" && msg.context ? msg.context : {};
    const r = {
      id: `${new Date(now).toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`,
      at: now,
      kind: msg.kind === "idea" ? "idea" : "bug",
      title: text.split("\n")[0].slice(0, 80) + (text.split("\n")[0].length > 80 ? "…" : ""),
      text,
      name: String(msg.name ?? "").slice(0, 24),
      player: String(msg.player ?? "").slice(0, 64),
      context: {
        page: String(c.page ?? "").slice(0, 200),
        duel: String(c.duel ?? "").slice(0, 8),
        number: Number(c.number) || null,
        status: String(c.status ?? "").slice(0, 16),
        guesses: Number(c.guesses) || 0,
        browser: String(c.browser ?? "").slice(0, 300),
        screen: String(c.screen ?? "").slice(0, 40),
        errors: Array.isArray(c.errors) ? c.errors.slice(-5).map((e) => String(e).slice(0, 300)) : [],
      },
    };
    await keep(r);
    pass(r); // in the background; the report is already safe
    return [200, { ok: true }];
  };
}

function describe(r, style) {
  const c = r.context;
  const lines = [
    `kind: ${r.kind}`,
    r.name && `from: ${r.name}`,
    c.page && `page: ${c.page}`,
    c.duel && `duel: ${c.duel} (#${c.number}, ${c.status}, ${c.guesses} guesses)`,
    c.screen && `screen: ${c.screen}`,
    c.browser && `browser: ${c.browser}`,
    ...c.errors.map((e) => `error: ${e}`),
    `report: ${r.id}`,
  ].filter(Boolean);
  return style === "markdown" ? `${r.text}\n\n---\n\n${lines.map((l) => `- ${l}`).join("\n")}` : lines.join("\n");
}
