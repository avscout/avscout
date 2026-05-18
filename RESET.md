# RESET — read this first

This is a clean restart. The zip contains the AVScout monorepo files at
the **root level** (no nested `avscout/` folder this time).

## Goal

Replace your repo's contents with what's in this zip, push to GitHub,
have CI deploy. Result: `https://avscout.github.io/avscout/` shows
the current code with all features from v12.

## Steps

### 1. Backup your repo folder (safety net)

In your file explorer or terminal, **rename** your repo folder:

  `avscout/`  →  `avscout-BACKUP-2026-05-18/`

Or just copy the whole folder somewhere safe. If anything goes wrong,
you have a fallback.

### 2. Make a fresh clone of the repo

Open a terminal in the parent folder (where the renamed backup now lives):

```
git clone https://github.com/avscout/avscout.git
cd avscout
```

You're now in a clean working tree that matches the remote exactly.

### 3. Delete everything except `.git/`

In VS Code's file tree (or your OS file explorer), with hidden files
visible, **select everything except `.git/`** and delete.

After deletion, the folder should contain only `.git/` (and maybe
`.DS_Store` on macOS, ignore that).

Verify in terminal:

```
ls -la
```

You should see `.` `..` `.git` and nothing else.

### 4. Unzip this archive and copy its contents into the repo

Unzip the file somewhere temporary (Downloads is fine). You'll see:

```
README.md
RESET.md (this file)
build/
floorplan-ext/
package.json
package-lock.json
shared/
.github/        (hidden folder — CI workflow)
.gitignore      (hidden file)
```

**Select all of these (including the hidden `.github/` and `.gitignore`)**
and copy/move them into your empty repo folder.

The result should look like:

```
your-repo/
├── .git/             (preserved from step 2)
├── .github/          (new, from zip — CI workflow)
├── .gitignore        (new)
├── README.md
├── RESET.md          (this file — delete after success)
├── build/
├── floorplan-ext/
├── package.json
├── package-lock.json
└── shared/
    └── avscout/      (the only thing under shared/)
        ├── avscout.css
        ├── avscout.html
        ├── avscout.js
        ├── boot.js
        ├── equipment.js
        ├── icons/
        ├── index.html
        ├── manifest.webmanifest
        ├── storage.js
        └── sw.js
```

### 5. Sanity-check before committing

In your terminal, inside the repo:

```
ls
```

Should NOT show a nested `avscout/` folder. If it does, you put the
files in the wrong place. Pull them up a level and try again.

```
cat shared/avscout/sw.js | head -10
```

Should say `const CACHE = 'avscout-v12';` near the top.

```
git status
```

Should show many modified files but no merge conflict markers and no
"unrelated histories" warnings.

### 6. Commit and push

```
git add -A
git commit -m "Clean reset to v12"
git push origin main
```

If push fails with "non-fast-forward" or similar, force it:

```
git push --force origin main
```

(Safe in this case because nobody else commits to this repo.)

### 7. Watch CI

GitHub → Actions tab. Wait ~60 seconds. `build` and `deploy-pages` jobs
should both go green.

### 8. Verify in browser

Visit: **https://avscout.github.io/avscout/**

Before reloading:
- DevTools (F12) → Application → Storage → "Clear site data" → confirm
- Reload the page

You should see AVScout with:
- Empty welcome screen (no floors yet)
- No left rail FAB visible (because no floors)
- Cyan accent on the welcome's "+ Load SVG" button

### 9. Delete this file

Once everything works, delete `RESET.md` from your repo and commit.

---

## If something goes wrong

- **Push fails with "rejected"** → use `git push --force origin main`
- **CI fails on `npm ci`** → tell me, I'll look at it
- **CI fails on the smoke test** → my smoke test has diagnostic output
  that'll tell us what's wrong with the bundle; paste the failure log
- **Pages still shows the old version** → service worker cache. Clear
  site data again and force-reload (Ctrl+Shift+R / Cmd+Shift+R)
