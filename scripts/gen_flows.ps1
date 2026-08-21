# Generates the screening-to-intake decision flow for every active program.
#
# Mirrors web/matcher.js exactly: the same rule-reading patterns, the same gate
# order, the same tenure and help-type tests. The document must describe what
# the screener actually does, not an idealised version of it.

#   powershell -ExecutionPolicy Bypass -File scripts\gen_flows.ps1
#
# Reads the live database through PostgREST with the public (read-only) key,
# writes web/flows/index.html and docs/flows.json, and optionally a
# self-contained copy of the page (-ArtifactOut). Run after any program load.
param(
    [string]$SupabaseUrl = "https://vhhcicawkhokncnhzboe.supabase.co",
    [string]$AnonKey     = "sb_publishable_uWoahvwMH3VYZ7n2egHi8Q_AJBUSZjQ",
    [string]$ArtifactOut = ""
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$sp = Join-Path ([IO.Path]::GetTempPath()) "toto-flows"; New-Item -ItemType Directory -Force $sp | Out-Null

$H = @{ apikey = $AnonKey; Authorization = "Bearer $AnonKey"; Accept = "application/json" }
function Fetch($query) {
    $raw = Invoke-WebRequest -Uri "$SupabaseUrl/rest/v1/$query" -Headers $H -UseBasicParsing
    [Text.Encoding]::UTF8.GetString($raw.RawContentStream.ToArray()) | ConvertFrom-Json
}
$programs = Fetch "programs?select=*,program_counties(county,state_code),eligibility(*),contacts(*),forms(*)&is_active=eq.true&order=program_id&limit=2000"
$rules    = Fetch "v_program_datasets?select=program_id,standard_id,standard_name,tier_max_pct,area,income_test,published_when&limit=2000"
$limits   = Fetch "v_current_income_limits?select=standard_id,area_id,tier_pct,amount,effective_date&household_size=eq.4&limit=5000"
"fetched: $($programs.Count) programs, $($rules.Count) rules, $($limits.Count) 4-person limits"

$ruleById = @{}; foreach ($r in $rules) { $ruleById[$r.program_id] = $r }

# 4-person limits keyed standard|area|tier, newest effective date wins.
$lim = @{}
foreach ($l in $limits) {
  $k = "$($l.standard_id)|$($l.area_id)|$([int][double]$l.tier_pct)"
  if (-not $lim.ContainsKey($k) -or $l.effective_date -gt $lim[$k].date) { $lim[$k] = @{ amount = [double]$l.amount; date = $l.effective_date } }
}
$proportional = @('HHS-FPG','HUD-MTSP','HUD-MTSP-HERA','OR-SMI','MN-SMI','OHCS-MIRL','OHCS-THGF')

function Esc($s) { if ($null -eq $s) { return '' }; ([string]$s).Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;').Replace('"','&quot;') }

# --- matcher.js mirrors -------------------------------------------------------
function Read-Rule($t) {
  $v = "$t".Trim()
  if ($v -eq '' -or $v -match '^(no|none|n/a)\b' -or $v -match '^not\b' -or $v -match 'priority only' -or $v -match 'voluntary demographic') { return 'not-required' }
  if ($v -match '^yes\b' -or $v -match '\bmust\b' -or $v -match '\brequired?\b') { return 'required' }
  return 'unknown'
}
function Tenure-Set($t) {
  $raw = "$t".ToLower()
  if ($raw.Trim() -eq '') { return @{ any = $true; list = @() } }
  $noPro = $raw -replace 'prospective homeowner', ''
  $list = @()
  if ($raw -match 'renter') { $list += 'renting' }
  if ($noPro -match 'homeowner') { $list += 'homeowner' }
  if ($raw -match 'prospective homeowner|first-time') { $list += 'buying' }
  if ($raw -match 'homeless|unstably housed|transitional|unhoused') { $list += 'unhoused' }
  elseif ($raw -match 'renter') { $list += 'unhoused?' }   # renter programs stay in play for unhoused, as "unknown"
  return @{ any = $false; list = $list }
}
function Help-Paths($cat) {
  $c = "$cat"
  $u = $c -match 'utility|energy|heat|water|sewer|electric|gas|weatheriz'
  $h = $c -match 'rent|housing|shelter|homeless|stabili|down payment|homebuyer|home ?ownership|home repair|mortgage|rehabilitation'
  if (-not $u -and -not $h) { return @('finding','staying','utility') }
  if ($u) { return @('utility','staying') } else { return @('finding','staying') }
}
function Area-Id($county, $state) {
  if ($county -eq 'Statewide') { return $state }
  if ($county -eq 'Unspecified') { return $null }
  return "$state-" + ($county.ToUpper() -replace ' ', '-')
}
function Limit-4p($std, $area, $tier) {
  if (-not $std -or -not $area -or $null -eq $tier) { return $null }
  $t = [int][double]$tier
  $k = "$std|$area|$t"
  if ($lim.ContainsKey($k)) { return @{ amount = $lim[$k].amount; approx = $false; date = $lim[$k].date } }
  foreach ($anchor in @(100,80,60,50,30)) {
    $ka = "$std|$area|$anchor"
    if ($lim.ContainsKey($ka)) {
      return @{ amount = ($lim[$ka].amount / $anchor) * $t; approx = ($proportional -notcontains $std); date = $lim[$ka].date }
    }
  }
  return $null
}
$gateDefs = @(
  @{ key='veteran';        field='veteran_rule';    q='Is a household member a veteran?';                      label='veteran status' },
  @{ key='senior';         field='age_rule';        q='Is a household member 60 or older?';                   label='the age of household members' },
  @{ key='disability';     field='disability_rule'; q='Does a household member have a disability?';           label='a household member with a disability' },
  @{ key='children';       field='children_rule';   q='Are there children, or is someone pregnant?';           label='children in the household or pregnancy' },
  @{ key='crisis';         field='crisis_required'; q='Facing eviction, a shutoff, or displacement?';          label='an eviction, shutoff, or displacement crisis' },
  @{ key='firstTimeBuyer'; field='first_time_buyer';q='Has nobody in the household owned a home in 3 years?';  label='first-time homebuyer status' },
  @{ key='utilityAccount'; field='utility_required';q='Is a utility account in your name?';                    label='a utility account in your name' }
)

# --- build flows ----------------------------------------------------------------
$flows = New-Object System.Collections.Generic.List[object]
foreach ($p in $programs) {
  $e = $p.eligibility; $c = $p.contacts; $r = $ruleById[$p.program_id]
  $counties = @($p.program_counties | ForEach-Object { $_.county })
  $firstCounty = ($counties | Where-Object { $_ -ne 'Statewide' -and $_ -ne 'Unspecified' } | Select-Object -First 1)
  if (-not $firstCounty) { $firstCounty = 'Statewide' }
  $areaForLimit = if ($r.area -eq 'applicant county') { Area-Id $firstCounty $p.state_code } else { $r.area }
  $tested = ($r.income_test -eq 'income test applied')
  $l4 = if ($tested) { Limit-4p $r.standard_id $areaForLimit $r.tier_max_pct } else { $null }

  $gates = foreach ($g in $gateDefs) {
    $txt = $e.($g.field)
    [pscustomobject]@{ key=$g.key; question=$g.q; label=$g.label; state=(Read-Rule $txt); evidence="$txt".Trim() }
  }
  $ten = Tenure-Set $e.eligible_tenure
  $form = @($p.forms | Select-Object -First 1)[0]
  $formUrl = if ($form -and $form.has_real_form) { $form.form_url } else { $null }

  $flows.Add([pscustomobject]@{
    program_id = $p.program_id; name = $p.program_name; administrator = $p.administrator
    state = $p.state_code; category = $p.category; counties = $counties
    help_paths = @(Help-Paths $p.category)
    tenure = [pscustomobject]@{ any = $ten.any; matches = @($ten.list); evidence = "$($e.eligible_tenure)".Trim() }
    income = [pscustomobject]@{
      tested = $tested; standard = $r.standard_id; standard_name = $r.standard_name
      tier = $(if ($tested) { [int][double]$r.tier_max_pct } else { $null })
      area = $r.area; example_county = $firstCounty
      limit_4p = $(if ($l4) { [math]::Round($l4.amount) } else { $null }); approx = $(if ($l4) { $l4.approx } else { $null })
      evidence = "$($e.income_standard)".Trim(); republished = $r.published_when
    }
    gates = @($gates)
    intake = [pscustomobject]@{
      status = "$($p.application_status)".Trim(); window = "$($p.application_window)".Trim()
      method = "$($p.application_method)".Trim(); documents = "$($p.required_documents)".Trim()
      form_url = $formUrl; form_notes = "$($form.form_notes)".Trim(); program_url = $p.source_url
      phone = "$($c.phone)".Trim(); email = "$($c.email)".Trim(); address = "$($c.address)".Trim(); hours = "$($c.intake_hours)".Trim()
      priority = "$($p.priority_factors)".Trim(); disqualifiers = "$($p.other_disqualifiers)".Trim()
      benefit = "$($p.benefit_type)".Trim(); max_benefit = "$($p.max_benefit)".Trim()
    }
  })
}

$flows | ConvertTo-Json -Depth 6 | Set-Content "$sp\flows.json" -Encoding UTF8

# --- HTML --------------------------------------------------------------------------
$sym = @{ required = '●'; 'not-required' = '○'; unknown = '?' }
$symTitle = @{ required = 'required — a "no" excludes'; 'not-required' = 'no requirement'; unknown = 'not documented — flagged, never excludes' }
$helpLabel = @{ finding = 'Finding a place'; staying = 'Staying housed'; utility = 'Utility bill' }
$tenLabel = @{ renting = 'renting'; homeowner = 'own my home'; buying = 'hoping to buy'; unhoused = 'not stably housed'; 'unhoused?' = 'not stably housed (kept in, flagged)' }
function Money($n) { if ($null -eq $n) { return '' }; '$' + ('{0:N0}' -f [double]$n) }

$sb = New-Object System.Text.StringBuilder
function W($s) { [void]$sb.AppendLine($s) }

W @'
<title>Toto Screening Flows</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{--ground:#f7f9fa;--surface:#fff;--sunk:#eef2f4;--rule:#dbe3e7;--rule2:#c2cfd6;--ink:#14202a;--ink2:#4c5c68;--ink3:#77878f;--accent:#1d5468;--accent2:#e2eef2;--accentink:#133c4c;--warn:#8a5716;--warn2:#fbf1e0;--bad:#8c322b;--bad2:#fbeae7;--ok:#1f6b45;--ok2:#e4f3ea;--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--body:Manrope,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--disp:Manrope,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--ground:#10171d;--surface:#17212a;--sunk:#1e2a34;--rule:#2c3a45;--rule2:#3e4f5c;--ink:#e8eef2;--ink2:#b0bec8;--ink3:#8092a0;--accent:#6fb6cd;--accent2:#16303b;--accentink:#a9d6e5;--warn:#d5a052;--warn2:#2e2413;--bad:#e08b82;--bad2:#301b19;--ok:#6cc79a;--ok2:#14301f}}
:root[data-theme=dark]{--ground:#10171d;--surface:#17212a;--sunk:#1e2a34;--rule:#2c3a45;--rule2:#3e4f5c;--ink:#e8eef2;--ink2:#b0bec8;--ink3:#8092a0;--accent:#6fb6cd;--accent2:#16303b;--accentink:#a9d6e5;--warn:#d5a052;--warn2:#2e2413;--bad:#e08b82;--bad2:#301b19;--ok:#6cc79a;--ok2:#14301f}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
.shell{max-width:1200px;margin:0 auto;padding:0 clamp(1rem,3vw,2.5rem);display:grid;grid-template-columns:1fr;gap:2rem}
@media(min-width:960px){.shell{grid-template-columns:15rem minmax(0,1fr);align-items:start}.rail{position:sticky;top:1.5rem;max-height:calc(100vh - 3rem);overflow:auto}}
.masthead{grid-column:1/-1;padding:clamp(2.5rem,6vw,4rem) 0 1.75rem;border-bottom:2px solid var(--ink)}
.creed{background:var(--surface);border:1px solid var(--rule);border-left:4px solid var(--accent);border-radius:4px;padding:1.2rem 1.4rem;margin:0 0 1.5rem}.creed p{margin:0;max-width:none;font-size:1.02rem}.creed p+p{margin-top:.7rem;color:var(--ink2);font-size:.95rem}
.eyebrow{font-family:var(--mono);font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin:0 0 .9rem}
.masthead h1{font-family:var(--disp);font-weight:700;font-size:clamp(2rem,1.3rem+3vw,3rem);line-height:1.08;letter-spacing:-.03em;margin:0 0 .8rem;max-width:22ch;text-wrap:balance}
.standfirst{font-size:1.05rem;color:var(--ink2);max-width:64ch;margin:0;text-wrap:pretty}
.rail{font-size:.84rem;padding-top:2.25rem}.rail h2{font-family:var(--mono);font-size:.68rem;letter-spacing:.15em;text-transform:uppercase;color:var(--ink3);margin:1rem 0 .5rem;font-weight:600}.rail h2:first-child{margin-top:0}
.rail ol{list-style:none;margin:0;padding:0;display:grid;gap:.08rem}.rail a{display:block;padding:.28rem .55rem;color:var(--ink2);text-decoration:none;border-left:2px solid var(--rule);line-height:1.3}.rail a:hover{color:var(--accentink);border-left-color:var(--accent);background:var(--accent2)}.rail small{display:block;color:var(--ink3);font-family:var(--mono);font-size:.68rem}
main{padding:2.25rem 0 5rem;min-width:0}section+section{margin-top:3.5rem}
h2.head{font-family:var(--disp);font-weight:600;font-size:clamp(1.4rem,1.1rem+1vw,1.85rem);margin:0 0 1rem;padding-bottom:.5rem;border-bottom:1px solid var(--rule2);text-wrap:balance}
h3{font-size:1rem;font-weight:650;margin:1.75rem 0 .55rem}p{margin:0 0 1rem;max-width:68ch;text-wrap:pretty}a{color:var(--accentink)}
code{font-family:var(--mono);font-size:.86em;background:var(--sunk);padding:.08em .36em;border-radius:3px}
figure{margin:0 0 1.25rem;background:var(--surface);border:1px solid var(--rule);border-radius:4px;padding:1.25rem 1.25rem .9rem;overflow-x:auto}figure svg{display:block;max-width:100%;height:auto;color:var(--ink)}figcaption{font-size:.86rem;color:var(--ink2);margin-top:.75rem;max-width:70ch}
.scroll{overflow-x:auto;margin:0 0 1.4rem;border:1px solid var(--rule);border-radius:4px;background:var(--surface)}table{border-collapse:collapse;width:100%;font-size:.86rem}th,td{text-align:left;padding:.5rem .7rem;border-bottom:1px solid var(--rule);vertical-align:top}thead th{font-family:var(--mono);font-size:.64rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);background:var(--sunk);white-space:nowrap;position:sticky;top:0}tbody tr:last-child td{border-bottom:none}
.matrix td{white-space:nowrap}.matrix td.g{text-align:center;font-family:var(--mono);font-size:1rem;width:2.6rem}.matrix td.g.req{color:var(--bad)}.matrix td.g.unk{color:var(--warn)}.matrix td.g.no{color:var(--ink3)}.matrix td.num{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right}.matrix td.pid{font-family:var(--mono);font-size:.76rem;color:var(--ink3)}
.std-tag{font-family:var(--mono);font-size:.74rem;color:var(--accentink);background:var(--accent2);padding:.1em .42em;border-radius:3px;white-space:nowrap}
.legend{display:flex;flex-wrap:wrap;gap:.4rem 1.4rem;font-size:.84rem;color:var(--ink2);margin:0 0 1rem}.legend b{font-family:var(--mono);font-weight:400}.legend .req{color:var(--bad)}.legend .unk{color:var(--warn)}.legend .no{color:var(--ink3)}
.prog{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:1.4rem 1.5rem;margin:0 0 1.25rem;scroll-margin-top:1rem}.prog>header{border-bottom:1px solid var(--rule);padding-bottom:.75rem;margin-bottom:1rem}.prog h3{margin:0 0 .25rem;font-size:1.1rem;letter-spacing:-.01em}.prog .sub{color:var(--ink3);font-size:.84rem;margin:0}.prog .sub .std-tag{margin-right:.4rem}
.flow{list-style:none;margin:0 0 1.2rem;padding:0;display:grid;gap:0}.flow li{display:grid;grid-template-columns:2rem 1fr;gap:.75rem;padding:.55rem 0;border-bottom:1px dashed var(--rule)}.flow li:last-child{border-bottom:none}.flow .n{font-family:var(--mono);font-size:.72rem;color:var(--ink3);padding-top:.25rem;text-align:right}.flow .q{font-weight:600}.flow .a{font-size:.9rem;color:var(--ink2);margin:.1rem 0 0}.flow .ev{font-size:.82rem;color:var(--ink3);margin:.15rem 0 0;font-style:italic}
.pass{color:var(--ok)}.fail{color:var(--bad)}.flag{color:var(--warn)}.flow .verdict{font-family:var(--mono);font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;margin-right:.4rem}
.steps{list-style:none;margin:0;padding:0;counter-reset:s}.steps li{display:grid;grid-template-columns:1.6rem 1fr;gap:.6rem;padding:.45rem 0;font-size:.92rem}.steps li::before{counter-increment:s;content:counter(s);font-family:var(--mono);font-size:.72rem;color:var(--accent);border:1px solid var(--accent);border-radius:50%;width:1.4rem;height:1.4rem;display:grid;place-items:center;margin-top:.15rem}.steps b{display:block;font-weight:650;font-size:.8rem;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3);margin-bottom:.1rem}
.note{border-left:3px solid var(--warn);background:var(--warn2);padding:.7rem 1rem;border-radius:0 4px 4px 0;margin:.8rem 0;font-size:.88rem}.note.hard{border-left-color:var(--bad);background:var(--bad2)}.note .label{display:block;font-family:var(--mono);font-size:.64rem;letter-spacing:.1em;text-transform:uppercase;color:var(--warn);margin-bottom:.2rem}.note.hard .label{color:var(--bad)}.note p{margin:0;max-width:none}
.two{display:grid;gap:1rem 2rem;grid-template-columns:minmax(0,1fr)}@media(min-width:800px){.two{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}.two>div{min-width:0}.prog{overflow-wrap:anywhere}
.state-head{font-family:var(--mono);font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3);margin:2.5rem 0 .75rem}
.colophon{grid-column:1/-1;border-top:1px solid var(--rule2);padding:1.5rem 0 3rem;color:var(--ink3);font-size:.86rem}
</style>
<div class="shell">
<header class="masthead">
<p class="eyebrow">Standard Operating Procedure · screening to intake</p>
<h1>From the first question to the program's front door</h1>
<p class="standfirst">For each of the 66 active programs: the questions the screener asks, the gate each one applies, what a "no" does, the income limit in dollars, and then — once a program matches — exactly how to apply, what to bring, and who to contact. Generated from the live database so it describes what the screener actually does.</p>
</header>
'@
$artHead = $sb.ToString(); [void]$sb.Clear()

# --- rail ---
W '<h2>Sections</h2><ol><li><a href="#rule">The governing rule</a></li><li><a href="#trunk">The shared trunk</a></li><li><a href="#matrix">Gate matrix</a></li><li><a href="#flows">Program flows</a></li><li><a href="#reading">How to read a flow</a></li></ol>'
foreach ($st in @('OR','MN')) {
  W "<h2>$(if($st -eq 'OR'){'Oregon'}else{'Minnesota'})</h2><ol>"
  foreach ($f in ($flows | Where-Object { $_.state -eq $st } | Sort-Object category, name)) {
    $short = if ($f.name.Length -gt 40) { $f.name.Substring(0,40) + '…' } else { $f.name }
    W "<li><a href=`"#p-$(Esc $f.program_id)`">$(Esc $short)<small>$(Esc $f.program_id)</small></a></li>"
  }
  W '</ol>'
}
$rail = $sb.ToString(); [void]$sb.Clear()

# --- governing rule ---
W @'
<section id="rule"><h2 class="head">The governing rule</h2>
<div class="creed">
<p>The screener removes a program only for a documented requirement the applicant's answer fails. It never removes a program for a question it doesn't answer, a limit that isn't published, or a box that wasn't ticked.</p>
<p>Every gate below is traceable to a line in the program's own materials — the evidence line under it. When a gate is wrong, fix the wording in the program matrix and reload; do not change the screener.</p>
</div>
</section>
'@

# --- trunk diagram ---
W @'
<section id="trunk"><h2 class="head">The shared trunk: what every applicant is asked</h2>
<p>Seven questions, asked once, in this order. Each one prunes the list of programs. A program is never removed by a question it doesn't care about — only by a documented requirement the answer fails.</p>
<figure>
<svg viewBox="0 0 1180 250" role="img" aria-label="The seven screening questions in order, with what each one removes from the program list, and the utility path skipping the tenure question">
<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" fill="currentColor"/></marker></defs>
<g fill="none" stroke="currentColor" stroke-width="1.5">
<rect x="10" y="60" width="120" height="52" rx="4"/><rect x="170" y="60" width="120" height="52" rx="4"/><rect x="330" y="60" width="130" height="52" rx="4"/><rect x="500" y="60" width="120" height="52" rx="4"/><rect x="660" y="60" width="120" height="52" rx="4"/><rect x="820" y="60" width="120" height="52" rx="4"/><rect x="980" y="60" width="140" height="52" rx="4"/>
<line x1="130" y1="86" x2="168" y2="86" marker-end="url(#ar)"/><line x1="290" y1="86" x2="328" y2="86" marker-end="url(#ar)"/><line x1="460" y1="86" x2="498" y2="86" marker-end="url(#ar)"/><line x1="620" y1="86" x2="658" y2="86" marker-end="url(#ar)"/><line x1="780" y1="86" x2="818" y2="86" marker-end="url(#ar)"/><line x1="940" y1="86" x2="978" y2="86" marker-end="url(#ar)"/>
<path d="M395 112 Q 395 170 560 170 Q 720 170 720 114" stroke="#c2410c" stroke-dasharray="5 4" marker-end="url(#ar)"/>
</g>
<g font-family="system-ui,sans-serif" font-size="12" fill="currentColor" text-anchor="middle">
<text x="70" y="81" font-weight="600">1 · State</text><text x="70" y="99" font-size="11">OR or MN</text>
<text x="230" y="81" font-weight="600">2 · County</text><text x="230" y="99" font-size="11">that state only</text>
<text x="395" y="81" font-weight="600">3 · Help needed</text><text x="395" y="99" font-size="11">find · stay · utility</text>
<text x="560" y="81" font-weight="600">4 · Tenure</text><text x="560" y="99" font-size="11">rent · own · buy · unhoused</text>
<text x="720" y="81" font-weight="600">5 · Household</text><text x="720" y="99" font-size="11">1–12 people</text>
<text x="880" y="81" font-weight="600">6 · Income</text><text x="880" y="99" font-size="11">gross, annual</text>
<text x="1050" y="81" font-weight="600">7 · Circumstances</text><text x="1050" y="99" font-size="11">seven checkboxes</text>
</g>
<g font-family="system-ui,sans-serif" font-size="10.5" fill="currentColor" text-anchor="middle">
<text x="149" y="50">scopes</text><text x="149" y="40">limits</text>
<text x="309" y="50">drops programs</text><text x="309" y="40">not serving it</text>
<text x="479" y="50">drops other</text><text x="479" y="40">help types</text>
<text x="639" y="50">drops other</text><text x="639" y="40">tenures</text>
<text x="799" y="50">picks the</text><text x="799" y="40">limit row</text>
<text x="959" y="50">excludes if</text><text x="959" y="40">over ×1.2</text>
<text x="560" y="190" fill="#c2410c">utility path skips tenure — those programs serve renters and owners alike</text>
<text x="1050" y="150" fill="currentColor">unticked = unknown, never a "no":</text><text x="1050" y="164">a required gate demotes to "possible"</text><text x="1050" y="178">and explains itself</text>
</g>
</svg>
<figcaption>The trunk is identical for every program. Arrow labels state what each answer removes. Income excludes only when gross income is more than 20% over the published limit, because programs test income after deductions; circumstances are soft gates — an unticked box demotes a program rather than hiding it.</figcaption>
</figure>
<div class="scroll"><table><thead><tr><th>#</th><th>Question</th><th>Hard or soft</th><th>What it does to the program list</th></tr></thead><tbody>
<tr><td>1</td><td>Which state are you in?</td><td>hard</td><td>Chooses the county list and which state's median-income table applies. Nothing is excluded yet.</td></tr>
<tr><td>2</td><td>Which county do you live in?</td><td>hard</td><td>Removes every program that does not list this county or "Statewide" for this state. County names repeat across states — Douglas exists in both — so the pair is what matches.</td></tr>
<tr><td>3</td><td>What do you need help with?</td><td>hard</td><td><em>Utility bill</em> keeps utility programs only. <em>Finding a place</em> keeps housing programs only. <em>Staying housed</em> keeps both — a shutoff notice is one of the things that costs people their housing. Programs whose category fits neither are never removed.</td></tr>
<tr><td>4</td><td>Rent, own, buying, or not stably housed?</td><td>hard where documented</td><td>Removes programs whose documented tenure does not include yours. Skipped entirely on the utility path. A program with no tenure documented is kept and flagged.</td></tr>
<tr><td>5</td><td>How many people in your household?</td><td>—</td><td>Selects the row of the income table. Sizes 1–8 are published; larger households extrapolate by HUD's rule.</td></tr>
<tr><td>6</td><td>Roughly what does your household earn?</td><td>hard at 120%</td><td>Compared to the program's published limit for your size. Over the limit but within 20%: kept and flagged, because programs count income after deductions. More than 20% over: removed. No published limit: kept and flagged. Skipped if you don't answer.</td></tr>
<tr><td>7</td><td>Does any of this apply? (seven boxes)</td><td>soft</td><td>Each program's documented rule is read as <b>required</b>, <b>no requirement</b>, or <b>not documented</b>. A required gate you didn't tick demotes the program to "possible" with a note — it never hides it. Being unhoused implies the crisis box; choosing the utility path implies the utility-account box.</td></tr>
</tbody></table></div>
</section>
'@

# --- matrix ---
W '<section id="matrix"><h2 class="head">Gate matrix: every program, every gate, at a glance</h2>'
W '<p>Rows are programs in the order they appear below. The seven gate columns are the circumstance questions, read exactly as the screener reads each program''s documented rule. The income column is the resolved limit for a four-person household in the program''s first listed county.</p>'
W '<div class="legend"><span><b class="req">●</b> required — an unticked box demotes</span><span><b class="no">○</b> no requirement</span><span><b class="unk">?</b> not documented — flagged, never excludes</span></div>'
W '<div class="scroll"><table class="matrix"><thead><tr><th>Program</th><th>Help path</th><th>Tenure</th><th>Income (4p)</th><th title="veteran">Vet</th><th title="age 60+">60+</th><th title="disability">Dis</th><th title="children / pregnancy">Kids</th><th title="crisis">Crisis</th><th title="first-time buyer">FTB</th><th title="utility account">Util</th></tr></thead><tbody>'
foreach ($st in @('OR','MN')) {
  W "<tr><td colspan=`"11`" style=`"background:var(--sunk);font-family:var(--mono);font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3)`">$(if($st -eq 'OR'){'Oregon'}else{'Minnesota'})</td></tr>"
  foreach ($f in ($flows | Where-Object { $_.state -eq $st } | Sort-Object category, name)) {
    $hp = ($f.help_paths | ForEach-Object { $helpLabel[$_] }) -join ' · '
    $tn = if ($f.tenure.any) { 'any (not documented)' } else { ($f.tenure.matches | ForEach-Object { $tenLabel[$_] }) -join ' · ' }
    $inc = if (-not $f.income.tested) { '<span class="no">none</span>' } elseif ($null -ne $f.income.limit_4p) { "$(if($f.income.approx){'≈ '})$(Money $f.income.limit_4p) <span class=`"pid`">$($f.income.tier)% $(Esc $f.income.standard)</span>" } else { "<span class=`"unk`">$($f.income.tier)% $(Esc $f.income.standard) — not published</span>" }
    $cells = ($f.gates | ForEach-Object { $cls = switch ($_.state) { 'required' {'req'} 'unknown' {'unk'} default {'no'} }; "<td class=`"g $cls`" title=`"$(Esc $symTitle[$_.state])`">$($sym[$_.state])</td>" }) -join ''
    W "<tr><td><a href=`"#p-$(Esc $f.program_id)`">$(Esc $f.name)</a><br><span class=`"pid`">$(Esc $f.program_id)</span></td><td style=`"white-space:normal`">$(Esc $hp)</td><td style=`"white-space:normal`">$(Esc $tn)</td><td class=`"num`">$inc</td>$cells</tr>"
  }
}
W '</tbody></table></div></section>'

# --- per-program flows ---
W '<section id="flows"><h2 class="head">Program flows</h2><p>One card per program. The <b>gates</b> are the trunk questions this program actually tests, in the order the screener applies them, with the program''s own wording as evidence. The <b>intake</b> steps are what happens after a match.</p>'
foreach ($st in @('OR','MN')) {
  W "<p class=`"state-head`">$(if($st -eq 'OR'){'Oregon'}else{'Minnesota'})</p>"
  foreach ($f in ($flows | Where-Object { $_.state -eq $st } | Sort-Object category, name)) {
    $i = $f.income; $k = $f.intake
    W "<article class=`"prog`" id=`"p-$(Esc $f.program_id)`"><header><h3>$(Esc $f.name)</h3><p class=`"sub`"><span class=`"std-tag`">$(Esc $f.program_id)</span>$(Esc $f.administrator) · $(Esc $f.category)</p></header>"
    W '<div class="two"><div>'
    W '<h3 style="margin-top:0">Gates, in order</h3><ol class="flow">'
    # 1 county
    $cl = ($f.counties | Where-Object { $_ -ne 'Unspecified' }) -join ', '
    if ($f.counties -contains 'Unspecified') { W "<li><span class=`"n`">1</span><div><div class=`"q`">Which county?</div><p class=`"a`"><span class=`"verdict flag`">kept + flagged</span>Service area not clearly documented — stays in, asks you to confirm.</p></div></li>" }
    else { W "<li><span class=`"n`">1</span><div><div class=`"q`">Which county?</div><p class=`"a`"><span class=`"verdict pass`">must be</span>$(Esc $cl)$(if($f.counties -contains 'Statewide'){' (statewide program)'})</p></div></li>" }
    # 2 help
    W "<li><span class=`"n`">2</span><div><div class=`"q`">What do you need help with?</div><p class=`"a`"><span class=`"verdict pass`">reached via</span>$(Esc (($f.help_paths | ForEach-Object { $helpLabel[$_] }) -join ' · '))</p><p class=`"ev`">category: $(Esc $f.category)</p></div></li>"
    # 3 tenure
    if ($f.help_paths -contains 'utility' -and $f.help_paths.Count -eq 2) { $tenNote = ' (skipped on the utility path)' } else { $tenNote = '' }
    if ($f.tenure.any) { W "<li><span class=`"n`">3</span><div><div class=`"q`">Rent, own, buying, or unhoused?$tenNote</div><p class=`"a`"><span class=`"verdict flag`">kept + flagged</span>Tenure not documented — never excludes.</p></div></li>" }
    else { W "<li><span class=`"n`">3</span><div><div class=`"q`">Rent, own, buying, or unhoused?$tenNote</div><p class=`"a`"><span class=`"verdict pass`">must be</span>$(Esc (($f.tenure.matches | ForEach-Object { $tenLabel[$_] }) -join ' · '))</p><p class=`"ev`">$(Esc $f.tenure.evidence)</p></div></li>" }
    # 4-5 household + income
    if ($i.tested) {
      $lim = if ($null -ne $i.limit_4p) { "$(if($i.approx){'≈ '})$(Money $i.limit_4p) for 4 people in $(Esc $i.example_county)" } else { 'not published for this area — kept and flagged' }
      W "<li><span class=`"n`">4–5</span><div><div class=`"q`">Household size, then income</div><p class=`"a`"><span class=`"verdict pass`">limit</span>$($i.tier)% of <span class=`"std-tag`">$(Esc $i.standard)</span> — $lim. Over by less than 20%: kept and flagged. Over by more: excluded.</p><p class=`"ev`">$(Esc $i.evidence)</p><p class=`"ev`">republished: $(Esc $i.republished)</p></div></li>"
    } else {
      W "<li><span class=`"n`">4–5</span><div><div class=`"q`">Household size, then income</div><p class=`"a`"><span class=`"verdict pass`">no income test</span>Passes everyone on income.</p><p class=`"ev`">$(Esc $i.evidence)</p></div></li>"
    }
    # 6 circumstances
    $n = 6
    foreach ($g in $f.gates) {
      $v = switch ($g.state) { 'required' { '<span class="verdict fail">required</span>A "no" demotes this program to possible and explains why.' } 'unknown' { '<span class="verdict flag">not documented</span>Kept; flagged "may have requirements".' } default { '<span class="verdict pass">no requirement</span>' } }
      if ($g.state -eq 'not-required' -and $g.evidence -eq '') { continue }
      $ev = ''; if ($g.evidence) { $ev = '<p class="ev">' + (Esc $g.evidence) + '</p>' }
      W "<li><span class=`"n`">$n</span><div><div class=`"q`">$(Esc $g.question)</div><p class=`"a`">$v</p>$ev</div></li>"
      $n++
    }
    W '</ol></div><div>'
    # intake
    W '<h3 style="margin-top:0">Intake, after a match</h3><ol class="steps">'
    $win = ''; if ($k.window) { $win = ' — <i>' + (Esc $k.window) + '</i>' }
    W "<li><div><b>Is it open?</b>$(Esc $k.status)$win</div></li>"
    if ($k.method) { W "<li><div><b>How to apply</b>$(Esc $k.method)</div></li>" }
    if ($k.documents) { W "<li><div><b>Bring</b>$(Esc $k.documents)</div></li>" }
    $fn = ''; if ($k.form_notes) { $fn = ' — ' + (Esc $k.form_notes) }
    if ($k.form_url) { W "<li><div><b>Form</b><a href=`"$(Esc $k.form_url)`">Application form</a>$fn</div></li>" }
    elseif ($k.program_url) { W "<li><div><b>Program page</b><a href=`"$(Esc $k.program_url)`">$(Esc $k.program_url)</a>$fn</div></li>" }
    $contact = @(); if ($k.phone) { $contact += $k.phone }; if ($k.email) { $contact += $k.email }; if ($k.address) { $contact += $k.address }
    $hrs = ''; if ($k.hours) { $hrs = '<br><i>' + (Esc $k.hours) + '</i>' }
    if ($contact.Count -or $k.hours) { W "<li><div><b>Contact</b>$(Esc ($contact -join ' · '))$hrs</div></li>" }
    $mx = ''; if ($k.max_benefit) { $mx = ' — ' + (Esc $k.max_benefit) }
    if ($k.benefit -or $k.max_benefit) { W "<li><div><b>What you may get</b>$(Esc $k.benefit)$mx</div></li>" }
    W '</ol>'
    if ($k.priority) { W "<div class=`"note`"><span class=`"label`">Priority</span><p>$(Esc $k.priority)</p></div>" }
    if ($k.disqualifiers) { W "<div class=`"note hard`"><span class=`"label`">Hard disqualifiers</span><p>$(Esc $k.disqualifiers)</p></div>" }
    W '</div></div></article>'
  }
}
W '</section>'

W @'
<section id="reading"><h2 class="head">How to read a flow</h2>
<p><b class="pass">must be</b> is a hard gate: the answer has to match or the program is removed. <b class="fail">required</b> is a soft gate: the program documents a requirement, and an unticked box demotes it to "possible" with a note rather than removing it — because an unticked box is not a "no". <b class="flag">kept + flagged</b> means the program's own materials don't say, so the screener keeps it and tells you to check.</p>
<p>The evidence line under each gate is the program's wording verbatim. When a gate looks wrong, that line is what to read — and the fix is to correct the wording in the matrix and reload, not to change the screener.</p>
<p>Intake steps are the program's published process. "Is it open?" comes first because several programs are seasonal or waitlisted, and nothing else matters if the window is shut.</p>
</section>
'@
$main = $sb.ToString(); [void]$sb.Clear()

$colophon = '<footer class="colophon"><p>Generated from the live database; the same content is available as structured data in <code>docs/flows.json</code>. Rule-reading mirrors <code>web/matcher.js</code> — where this document and the screener disagree, that is a bug.</p></footer>'

# Artifact: self-contained page.
$art = $artHead + '<nav class="rail" aria-label="Contents">' + $rail + '</nav><main>' + $main + '</main>' + $colophon + '</div>'
if ($ArtifactOut) { [System.IO.File]::WriteAllText($ArtifactOut, $art, (New-Object System.Text.UTF8Encoding($false))) }

# Site page: the SOP chrome, so it reads as the same product as /sop/ and /data/.
$site = @'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Screening Flows SOP — Toto Housing Companion</title>
    <meta name="description" content="Every screening question, the gate it applies to each program, and the intake steps that follow a match." />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23ff0055' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 10.5 12 3l9 7.5'/%3E%3Cpath d='M5 9.5V21h14V9.5'/%3E%3Cpath d='M9.5 21v-6h5v6'/%3E%3C/svg%3E" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" />
    <link rel="stylesheet" href="../styles.css?v=__BUILD__" />
    <link rel="stylesheet" href="../sop/sop.css?v=__BUILD__" />
    <link rel="stylesheet" href="flows.css?v=__BUILD__" />
  </head>
  <body class="sop flows">
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header">
      <div class="wrap wrap--sop site-header__inner">
        <a class="brand" href="../">
          <span class="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" /></svg>
          </span>
          <span class="brand__text"><strong>Toto Housing Companion</strong><small>Screening flows SOP</small></span>
        </a>
        <a class="btn btn--ghost btn--sm" href="../data/">Back to the limits</a>
      </div>
    </header>
    <div class="shell">
      <header class="masthead">
        <p class="eyebrow">Standard Operating Procedure · screening to intake</p>
        <h1>From the first question to the program's front door</h1>
        <p class="standfirst">For each of the 66 active programs: the questions the screener asks, the gate each one applies, what a "no" does, the income limit in dollars, and then — once a program matches — how to apply, what to bring, and who to contact. Generated from the live database, so it describes what the screener actually does.</p>
      </header>
      <nav class="rail" aria-label="Contents">
'@ + $rail + @'
      </nav>
      <main id="main">
'@ + $main + @'
      </main>
'@ + $colophon + @'
    </div>
    <footer class="site-footer">
      <div class="wrap wrap--sop">
        <p>This is the companion to the <a href="../sop/">income standards SOP</a>: that one says which limit a program is tested against; this one says every other question, and what happens after a match.</p>
      </div>
    </footer>
  </body>
</html>
'@
New-Item -ItemType Directory -Force "$repo\web\flows" | Out-Null
[System.IO.File]::WriteAllText("$repo\web\flows\index.html", $site, (New-Object System.Text.UTF8Encoding($false)))
Copy-Item "$sp\flows.json" "$repo\docs\flows.json" -Force
"programs: $($flows.Count)"
"required gates: $(($flows | ForEach-Object { $_.gates } | Where-Object { $_.state -eq 'required' }).Count)"
"unknown gates : $(($flows | ForEach-Object { $_.gates } | Where-Object { $_.state -eq 'unknown' }).Count)"
"income tested : $(($flows | Where-Object { $_.income.tested }).Count)   with a resolved 4p limit: $(($flows | Where-Object { $null -ne $_.income.limit_4p }).Count)"
"wrote         : web\flows\index.html, docs\flows.json$(if($ArtifactOut){", $ArtifactOut"})"
