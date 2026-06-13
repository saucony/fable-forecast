#!/usr/bin/env node
/**
 * fable-forecast — What will Fable 5 actually cost YOU after June 22, 2026?
 *
 * Reads your local Claude Code session logs (~/.claude/projects/**.jsonl),
 * reprices your real usage — including the cache-token mix that generic
 * calculators ignore — under post-June-22 scenarios, and tells you whether
 * to buy credits, fall back to Opus, or go hybrid.
 *
 * 100% local. Your logs never leave your machine.
 * (The only network call is optional license verification for the Pro report.)
 *
 * Usage:
 *   node cli.js                    # terminal summary (free)
 *   node cli.js --days 14          # change the lookback window
 *   node cli.js --report out.html  # HTML report (preview; full with --key)
 *   node cli.js --key YOUR-KEY --report out.html
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Pricing (USD per million tokens, June 2026, first-party API rates)
// Cache: read = 0.1x input; write 5m = 1.25x input; write 1h = 2x input.
// ---------------------------------------------------------------------------
const PRICING = {
  'fable-5':    { label: 'Fable 5',    input: 10.0, output: 50.0 },
  'opus-4.5+':  { label: 'Opus 4.5–4.8', input: 5.0, output: 25.0 },
  'opus-legacy':{ label: 'Opus ≤4.1',  input: 15.0, output: 75.0 },
  'sonnet':     { label: 'Sonnet',     input: 3.0,  output: 15.0 },
  'haiku-4.5':  { label: 'Haiku 4.5',  input: 1.0,  output: 5.0 },
  'haiku-old':  { label: 'Haiku ≤3.5', input: 0.8,  output: 4.0 },
  'unknown':    { label: 'Unknown',    input: 5.0,  output: 25.0 },
};

function familyOf(model) {
  if (!model || model === '<synthetic>') return null;
  const m = model.toLowerCase();
  if (m.includes('fable')) return 'fable-5';
  if (m.includes('opus')) {
    if (/opus-4-[5-9]/.test(m)) return 'opus-4.5+';
    return 'opus-legacy';
  }
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) {
    if (m.includes('4-5')) return 'haiku-4.5';
    return 'haiku-old';
  }
  return 'unknown';
}

function costOf(tok, fam) {
  const p = PRICING[fam] || PRICING.unknown;
  return (
    (tok.input * p.input +
      tok.output * p.output +
      tok.cacheRead * p.input * 0.1 +
      tok.cacheWrite5m * p.input * 1.25 +
      tok.cacheWrite1h * p.input * 2.0) /
    1e6
  );
}

function zeroTok() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, messages: 0 };
}

function addTok(a, b) {
  a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead;
  a.cacheWrite5m += b.cacheWrite5m; a.cacheWrite1h += b.cacheWrite1h;
  a.messages += b.messages;
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------
function* jsonlFiles(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) yield* jsonlFiles(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

function parseLogs(claudeDir, sinceMs) {
  const projectsDir = path.join(claudeDir, 'projects');
  const seen = new Set(); // dedupe across resumed/forked sessions
  const byModel = new Map(); // family -> tok
  const byProject = new Map(); // project dir name -> { tok, costActual }
  const byDay = new Map(); // YYYY-MM-DD -> costActual
  let firstTs = Infinity, lastTs = -Infinity, files = 0, badLines = 0;

  for (const file of jsonlFiles(projectsDir)) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    files++;
    const project = path.basename(path.dirname(file));
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let d;
      try { d = JSON.parse(line); } catch { badLines++; continue; }
      const msg = d.message;
      if (!msg || typeof msg !== 'object' || !msg.usage) continue;
      const fam = familyOf(msg.model);
      if (!fam) continue;
      const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      const id = msg.id || d.uuid;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const u = msg.usage;
      const cc = u.cache_creation || {};
      const w5 = cc.ephemeral_5m_input_tokens ?? null;
      const w1 = cc.ephemeral_1h_input_tokens ?? null;
      const tok = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite5m: w5 !== null ? w5 : (u.cache_creation_input_tokens || 0),
        cacheWrite1h: w1 !== null ? w1 : 0,
        messages: 1,
      };
      if (ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;

      if (!byModel.has(fam)) byModel.set(fam, zeroTok());
      addTok(byModel.get(fam), tok);

      if (!byProject.has(project)) byProject.set(project, { tok: zeroTok(), cost: 0 });
      const proj = byProject.get(project);
      addTok(proj.tok, tok);
      proj.cost += costOf(tok, fam);

      const day = new Date(ts).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + costOf(tok, fam));
    }
  }
  return { byModel, byProject, byDay, firstTs, lastTs, files, badLines };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
function buildScenarios(byModel) {
  const total = zeroTok();
  let actualCost = 0;
  for (const [fam, tok] of byModel) {
    addTok(total, tok);
    actualCost += costOf(tok, fam);
  }
  return {
    total,
    actual: actualCost,
    allFable: costOf(total, 'fable-5'),
    allOpus: costOf(total, 'opus-4.5+'),
    allSonnet: costOf(total, 'sonnet'),
  };
}

function recommend(s, monthly) {
  const fable = monthly(s.allFable);
  const opus = monthly(s.allOpus);
  const lines = [];
  lines.push(
    `If you keep your current workload entirely on Fable 5 after June 22, ` +
    `expect roughly $${fable.toFixed(0)}/month drawn from usage credits at API-equivalent rates.`
  );
  lines.push(
    `The same workload entirely on Opus 4.8 stays inside normal plan limits ` +
    `(API-equivalent value ≈ $${opus.toFixed(0)}/month) — the Fable premium for you is ` +
    `$${(fable - opus).toFixed(0)}/month (${opus > 0 ? ((fable / opus - 1) * 100).toFixed(0) : '—'}% more).`
  );
  if (fable < 40) {
    lines.push(`Verdict: your Fable burn is modest — buying a small credit pack and staying on Fable is reasonable.`);
  } else if (fable < 250) {
    lines.push(`Verdict: go hybrid — keep Fable for long-horizon/ambiguous tasks, route routine work to Opus 4.8. Budget credits at roughly half the all-Fable number.`);
  } else {
    lines.push(`Verdict: at this volume, all-Fable is a serious line item. Default to Opus 4.8 and reserve Fable for the tasks where the capability gap actually pays for itself.`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
const fmt = (n) => n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3);
const fmtTok = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n);
const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);

function printTerminal(data, opts) {
  const { byModel, byProject, firstTs, lastTs } = data;
  const s = buildScenarios(byModel);
  const days = Math.max(1, (lastTs - firstTs) / 86400000);
  const monthly = (c) => (c / days) * 30;

  console.log('');
  console.log('  fable-forecast — your Claude Code usage, repriced for June 22');
  console.log('  ' + '─'.repeat(62));
  console.log(`  Window: last ${opts.days} days (${new Date(firstTs).toISOString().slice(0,10)} → ${new Date(lastTs).toISOString().slice(0,10)}, ${days.toFixed(1)} active span)`);
  console.log(`  Messages: ${s.total.messages.toLocaleString()}   Tokens: ${fmtTok(s.total.input + s.total.output + s.total.cacheRead + s.total.cacheWrite5m + s.total.cacheWrite1h)} (incl. cache)`);
  console.log('');
  console.log('  Usage by model (API-equivalent value):');
  for (const [fam, tok] of [...byModel.entries()].sort((a, b) => costOf(b[1], b[0]) - costOf(a[1], a[0]))) {
    const c = costOf(tok, fam);
    console.log(`    ${pad(PRICING[fam].label, 14)} in:${rpad(fmtTok(tok.input), 8)}  out:${rpad(fmtTok(tok.output), 8)}  cacheR:${rpad(fmtTok(tok.cacheRead), 8)}  ≈ $${fmt(c)}`);
  }
  console.log('');
  console.log('  Post-June-22 scenarios (your real token + cache mix, monthly):');
  console.log(`    All Fable 5      $${rpad(fmt(monthly(s.allFable)), 9)} /mo  ← credits at API rates`);
  console.log(`    All Opus 4.8     $${rpad(fmt(monthly(s.allOpus)), 9)} /mo`);
  console.log(`    All Sonnet 4.6   $${rpad(fmt(monthly(s.allSonnet)), 9)} /mo`);
  console.log(`    Your actual mix  $${rpad(fmt(monthly(s.actual)), 9)} /mo`);
  console.log('');
  const cacheShare = s.total.cacheRead / Math.max(1, s.total.input + s.total.cacheRead + s.total.cacheWrite5m + s.total.cacheWrite1h);
  console.log(`  Cache check: ${(cacheShare * 100).toFixed(0)}% of your input tokens were cache reads (10x cheaper).`);
  console.log('  Generic calculators that ignore cache would overestimate your bill by');
  const naiveFable = ((s.total.input + s.total.cacheRead + s.total.cacheWrite5m + s.total.cacheWrite1h) * 10 + s.total.output * 50) / 1e6;
  console.log(`  ${s.allFable > 0 ? ((naiveFable / s.allFable - 1) * 100).toFixed(0) : '—'}% (naive all-Fable: $${fmt(monthly(naiveFable))}/mo vs real $${fmt(monthly(s.allFable))}/mo).`);
  console.log('');
  console.log('  Recommendation:');
  for (const line of recommend(s, monthly)) console.log('    • ' + line.replace(/(.{1,72})(\s|$)/g, '$1\n      ').trim());
  console.log('');
  console.log('  Full per-project HTML report: node cli.js --report fable-report.html');
  console.log('');
  return { s, monthly, days };
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------
function htmlReport(data, opts, licensed) {
  const { byModel, byProject, byDay, firstTs, lastTs } = data;
  const s = buildScenarios(byModel);
  const days = Math.max(1, (lastTs - firstTs) / 86400000);
  const monthly = (c) => (c / days) * 30;
  const esc = (x) => String(x).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

  const projects = [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const shownProjects = licensed ? projects : projects.slice(0, 3);
  const dayEntries = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  const maxDay = Math.max(...dayEntries.map(([, c]) => c), 0.0001);

  const scenarioRows = [
    ['All Fable 5 (credits)', monthly(s.allFable)],
    ['All Opus 4.8', monthly(s.allOpus)],
    ['All Sonnet 4.6', monthly(s.allSonnet)],
    ['Your actual mix', monthly(s.actual)],
  ];
  const maxScenario = Math.max(...scenarioRows.map(([, v]) => v), 0.0001);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fable Forecast — June 22 readiness report</title>
<style>
  :root { --ink:#1a1714; --paper:#faf7f2; --accent:#b4532a; --soft:#e8e1d6; --good:#3a7d44; }
  body { font-family: Georgia, 'Times New Roman', serif; background:var(--paper); color:var(--ink); margin:0; padding:2.5rem 1.5rem; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; } h2 { font-size: 1.25rem; margin: 2.2rem 0 .6rem; border-bottom: 2px solid var(--soft); padding-bottom: .3rem; }
  .sub { color:#6b6358; font-style: italic; margin-bottom: 1.6rem; }
  table { border-collapse: collapse; width: 100%; font-size: .95rem; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--soft); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 1.1rem; background: var(--accent); border-radius: 2px; min-width: 2px; }
  .bar.alt { background: #8a9b6e; }
  .big { font-size: 2.4rem; font-weight: bold; }
  .cards { display:flex; gap:1rem; flex-wrap:wrap; margin:1.2rem 0; }
  .card { flex:1 1 180px; background:#fff; border:1px solid var(--soft); border-radius:8px; padding:1rem 1.2rem; }
  .card .label { font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; color:#6b6358; }
  .verdict { background:#fff; border-left: 4px solid var(--accent); padding: 1rem 1.2rem; margin: 1rem 0; }
  .spark { display:flex; align-items:flex-end; gap:2px; height:90px; margin:.8rem 0; }
  .spark div { flex:1; background:var(--accent); opacity:.8; border-radius:1px 1px 0 0; }
  .upsell { background:#fff; border:2px dashed var(--accent); border-radius:8px; padding:1.2rem; margin:1.5rem 0; }
  .muted { color:#6b6358; font-size:.85rem; }
  footer { margin-top:3rem; color:#6b6358; font-size:.85rem; border-top:1px solid var(--soft); padding-top:1rem; }
</style></head><body><main>
<h1>Fable Forecast</h1>
<div class="sub">Your Claude Code usage, repriced for the June 22 credit change · window: ${esc(new Date(firstTs).toISOString().slice(0,10))} → ${esc(new Date(lastTs).toISOString().slice(0,10))} · generated locally${licensed ? '' : ' · FREE PREVIEW'}</div>

<div class="cards">
  <div class="card"><div class="label">All-Fable, monthly</div><div class="big">$${esc(fmt(monthly(s.allFable)))}</div><div class="muted">credits at API rates</div></div>
  <div class="card"><div class="label">All-Opus 4.8, monthly</div><div class="big">$${esc(fmt(monthly(s.allOpus)))}</div><div class="muted">stays on plan limits</div></div>
  <div class="card"><div class="label">Fable premium</div><div class="big">$${esc(fmt(monthly(s.allFable) - monthly(s.allOpus)))}</div><div class="muted">what Fable costs you over Opus</div></div>
</div>

<h2>Scenario comparison (monthly, your real cache mix)</h2>
<table>${scenarioRows.map(([label, v]) => `
<tr><td style="width:11rem">${esc(label)}</td><td><div class="bar${label.includes('Fable') ? '' : ' alt'}" style="width:${(v / maxScenario * 100).toFixed(1)}%"></div></td><td class="num" style="width:7rem">$${esc(fmt(v))}/mo</td></tr>`).join('')}
</table>
<p class="muted">Repriced from ${s.total.messages.toLocaleString()} assistant messages: input ${esc(fmtTok(s.total.input))}, output ${esc(fmtTok(s.total.output))}, cache reads ${esc(fmtTok(s.total.cacheRead))} (0.1×), cache writes ${esc(fmtTok(s.total.cacheWrite5m + s.total.cacheWrite1h))} (1.25–2×). Subscription usage is repriced at API-equivalent rates — that's exactly how credits draw down after June 22.</p>

<h2>Daily burn (actual mix, API-equivalent $)</h2>
<div class="spark">${dayEntries.map(([d, c]) => `<div style="height:${Math.max(2, c / maxDay * 100).toFixed(1)}%" title="${esc(d)}: $${esc(fmt(c))}"></div>`).join('')}</div>
<p class="muted">${esc(dayEntries[0]?.[0] || '')} → ${esc(dayEntries[dayEntries.length - 1]?.[0] || '')}, peak day $${esc(fmt(maxDay))}</p>

<h2>Where it goes — by project${licensed ? '' : ` (top 3 of ${projects.length})`}</h2>
<table><tr><th>Project</th><th class="num">Messages</th><th class="num">Output tok</th><th class="num">Value (window)</th><th class="num">All-Fable /mo</th></tr>
${shownProjects.map(([name, p]) => `<tr><td>${esc(name.replace(/^-Users-[^-]+-?/, '~/').replace(/-/g, '/'))}</td><td class="num">${p.tok.messages.toLocaleString()}</td><td class="num">${esc(fmtTok(p.tok.output))}</td><td class="num">$${esc(fmt(p.cost))}</td><td class="num">$${esc(fmt(monthly(costOf(p.tok, 'fable-5'))))}</td></tr>`).join('\n')}
</table>
${licensed ? '' : `<div class="upsell"><b>This is the free preview.</b> The full report unlocks every project, the model-by-model breakdown, and the routing recommendation table (which projects to keep on Fable vs route to Opus/Sonnet). Unlock key: <a href="https://gumroad.com">$12 on Gumroad</a> → <code>node cli.js --key YOUR-KEY --report report.html</code></div>`}

${licensed ? `<h2>Model breakdown</h2>
<table><tr><th>Model family</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache reads</th><th class="num">Cache writes</th><th class="num">Value</th></tr>
${[...byModel.entries()].sort((a, b) => costOf(b[1], b[0]) - costOf(a[1], a[0])).map(([fam, t]) => `<tr><td>${esc(PRICING[fam].label)}</td><td class="num">${esc(fmtTok(t.input))}</td><td class="num">${esc(fmtTok(t.output))}</td><td class="num">${esc(fmtTok(t.cacheRead))}</td><td class="num">${esc(fmtTok(t.cacheWrite5m + t.cacheWrite1h))}</td><td class="num">$${esc(fmt(costOf(t, fam)))}</td></tr>`).join('\n')}
</table>` : ''}

<h2>Verdict</h2>
<div class="verdict">${recommend(s, monthly).map((l) => `<p>${esc(l)}</p>`).join('')}</div>

<footer>Generated by <b>fable-forecast</b> — runs 100% locally; your logs never leave your machine. Pricing: Fable 5 $10/$50 per MTok, Opus 4.8 $5/$25, Sonnet 4.6 $3/$15; cache reads 0.1×, cache writes 1.25×/2× (5m/1h). Independent tool, not affiliated with Anthropic. Estimates, not invoices.</footer>
</main></body></html>`;
}

// ---------------------------------------------------------------------------
// License (Gumroad) — verified once, cached locally. Fails open politely.
// ---------------------------------------------------------------------------
// Unique permalink of the Gumroad product (stable even if the pretty URL changes).
const GUMROAD_PRODUCT_PERMALINK = process.env.FABLE_FORECAST_PRODUCT_ID || 'lbosvv';
const LICENSE_CACHE = path.join(os.homedir(), '.fable-forecast-license');

async function verifyKey(key) {
  try {
    if (fs.existsSync(LICENSE_CACHE) && fs.readFileSync(LICENSE_CACHE, 'utf8').trim() === key) return true;
  } catch {}
  try {
    const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ product_permalink: GUMROAD_PRODUCT_PERMALINK, license_key: key, increment_uses_count: 'true' }),
    });
    const body = await res.json();
    if (body && body.success) {
      try { fs.writeFileSync(LICENSE_CACHE, key, { mode: 0o600 }); } catch {}
      return true;
    }
    return false;
  } catch {
    // Offline or Gumroad down: don't punish a paying user.
    console.error('  (license server unreachable — accepting key provisionally)');
    return true;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf('--' + name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const opts = {
    days: parseInt(opt('days', '30'), 10) || 30,
    report: opt('report', null),
    json: opt('json', null),
    key: opt('key', null),
    claudeDir: opt('claude-dir', path.join(os.homedir(), '.claude')),
  };

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: fable-forecast [--days N] [--report out.html] [--json out.json] [--key LICENSE] [--claude-dir DIR]');
    return;
  }

  const sinceMs = Date.now() - opts.days * 86400000;
  const data = parseLogs(opts.claudeDir, sinceMs);

  if (data.byModel.size === 0) {
    console.error(`No Claude Code usage found in ${opts.claudeDir}/projects for the last ${opts.days} days.`);
    console.error('Is Claude Code installed and used on this machine? Try --claude-dir or a larger --days.');
    process.exit(1);
  }

  printTerminal(data, opts);

  if (opts.json) {
    // Aggregate-only export for team audits: token counts and derived costs.
    // Contains NO prompts, code, file names, or message content.
    const s = buildScenarios(data.byModel);
    const out = {
      tool: 'fable-forecast', version: 1,
      generatedAt: new Date().toISOString(),
      windowDays: opts.days,
      firstTs: new Date(data.firstTs).toISOString(),
      lastTs: new Date(data.lastTs).toISOString(),
      totals: s.total,
      scenariosWindow: { actual: s.actual, allFable: s.allFable, allOpus: s.allOpus, allSonnet: s.allSonnet },
      byModel: Object.fromEntries([...data.byModel].map(([f, t]) => [f, { ...t, costWindow: costOf(t, f) }])),
      byProject: Object.fromEntries([...data.byProject].map(([n, p]) => [n, { ...p.tok, costWindow: p.cost }])),
    };
    fs.writeFileSync(opts.json, JSON.stringify(out, null, 2));
    console.log(`  JSON summary written to ${opts.json} (aggregate token counts only)\n`);
  }

  if (opts.report) {
    let licensed = false;
    if (opts.key) licensed = await verifyKey(opts.key);
    if (opts.key && !licensed) console.error('  License key not recognized — generating free preview instead.\n');
    fs.writeFileSync(opts.report, htmlReport(data, opts, licensed));
    console.log(`  ${licensed ? 'Full report' : 'Preview report'} written to ${opts.report}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
