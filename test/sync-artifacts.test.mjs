import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

import { renderArtifact, rootDir } from '../scripts/src/sync-artifacts/common.mjs';
import {
  processAgents,
  processClaudeLegacyCommands,
  processSkills,
} from '../scripts/src/sync-artifacts/processors.mjs';
import {
  buildCodexPluginManifest,
  buildMcpConfig,
  buildOpenCodePackageJson,
  readRootPackageJson,
} from '../scripts/src/sync-artifacts/package-artifacts.mjs';

function renderSkill(skillName, platform = 'codex') {
  const raw = readFileSync(join(rootDir, 'source', 'skills', skillName, 'SKILL.md'), 'utf8');
  return renderArtifact(raw, platform);
}

function renderAgent(agentName, platform = 'codex') {
  const raw = readFileSync(join(rootDir, 'source', 'agents', agentName, 'AGENT.md'), 'utf8');
  return renderArtifact(raw, platform);
}

function assertNoNonCodexDelegationText(rendered) {
  assert.doesNotMatch(rendered, /Task\(/);
  assert.doesNotMatch(rendered, /subagent_type:/);
  assert.doesNotMatch(rendered, /run_in_background/);
  assert.doesNotMatch(rendered, /@polygraph-delegate-subagent/);
}

function sectionBetween(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1);
  return content.slice(startIndex, endIndex);
}

test('polygraph init subagent does not expect candidate repo descriptions', () => {
  const rendered = renderAgent('polygraph-init-subagent');
  const discoverySection = sectionBetween(
    rendered,
    '### Step 1: Discover Candidate Repos',
    '### Step 2: Select Relevant Repos'
  );
  const selectionSection = sectionBetween(
    rendered,
    '### Step 2: Select Relevant Repos',
    '### Step 3: Initialize Polygraph Session or Attach Repos'
  );
  const summarySection = sectionBetween(
    rendered,
    '### Step 5: Return Summary',
    '## Important Notes'
  );

  assert.doesNotMatch(discoverySection, /`description`/);
  assert.match(discoverySection, /Candidate entries do not include repository descriptions/);
  assert.doesNotMatch(selectionSection, /repo descriptions?/);
  assert.doesNotMatch(summarySection, /\| Repo \| Repository ID \| Description \|/);
  assert.match(summarySection, /\| Repo \| Repository ID \| Selected \|/);
});

