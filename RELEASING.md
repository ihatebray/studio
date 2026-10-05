# Releasing an update

Studio updates itself from GitHub Releases on `ihatebray/studio`. When a new
release is published, every installed copy finds it within an hour, downloads
it in the background, and shows a **Restart to update** notification (also in
the bell and in Settings → System → Updates).

## One-time setup

1. **A GitHub token**, so the build can upload to Releases.
   GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token.
   - Repository access: only `ihatebray/studio`
   - Permissions: **Contents: Read and write**

   Keep it private. Don't commit it.
2. `npm install` (picks up the GitHub publisher).
3. As for any build: `npm run setup:binaries` and `npm run setup:spotify`
   if you haven't already.

## Every release

```powershell
# 1. Your changes are committed and pushed to main, and src/changelog.js
#    has an entry for the new version (it's what Settings → Changelog shows).

# 2. Bump the version (0.0.1 -> 0.0.2). This commits and tags it.
npm version patch          # or: npm version minor   for bigger releases
git push --follow-tags

# 3. Build and upload (PowerShell; the token lasts for this window only).
$env:GITHUB_TOKEN = "github_pat_..."
npm run publish
```

4. On GitHub, open **Releases**. There's a draft named after the new version.
   Write what changed if you like (it's only shown on GitHub; the app's
   What's new screen shows the src/changelog.js entry), then press
   **Publish release**.

Installed copies pick it up within the hour. Settings → System →
**Check for updates** checks straight away. After you publish, the update
service can take a few minutes to see the new release.

## Things to know

- **The version must go up every time.** Studio only offers a release whose
  version is higher than the one installed.
- **The first time:** 0.0.1 is the first release. Copies installed before
  it (they called themselves 0.1.0) can't update themselves: uninstall that
  Studio (Windows Settings → Apps), then install 0.0.1 with `studio-Setup.exe`
  from the release. Uninstalling keeps the library, settings and sign-ins.
  Every later release then arrives on its own.
- **Only the Windows installer updates itself** (`studio-Setup.exe`). The zip
  build, macOS and Linux still get the notification, but its button opens
  the release page to download it.
- **Nothing is lost on update.** The library, settings and sign-ins live in
  the user's data folder, which the update doesn't touch.
- **Running from source** (`npm start`) never checks for updates.
- **Undo a bad release:** delete it on GitHub (or mark it as a pre-release)
  and publish a fixed version with a higher number. Copies that already
  updated get the fix the same way.
