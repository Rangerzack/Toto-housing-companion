# Mirrored intake forms

Local copies of every downloadable intake form the active programs publish,
fetched 2026-08-21. They exist so that an agency redesigning its website
cannot break an application mid-stream: the screener links the agency's own
URL first (it is the canonical, current version), and these mirrors are the
fallback when the monthly link checker (`check-links.yml`) reports one dead.

If a link dies: verify the agency hasn't simply moved the form (update
`Application Form URL` in the matrix CSV if so), and only point at the mirror
while no live copy exists — a mirror goes stale the day the agency revises
the form.

| File | Program(s) | Canonical source |
|---|---|---|
| access-homeownership-intake.pdf | ACCESS-HOAP-OR-001, ACCESS-RVAR-OAR-OR-001 | accesshelps.org |
| reoregon-hss-application.pdf | OHCS-REOREGON-DPA-001 | oregon.gov/ohcs (rev. 01/16/25) |
| or-home-savings-designation.pdf | OR-HOME-SAVINGS-001 | oregon.gov/dor (rev. 11-04-24) |
| pacific-power-lid-application.pdf | PP-LID-OR-001 | pacificpower.net (11/25 edition) |
| xcel-mn-luac-application.pdf | XCEL-LUAC-10 | xcelenergy.com (17-9194 05-24) |
| xcel-mn-medical-affordability.pdf | XCEL-MAP-11 | xcelenergy.com (17-9203 05-24) |
| mn-energy-programs-application-2025-26.pdf | EAP-PH-01, EAP-CRISIS-02, EAP-ERR-03 (and required for the EAP-gated programs) | mn.gov/commerce (2025–26; replaced each September) |
| mn-combined-application-dhs5223.pdf | Benton/Sherburne/Stearns EA & EGA | mn.gov/dhs (edition 7-22 — confirm current before relying on it) |

The HAJC voucher application has no downloadable form: it lives behind the
pha-web.com applicant portal and requires a registration code from the
Housing Authority.
