# Google Sheet mirror

Every data load ends by pushing the current datasets to a shared Google Sheet,
so anyone with the link sees what the database holds without touching it.

**Sheet:** <https://docs.google.com/spreadsheets/d/1pmeyHqUEXIvL9hXXnBc45VxP9YhmGqlRX1pstqrL0Fc>

Six tabs, each replaced in full on every refresh, plus an *About* tab with the
timestamp of the last push:

| Tab | Holds |
| --- | ----- |
| Programs & datasets | Every program, the income dataset it is tested against, and why |
| Income limits | Every published income figure, one row per household size |
| Rent limits | Every published rent figure, by bedroom count |
| Standards | The datasets: publisher, source URL, when they republish |
| Areas | Counties and states the limits are keyed to |
| Dataset usage | How many programs sit on each dataset |

It is a **mirror, not a workbook**. Edits made in the sheet are lost on the
next refresh. Change the data by reloading it; the sheet follows.

## One-time setup: the service account

GitHub Actions cannot use a person's Google login. It needs a *service
account* — a robot identity with its own email — that the sheet is shared
with. This takes about five minutes and is done once.

1. Open <https://console.cloud.google.com/> and create a project (any name;
   "toto-housing" is fine). If you already have one, use it.
2. **APIs & Services → Enable APIs** → enable **Google Sheets API**.
3. **IAM & Admin → Service Accounts → Create service account.** Name it
   `sheet-exporter`. No roles are needed; click through.
4. Open the new account → **Keys → Add key → Create new key → JSON.** A file
   downloads. This is a credential; treat it like a password.
5. Open the sheet above → **Share** → paste the service account's email
   (it ends in `@<project>.iam.gserviceaccount.com`, shown on the account
   page) → give it **Editor** → uncheck "Notify people" → Share.
6. In the GitHub repo → **Settings → Secrets and variables → Actions → New
   repository secret:**
   - Name: `GOOGLE_SA_JSON`
   - Value: the *entire contents* of the JSON file from step 4, pasted as-is.

`GOOGLE_SHEET_ID` is already set. Once `GOOGLE_SA_JSON` is in, the next data
load fills the sheet automatically; or run **Export to Google Sheets** from
the Actions tab to fill it immediately.

## Sharing the sheet

Share it from Google the normal way. **Viewer** is the right level for almost
everyone — a Viewer can read, filter, and copy, and cannot break the mirror.
Only the service account needs Editor.

## Until the service account is set

The export still runs on every load and attaches the same six tables as a
downloadable **dataset-snapshot** artifact on the workflow run. Nothing is
lost; the sheet is just not updated yet.

## If the sheet is ever deleted or moved

Create a new one, put its ID (the long string in its URL) into the
`GOOGLE_SHEET_ID` secret, share it with the service account, and run the
export. The tabs are created on first push.
