# Fenix Dash

A free personal phone app for your Garmin data. Start with **SETUP.md**.

- `garmin_dash/` downloads your data with Garmin's Personal API, merges it with past history and encrypts it (AES-256-GCM).
- `web/` is the phone app (installable, works offline). It decrypts in the browser with your passphrase.
- `workflow/refresh.yml` is the GitHub automation (copy it to `.github/workflows/refresh.yml`).
- `tools/make-passphrase.html` creates a strong random passphrase.
- Tests: `pip install -r requirements.txt pytest && pytest`

Try it with sample data: `python -m garmin_dash preview --out site`, copy `web/*` into `site/`, serve that folder, passphrase `sample-passphrase`.
