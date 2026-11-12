# Fenix Dash: setup guide (iPhone, free)

You will end up with an app icon on your iPhone. Tap it, type your passphrase, and see your Garmin Fenix 9 data. GitHub refreshes the data by itself every 3 hours, even when your phone and computer are off. Cost: $0.

**You need:** a computer for about 20 minutes, once (uploading files from an iPhone is painful). Your iPhone. Your Garmin Connect login.

**How it works, in one breath:** GitHub (free) asks Garmin for your numbers, scrambles them with your passphrase, and puts the scrambled file on a web page next to the app. The app on your phone unscrambles it. Nobody without your passphrase can read your numbers.

---

## Part 1. Make your passphrase (2 min)

1. Unzip `fenix-dash.zip`. Open the file `tools/make-passphrase.html` (double-click it).
2. You'll see six words like `piglet-gloss-...`. Press **Make another** until you like one.
3. **Write it on paper.** If you lose it you can't read your data, and nobody can recover it for you (you'd just set up a new one, see Part 7).

## Part 2. Make your Garmin key (3 min)

1. Go to https://connect.garmin.com and sign in.
2. Open **Settings → Personal API Key**, choose **Create Key**, accept the terms.
3. Pick the **longest expiry** Garmin offers. Garmin shows the key **once**. Copy it into a note for now.

> If Garmin's page looks different from this, search the Garmin Connect settings for "API". The key is a long string of letters and numbers.

## Part 3. Make your GitHub home (3 min)

1. Go to https://github.com and sign up (free). Verify your email.
2. Click **+** (top right) → **New repository**.
3. Name: `fenix` (your app's address will contain this name). Choose **Public**. Do not tick any boxes. Click **Create repository**.

*Why Public?* GitHub's free plan only serves web pages from public repositories. Your numbers are scrambled, so being public doesn't expose them. Your Garmin key and passphrase are stored as secrets, which stay private.

## Part 4. Upload the files (5 min)

1. On the empty repository page, click **uploading an existing file**.
2. Open the unzipped folder on your computer. Select **everything inside it** (the folders `garmin_dash`, `web`, `tests`, `tools`, `workflow`, and the loose files) and **drag them into the browser**. Wait until every file shows a green tick, then click **Commit changes**.
3. Now the one special file. Click **Add file → Create new file**. In the name box type exactly:
   `.github/workflows/refresh.yml`
   (when you type each `/`, GitHub turns it into a folder).
4. On your computer open `workflow/refresh.yml` in any text editor, select all, copy, and paste into the big box on GitHub. Click **Commit changes → Commit changes**.

## Part 5. Give GitHub your secrets and switch on the web page (5 min)

In your repository click **Settings** (top row).

1. **Secrets and variables → Actions → Secrets tab → New repository secret**
   - Name `GARMIN_PERSONAL_API_KEY`, value: the Garmin key. Save.
   - New secret again: name `FENIX_PASSPHRASE`, value: your six words exactly as written. Save.
2. **Variables tab → New repository variable** (optional but recommended)
   - Name `FENIX_TIMEZONE`, value: your time zone name, like `America/New_York`, `Europe/London`, `Asia/Kolkata`. If you skip it, `America/Los_Angeles` is used and "today" may be off by a few hours.
3. **Pages** (left menu) → under **Source** choose **GitHub Actions**.

## Part 6. First run, then your phone (10 min)

1. Click **Actions** (top row). If GitHub asks, click the green button to enable workflows.
2. Click **Refresh Garmin data** on the left, then **Run workflow**. **Tick "Only check the connection"** and run. After about a minute, click the run and open the step **Check the connection to Garmin**. You should see a list of data kinds with field names. That proves GitHub can talk to Garmin with your key.
3. Run it again with the box **unticked**. Wait 2 to 4 minutes for a green tick. (The first run downloads 90 days.)
4. On your iPhone, open **Safari** (it must be Safari) and go to:
   `https://YOUR-GITHUB-USERNAME.github.io/fenix/`
5. Type your passphrase and tap **Unlock**. You should see your data.
6. Tap the **Share** button (square with arrow) → **Add to Home Screen** → **Add**.
7. Open the app **from your home screen** and type the passphrase **once more** (the home-screen app keeps its own storage). After that it remembers it.

Done. Open the app whenever you like. "Updated … ago" at the top shows how fresh the data is. Your watch has to sync to the Garmin Connect phone app first; the dashboard can only show what Garmin Connect has.

---

## Part 7. If something goes wrong

**First, look at Actions → the latest run.** Green tick = fine. Red cross = click it and read the red message.

| What you see | What it means / what to do |
|---|---|
| Unlock says "That passphrase isn't right" | Typo. Capitals and hyphens matter. Make sure it matches the `FENIX_PASSPHRASE` secret exactly. |
| "No data published yet" in the app | Run the workflow (Part 6, step 3) and wait for the green tick. |
| Red run, message mentions the key or 401/403 | The Garmin key is wrong, expired or was pasted with a space. Make a new key (Part 2) and update the secret. |
| Red run, "Garmin returned nothing for every kind" | Garmin may be down, or may block GitHub's servers. Re-run later. If it keeps failing, the check step shows what Garmin said. |
| Some cards show "–" or a yellow note | Garmin didn't send that number, or its field names differ from what the app expects. Tick "Only check the connection", run, and send me the output of that step (it has field names only, never your numbers). |
| Red run, "existing published data can't be opened with this passphrase" | You changed the passphrase. To start fresh with the new one: Settings → Secrets and variables → Actions → Variables → add `FENIX_RESET` = `1`, run once, then delete that variable. Old history is rebuilt from Garmin (last 90 days). |
| "The data hasn't refreshed for …" banner | Scheduled runs stopped. GitHub pauses them on quiet public repos after about 60 days. Open Actions → Refresh Garmin data → **Enable workflow**, then **Run workflow**. Also check for an expired Garmin key. |
| App doesn't update after a fix | Pull down / reopen the app. If still old, remove it from the home screen and add it again. |

**Changing your passphrase later:** change the secret, add `FENIX_RESET=1` as above, run once, then type the new passphrase on your phone.

---

## What to know (honest limits)

- **Not yet proven against your real watch.** I built and tested everything with realistic sample data and a real encryption round trip in a browser. I could not test against Garmin's live service. Part 6 step 2 is how you find out quickly, and the app is built to show "–" instead of breaking if a field is missing.
- **It's "public but scrambled".** Anyone can download the scrambled file. With a six-random-word passphrase it is not realistically guessable. A short or common passphrase would be guessable, so use the generated one.
- **Not instant.** Data refreshes every 3 hours at best (GitHub can delay scheduled runs by 10 to 30 minutes). You can run the workflow by hand any time.
- **Garmin key expiry.** If you chose a short expiry the data stops refreshing when it ends. Make a new key and update the secret.
- **Time zone** matters for what counts as "today". Set `FENIX_TIMEZONE`.
