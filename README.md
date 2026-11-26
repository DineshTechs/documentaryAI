# Documentary Studio (Node.js)

An AI documentary studio for a YouTube channel. You give it a topic; its agent researches the story, writes the
script, finds archive images, records the narration and directs the film. A built-in renderer then makes a 1080p
MP4 with captions, chapters and mixed audio. You approve each key step from the web app or Telegram, then publish
straight to YouTube.

**Version 2 is pure Node.js:** no Docker, no Python, and no root or `sudo` access needed. It runs as a normal
**cPanel "Setup Node.js App"** (shared hosting), on any VPS, or on your own PC (Windows included).

## Features

- **Film pipeline**: Story → Voice → Images → Scene → Review → Render. The agent stops for your approval at the
  beat table, the look, and the 30-second draft. You can message it at any time.
- **Built-in documentary renderer** (Skia + ffmpeg, both installed by `npm install`):
  - Five looks: cork evidence wall, aged-paper archive, blueprint, night, studio.
  - Pinned polaroids, newspaper clippings, typed documents, sticky notes, stamps, red string, map markers and
    animated routes, hand-drawn highlights, arrows, title cards, typewriter labels, animated counters.
  - Camera moves with a subtle handheld drift, film grain, vignette, fades and flashes, and burned-in captions.
  - Narration placed to the exact millisecond, background music that ducks under the voice, YouTube loudness
    (-14 LUFS), and SRT captions and chapters files.
  - Scenes are cached, so re-rendering after a small change only re-renders the scenes that changed.
- **Any AI provider**: Claude, OpenAI, Gemini, OpenRouter, DeepSeek, Groq, Mistral, xAI, or OpenAI-compatible
  (Ollama, LM Studio). Set one default and switch per film.
- **Voice**: OpenAI TTS or ElevenLabs, or upload your own recording (the agent splits it into lines).
- **Research**: Wikipedia and web pages, plus optional Brave Search. Images come from **Wikimedia Commons**
  (free licences only), and credits are recorded automatically.
- **YouTube**: AI titles, description with chapters and credits, tags, and thumbnail ideas. Pick a video frame as
  the thumbnail or upload one. Upload with captions and thumbnail, set visibility, or schedule a release.
- **Ideas & calendar**: a kanban board, AI brainstorming, a release calendar, and "Make film" from any idea.
- **Telegram bot**: every feature plus push notifications (approvals with files, finished films with video).
- **Setup check**: renders a test clip and tells you how long a 90-second film takes on your server.

---

## Install on cPanel hosting (e.g. MilesWeb), no root needed

Your hosting needs **"Setup Node.js App"** in cPanel (Node 18 or newer) and **Terminal** or SSH access.

1. **Get the code.** In cPanel, open **Terminal**. Put the app *outside* `public_html`:
   ```bash
   cd ~
   git clone https://github.com/DineshTechs/documentaryAI.git
   ```
   For a private repo, git asks for your GitHub username and a **personal access token** (GitHub → Settings →
   Developer settings → Fine-grained tokens, *Contents: read-only*).

2. **Create the app.** In cPanel, open **Setup Node.js App → Create Application**:
   - **Node.js version**: the newest offered (22 or 20).
   - **Application mode**: Production.
   - **Application root**: `documentaryAI`.
   - **Application URL**: your domain or a subdomain, e.g. `studio.yourchannel.in` (create the subdomain under
     cPanel → Domains first).
   - **Application startup file**: `app.js`.
   - Click **Create**.

3. **Install packages.** On the same page, click **Run NPM Install**. This installs the graphics engine and
   ffmpeg into the app folder.

4. **Set your password.** Still on that page, add two **Environment variables**, then click **Save**:
   - `APP_PASSWORD`: the password you'll log in with.
   - `SECRET_KEY`: any long random text (e.g. mash the keyboard for 40+ characters).

5. Click **Restart**, then open `https://studio.yourchannel.in` and log in.

6. In **Settings**:
   1. **Server check**: renders a test clip and shows how fast this server makes films.
   2. **AI models**: add a key (e.g. Anthropic), set the default provider and model, then click **Test**.
   3. **Narration voice**: OpenAI TTS or ElevenLabs, then click **Test voice**.
   4. **Telegram** and **YouTube** whenever you like (below).

7. **Recommended: keep the app awake.** cPanel puts idle apps to sleep. The app keeps itself awake while it's
   making a film, but a cron job keeps it ready at all times. In cPanel → **Cron Jobs**, add *every 5 minutes*:
   ```
   curl -s https://studio.yourchannel.in/api/health > /dev/null
   ```

