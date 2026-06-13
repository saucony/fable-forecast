# fable-forecast

**What will Fable 5 actually cost *you* after June 22?**

On June 22, 2026, Claude Fable 5 leaves the free tier on Pro/Max/Team plans.
After that, every Fable token draws prepaid usage credits at API rates —
$10/MTok in, $50/MTok out, double Opus 4.8.

Generic calculators can't answer the real question, because they ignore your
**cache mix**. Cache reads cost 10× less than fresh input, and for a typical
Claude Code user 90%+ of input tokens are cache reads — so naive estimates
overshoot by 5–8×.

`fable-forecast` reads your local Claude Code session logs
(`~/.claude/projects/**/*.jsonl`), reprices your *real* last-30-days usage —
input, output, cache reads, 5-minute and 1-hour cache writes — under
post-June-22 scenarios, and gives you a verdict:

```
Post-June-22 scenarios (your real token + cache mix, monthly):
  All Fable 5      $   312 /mo   ← credits at API rates
  All Opus 4.8     $   156 /mo
  All Sonnet 4.6   $    94 /mo
  Your actual mix  $   171 /mo

Cache check: 99% of your input tokens were cache reads (10x cheaper).
A naive calculator would overestimate your bill by 749%.
```

## Run it

No install, no dependencies, no telemetry. **100% local — your logs never
leave your machine.**

```bash
git clone https://github.com/saucony/fable-forecast && node fable-forecast/cli.js
```

Options:

```
--days N            lookback window (default 30)
--report out.html   write an HTML report
--key LICENSE-KEY   unlock the full report (per-project breakdown + routing table)
--claude-dir DIR    non-standard ~/.claude location
```

## Free vs Pro

- **Free (this repo):** full terminal summary, all scenarios, cache-accuracy
  check, verdict — everything above.
- **Pro report ($12):** self-contained HTML with every project broken out,
  daily burn chart, model-by-model table, and a routing recommendation
  (which projects justify Fable, which to route to Opus/Sonnet).
- **Team Credit Cliff Audit ($249):** run the collector across your team,
  we turn it into a written buy/route/stay decision memo for your eng leads.

Both on Gumroad — link in the repo description.

## Honesty notes

- Subscription usage doesn't bill per token today; the tool reprices it at
  **API-equivalent rates**, which is exactly how credits draw down after
  June 22. Estimates, not invoices.
- Independent tool. Not affiliated with Anthropic.

MIT licensed.