test('renderArtifact preserves a valid frontmatter boundary for the codex polygraph skill', () => {
  const rendered = renderSkill('polygraph');

  assert.match(rendered, /^---\n[\s\S]*?\n---\n/);
  assert.doesNotMatch(rendered, /\n---#/);
  assert.match(rendered, /\n# Working with Polygraph\b/);
});

test('rendered polygraph skill documents linked references', () => {
  const raw = readFileSync(join(rootDir, 'source', 'skills', 'polygraph', 'SKILL.md'), 'utf8');
  const rendered = renderArtifact(raw, 'codex');

  assert.match(rendered, /`link_reference` for linking external references to sessions/);
  assert.match(rendered, /`link_reference` \| — \| Link an external reference to a session\./);
  assert.match(rendered, /session\.linkedReferences/);
  assert.match(rendered, /### Linked References/);
  assert.match(rendered, /When an external resource is mentioned during a Polygraph session and appears relevant to the current work/);
  assert.match(rendered, /record it with `link_reference\(\{ sessionId, reference \}\)`/);
  assert.match(rendered, /pull requests, GitHub issues, other Polygraph sessions, and Linear issues/);
  assert.match(rendered, /Invoke the MCP tool with a single object containing `\{ sessionId, reference \}`/);
  assert.match(rendered, /For example, to record a relevant pull request/);
  assert.match(rendered, /link_reference\(\{/);
  assert.match(rendered, /sessionId: "<current-session-id>"/);
  assert.match(rendered, /reference: \{/);
  assert.match(rendered, /type: "github_pr"/);
  assert.match(rendered, /url: "https:\/\/github\.com\/nrwl\/polygraph-skills\/pull\/123"/);
  assert.match(rendered, /label: "Implementation PR"/);
  assert.match(rendered, /To record a relevant Polygraph session, use the same invocation shape and include `reference\.sessionId`/);
  assert.match(rendered, /type: "session"/);
  assert.match(rendered, /label: "Inspected Polygraph session"/);
  assert.match(rendered, /sessionId: "<inspected-session-id>"/);
  assert.match(rendered, /The canonical MCP parameters are `\{ sessionId, reference \}`/);
  assert.match(rendered, /polygraph session show --details <session-id>/);

  const printSection = sectionBetween(rendered, '### Print Polygraph Session Details', '## Best Practices');
  assert.doesNotMatch(printSection, /link_reference/);
  assert.doesNotMatch(printSection, /linked reference/);

  assert.doesNotMatch(rendered, /link_session/);
  assert.doesNotMatch(rendered, /polygraph session link/);
  assert.doesNotMatch(rendered, /linkedSessions/);
  assert.doesNotMatch(rendered, /targetSessionId/);
  assert.doesNotMatch(rendered, /linkedSessionId/);
  assert.doesNotMatch(rendered, /Record a linked reference on a session/);
  assert.doesNotMatch(rendered, /Repeat the link step every time a session is inspected this way/);
  assert.doesNotMatch(rendered, /always link the inspected session/);
  assert.doesNotMatch(rendered, /Print the inspected session details for the user/);
  assert.doesNotMatch(rendered, /--(?:target|dependency|dependent)Id\b|\b(?:target|dependency|dependent)Id:/);
});

test('rendered polygraph skill points at the session description reference file', () => {
  const rendered = renderSkill('polygraph');
  const policySection = sectionBetween(
    rendered,
    '### Session Description Policy',
    '### 3. Create Draft PRs'
  );
  const createPrSection = sectionBetween(
    rendered,
    '### 3. Create Draft PRs',
    '### 4. Get Current Polygraph Session'
  );
  const associatePrSection = sectionBetween(
    rendered,
    '### 6. Associate Existing PRs',
    '### 7. Add Repositories to a Session'
  );
  const updateDescriptionSection = sectionBetween(
    rendered,
    '### Update Session Description',
    '### Print Polygraph Session Details'
  );

  assert.match(rendered, /`update_session` \| `polygraph session update --session <id> \[--title\] \[--description\]`/);
  assert.match(rendered, /`update_session` for session metadata updates/);
  assert.doesNotMatch(rendered, /update_session_description/);
  assert.doesNotMatch(rendered, /update-description/);

  // The policy section is now a short on-demand pointer to the reference file.
  assert.match(policySection, /`description` is user-facing Polygraph session context/);
  assert.match(policySection, /read \[`reference\/session-description\.md`\]\(reference\/session-description\.md\)/);
  assert.match(policySection, /That reference file holds the full policy/);
  assert.match(createPrSection, /[Mm]ust follow the Session Description Policy/);
  assert.match(associatePrSection, /[Mm]ust follow the Session Description Policy/);
  assert.match(updateDescriptionSection, /reference\/session-description\.md/);
  assert.match(updateDescriptionSection, /Then call `update_session` with the resulting summary as `description`\./);

  // The detailed guidance moved OUT of SKILL.md into the reference file.
  assert.doesNotMatch(rendered, /Goal: <what the session is trying to accomplish>/);
  assert.doesNotMatch(rendered, /Next Steps: <clear next implementation steps>/);
  assert.doesNotMatch(rendered, /Prefer high-level state over file-by-file changelogs/);
  assert.doesNotMatch(updateDescriptionSection, /\*\*Parameters:\*\*/);
  assert.doesNotMatch(rendered, /description: "Add user preferences feature: UI in frontend, API in backend"/);
  assert.doesNotMatch(rendered, /Session Description Summary/);
  assert.doesNotMatch(rendered, /cloud_polygraph_create_prs/);
});

test('session description reference ships to every platform dist skill folder', () => {
  const platforms = ['claude', 'opencode', 'codex'];

  for (const platform of platforms) {
    const outputDir = mkdtempSync(join(tmpdir(), `polygraph-${platform}-skills-`));
    processSkills(platform, {
      outputDir,
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
    });

    const referencePath = join(
      outputDir,
      'skills',
      'polygraph',
      'reference',
      'session-description.md'
    );
    const reference = readFileSync(referencePath, 'utf8');

    // Canonical template now uses Markdown headings instead of flat labels.
    assert.match(reference, /^## Goal$/m);
    assert.match(reference, /^## Current progress$/m);
    assert.match(reference, /^## What worked$/m);
    assert.match(reference, /^## Next steps$/m);
    assert.doesNotMatch(reference, /^Goal: <what the session is trying to accomplish>$/m);

    // Durable guidance bullets preserved.
    assert.match(reference, /Do not use a one-line feature summary/);
    assert.match(reference, /Keep it concise but durable for a future resumed agent/);
    assert.match(reference, /Prefer high-level state over file-by-file changelogs/);
    assert.match(reference, /Mention unresolved decisions or risks when they matter/);
    assert.match(reference, /include only next implementation steps/);

    // Dual-audience note.
    assert.match(reference, /humans, in the web UI/i);
    assert.match(reference, /reconstructing session history/i);
    assert.match(reference, /Don't assume the original working tree is available/);

    // Formatting building blocks.
    assert.match(reference, /## Formatting building blocks/);
    assert.match(reference, /> \[!WARNING\]/);
    assert.match(reference, /> \[!CAUTION\]/);
    assert.match(reference, /> \[!NOTE\]/);
    assert.match(reference, /> \[!IMPORTANT\]/);
    assert.match(reference, /> \[!TIP\]/);
    assert.match(reference, /Tables \(GFM\)/);
    assert.match(reference, /mermaid/);
    assert.match(reference, /Do NOT redraw the cross-repo dependency \/ repository graph/);
    assert.match(reference, /Plain text remains the norm; diagrams are optional/);
    assert.match(reference, /localhost/);
    assert.match(reference, /file:\/\//);
    assert.match(reference, /Do NOT put repo-relative file paths/);
    assert.match(reference, /use the `link_reference` tool instead of inline links/);
    assert.match(reference, /\*\*supplementary\*\* to the description, not a replacement/);
  }
});

test('codex polygraph skill uses custom Codex subagent guidance', () => {
  const rendered = renderSkill('polygraph');

  assert.match(rendered, /agent_type: "polygraph-init-subagent"/);
  assert.match(rendered, /agent_type: "polygraph-delegate-subagent"/);
  assert.match(rendered, /Codex `spawn_agent` ≠ Polygraph MCP `spawn_agent`/);
  assert.match(rendered, /`wait_agent`/);
  assert.match(rendered, /stop session work/i);
  assert.match(rendered, /Re-run `polygraph whoami`/);
  assert.match(rendered, /parent conversation is responsible for detecting an existing session ID/);
  assert.match(rendered, /fresh Codex Desktop conversation started with `\/polygraph:session-start`/);
  assert.match(rendered, /Resume is not a work command/);
  assert.match(rendered, /Treat "resume" as context restoration followed by waiting for user instructions/);
  assert.match(rendered, /- repo: "<org\/repo-name>"/);
  assert.match(rendered, /repo: "org\/repo-name"/);
  assert.doesNotMatch(rendered, /- target: "<org\/repo-name>"/);
  assert.doesNotMatch(rendered, /target: "org\/repo-name"/);
  assertNoNonCodexDelegationText(rendered);
});

test('codex session-start skill routes session creation through init subagent', () => {
  const rendered = renderSkill('session-start');

  assert.match(rendered, /^---\n[\s\S]*?name: session-start[\s\S]*?\n---\n/);
  assert.match(rendered, /Start or reconnect a Polygraph session/);
  assert.match(rendered, /Check Authentication First/);
  assert.match(rendered, /If auth is missing, expired, or no organization is selected, stop session work/);
  assert.match(rendered, /Facilitate user reauth through the browser-based flow/);
  assert.match(rendered, /Re-run `whoami` after reauth/);
  assert.match(rendered, /Parent Session Detection/);
  assert.match(rendered, /parent conversation is responsible for detecting an existing Polygraph session ID/);
  assert.match(rendered, /init subagent cannot infer the parent's current session context by itself/);
  assert.match(rendered, /fresh Codex Desktop conversation started with `\/polygraph:session-start`/);
  assert.match(rendered, /agent_type: "polygraph-init-subagent"/);
  assert.match(rendered, /Do NOT call the Polygraph MCP `list_repos` or `start_session` tools directly/);
  assert.match(rendered, /Direct `add_repo` is allowed only when the user gives exact repository refs/);
  assert.match(rendered, /If sessionId is provided, reuse that session and use add_repo/);
  assert.match(rendered, /The parent conversation detected any existing sessionId/);
  assert.match(rendered, /this is a fresh session-start flow; create a new session via start_session/);
  assert.match(rendered, /If exact repo refs were provided, pass them directly to add_repo and do NOT call list_repos/);
  assert.match(rendered, /Collect the result with `wait_agent`/);
  assert.match(rendered, /`session_intro` MCP tool/);
  assertNoNonCodexDelegationText(rendered);
});

test('background-session-start is an explicit OAuth capture skill', () => {
  const rendered = renderSkill('background-session-start', 'claude');
  const frontmatter = rendered.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';

  assert.match(rendered, /^---\n[\s\S]*?name: background-session-start[\s\S]*?\n---\n/);
  assert.match(rendered, /\/james-polygraph:background-session-start/);
  assert.match(rendered, /\$ARGUMENTS/);
  assert.match(frontmatter, /when_to_use:.*Slack-routed Claude Code task/i);
  assert.match(frontmatter, /disable-model-invocation: false/);
  assert.match(frontmatter, /user-invocable: true/);
  assert.match(rendered, /opt-in boundary/);
  assert.match(rendered, /exactly one Git repository/);
  assert.match(rendered, /mcp__polygraph-oauth-spike__background_session_start/);
  assert.match(rendered, /background_session_start/);
  assert.match(rendered, /background_capture_event/);
  assert.doesNotMatch(frontmatter, /^hooks:/m);
  assert.match(
    rendered,
    /node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/background-capture-lifecycle\.mjs" activate/
  );
  assert.match(rendered, /mode-`0600` files under\s+`~\/\.polygraph\/background-capture\/`/);
  assert.match(rendered, /sessionUrl/);
  assert.match(
    rendered,
    /MCP\s+tool call is structured JSON and does not perform shell expansion/
  );
  assert.match(rendered, /providerSessionId.*exactly equal to the concrete value/is);
  assert.match(rendered, /never\s+pass `\$CLAUDE_CODE_SESSION_ID`/i);
  assert.match(rendered, /capture\.status.*started/);
  assert.match(rendered, /captureHookUrl/);
  assert.match(rendered, /short-lived append capability/);
  assert.match(rendered, /stop\s+before repository work/i);
  assert.match(rendered, /Do not call `background_capture_event` yourself during start/);
  assert.match(rendered, /Do not create or edit `.claude\/settings\.json`/);
  assert.match(rendered, /`.claude\/settings\.local\.json`/);
  assert.match(rendered, /same production Claude transcript adapter/);
  assert.match(rendered, /stable\s+opt-in byte offset/);
  assert.match(rendered, /do not duplicate transcript events/);
  assert.match(rendered, /separate Claude tool approval/);
  assert.match(rendered, /pauses and resumes a worker/);
  assert.match(rendered, /including warm follow-ups and pause\/resume/);
  assert.match(
    rendered,
    /never\s+invoke\s+this skill do not transmit transcript content/,
  );
  assert.match(rendered, /preserve user prompts, assistant text/);
  assert.match(rendered, /available thinking blocks/);
  assert.match(rendered, /opaque or empty signed thinking block cannot be expanded/);
  assert.match(
    rendered,
    /provider continues to own.*branch creation.*commits.*pushes.*pull request creation/is
  );
  assert.doesNotMatch(rendered, /POLYGRAPH_(?:SERVICE_ACCOUNT|API_TOKEN|ACCESS_TOKEN)/);
  assert.doesNotMatch(rendered, /\b(?:list_repos|spawn_agent|create_pr)\s*\(/);
});

test('Claude packages background-session-start as a legacy plugin command too', () => {
  const outputDir = mkdtempSync(
    join(tmpdir(), 'polygraph-claude-background-command-')
  );
  const config = {
    outputDir,
    skillsDir: 'skills',
    skillsFile: 'SKILL.md',
  };

  processSkills('claude', config);
  processClaudeLegacyCommands(config);

  const skill = readFileSync(
    join(outputDir, 'skills', 'background-session-start', 'SKILL.md'),
    'utf8'
  );
  const command = readFileSync(
    join(outputDir, 'commands', 'background-session-start.md'),
    'utf8'
  );
  assert.equal(command, skill);
  assert.match(command, /name: background-session-start/);
  assert.match(command, /mcp__polygraph-oauth-spike__background_session_start/);
  assert.match(command, /\$ARGUMENTS/);
});

test('Claude plugin hooks keep capture dormant until a session is activated', () => {
  const hooks = JSON.parse(
    readFileSync(join(rootDir, 'source', 'hooks', 'hooks.json'), 'utf8')
  ).hooks;

  const lifecycleCommand =
    'node ${CLAUDE_PLUGIN_ROOT}/hooks/background-capture-lifecycle.mjs';

  assert.ok(
    hooks.SessionStart[0].hooks.some(
      (hook) => hook.type === 'command' && hook.command === lifecycleCommand
    )
  );
  assert.deepEqual(hooks.UserPromptSubmit, [
    { hooks: [{ type: 'command', command: lifecycleCommand }] },
  ]);
  assert.deepEqual(hooks.Stop, [
    { hooks: [{ type: 'command', command: lifecycleCommand }] },
  ]);
  assert.deepEqual(hooks.SessionEnd, [
    { hooks: [{ type: 'command', command: lifecycleCommand }] },
  ]);
  assert.ok(
    hooks.PreToolUse.some(
      (group) =>
        group.matcher === undefined &&
        group.hooks.some(
          (hook) => hook.type === 'command' && hook.command === lifecycleCommand,
        ),
    ),
  );
  assert.deepEqual(hooks.PostToolUseFailure, [
    { hooks: [{ type: 'command', command: lifecycleCommand }] },
  ]);
  assert.doesNotMatch(JSON.stringify(hooks), /"type":"mcp_tool"/);
});

test('rendered polygraph skill keeps session intro as hidden internal fallback', () => {
  const rendered = renderSkill('polygraph');
  const toolsSection = sectionBetween(rendered, '## Available Tools', '## CLI Statefulness');

  assert.match(rendered, /`session_intro` MCP tool/);
  assert.match(rendered, /`polygraph session intro -s <sessionId>`/);
  assert.match(rendered, /intentionally hidden\/internal and may not appear in public command listings/);
  assert.doesNotMatch(toolsSection, /polygraph session intro/);
});

test('rendered polygraph skill documents PR repository semantics', () => {
  const rendered = renderSkill('polygraph');
  const createPrSection = sectionBetween(
    rendered,
    '### 3. Create Draft PRs',
    '### 4. Get Current Polygraph Session'
  );
  const associatePrSection = sectionBetween(
    rendered,
    '### 6. Associate Existing PRs',
    '### 7. Add Repositories to a Session'
  );

  assert.match(createPrSection, /`targetRepository` \(optional\): Target GitHub repository for fork PR creation or registration/);
  assert.match(createPrSection, /keep `owner` and `repo` set to the source repository/);
  assert.match(createPrSection, /targetRepository: "org\/frontend"/);

  assert.match(associatePrSection, /Provide either a `prUrl` to associate a specific PR, or a `branch` name plus `repo` to find and associate PRs for a source repository\./);
  assert.match(associatePrSection, /- `repo` \(optional\): Source repository for branch-based association/);
  assert.match(associatePrSection, /repo: "org\/repo"/);
  assert.doesNotMatch(associatePrSection, /URL-based association infers|Branch-based association uses/);
  assert.doesNotMatch(associatePrSection, /targetRepo|targetRepository/);
});

test('polygraph skill renders platform-specific sandboxing guidance', () => {
  const claude = renderSkill('polygraph', 'claude');
  const codex = renderSkill('polygraph', 'codex');
  const opencode = renderSkill('polygraph', 'opencode');

  for (const rendered of [claude, codex]) {
    assert.match(rendered, /## Sandboxing in Polygraph Sessions/);
    assert.match(rendered, /Recognize sandbox denials — do not retry or work around them\./);
    assert.match(rendered, /`!`-prefixed user commands — those run inside the same sandbox/);
    assert.match(rendered, /\*\*Respect the sandbox\*\*/);
    assert.match(rendered, /Never blame the tooling\./);
    assert.doesNotMatch(rendered, /\{%|\{\{/);
  }

  assert.match(claude, /\.claude\/settings\.json/);
  assert.match(claude, /"allowWrite"/);
  assert.match(claude, /Agent Options → Claude → sandbox/);
  assert.match(claude, /agentOptions\.claude\.sandbox: false/);
  assert.doesNotMatch(claude, /\.codex\/config\.toml/);
  assert.doesNotMatch(claude, /sandbox_workspace_write/);

  assert.match(codex, /\.codex\/config\.toml/);
  assert.match(codex, /\[sandbox_workspace_write\]/);
  assert.match(codex, /network_access = true/);
  assert.match(codex, /Agent Options → Codex → sandbox/);
  assert.match(codex, /agentOptions\.codex\.sandbox: false/);
  assert.doesNotMatch(codex, /\.claude\/settings\.json/);
  assert.doesNotMatch(codex, /"allowWrite"/);

  assert.doesNotMatch(opencode, /sandbox/i);
});

test('codex CI skills include built-in subagent guidance', () => {
  const getLatestCi = renderSkill('get-latest-ci');
  const awaitPolygraphCi = renderSkill('await-polygraph-ci');

  assert.match(getLatestCi, /Use a Codex built-in subagent to call the MCP tool/);
  assert.match(getLatestCi, /Always delegate the MCP call to a Codex built-in subagent/);
  assert.match(getLatestCi, /`wait_agent`/);

  assert.match(awaitPolygraphCi, /Codex subagent wrapper/);
  assert.match(awaitPolygraphCi, /agent_type: "polygraph-delegate-subagent"/);
  assert.match(awaitPolygraphCi, /the delegate-and-poll loop should run inside `polygraph-delegate-subagent`/);
  assert.match(awaitPolygraphCi, /show_agent\(sessionId: "<session-id>", repo: "frontend"\)/);
  assert.doesNotMatch(awaitPolygraphCi, /show_agent\(sessionId: "<session-id>", target: "frontend"\)/);
  assert.match(awaitPolygraphCi, /`wait_agent`/);

  assertNoNonCodexDelegationText(getLatestCi);
  assertNoNonCodexDelegationText(awaitPolygraphCi);
});

test('pack-and-copy skill keeps consumer CI installable', () => {
  const rendered = renderSkill('pack-and-copy');

  assert.match(rendered, /including `\.polygraph-packages\/\*\.tgz`/);
  assert.match(rendered, /Fresh CI clones need those tarballs/);
  assert.match(rendered, /`npm install`, `pnpm install`, or `yarn install`/);
  assert.match(rendered, /On reruns in the same worktree/);
  assert.match(rendered, /`npm install --force`, `pnpm install --force`, or `yarn install --force`/);
  assert.doesNotMatch(rendered, /added to `\.gitignore` automatically/);
});

test('codex agents render as valid custom agent TOML', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'polygraph-codex-agents-'));

  processAgents('codex', {
    outputDir,
    supportsAgents: true,
    agentsDir: 'agents',
    agentsExt: '.toml',
    agentsFormat: 'toml',
  });

  const initAgent = parse(
    readFileSync(join(outputDir, 'agents', 'polygraph-init-subagent.toml'), 'utf8')
  );
  const delegateAgent = parse(
    readFileSync(join(outputDir, 'agents', 'polygraph-delegate-subagent.toml'), 'utf8')
  );

  assert.equal(initAgent.name, 'polygraph-init-subagent');
  assert.match(initAgent.description, /initializes a Polygraph session/);
  assert.match(initAgent.developer_instructions, /# Polygraph Init Subagent/);
  assert.match(initAgent.developer_instructions, /Do NOT call `spawn_agent`/);

  assert.equal(delegateAgent.name, 'polygraph-delegate-subagent');
  assert.match(delegateAgent.description, /Delegates work to a child agent/);
  assert.match(delegateAgent.developer_instructions, /# Polygraph Delegate Subagent/);
  assert.match(delegateAgent.developer_instructions, /Backoff schedule for polling/);
  assert.match(delegateAgent.developer_instructions, /Resume\/reconstruction is read-only/);
  assert.match(delegateAgent.developer_instructions, /After resuming, wait for explicit user instructions/);
});

test('opencode agents render as markdown subagents for plugin registration', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'polygraph-opencode-agents-'));

  processAgents('opencode', {
    outputDir,
    supportsAgents: true,
    agentsDir: 'agents',
    agentsExt: '.md',
  });

  const initAgent = readFileSync(join(outputDir, 'agents', 'polygraph-init-subagent.md'), 'utf8');
  const delegateAgent = readFileSync(join(outputDir, 'agents', 'polygraph-delegate-subagent.md'), 'utf8');

  assert.match(initAgent, /^---\n\s*description: Discovers candidate repositories/);
  assert.match(initAgent, /\nmode: subagent\n\s*---\n/);
  assert.match(initAgent, /# Polygraph Init Subagent/);
  assert.doesNotMatch(initAgent, /^name = /m);

  assert.match(delegateAgent, /^---\n\s*description: Delegates work to a child agent/);
  assert.match(delegateAgent, /\nmode: subagent\n\s*---\n/);
  assert.match(delegateAgent, /# Polygraph Delegate Subagent/);
  assert.doesNotMatch(delegateAgent, /^developer_instructions = /m);
});

test('opencode skill names are native-compatible and match their directories', () => {
  const skillsDir = join(rootDir, 'source', 'skills');

  for (const entry of readdirSync(skillsDir)) {
    if (!statSync(join(skillsDir, entry)).isDirectory()) continue;

    const rendered = renderSkill(entry, 'opencode');
    const name = rendered.match(/^name:\s*(.+)$/m)?.[1].trim();

    assert.equal(name, entry);
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64);
  }
});

test('codex plugin manifest does not advertise agents (codex ignores the field)', () => {
  const manifest = buildCodexPluginManifest(readRootPackageJson());

  assert.equal(manifest.name, 'james-polygraph');
  assert.equal(manifest.agents, undefined);
});

test('codex plugin manifest registers the bundled SessionStart hooks file', () => {
  const manifest = buildCodexPluginManifest(readRootPackageJson());

  assert.equal(manifest.hooks, './hooks/hooks.json');
});

test('codex plugin manifest describes Polygraph beyond multi-repo coordination', () => {
  const manifest = buildCodexPluginManifest(readRootPackageJson());

  assert.equal(
    manifest.interface.shortDescription,
    'Cross-repo visibility and persistent memory for Codex agents.'
  );
  assert.equal(
    manifest.interface.longDescription,
    'Give Codex the Polygraph meta-harness: repository graph context, resumable agent sessions, linked PR and CI state, and workflows for coordinating work across repo boundaries when needed.'
  );
  assert.deepEqual(manifest.interface.defaultPrompt, [
    'Start a Polygraph session for this work.',
    'Start a Polygraph session and include the repos related to this change.',
    'Resume or inspect my Polygraph session and summarize the current state.',
  ]);
});

test('opencode package is published as a native plugin package', () => {
  const pkg = buildOpenCodePackageJson(readRootPackageJson());

  assert.equal(pkg.name, '@ai-jameshenry/james-polygraph-opencode-plugin');
  assert.equal(pkg.private, false);
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.exports, { './server': './server.js' });
  assert.equal(pkg.main, './server.js');
  assert.deepEqual(pkg.dependencies, { 'js-yaml': '^4.1.1' });
  assert.deepEqual(pkg.files, ['server.js', 'agent-capture-mapping.mjs', 'skills/', 'agents/', 'README.md']);
});

test('Claude packaging cannot accidentally restore the legacy local MCP', () => {
  assert.throws(
    () => buildMcpConfig('claude'),
    /Only the Codex package ships the local Polygraph MCP/
  );
});

test('buildMcpConfig can force an MCP server agent type', () => {
  assert.deepEqual(buildMcpConfig('codex'), {
    mcpServers: {
      'james-polygraph-mcp': {
        type: 'stdio',
        command: 'node',
        args: ['${PLUGIN_ROOT}/wip-mcp/bin/polygraph-mcp.mjs'],
        env: {
          POLYGRAPH_AGENT_TYPE: 'codex',
        },
      },
    },
  });
});

test('the WIP fork metadata coexists with the official plugin namespace', () => {
  const pkg = readRootPackageJson();
  const marketplace = JSON.parse(
    readFileSync(join(rootDir, '.claude-plugin', 'marketplace.json'), 'utf8')
  );

  assert.equal(pkg.name, 'james-polygraph-skills');
  assert.equal(marketplace.name, 'james-polygraph-plugins');
  assert.equal(marketplace.plugins[0].name, 'james-polygraph');
  assert.equal(marketplace.plugins[0].source, './dist/claude');
});

test('Claude Code web installation docs require OAuth connector opt-in without machine credentials', () => {
  const docs = readFileSync(
    join(rootDir, 'docs', 'claude-code-web-background-spike.md'),
    'utf8'
  );

  assert.match(docs, /npm ci/);
  assert.match(docs, /npm run build/);
  assert.match(docs, /james-polygraph@james-polygraph-plugins/);
  assert.match(docs, /\/james-polygraph:background-session-start/);
  assert.match(docs, /polygraph-oauth-spike/);
  assert.match(docs, /account-level OAuth connection/);
  assert.match(docs, /ordinary sessions transmit no prompt content/);
  assert.match(docs, /pause and resume/);
  assert.doesNotMatch(docs, /POLYGRAPH_SERVICE_ACCOUNT_(?:CLIENT_ID|SECRET)/);
  assert.doesNotMatch(docs, /source\/wip-mcp/);
});