**Updating later:** run `deploy.bat` on your PC (see [Development and deployments](#development-and-deployments)).
Or, in cPanel Terminal, run the activation command shown at the top of the Setup Node.js App page (it starts with
`source /home/USER/nodevenv/...`), then:
```bash
cd ~/documentaryAI && git pull && npm install --omit=dev && mkdir -p tmp && touch tmp/restart.txt
```

### Shared hosting tips

- Rendering uses a lot of CPU. If your host slows the app down, add the environment variable `RENDER_THREADS=1`.
  Make shorter films, or use 720p.
- If **Run NPM Install** can't download ffmpeg, download a static ffmpeg build for Linux (x86_64), upload it to
  the app folder, run `chmod +x ffmpeg`, and set the environment variable `FFMPEG_PATH=/home/USER/documentaryAI/ffmpeg`.
- Films, settings and the database live in `documentaryAI/data/`. Back that folder up.
- Fonts (OFL Google Fonts) download into `data/fonts` on the first start. If your host blocks that, copy `.ttf`
  files into the `fonts/` folder.

## Install on a VPS or your own PC

Install **Node.js 18+** (on Ubuntu: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs`), then:
```bash
git clone https://github.com/DineshTechs/documentaryAI.git && cd documentaryAI
cp .env.example .env      # set APP_PASSWORD and SECRET_KEY
npm install
npm start                 # http://localhost:3000
```
**On a VPS**, keep it running with pm2: `sudo npm i -g pm2 && pm2 start app.js --name studio && pm2 save && pm2 startup`.
Put a web server with HTTPS in front of it, e.g. Caddy: `studio.yourchannel.in { reverse_proxy 127.0.0.1:3000 }`.

**On Windows**, install Node.js from nodejs.org, then double-click `run_app.bat`.

Run `npm run check` at any time for the same server check as in Settings.

---

## Telegram bot

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token.
2. Go to **Settings → Telegram bot**, paste the token, tick **Enable**, set your timezone, and save.
3. Tap **Open pairing link** on your phone. Only paired accounts can use the bot, and each code works once.

When the app has an https address, the bot uses a **webhook**: Telegram calls your app, which wakes it up even on
cPanel. Without https (on your PC) it uses polling.

| Area | Commands |
|---|---|
| Films | `/films` · `/film 3` · `/use 3` · `/new Title \| topic \| 90 \| 16:9` · `/status` |
| Agent | `/approve [note]` · `/changes …` · `/resume` · `/stop` · `/log` · any plain message goes to the agent |
| Files | `/files` · `/get film.json` · `/video` · `/stills` · send photos, audio, voice notes or documents to add them to the film |
| YouTube | `/meta` · `/title …` · `/tags a, b` · `/privacy public` · `/schedule 2026-12-01 18:00` · `/thumb 4.5` · photo with caption `thumbnail` · `/upload` |
| Planning | `/ideas` · `/idea Title \| notes` · `/brainstorm theme` · `/makefilm 5` · `/plan 5 2026-12-10` · `/calendar` |
| AI | `/models` · `/model` · `/model openrouter some/model` · `/model default anthropic claude-sonnet-5-5` |

Telegram lets bots send files up to 50 MB and receive files up to 20 MB. Bigger files go through the web app.

## YouTube connection

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3**.
2. Set up the **OAuth consent screen** (External) and add your Google account as a **test user**.
3. Create **Credentials → OAuth client ID → Web application**. Add the redirect URI shown in Settings (it's
   detected automatically), e.g. `https://studio.yourchannel.in/oauth/youtube/callback`. If you run more than
   one copy (staging, your PC), add each copy's URI to the same client.
4. Paste the client ID and secret into Settings, save, and click **Connect YouTube channel**.

While your Google app is in "Testing" mode, the login expires every 7 days. Publish the consent screen to avoid
that. Custom thumbnails need a phone-verified YouTube channel.

---

## Development and deployments

Run several copies, e.g. **staging** (for testing) and **main** (your live channel). On cPanel, each copy is its
own **Setup Node.js App** with its own folder and subdomain:

| Copy | Folder | URL | Git branch |
|---|---|---|---|
| main | `~/documentaryAI` | `studio.yourchannel.in` | `main` |
| staging | `~/documentaryAI-staging` | `staging.yourchannel.in` | `develop` |

Create the staging copy: `git clone -b develop https://github.com/DineshTechs/documentaryAI.git ~/documentaryAI-staging`,
then repeat steps 2–5 above with that folder. Each copy has its own data, password, settings and Telegram bot.

**On your PC (Windows):**

| File | What it does |
|---|---|
| `git_push.bat` | Commit and push your current branch to GitHub |
| `switch_branch.bat` | Switch between develop / main / a feature branch |
| `deploy.bat staging` / `deploy.bat main` | Update that copy on the server over SSH (git pull, npm install, restart) |
| `release.bat` | Merge develop into main, push, and offer to deploy main |
| `run_app.bat` | Optional: run the app on your PC (needs Node.js) |

The first time you run `deploy.bat`, it asks for your SSH login (e.g. `document1@yourserver`) and the folder of
each copy. It saves them in `deploy.config`, which isn't pushed to GitHub. In cPanel, enable SSH under
**SSH Access** (or ask your host).

---

## How it works

```
Browser / Telegram ──► Node.js server (app.js) ──► Agent (per film) ──► tools:
                                                     research · Wikimedia Commons · TTS · files ·
                                                     check_film · stills · contact sheet · draft · final
                                                         │
                                                         ▼  (separate process)
                                     Renderer: film.json → Skia frames → ffmpeg → MP4 + SRT + chapters
```

- The agent writes **`film.json`**, a description of every scene, element, camera move and narration line.
  The format is documented in [`src/GUIDE.md`](src/GUIDE.md), which is also the agent's instruction manual.
- The agent never runs shell commands. It can only use the tools above, inside each film's folder.
- Only one render runs at a time, so small servers aren't overloaded.
- Each scene is encoded separately and cached, so an interrupted render picks up where it stopped.

## Project layout

```
app.js                 entry point (cPanel startup file)
src/server.js          web server and API          src/agent.js       film-making agent + tools
src/llm.js             AI providers                src/telegram.js    Telegram bot
src/youtube.js         YouTube login/upload/meta   src/research.js    web, Wikipedia, Wikimedia Commons
src/tts.js             narration voice             src/store.js       JSON storage (data/)
src/GUIDE.md           film craft + film.json reference
src/renderer/          the documentary renderer (looks, elements, timeline, audio, render, worker)
static/                web interface (no build step)
```

The film style is inspired by the open-source [cinematic-skill](https://github.com/Moh4696/cinematic-skill)
project (MIT); the renderer here is an independent Node.js implementation.
